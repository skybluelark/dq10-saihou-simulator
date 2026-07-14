// リプレイ一致率計測ツール (SOLVER_DESIGN §S8-④b)。
// 目的: ユーザーの実プレイのリプレイを教師データとして、各行動時点でエキスパートポリシー
//       (rankExpert)が提示する候補ランキングに対しユーザーの実際の選択が何位だったかを
//       計測し、一致率(@1/@3)・ルール外(rankExpertのルールが実プレイの手を禁止したケース。
//       ルールの過剰プルーンを示すシグナル)を集計する。以後のソルバー改善(ルール・スコア式
//       の調整)の判断材料に使う。
//
// 実行: npm run solver:agreement (= vite-node scripts/solver-agreement.ts)
//       npx vite-node scripts/solver-agreement.ts -- data/replays/foo.json data/replays/bar.json
//       npx vite-node scripts/solver-agreement.ts -- data/replays/  (ディレクトリ指定: 直下の *.json 全部)
// 引数(任意・複数可): リプレイJSONのファイルパスまたはディレクトリ。省略時は data/replays/ を既定とする。
//
// 手順(2系統・いずれも同一シードから独立に再構築する):
//   1. 検証: src/core/replay.ts の runReplay(createSession→applyAction×N)でそのまま再実行し、
//      check があれば matchesReplayCheck で照合する(NGでも解析自体は続行)。
//   2. ステップ解析: createRng(replay.seed) から自前でセッションを再構築し、各行動について
//      [beginTurn(ターン開始処理。冪等・？抽選等を含む) → rankExpert(乱数を消費しない
//      ティア付き順位付け。ユーザー行動が禁止候補ならルール外扱いとし、参考として
//      scoreCandidates 側の素の順位も求める) → 順位判定 → applyAction] の順に処理する。
//      src/core/replay.ts 冒頭のコメントの通り、beginTurn は turnStarted ガードにより
//      1ターンにつき1度しか実処理を行わない(2回目以降は乱数を消費しないno-op)ため、
//      「各行動の直前に beginTurn を挟んでから applyAction する」手順は
//      「applyAction だけを連続で呼ぶ」runReplay 単独実行と乱数消費列・状態が完全に一致する
//      (T12 beginTurn 公開API のテストで保証されている)。順序をこれと変えると
//      (例: beginTurnを挟まない、複数回挟む等)乱数消費がずれて盤面が実プレイと一致しなくなる
//      ため、必ずこの順序を守ること。
//
// 決定性: rankExpert・scoreCandidates はいずれも乱数を消費しない純粋な静的評価のため、
//        上記のステップ解析ループに差し込んでも乱数消費列(=盤面の再現)には一切影響しない。
//        同一入力なら stdout は完全に同一になる(実行時間のみ stderr に出す。
//        solver-bench.ts と同じ方針)。

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join, basename } from 'node:path';
import {
  Engine,
  createRng,
  parseReplay,
  runReplay,
  matchesReplayCheck,
} from '../src/core';
import type { Action, EngineData, GameState, SkillDef } from '../src/core';
import { loadGameParams, loadNeedles, loadSkills, loadConcentration, loadRecipes } from '../src/data';
import type { RecipeDef } from '../src/data';
import { createSolverContext, scoreCandidates, rankExpert } from '../src/stats';
import type { Candidate, ExpertChoice, ScoredCandidate, SolverContext } from '../src/stats';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

const STAR_LABEL: Record<string, string> = {
  star3: '★3',
  star2: '★2',
  star1: '★1',
  star0: '★0',
  fail: 'fail',
};

// ---- 入力ファイル列挙 ----

/** argv からリプレイファイル一覧を作る。ディレクトリは直下の *.json のみ(再帰なし)。 */
function collectReplayFiles(argv: string[]): string[] {
  const inputs = argv.length > 0 ? argv : [resolve(root, 'data/replays')];
  const files: string[] = [];
  for (const raw of inputs) {
    const p = resolve(process.cwd(), raw);
    let st;
    try {
      st = statSync(p);
    } catch {
      console.error(`パスが見つかりません: ${p}`);
      continue;
    }
    if (st.isDirectory()) {
      const names = readdirSync(p)
        .filter((n) => n.toLowerCase().endsWith('.json'))
        .sort();
      for (const n of names) files.push(join(p, n));
    } else {
      files.push(p);
    }
  }
  return files;
}

// ---- 整形ヘルパ ----

function padL(s: string, w: number): string {
  return s.padStart(w);
}

function padR(s: string, w: number): string {
  return s.padEnd(w);
}

function formatPercent(n: number, total: number): string {
  if (total === 0) return '0.0%';
  return `${((n / total) * 100).toFixed(1)}%`;
}

/** 行動の表記: 特技ID(対象r,c) / 特技ID / finish。 */
function formatAction(action: Action): string {
  if (action.type === 'finish') return 'finish';
  if (action.type === 'skill') return action.skillId;
  return `${action.skillId}(${action.anchor.r},${action.anchor.c})`;
}

/** 盤面の残り値(r,c昇順): "r,c:残り" を連結。 */
function formatBoard(state: GameState): string {
  return [...state.cells]
    .sort((a, b) => a.r - b.r || a.c - b.c)
    .map((cell) => `${cell.r},${cell.c}:${cell.base - cell.cumulative}`)
    .join(' ');
}

// ---- 行動の同一性判定 ----
// finish同士 / type:'skill'はskillId一致 / type:'sew'はskillId一致かつ
// 「解決済み対象マス集合(r,c,multiplierをr,c昇順で連結した文字列)」の一致で判定する
// (アンカー自動置換により異なるアンカーが同一対象になり得るため、アンカーの単純比較はしない)。

function targetSetKey(targets: { r: number; c: number; multiplier: number }[]): string {
  return [...targets]
    .sort((a, b) => a.r - b.r || a.c - b.c)
    .map((t) => `${t.r},${t.c},${t.multiplier}`)
    .join(';');
}

function candidateKey(candidate: Candidate): string {
  if (candidate.action.type === 'finish') return 'finish';
  if (candidate.action.type === 'skill') return `skill:${candidate.skillId}`;
  return `sew:${candidate.skillId}|${targetSetKey(candidate.targetCells)}`;
}

/** ユーザー行動の対象解決(候補側と同じ形へ: 存在マスのみ・r,c,multiplier)。 */
function resolveUserSewTargets(
  engine: Engine,
  skill: SkillDef,
  state: GameState,
  anchor: { r: number; c: number },
): { r: number; c: number; multiplier: number }[] {
  const resolved = engine.resolveTargets(skill, anchor, state.rows, state.cols);
  const existing: { r: number; c: number; multiplier: number }[] = [];
  for (const t of resolved) {
    if (engine.cellAt(state, t.r, t.c)) existing.push({ r: t.r, c: t.c, multiplier: t.multiplier });
  }
  return existing;
}

function userActionKey(
  engine: Engine,
  state: GameState,
  skillMap: Map<string, SkillDef>,
  action: Action,
): string {
  if (action.type === 'finish') return 'finish';
  if (action.type === 'skill') return `skill:${action.skillId}`;
  const skill = skillMap.get(action.skillId);
  if (!skill) throw new Error(`不明な特技: ${action.skillId}`);
  const targets = resolveUserSewTargets(engine, skill, state, action.anchor);
  return `sew:${action.skillId}|${targetSetKey(targets)}`;
}

/** scored(score降順ソート済み)の中からユーザー行動と一致する候補の順位(1始まり)を探す。見つからなければ null(候補外)。 */
function findRank(scored: ScoredCandidate[], userKey: string): number | null {
  for (let i = 0; i < scored.length; i++) {
    if (candidateKey(scored[i].candidate) === userKey) return i + 1;
  }
  return null;
}

/** rankExpert の出力(tier昇順→score降順ソート済み)の中からユーザー行動の順位(1始まり)を探す。見つからなければ null(ルール外)。 */
function findExpertRank(choices: ExpertChoice[], userKey: string): number | null {
  for (let i = 0; i < choices.length; i++) {
    if (candidateKey(choices[i].scored.candidate) === userKey) return i + 1;
  }
  return null;
}

/**
 * 一致マーク: 1位=◎ / 2〜3位=○ / 4位以下=数値 / ルール外(rankExpertの禁止候補)=✗ルール外
 * (括弧内に従来のscoreCandidates順位=「素」順位を併記。ルールの過剰プルーンを示すシグナル)。
 */
function agreementMark(rank: number | null, fallbackRank: number | null): string {
  if (rank === null) return `✗ルール外${fallbackRank !== null ? `(素${fallbackRank}位)` : ''}`;
  if (rank === 1) return '◎';
  if (rank <= 3) return '○';
  return String(rank);
}

// ---- 1リプレイの処理 ----

interface Row {
  idx: number;
  turn: number;
  power: string;
  conc: number;
  userText: string;
  userTier: string; // ルール外の場合は '-'
  topText: string;
  topTier: number;
  mark: string;
  rank: number | null;
  board: string;
}

interface ReplayAgreementSummary {
  total: number;
  top1: number;
  top3: number;
  ruleExcluded: number;
  clothType: string;
  massCount: number;
}

function processReplay(
  file: string,
  engine: Engine,
  skillMap: Map<string, SkillDef>,
  recipes: RecipeDef[],
  engineData: EngineData,
  ctxCache: Map<string, SolverContext>,
): ReplayAgreementSummary | null {
  const rule = '-'.repeat(78);
  console.log('='.repeat(78));
  console.log(`ファイル: ${basename(file)}`);

  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    console.error(`読み込みエラー: ${file}: ${(e as Error).message}`);
    return null;
  }

  const parsed = parseReplay(text);
  if (!parsed.ok) {
    console.error(`パースエラー: ${file}: ${parsed.error}`);
    return null;
  }
  const replay = parsed.replay;

  const recipe = recipes.find((r) => r.id === replay.recipeId);
  if (!recipe) {
    console.error(`レシピが見つかりません: ${replay.recipeId} (${file})`);
    return null;
  }

  console.log(`recipeId: ${replay.recipeId} (${recipe.name})`);

  // --- 検証: runReplay で再実行し、check があれば照合する ---
  const verified = runReplay(engine, recipe, replay);
  if (replay.check) {
    const j = engine.judge(verified.final);
    const ok = matchesReplayCheck(replay.check, j, verified.final);
    console.log(
      `check: ${STAR_LABEL[replay.check.star]} 誤差${replay.check.totalError} ${replay.check.turn}ターン → ${ok ? 'OK' : 'NG'}`,
    );
    if (!ok) {
      console.log(
        `  警告: 再実行結果が一致しません(再実行: ${STAR_LABEL[j.star]} 誤差${j.totalError} ${verified.final.turn}ターン)。解析は続行します。`,
      );
    }
  } else {
    console.log('check: なし(検証スキップ)');
  }

  // --- ソルバーコンテキスト(configごとにキャッシュ) ---
  const ctxKey = JSON.stringify(replay.config);
  let ctx = ctxCache.get(ctxKey);
  if (!ctx) {
    ctx = createSolverContext(engine, engineData, replay.config);
    ctxCache.set(ctxKey, ctx);
  }

  // --- ステップ解析: createRng(seed) から独立に再構築し、各行動の直前(beginTurn済み時点)で
  //     rankExpert を実行してユーザーの手の順位を求める(ルール外の場合のみ、参考として
  //     scoreCandidates の素の順位も求める) ---
  const rng = createRng(replay.seed);
  let state = engine.createSession(recipe, replay.config, rng).state;

  const rows: Row[] = [];
  for (let i = 0; i < replay.actions.length; i++) {
    const action = replay.actions[i];
    if (state.finished) break; // 安全弁(finishは末尾に1つのみの想定)

    state = engine.beginTurn(state, rng).state;

    const choices = rankExpert(ctx, state);
    const userKey = userActionKey(engine, state, skillMap, action);
    const rank = findExpertRank(choices, userKey);
    const fallbackRank = rank === null ? findRank(scoreCandidates(ctx, state), userKey) : null;
    const top = choices[0];

    rows.push({
      idx: i + 1,
      turn: state.turn + 1,
      power: state.currentPower,
      conc: state.concentration,
      userText: formatAction(action),
      userTier: rank !== null ? String(choices[rank - 1].tier) : '-',
      topText: formatAction(top.scored.candidate.action),
      topTier: top.tier,
      mark: agreementMark(rank, fallbackRank),
      rank,
      board: formatBoard(state),
    });

    state = engine.applyAction(state, action, replay.config, rng).state;
  }

  // --- 出力: 行動テーブル ---
  console.log(rule);
  console.log(
    `${padL('#', 3)} ${padL('ﾀｰﾝ', 4)} ${padR('パワー', 10)} ${padL('集中力', 6)} ${padR('ユーザーの手', 22)} ${padL('Uティア', 7)} ${padR('ポリシー1位', 22)} ${padL('Pティア', 7)} 一致`,
  );
  for (const row of rows) {
    console.log(
      `${padL(String(row.idx), 3)} ${padL(String(row.turn), 4)} ${padR(row.power, 10)} ${padL(String(row.conc), 6)} ${padR(row.userText, 22)} ${padL(row.userTier, 7)} ${padR(row.topText, 22)} ${padL(String(row.topTier), 7)} ${row.mark}`,
    );
    if (row.rank === null || row.rank >= 4) {
      console.log(`     -> 盤面: ${row.board}  /  ポリシー1位: ${row.topText}`);
    }
  }

  // --- サマリ ---
  const total = rows.length;
  const top1 = rows.filter((r) => r.rank === 1).length;
  const top3 = rows.filter((r) => r.rank !== null && r.rank <= 3).length;
  const ruleExcluded = rows.filter((r) => r.rank === null).length;

  console.log(rule);
  console.log(
    `一致率@1: ${formatPercent(top1, total)}  一致率@3: ${formatPercent(top3, total)}  ルール外: ${ruleExcluded}件  行動数: ${total}`,
  );

  return { total, top1, top3, ruleExcluded, clothType: recipe.clothType, massCount: recipe.cells.length };
}

// ---- セグメント別サマリ(布種別×マス数) ----

interface AgreementSegment {
  clothType: string;
  massCount: number;
  total: number;
  top1: number;
  top3: number;
  ruleExcluded: number;
}

/** リプレイ別集計を clothType×マス数で束ねる。 */
function buildSegments(results: ReplayAgreementSummary[]): AgreementSegment[] {
  const map = new Map<string, AgreementSegment>();
  for (const r of results) {
    const key = `${r.clothType}|${r.massCount}`;
    let seg = map.get(key);
    if (!seg) {
      seg = { clothType: r.clothType, massCount: r.massCount, total: 0, top1: 0, top3: 0, ruleExcluded: 0 };
      map.set(key, seg);
    }
    seg.total += r.total;
    seg.top1 += r.top1;
    seg.top3 += r.top3;
    seg.ruleExcluded += r.ruleExcluded;
  }
  return [...map.values()].sort((a, b) => a.clothType.localeCompare(b.clothType) || a.massCount - b.massCount);
}

function printSegmentSummary(segments: AgreementSegment[]): void {
  const rule = '-'.repeat(78);
  console.log('[セグメント別サマリ] 布種別 × マス数');
  console.log(rule);
  console.log(
    `${padR('布', 8)} ${padL('マス数', 6)} ${padL('行動数', 6)} ${padL('一致率@1', 8)} ${padL('一致率@3', 8)} ${padL('ルール外', 8)}`,
  );
  console.log(rule);
  for (const seg of segments) {
    console.log(
      `${padR(seg.clothType, 8)} ${padL(String(seg.massCount), 6)} ${padL(String(seg.total), 6)} ${padL(formatPercent(seg.top1, seg.total), 8)} ${padL(formatPercent(seg.top3, seg.total), 8)} ${padL(`${seg.ruleExcluded}件`, 8)}`,
    );
  }
  console.log('='.repeat(78));
}

// ---- main ----

function main(): void {
  const argv = process.argv.slice(2);
  const files = collectReplayFiles(argv);
  if (files.length === 0) {
    console.error('処理対象のリプレイファイルがありません。');
    process.exitCode = 1;
    return;
  }

  const params = loadGameParams();
  const needles = loadNeedles();
  const skills = loadSkills();
  const concentration = loadConcentration();
  const recipes = loadRecipes();
  const engineData: EngineData = { params, needles, skills, concentration };
  const engine = new Engine(engineData);
  const skillMap = new Map(engine.listSkills().map((s) => [s.id, s]));
  const ctxCache = new Map<string, SolverContext>();

  console.log(`ソルバー・リプレイ一致率計測: 対象ファイル数=${files.length}`);

  const startedAt = Date.now();

  let processed = 0;
  let sumTotal = 0;
  let sumTop1 = 0;
  let sumTop3 = 0;
  let sumOut = 0;
  const results: ReplayAgreementSummary[] = [];

  for (const file of files) {
    const result = processReplay(file, engine, skillMap, recipes, engineData, ctxCache);
    if (!result) continue;
    processed++;
    results.push(result);
    sumTotal += result.total;
    sumTop1 += result.top1;
    sumTop3 += result.top3;
    sumOut += result.ruleExcluded;
  }

  console.log('='.repeat(78));
  console.log(`[全リプレイ合算] 処理件数=${processed}/${files.length}`);
  console.log(
    `一致率@1: ${formatPercent(sumTop1, sumTotal)}  一致率@3: ${formatPercent(sumTop3, sumTotal)}  ルール外計: ${sumOut}件  行動数計: ${sumTotal}`,
  );
  console.log('='.repeat(78));
  printSegmentSummary(buildSegments(results));

  if (processed < files.length) process.exitCode = 1;

  // 実行時間は実行のたびに変動するため、決定的であるべき stdout ではなく stderr に出す
  // (「同一入力なら stdout が完全一致」という動作確認要件を壊さないため。solver-bench.ts と同じ方針)。
  const elapsedMs = Date.now() - startedAt;
  console.error(`実行時間: ${(elapsedMs / 1000).toFixed(1)}秒`);
}

main();

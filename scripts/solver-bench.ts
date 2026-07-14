// ソルバー用ベンチマークスクリプト: 自己対局 + 損失分解 (SOLVER_DESIGN §S8-④a)。
// 目的: 実機基準設定(奇跡針★3・Lv80・コツ/パッシブ有)で自己対局を回し、
//       レシピ別の★3率・平均誤差評価値・損失分解(縫いすぎ/未完/ゲージ内残し)を計測する。
//       以後のソルバー改善の前後比較の基準値として使う。
//
// 実行: npm run solver:bench (= vite-node scripts/solver-bench.ts)
//       npx vite-node scripts/solver-bench.ts -- --games 50 --seed 1 --recipe <id> --policy expert
// 引数(すべて任意): --games N(レシピあたり試行数、既定50) / --seed S(基準シード、既定1、
//       ゲームiのシード=S+i) / --recipe <id>(指定レシピのみ実行、省略時は全レシピ) /
//       --policy expert|greedy(自己対局の手選択ポリシー、既定 expert)
//
// 決定性: pickExpert・pickGreedy はいずれも決定的(乱数を消費しない静的スコア/ルールの
//       先頭を選ぶだけ)で、各ゲームの乱数もシード固定のため、同一引数なら stdout は
//       完全に同一になる。ただし実行時間は実行のたびに変動するため diff を壊さないよう
//       stderr に出す(「判断に迷った点」参照)。
//
// scripts/ は src 外のためテスト対象外。既存の scripts/recipes-import.ts と同様に
// vite-node で src を直接 import する開発ツール。

import { Engine, createRng, DEFAULT_CONFIG, cellErrorScore } from '../src/core';
import type { SimulatorConfig, GameState, Action } from '../src/core';
import {
  loadGameParams,
  loadNeedles,
  loadSkills,
  loadConcentration,
  loadRecipes,
} from '../src/data';
import type { RecipeDef } from '../src/data';
import { createSolverContext, pickGreedy, pickExpert } from '../src/stats';
import type { SolverContext, ScoredCandidate } from '../src/stats';

// マスの誤差評価値の境界(SOLVER_DESIGN §S8-④a 指定値。game-params.json の
// gauge.yellowRange=4 / gauge.penaltyError=9 と同値だが、ベンチマークの損失分解の
// 区分基準として明示的に固定値で扱う)。
const YELLOW_RANGE = 4;
const PENALTY_ERROR = 9;

const ACTION_LIMIT = 100; // 自己対局1ゲームあたりの行動数上限(無限ループ防止の安全弁)

type Star = 'star3' | 'star2' | 'star1' | 'star0' | 'fail';
const STAR_ORDER: Star[] = ['star3', 'star2', 'star1', 'star0', 'fail'];
const STAR_LABEL: Record<Star, string> = {
  star3: '★3',
  star2: '★2',
  star1: '★1',
  star0: '★0',
  fail: 'fail',
};

// ---- CLI引数 ----

type PolicyName = 'expert' | 'greedy';

interface BenchArgs {
  games: number;
  seed: number;
  recipeId: string | null;
  policy: PolicyName;
}

function parseArgs(argv: string[]): BenchArgs {
  let games = 50;
  let seed = 1;
  let recipeId: string | null = null;
  let policy: PolicyName = 'expert';
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--games') {
      games = Number(argv[++i]);
    } else if (a === '--seed') {
      seed = Number(argv[++i]);
    } else if (a === '--recipe') {
      recipeId = argv[++i];
    } else if (a === '--policy') {
      const v = argv[++i];
      if (v !== 'expert' && v !== 'greedy') {
        throw new Error(`--policy が不正です(expert|greedyのいずれか): ${v}`);
      }
      policy = v;
    }
  }
  if (!Number.isFinite(games) || games <= 0) {
    throw new Error(`--games が不正です: ${games}`);
  }
  if (!Number.isFinite(seed)) {
    throw new Error(`--seed が不正です: ${seed}`);
  }
  return { games, seed, recipeId, policy };
}

/** --policy 指定から候補選択関数を得る。 */
function pickerFor(policy: PolicyName): (ctx: SolverContext, state: GameState) => ScoredCandidate {
  return policy === 'expert' ? pickExpert : pickGreedy;
}

// ---- 集計 ----

interface RecipeStats {
  recipe: RecipeDef;
  games: number;
  starCounts: Record<Star, number>;
  sumTotalError: number;
  sumOversew: number; // 縫いすぎ(remaining<0)の誤差評価値合計
  sumIncomplete: number; // 未完(remaining>4)の誤差評価値合計
  sumInGauge: number; // ゲージ内残し(0<remaining≤4)の誤差評価値合計
  sumActions: number;
  sumConcLeft: number;
  concExhausted: number; // 終局時 残り集中力<10 の回数
  skillUsage: Map<string, number>; // 特技ID → 合算使用回数
  unfinished: number; // 行動数上限で終局しなかった回数(異常検知用)
}

function newRecipeStats(recipe: RecipeDef): RecipeStats {
  return {
    recipe,
    games: 0,
    starCounts: { star3: 0, star2: 0, star1: 0, star0: 0, fail: 0 },
    sumTotalError: 0,
    sumOversew: 0,
    sumIncomplete: 0,
    sumInGauge: 0,
    sumActions: 0,
    sumConcLeft: 0,
    concExhausted: 0,
    skillUsage: new Map(),
    unfinished: 0,
  };
}

interface GameResult {
  star: Star;
  totalError: number;
  oversew: number;
  incomplete: number;
  inGauge: number;
  actions: number;
  concLeft: number;
  skillCounts: Map<string, number>;
  finished: boolean;
}

/** 1ゲームの自己対局(指定ポリシー)を実行し、終局盤面から各種指標を計算する。 */
function playOneGame(
  engine: Engine,
  ctx: SolverContext,
  recipe: RecipeDef,
  config: SimulatorConfig,
  seed: number,
  picker: (ctx: SolverContext, state: GameState) => ScoredCandidate,
): GameResult {
  const rng = createRng(seed);
  const opened = engine.createSession(recipe, config, rng);
  let st: GameState = engine.beginTurn(opened.state, rng).state;
  let actions = 0;
  const skillCounts = new Map<string, number>();

  while (!st.finished && actions < ACTION_LIMIT) {
    const pick = picker(ctx, st);
    const action: Action = pick.candidate.action;
    if (action.type === 'sew' || action.type === 'skill') {
      skillCounts.set(action.skillId, (skillCounts.get(action.skillId) ?? 0) + 1);
    }
    st = engine.applyAction(st, action, config, rng).state;
    actions++;
    if (!st.finished) st = engine.beginTurn(st, rng).state;
  }

  const finished = st.finished;
  const j = engine.judge(st);

  // 損失分解: 終局盤面の各マスを残り値で3区分に分類し、誤差評価値を帰属させる。
  let oversew = 0;
  let incomplete = 0;
  let inGauge = 0;
  for (const cell of st.cells) {
    const remaining = cell.base - cell.cumulative;
    const score = cellErrorScore(remaining, YELLOW_RANGE, PENALTY_ERROR);
    if (remaining < 0) oversew += score;
    else if (remaining > YELLOW_RANGE) incomplete += score;
    else if (remaining > 0) inGauge += score; // 0 < remaining ≤ 4
    // remaining === 0 は誤差0(完全一致)のためどの区分にも計上しない
  }

  return {
    star: j.star,
    totalError: j.totalError,
    oversew,
    incomplete,
    inGauge,
    actions,
    concLeft: st.concentration,
    skillCounts,
    finished,
  };
}

// ---- 出力整形 ----

function formatPercent(n: number, total: number): string {
  if (total === 0) return '0.0%';
  return `${((n / total) * 100).toFixed(1)}%`;
}

function fmtNum(n: number, digits = 2): string {
  return n.toFixed(digits);
}

function padL(s: string, w: number): string {
  return s.padStart(w);
}

function padR(s: string, w: number): string {
  return s.padEnd(w);
}

function printRecipeBlock(stats: RecipeStats, skillNameOf: (id: string) => string): void {
  const r = stats.recipe;
  const g = stats.games;
  const rule = '-'.repeat(72);

  console.log('='.repeat(72));
  console.log(
    `[${r.id}] ${r.name}  (マス数=${r.cells.length} 布=${r.clothType} 誤差制限=${r.errorLimit ? '有' : '無'})`,
  );
  console.log(rule);
  for (const key of STAR_ORDER) {
    const c = stats.starCounts[key];
    console.log(`  ${padR(STAR_LABEL[key], 6)}: ${padL(String(c), 4)}回  (${padL(formatPercent(c, g), 6)})`);
  }
  console.log(rule);
  console.log(`  平均誤差評価値      : ${padL(fmtNum(stats.sumTotalError / g), 6)}`);
  console.log(`    縫いすぎ          : ${padL(fmtNum(stats.sumOversew / g), 6)}`);
  console.log(`    未完              : ${padL(fmtNum(stats.sumIncomplete / g), 6)}`);
  console.log(`    ゲージ内残し      : ${padL(fmtNum(stats.sumInGauge / g), 6)}`);
  console.log(rule);
  console.log(`  平均行動数          : ${padL(fmtNum(stats.sumActions / g, 1), 6)}`);
  console.log(`  平均残り集中力      : ${padL(fmtNum(stats.sumConcLeft / g, 1), 6)}`);
  console.log(`  集中力枯渇率        : ${padL(formatPercent(stats.concExhausted, g), 6)}`);
  console.log(rule);
  console.log('  行動内訳(上位8、平均/ゲーム):');
  const entries = [...stats.skillUsage.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  if (entries.length === 0) {
    console.log('    (使用なし)');
  } else {
    for (const [id, count] of entries) {
      const label = `${id}(${skillNameOf(id)})`;
      console.log(`    ${padR(label, 26)}: ${padL(fmtNum(count / g, 1), 5)}`);
    }
  }
  if (stats.unfinished > 0) {
    console.log(
      `  警告: ${stats.unfinished}/${g} ゲームが行動数上限(${ACTION_LIMIT})で終局しませんでした(その時点の盤面で judge)`,
    );
  }
  console.log('='.repeat(72));
}

function printOverallSummary(allStats: RecipeStats[], totalGames: number): void {
  let star3 = 0;
  let star2 = 0;
  let star1 = 0;
  let star0 = 0;
  let fail = 0;
  let sumErr = 0;
  let sumOver = 0;
  let sumInc = 0;
  let sumIn = 0;
  for (const s of allStats) {
    star3 += s.starCounts.star3;
    star2 += s.starCounts.star2;
    star1 += s.starCounts.star1;
    star0 += s.starCounts.star0;
    fail += s.starCounts.fail;
    sumErr += s.sumTotalError;
    sumOver += s.sumOversew;
    sumInc += s.sumIncomplete;
    sumIn += s.sumInGauge;
  }
  console.log('='.repeat(72));
  console.log(`[全レシピ合算] レシピ数=${allStats.length}  総ゲーム数=${totalGames}`);
  console.log(
    `  ★3率: ${padL(formatPercent(star3, totalGames), 6)}  (★3=${star3} ★2=${star2} ★1=${star1} ★0=${star0} fail=${fail})`,
  );
  console.log(
    `  平均誤差評価値: ${fmtNum(sumErr / totalGames)}  (縫いすぎ=${fmtNum(sumOver / totalGames)} 未完=${fmtNum(sumInc / totalGames)} ゲージ内=${fmtNum(sumIn / totalGames)})`,
  );
  console.log('='.repeat(72));
}

// ---- セグメント別サマリ(布種別×マス数) ----

interface SegmentStats {
  clothType: string;
  massCount: number;
  games: number;
  star3: number;
  sumTotalError: number;
}

/** レシピ別集計を clothType×マス数(cells.length)で束ねる。 */
function buildSegments(allStats: RecipeStats[]): SegmentStats[] {
  const map = new Map<string, SegmentStats>();
  for (const s of allStats) {
    const key = `${s.recipe.clothType}|${s.recipe.cells.length}`;
    let seg = map.get(key);
    if (!seg) {
      seg = { clothType: s.recipe.clothType, massCount: s.recipe.cells.length, games: 0, star3: 0, sumTotalError: 0 };
      map.set(key, seg);
    }
    seg.games += s.games;
    seg.star3 += s.starCounts.star3;
    seg.sumTotalError += s.sumTotalError;
  }
  return [...map.values()].sort((a, b) => a.clothType.localeCompare(b.clothType) || a.massCount - b.massCount);
}

function printSegmentSummary(segments: SegmentStats[]): void {
  const rule = '-'.repeat(72);
  console.log('='.repeat(72));
  console.log('[セグメント別サマリ] 布種別 × マス数');
  console.log(rule);
  console.log(
    `${padR('布', 8)} ${padL('マス数', 6)} ${padL('ゲーム数', 8)} ${padL('★3率', 8)} ${padL('平均誤差', 8)}`,
  );
  console.log(rule);
  for (const seg of segments) {
    console.log(
      `${padR(seg.clothType, 8)} ${padL(String(seg.massCount), 6)} ${padL(String(seg.games), 8)} ${padL(formatPercent(seg.star3, seg.games), 8)} ${padL(fmtNum(seg.sumTotalError / seg.games), 8)}`,
    );
  }
  console.log('='.repeat(72));
}

// ---- main ----

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  const params = loadGameParams();
  const needles = loadNeedles();
  const skills = loadSkills();
  const concentration = loadConcentration();
  const allRecipes = loadRecipes();

  const engine = new Engine({ params, needles, skills, concentration });
  const config: SimulatorConfig = { ...DEFAULT_CONFIG, needle: { type: 'miracle', stars: 3 } };
  // ctx は config ごとに1回だけ構築して全ゲームで使い回す(仕上げテーブルの構築が重いため)。
  const ctx = createSolverContext(engine, { params, needles, skills, concentration }, config);

  const skillNameMap = new Map(skills.skills.map((s) => [s.id, s.name]));
  const skillNameOf = (id: string): string => skillNameMap.get(id) ?? id;

  let targetRecipes: RecipeDef[];
  if (args.recipeId) {
    const found = allRecipes.find((r) => r.id === args.recipeId);
    if (!found) {
      console.error(`レシピが見つかりません: ${args.recipeId}`);
      process.exitCode = 1;
      return;
    }
    targetRecipes = [found];
  } else {
    targetRecipes = allRecipes;
  }

  const picker = pickerFor(args.policy);

  console.log(
    `ソルバー自己対局ベンチマーク: レシピ数=${targetRecipes.length} games/レシピ=${args.games} 基準シード=${args.seed} ポリシー=${args.policy}`,
  );
  console.log(
    `設定: 針=${config.needle.type}★${config.needle.stars} Lv=${config.level} コツ=${config.kotsu} 会心アップ=${config.passives.critUp} 必殺アップ=${config.passives.hissatsuUp}`,
  );
  console.log('');

  const startedAt = Date.now();
  const allStats: RecipeStats[] = [];

  targetRecipes.forEach((recipe, i) => {
    const stats = newRecipeStats(recipe);
    for (let g = 0; g < args.games; g++) {
      const seed = args.seed + g;
      const result = playOneGame(engine, ctx, recipe, config, seed, picker);
      stats.games++;
      stats.starCounts[result.star]++;
      stats.sumTotalError += result.totalError;
      stats.sumOversew += result.oversew;
      stats.sumIncomplete += result.incomplete;
      stats.sumInGauge += result.inGauge;
      stats.sumActions += result.actions;
      stats.sumConcLeft += result.concLeft;
      if (result.concLeft < 10) stats.concExhausted++;
      if (!result.finished) stats.unfinished++;
      for (const [id, c] of result.skillCounts) {
        stats.skillUsage.set(id, (stats.skillUsage.get(id) ?? 0) + c);
      }
    }
    console.log(`done ${i + 1}/${targetRecipes.length}: ${recipe.id}`);
    printRecipeBlock(stats, skillNameOf);
    allStats.push(stats);
  });

  const totalGames = allStats.reduce((sum, s) => sum + s.games, 0);
  printOverallSummary(allStats, totalGames);
  printSegmentSummary(buildSegments(allStats));

  // 実行時間は実行のたびに変動するため、決定的であるべき stdout ではなく stderr に出す
  // (「同一引数なら stdout が完全一致」という動作確認要件を壊さないため)。
  const elapsedMs = Date.now() - startedAt;
  console.error(`実行時間: ${(elapsedMs / 1000).toFixed(1)}秒`);
}

main();

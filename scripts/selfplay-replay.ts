// ソルバー自己対局→リプレイJSON出力ツール (コーチング用途)。
// 目的: エキスパートポリシー(pickExpert)による自己対局1ゲームを実行し、選択した行動列を
//       ブラウザUIのリプレイビューアで読み込める ReplayData v:1 形式のJSONとして出力する。
//       人間のエキスパートがソルバーの手順(の各手)をリプレイビューアで検分するためのツール。
//
// 実行: npm run selfplay:replay -- --recipe <id> [--seed N] [--out <path>]
//       npx vite-node scripts/selfplay-replay.ts -- --recipe reppu_koromo_shita --seed 1
// 引数: --recipe <id>(必須。省略時は使い方をstderrに出し exit 1) / --seed N(任意、既定1) /
//       --out <path>(任意。指定時はリプレイJSONを当該パスへも書き出す)
//
// 決定性: pickExpert は決定的(乱数を消費しない静的スコアの先頭を選ぶだけ)で、ゲームの乱数も
//       シード固定のため、同一引数なら stdout(リプレイJSON1行)は完全に同一になる。
//       乱数消費順は scripts/solver-bench.ts の playOneGame と完全に同一(createRng(seed)→
//       engine.createSession→engine.beginTurn→ループ{pickExpert→applyAction→未終了なら
//       beginTurn})にすること(ARCHITECTURE A4「乱数消費順は変更厳禁」、T12「beginTurn→
//       applyAction順」の保証に合わせるため)。ACTION_LIMIT=100 の安全弁も solver-bench.ts と
//       同値(自己対局の無限ループ防止。上限到達時はstderrに警告し、その時点の盤面でjudgeする)。
//
// scripts/ は src 外のためテスト対象外。既存の scripts/solver-bench.ts と同様に vite-node で
// src を直接 import する開発ツール。

import { writeFileSync } from 'node:fs';
import { Engine, createRng, DEFAULT_CONFIG, makeReplayCheck, serializeReplay } from '../src/core';
import type { Action, GameState, ReplayData, SimulatorConfig } from '../src/core';
import {
  loadGameParams,
  loadNeedles,
  loadSkills,
  loadConcentration,
  loadRecipes,
} from '../src/data';
import type { RecipeDef } from '../src/data';
import { createSolverContext, pickExpert } from '../src/stats';
import type { SolverContext } from '../src/stats';

const ACTION_LIMIT = 100; // 自己対局1ゲームあたりの行動数上限(無限ループ防止の安全弁。solver-bench.ts と同値)

const USAGE = '使い方: npm run selfplay:replay -- --recipe <id> [--seed N] [--out <path>]';

// ---- CLI引数 ----

interface CliArgs {
  recipeId: string;
  seed: number;
  outPath: string | null;
}

function parseArgs(argv: string[]): CliArgs {
  let recipeId: string | null = null;
  let seed = 1;
  let outPath: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--recipe') {
      recipeId = argv[++i];
    } else if (a === '--seed') {
      seed = Number(argv[++i]);
    } else if (a === '--out') {
      outPath = argv[++i];
    }
  }
  if (!recipeId) {
    console.error(USAGE);
    process.exit(1);
  }
  if (!Number.isFinite(seed)) {
    console.error(`--seed が不正です: ${seed}`);
    process.exit(1);
  }
  return { recipeId, seed, outPath };
}

// ---- 自己対局 ----

interface SelfplayResult {
  state: GameState;
  actions: Action[];
  hitLimit: boolean; // 行動数上限到達で打ち切ったか(異常検知用)
}

/**
 * エキスパートポリシー(pickExpert)で1ゲーム自己対局し、選んだ行動列を記録する。
 * 乱数消費順は solver-bench.ts の playOneGame と完全に同一(createRng→createSession→
 * beginTurn→ループ{pickExpert→applyAction→未終了ならbeginTurn})。pickExpert は決定的で
 * セッション乱数を消費しないため、この順序を守る限りリプレイ再現性(ARCHITECTURE A4)が
 * 保たれる。
 */
function playSelfplayGame(
  engine: Engine,
  ctx: SolverContext,
  recipe: RecipeDef,
  config: SimulatorConfig,
  seed: number,
): SelfplayResult {
  const rng = createRng(seed);
  const opened = engine.createSession(recipe, config, rng);
  let st: GameState = engine.beginTurn(opened.state, rng).state;
  const actions: Action[] = [];

  while (!st.finished && actions.length < ACTION_LIMIT) {
    const pick = pickExpert(ctx, st);
    const action: Action = pick.candidate.action;
    actions.push(action);
    st = engine.applyAction(st, action, config, rng).state;
    if (!st.finished) st = engine.beginTurn(st, rng).state;
  }

  return { state: st, actions, hitLimit: !st.finished };
}

// ---- main ----

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  const params = loadGameParams();
  const needles = loadNeedles();
  const skills = loadSkills();
  const concentration = loadConcentration();
  const allRecipes = loadRecipes();

  const recipe = allRecipes.find((r) => r.id === args.recipeId);
  if (!recipe) {
    console.error(`レシピが見つかりません: ${args.recipeId}`);
    process.exit(1);
  }

  const engine = new Engine({ params, needles, skills, concentration });
  const config: SimulatorConfig = { ...DEFAULT_CONFIG, needle: { type: 'miracle', stars: 3 } };
  // ctx は自己対局1回分のみのため使い回しは不要だが、solver-bench.ts と同じ組み立て方に揃える。
  const ctx = createSolverContext(engine, { params, needles, skills, concentration }, config);

  const { state, actions, hitLimit } = playSelfplayGame(engine, ctx, recipe, config, args.seed);
  if (hitLimit) {
    console.error(
      `警告: 行動数上限(${ACTION_LIMIT})に到達しゲームが終局しませんでした(その時点の盤面でjudge)`,
    );
  }

  const judge = engine.judge(state);
  const check = makeReplayCheck(judge, state);
  const replay: ReplayData = {
    v: 1,
    seed: args.seed,
    recipeId: recipe.id,
    config,
    actions,
    check,
  };
  const json = serializeReplay(replay);

  // stdout: リプレイJSON1行のみ(決定的。パイプ・リダイレクトでそのまま利用できるよう他の出力を混ぜない)
  console.log(json);

  if (args.outPath) {
    writeFileSync(args.outPath, json + '\n', 'utf8');
  }

  // stderr: 人間向けサマリ(stdoutの決定性を壊さないためこちらに出す。solver-bench.ts と同じ方針)
  console.error(
    `[${recipe.id}] ${recipe.name}  seed=${args.seed}  判定=${judge.star}  誤差=${judge.totalError}  ` +
      `ターン数=${state.turn}  行動数=${actions.length}  残り集中力=${state.concentration}`,
  );
}

main();

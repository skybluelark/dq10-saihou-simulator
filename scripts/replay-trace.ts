// リプレイ完全トレース (再現不一致の診断・コーチング用ツール)
//
// 実行: npm run replay:trace -- data/replays/foo.json
// 出力: 各ターンの開始イベント(？抽選・発光・再生回復・集中自動回復)→開始後盤面→
//       行動→結果イベント(マス別ダメージ・会心・頭打ち等。JSONそのまま)→行動後盤面。
//       最後に判定と check の照合結果。
// 決定性: シード再構築のみ。同一入力なら stdout は完全同一。
// 乱数整合: solver-agreement.ts と同じ「beginTurn→applyAction」順(T12保証)を守る。

import * as fs from 'node:fs';
import { Engine, createRng } from '../src/core';
import type { Action, GameState, SimulatorConfig } from '../src/core';
import { loadGameParams, loadNeedles, loadSkills, loadConcentration, loadRecipes } from '../src/data';

interface ReplayFile {
  seed: number;
  recipeId: string;
  config: SimulatorConfig;
  actions: Action[];
  check?: { star: string; totalError: number; turn: number };
}

const fileArg = process.argv[2];
if (!fileArg) {
  console.error('使い方: npm run replay:trace -- <リプレイJSONパス>');
  process.exit(1);
}

const replay = JSON.parse(fs.readFileSync(fileArg, 'utf8')) as ReplayFile;
const params = loadGameParams();
const engine = new Engine({
  params,
  needles: loadNeedles(),
  skills: loadSkills(),
  concentration: loadConcentration(),
});
const recipe = loadRecipes().find((r) => r.id === replay.recipeId);
if (!recipe) throw new Error(`不明なレシピ: ${replay.recipeId}`);

const fmtBoard = (s: GameState): string =>
  s.cells
    .map((c) => `${c.r},${c.c}:${c.base - c.cumulative}${c.shitsuke ? 'し' : ''}`)
    .join('  ');

const describeAction = (a: Action): string => {
  if (a.type === 'finish') return 'finish';
  if (a.type === 'skill') return a.skillId;
  return `${a.skillId}(${a.anchor.r},${a.anchor.c})`;
};

console.log(`リプレイ: ${fileArg}`);
console.log(`recipeId: ${replay.recipeId}  seed: ${replay.seed}  布: ${recipe.clothType}`);

const rng = createRng(replay.seed);
let state = engine.createSession(recipe, replay.config, rng).state;

for (const action of replay.actions) {
  if (state.finished) break;

  const bt = engine.beginTurn(state, rng);
  state = bt.state;
  console.log(`\n--- ターン${state.turn + 1} (集中${state.concentration}) ---`);
  for (const e of bt.events) console.log(`  [開始] ${JSON.stringify(e)}`);
  console.log(`  盤面: ${fmtBoard(state)}`);

  const res = engine.applyAction(state, action, replay.config, rng);
  console.log(`  行動: ${describeAction(action)}`);
  for (const e of res.events) console.log(`  [結果] ${JSON.stringify(e)}`);
  state = res.state;
  console.log(`  後盤面: ${fmtBoard(state)} 集中=${state.concentration}`);
}

const result = engine.judge(state);
console.log(`\n最終判定: ${result.star} 誤差${result.totalError} (${state.turn}ターン)`);
if (replay.check) {
  const ok =
    result.star === replay.check.star &&
    result.totalError === replay.check.totalError &&
    state.turn === replay.check.turn;
  console.log(
    `check照合: ${ok ? 'OK' : 'NG'} (期待: ${replay.check.star} 誤差${replay.check.totalError} ${replay.check.turn}ターン)`,
  );
}

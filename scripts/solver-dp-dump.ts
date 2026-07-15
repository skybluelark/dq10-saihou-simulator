// 調整厳密DPの決定表・分岐木ダンプ (SOLVER_POLICY §10.10 検証ツール)
//
// 目的: エキスパートの終盤定石(E1/§10.10)と厳密DPの突き合わせ。目的関数
//       (expErr=期待誤差最小 / pZero=誤差0率最大 / pLe1=誤差1以内率最大)と
//       ロック維持償却(lockUpkeep)を切り替え、「残数値×使える集中力→最適初手」
//       の決定表と、初手の出目ごとの後続手(分岐木)を出力する。
// 実行: npm run solver:dp (= vite-node scripts/solver-dp-dump.ts)
// 決定性: 乱数なし。同一データ・同一実装なら stdout は完全に同一。

import { DEFAULT_CONFIG, sewDamage, hogushiDamage, computeCritRate } from '../src/core';
import type { SimulatorConfig, SkillDef } from '../src/core';
import { loadGameParams, loadNeedles, loadSkills, loadConcentration } from '../src/data';
import { buildAdjustDp, adjustLookup } from '../src/stats/adjust-dp';
import type { AdjustDp, AdjustObjective } from '../src/stats/adjust-dp';
import { DEFAULT_ADJUST_DP_PARAMS } from '../src/stats/types';

const params = loadGameParams();
const needles = loadNeedles();
const skills = loadSkills();
const concentration = loadConcentration();
const data = { params, needles, skills, concentration };
const config: SimulatorConfig = { ...DEFAULT_CONFIG, needle: { type: 'miracle', stars: 3 } };

const needle = needles.needles.find((n) => n.id === config.needle.type);
if (!needle) throw new Error(`不明な針: ${config.needle.type}`);
const critBase = {
  needleCritRate: needle.critRate[config.needle.stars],
  kotsu: config.kotsu,
  passiveCritUp: config.passives.critUp,
  rainbowCritTurn: false,
  lightGlowCell: false,
  mugaActive: false,
  shiftCrit: false,
};
const pNormal = computeCritRate(params, { ...critBase, aim: false });
const pAim = computeCritRate(params, { ...critBase, aim: true });

const OBJECTIVES: AdjustObjective[] = ['expErr', 'pZero', 'pLe1'];
const UPKEEPS = [3.5, 0]; // 3.5 = 既定(統一7÷純増2手。§10.8②)、0 = 素の集中(定石照合用)

const dps = new Map<string, AdjustDp>();
for (const upkeep of UPKEEPS) {
  for (const obj of OBJECTIVES) {
    dps.set(
      `${upkeep}|${obj}`,
      buildAdjustDp(data, config, { ...DEFAULT_ADJUST_DP_PARAMS, lockUpkeep: upkeep }, obj),
    );
  }
}

const opName = (id: string | null): string =>
  id === null ? '打ち止め' : (skills.skills.find((s) => s.id === id)?.name ?? id);
const fmtR = (r: number): string => (r >= 0 ? `+${r}` : `${r}`);

// ---- 参考: 弱パワー(補正1)の単発出目表 ----
console.log('== 弱パワー・補正1の出目(基礎値12〜18) ==');
console.log(`会心率: 通常 ${(pNormal * 100).toFixed(1)}% / ねらい ${(pAim * 100).toFixed(1)}% (奇跡針★3・コツ・パッシブ)`);
for (const s of skills.skills) {
  if (s.kind === 'sew' && s.target === 'single') {
    const vals: number[] = [];
    for (let bv = 12; bv <= 18; bv++) vals.push(sewDamage(bv, s.multiplier ?? 1, 'weak', 1));
    console.log(`  ${s.name}(コスト${s.cost}): {${vals.join(',')}}`);
  }
}
{
  const vals: number[] = [];
  for (let roll = 6; roll <= 9; roll++) vals.push(-hogushiDamage(-roll, 'weak', 1));
  const hog = skills.skills.find((s) => s.kind === 'recover');
  console.log(`  ${hog?.name}(コスト${hog?.cost}): 回復 {${vals.join(',')}}`);
}

// ---- 決定表 ----
function decisionRanges(dp: AdjustDp, r: number, bMax: number): string {
  const parts: string[] = [];
  let start = 0;
  let cur = adjustLookup(dp, r, 0, false).firstOp;
  for (let b = 1; b <= bMax; b++) {
    const op = adjustLookup(dp, r, b, false).firstOp;
    if (op !== cur) {
      parts.push(`${start}〜${b - 1}:${opName(cur)}`);
      start = b;
      cur = op;
    }
  }
  parts.push(`${start}〜:${opName(cur)}`);
  return parts.join(' / ');
}

const TABLE_RS = [12, 11, 10, 8, 7, 6, 5, 4, 3, 2, -2, -3];
for (const upkeep of UPKEEPS) {
  console.log(`\n== 決定表(弱ロック中・しつけ無し・lockUpkeep=${upkeep}。b=そのマスに使える集中力) ==`);
  for (const r of TABLE_RS) {
    console.log(`r=${fmtR(r)}`);
    for (const obj of OBJECTIVES) {
      const dp = dps.get(`${upkeep}|${obj}`);
      if (!dp) continue;
      console.log(`  ${obj.padEnd(6)}: ${decisionRanges(dp, r, 44)}`);
    }
  }
}

// ---- 損益分岐: r=+2 のほぐしルート ----
console.log('\n== r=+2 ほぐしルートの損益分岐(firstOp=糸ほぐしになる最小b) ==');
for (const upkeep of UPKEEPS) {
  for (const obj of OBJECTIVES) {
    const dp = dps.get(`${upkeep}|${obj}`);
    if (!dp) continue;
    let found = -1;
    for (let b = 0; b <= dp.params.budgetMax; b++) {
      if (adjustLookup(dp, 2, b, false).firstOp === 'ito_hogushi') {
        found = b;
        break;
      }
    }
    console.log(`  lockUpkeep=${upkeep} ${obj.padEnd(6)}: ${found === -1 ? '出現せず' : `b=${found}`}`);
  }
}

// ---- 分岐木 ----
type Outcome = { r: number; prob: number };

function outcomesOf(op: SkillDef, r: number, correction: 1 | 2): Outcome[] {
  const map = new Map<number, number>();
  const add = (rr: number, w: number): void => {
    map.set(rr, (map.get(rr) ?? 0) + w);
  };
  if (op.kind === 'recover') {
    for (let roll = 6; roll <= 9; roll++) add(r - hogushiDamage(-roll, 'weak', correction), 1 / 4);
  } else {
    const mult = op.multiplier ?? 1;
    const p = op.aim === true ? pAim : pNormal;
    for (let bv = 12; bv <= 18; bv++) {
      const d0 = sewDamage(bv, mult, 'weak', correction);
      if (r > 0) {
        add(r - Math.min(d0 * 2, r), (1 / 7) * p);
        add(r - d0, (1 / 7) * (1 - p));
      } else {
        add(r - d0, 1 / 7);
      }
    }
  }
  return [...map.entries()].map(([rr, prob]) => ({ r: rr, prob })).sort((a, b) => b.r - a.r);
}

function printTree(key: string, r: number, b: number, depth: number, indent: string, s: 0 | 1): void {
  const dp = dps.get(key);
  if (!dp) return;
  const entry = adjustLookup(dp, r, b, s === 1);
  console.log(
    `${indent}r=${fmtR(r)}, b=${b}${s === 1 ? ', しつけ済' : ''}: ` +
      `${opName(entry.firstOp)}  (exp誤差${entry.expErr.toFixed(2)} / p0=${(entry.pZero * 100).toFixed(1)}% / p≤1=${(entry.pLe1 * 100).toFixed(1)}%)`,
  );
  if (entry.firstOp === null || depth <= 0) return;
  const op = skills.skills.find((sk) => sk.id === entry.firstOp);
  if (!op) return;
  const bLeft = b - ((op.cost ?? 0) + dp.params.lockUpkeep);
  if (op.effect === 'cellCorrection') {
    printTree(key, r, bLeft, depth - 1, indent + '    ', 1);
    return;
  }
  const correction: 1 | 2 = s === 1 ? 2 : 1;
  for (const o of outcomesOf(op, r, correction)) {
    console.log(`${indent}  ${(o.prob * 100).toFixed(1).padStart(5)}% → 残${fmtR(o.r)}`);
    if (o.r !== 0 && depth > 1) printTree(key, o.r, bLeft, depth - 1, indent + '      ', 0);
  }
}

function treeSection(title: string, key: string, r: number, b: number, depth: number): void {
  console.log(`\n== 分岐木: ${title} [lockUpkeep=${key.split('|')[0]}, obj=${key.split('|')[1]}] ==`);
  printTree(key, r, b, depth, '  ', 0);
}

// r=+2: ほぐし→(+3/+4)→かげん/半かげんの分岐(ユーザー質問の検証)
treeSection('r=+2, b=28(=ほぐし16+半かげん12。定石値)', '0|expErr', 2, 28, 3);
treeSection('r=+2, b=28', '0|pLe1', 2, 28, 3);
treeSection('r=+2, b=35(償却+3.5/手込みの等価予算)', '3.5|expErr', 2, 35, 3);
// r=7/8: ねらい vs ぬう→ほぐし連鎖(目的関数で最適が入れ替わるか)
treeSection('r=+7, b=40(予算潤沢)', '0|pZero', 7, 40, 2);
treeSection('r=+7, b=40(予算潤沢)', '0|pLe1', 7, 40, 2);
treeSection('r=+8, b=40(予算潤沢)', '0|pLe1', 8, 40, 2);
// r=10: かげんスタート定石と集中依存の分岐(ユーザー実戦: 15集中でぬうスタート)
treeSection('r=+10, b=15(ぬう+かげん分のみ)', '0|pLe1', 10, 15, 2);
treeSection('r=+10, b=22(かげん+半かげん分のみ)', '0|pLe1', 10, 22, 2);
treeSection('r=+10, b=40(予算潤沢)', '0|pLe1', 10, 40, 2);

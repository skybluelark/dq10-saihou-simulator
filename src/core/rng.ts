// 乱数設計 (ARCHITECTURE A4)
// 注入式 Rng インターフェース + シード指定可能な mulberry32 実装。

export interface Rng {
  /** [0, 1) の一様乱数。 */
  next(): number;
  /** [0, max) の整数。 */
  nextInt(max: number): number;
  /** 現在の内部状態(スナップショット/複製用)。 */
  getState(): number;
}

/** mulberry32 PRNG(32bit状態、シード指定可)。 */
export class Mulberry32 implements Rng {
  private state: number;

  constructor(seed: number) {
    // 状態は符号なし32bitとして扱う
    this.state = seed >>> 0;
  }

  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  nextInt(max: number): number {
    return Math.floor(this.next() * max);
  }

  getState(): number {
    return this.state >>> 0;
  }
}

/** シードから Rng を作る。 */
export function createRng(seed: number): Rng {
  return new Mulberry32(seed);
}

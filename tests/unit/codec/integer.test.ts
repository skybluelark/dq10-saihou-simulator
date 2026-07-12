import { describe, it, expect } from 'vitest';
import { ConfigCodec, type ConfigJsonSchema } from '../../../src/core/codec/index';

// リプレイコードの乱数シード(0〜2^32-1)を想定した整数レンジフィールド。
const seedSchema: ConfigJsonSchema = {
  type: 'object',
  properties: {
    seed: { type: 'integer', minimum: 0, maximum: 2 ** 32 - 1 },
  },
};

describe('integer range fields', () => {
  it('computes the combination count as maximum - minimum + 1', () => {
    const codec = new ConfigCodec(seedSchema);
    expect(codec.combinationCount).toBe(2n ** 32n);
  });

  it('round-trips the minimum, maximum, and a mid-range value', () => {
    const codec = new ConfigCodec(seedSchema);
    for (const seed of [0, 2 ** 32 - 1, 123456789]) {
      expect(codec.decode(codec.encode({ seed }))).toEqual({ seed });
    }
  });

  it('round-trips a batch of scattered values across the full range without hanging', () => {
    // 2^32レンジを値ごとにループしていたら現実的な時間で終わらない。
    // この程度の件数がテストのタイムアウト内に即座に終わることが、O(1)実装の間接的な確認になる。
    const codec = new ConfigCodec(seedSchema);
    const seeds = [0, 1, 2 ** 31, 2 ** 32 - 2, 2 ** 32 - 1, 4242424242, 1000000007];
    for (const seed of seeds) {
      expect(codec.decode(codec.encode({ seed }))).toEqual({ seed });
    }
  });

  it('round-trips when mixed with enum and array fields', () => {
    const schema: ConfigJsonSchema = {
      type: 'object',
      properties: {
        mode: { enum: ['easy', 'normal', 'hard'] },
        seed: { type: 'integer', minimum: 0, maximum: 2 ** 32 - 1 },
        buffs: {
          type: 'array',
          maxItems: 2,
          items: { type: 'object', properties: { kind: { enum: ['atk', 'def'] } } },
        },
      },
    };
    const codec = new ConfigCodec(schema);
    const config = {
      mode: 'hard' as const,
      seed: 4000000000,
      buffs: [{ kind: 'atk' }, { kind: 'def' }],
    };
    expect(codec.decode(codec.encode(config))).toEqual(config);
  });

  it('supports a narrow integer range alongside other fields (min===max degenerate case)', () => {
    const schema: ConfigJsonSchema = {
      type: 'object',
      properties: {
        fixed: { type: 'integer', minimum: 7, maximum: 7 },
        mode: { enum: ['a', 'b'] },
      },
    };
    const codec = new ConfigCodec(schema);
    expect(codec.combinationCount).toBe(2n);
    const config = { fixed: 7, mode: 'b' as const };
    expect(codec.decode(codec.encode(config))).toEqual(config);
  });

  it('rejects an encode value outside the declared range', () => {
    const codec = new ConfigCodec(seedSchema);
    expect(() => codec.encode({ seed: -1 })).toThrow(/out of range/);
    expect(() => codec.encode({ seed: 2 ** 32 })).toThrow(/out of range/);
  });

  it('rejects a non-integer encode value', () => {
    const codec = new ConfigCodec(seedSchema);
    expect(() => codec.encode({ seed: 1.5 })).toThrow(/out of range/);
  });

  it('rejects minimum > maximum at construction time', () => {
    const bad: ConfigJsonSchema = {
      type: 'object',
      properties: { seed: { type: 'integer', minimum: 10, maximum: 5 } },
    };
    expect(() => new ConfigCodec(bad)).toThrow(/minimum/);
  });

  it('rejects non-integer minimum/maximum at construction time', () => {
    const badMin: ConfigJsonSchema = {
      type: 'object',
      properties: { seed: { type: 'integer', minimum: 0.5, maximum: 5 } },
    };
    expect(() => new ConfigCodec(badMin)).toThrow(/safe integer/);

    const badMax: ConfigJsonSchema = {
      type: 'object',
      properties: { seed: { type: 'integer', minimum: 0, maximum: Number.NaN } },
    };
    expect(() => new ConfigCodec(badMax)).toThrow(/safe integer/);
  });

  it('rejects dependsOn that targets an integer field', () => {
    const bad: ConfigJsonSchema = {
      type: 'object',
      properties: {
        seed: { type: 'integer', minimum: 0, maximum: 2 ** 32 - 1 },
        note: { dependsOn: 'seed', cases: { '0': ['x'] } },
      },
    };
    expect(() => new ConfigCodec(bad)).toThrow(/cannot depend on integer field/);
  });
});

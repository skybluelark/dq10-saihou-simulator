import { describe, it, expect } from 'vitest';
import { ConfigCodec, type ConfigJsonSchema } from '../../../src/core/codec/index';

// buffs: 0〜3個、各要素は kind(3択) + power(2択) の独立な項目。
const schema: ConfigJsonSchema = {
  type: 'object',
  properties: {
    buffs: {
      type: 'array',
      minItems: 0,
      maxItems: 3,
      items: {
        type: 'object',
        properties: {
          kind: { enum: ['atk', 'def', 'spd'] },
          power: { enum: [1, 2] },
        },
      },
    },
  },
};

describe('list (array) fields', () => {
  it('counts combinations as a geometric sum over item counts', () => {
    const codec = new ConfigCodec(schema);
    // itemCombos = 3*2 = 6. sum_{L=0}^{3} 6^L = 1 + 6 + 36 + 216 = 259
    expect(codec.combinationCount).toBe(259n);
  });

  it('round-trips empty, single, and max-length arrays', () => {
    const codec = new ConfigCodec(schema);
    const cases = [
      { buffs: [] },
      { buffs: [{ kind: 'atk', power: 1 }] },
      { buffs: [{ kind: 'atk', power: 1 }, { kind: 'def', power: 2 }] },
      {
        buffs: [
          { kind: 'atk', power: 1 },
          { kind: 'def', power: 2 },
          { kind: 'spd', power: 2 },
        ],
      },
    ];
    for (const c of cases) {
      expect(codec.decode(codec.encode(c))).toEqual(c);
    }
  });

  it('preserves item order (order matters, not just multiset)', () => {
    const codec = new ConfigCodec(schema);
    const a = { buffs: [{ kind: 'atk', power: 1 }, { kind: 'def', power: 2 }] };
    const b = { buffs: [{ kind: 'def', power: 2 }, { kind: 'atk', power: 1 }] };
    expect(codec.encode(a)).not.toBe(codec.encode(b));
    expect(codec.decode(codec.encode(a))).toEqual(a);
    expect(codec.decode(codec.encode(b))).toEqual(b);
  });

  it('rejects arrays outside the min/max length range', () => {
    const codec = new ConfigCodec(schema);
    const tooLong = {
      buffs: [
        { kind: 'atk', power: 1 },
        { kind: 'atk', power: 1 },
        { kind: 'atk', power: 1 },
        { kind: 'atk', power: 1 },
      ],
    };
    expect(() => codec.encode(tooLong)).toThrow(/must be an array/);
  });

  it('rejects an invalid value inside an item', () => {
    const codec = new ConfigCodec(schema);
    expect(() => codec.encode({ buffs: [{ kind: 'unknown', power: 1 }] })).toThrow();
  });

  it('supports conditional (dependsOn) fields inside the item schema', () => {
    const nested: ConfigJsonSchema = {
      type: 'object',
      properties: {
        buffs: {
          type: 'array',
          maxItems: 2,
          items: {
            type: 'object',
            properties: {
              kind: { enum: ['atk', 'def', 'spd'] },
              target: {
                dependsOn: 'kind',
                cases: { atk: ['enemy'], def: ['self'], spd: ['self', 'party'] },
              },
            },
          },
        },
      },
    };
    const codec = new ConfigCodec(nested);
    // itemCombos = 1(atk)+1(def)+2(spd) = 4. sum_{L=0}^{2} 4^L = 1+4+16 = 21
    expect(codec.combinationCount).toBe(21n);

    const config = { buffs: [{ kind: 'spd', target: 'party' }, { kind: 'atk', target: 'enemy' }] };
    expect(codec.decode(codec.encode(config))).toEqual(config);
    expect(() => codec.encode({ buffs: [{ kind: 'atk', target: 'self' }] })).toThrow();
  });

  it('rejects dependsOn that targets an array field', () => {
    const bad: ConfigJsonSchema = {
      type: 'object',
      properties: {
        buffs: { type: 'array', maxItems: 1, items: { type: 'object', properties: { kind: { enum: ['atk'] } } } },
        note: { dependsOn: 'buffs', cases: { x: ['y'] } },
      },
    };
    expect(() => new ConfigCodec(bad)).toThrow(/cannot depend on array field/);
  });
});

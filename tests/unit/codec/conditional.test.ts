import { describe, it, expect } from 'vitest';
import { ConfigCodec, type ConfigJsonSchema } from '../../../src/core/codec/index';

// fieldA=x2 のときだけ fieldB の選択肢が1個に絞られる例。
const schema: ConfigJsonSchema = {
  type: 'object',
  properties: {
    fieldA: { enum: ['x1', 'x2', 'x3'] },
    fieldB: {
      dependsOn: 'fieldA',
      cases: {
        x1: ['p', 'q'],
        x2: ['p'],
        x3: ['p', 'q', 'r'],
      },
    },
  },
};

describe('conditional fields', () => {
  it('counts only the reachable combinations, not the full cartesian product', () => {
    const codec = new ConfigCodec(schema);
    // 独立掛け算なら 3*3=9 だが、実際は 2+1+3=6 通りしかない
    expect(codec.combinationCount).toBe(6n);
  });

  it('round-trips every reachable combination', () => {
    const codec = new ConfigCodec(schema);
    const cases: Array<{ fieldA: string; fieldB: string }> = [
      { fieldA: 'x1', fieldB: 'p' },
      { fieldA: 'x1', fieldB: 'q' },
      { fieldA: 'x2', fieldB: 'p' },
      { fieldA: 'x3', fieldB: 'p' },
      { fieldA: 'x3', fieldB: 'q' },
      { fieldA: 'x3', fieldB: 'r' },
    ];
    for (const c of cases) {
      expect(codec.decode(codec.encode(c))).toEqual(c);
    }
  });

  it('rejects a value that is not valid for the resolved context', () => {
    const codec = new ConfigCodec(schema);
    // fieldA=x2 のときは fieldB='q' は無効
    expect(() => codec.encode({ fieldA: 'x2', fieldB: 'q' })).toThrow();
  });

  it('falls back to default when no case matches, and throws when neither is present', () => {
    const withDefault: ConfigJsonSchema = {
      type: 'object',
      properties: {
        fieldA: { enum: ['x1', 'x2'] },
        fieldB: { dependsOn: 'fieldA', cases: { x1: ['p'] }, default: ['q', 'r'] },
      },
    };
    const codec = new ConfigCodec(withDefault);
    expect(codec.decode(codec.encode({ fieldA: 'x2', fieldB: 'q' }))).toEqual({ fieldA: 'x2', fieldB: 'q' });

    const withoutDefault: ConfigJsonSchema = {
      type: 'object',
      properties: {
        fieldA: { enum: ['x1', 'x2'] },
        fieldB: { dependsOn: 'fieldA', cases: { x1: ['p'] } },
      },
    };
    const codec2 = new ConfigCodec(withoutDefault);
    expect(() => codec2.encode({ fieldA: 'x2', fieldB: 'q' })).toThrow(/no case/);
  });

  it('rejects a forward reference (dependsOn a field declared later)', () => {
    const bad: ConfigJsonSchema = {
      type: 'object',
      properties: {
        fieldB: { dependsOn: 'fieldA', cases: { x1: ['p'] } },
        fieldA: { enum: ['x1'] },
      },
    };
    expect(() => new ConfigCodec(bad)).toThrow(/declared after/);
  });
});

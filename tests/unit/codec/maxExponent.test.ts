import { describe, it, expect } from 'vitest';
import { ConfigCodec, type ConfigJsonSchema } from '../../../src/core/codec/index';

// enum長200の項目を33個並べる: 200^33 ≈ 8.6e75 のオーダー(実際の想定である10^78付近を再現)
function bigSchema(fieldCount: number, enumSize: number): ConfigJsonSchema {
  const properties: ConfigJsonSchema['properties'] = {};
  for (let i = 0; i < fieldCount; i++) {
    properties[`f${i}`] = { enum: Array.from({ length: enumSize }, (_, v) => v) };
  }
  return { type: 'object', properties };
}

describe('maxExponent (combination-count sanity check)', () => {
  it('accepts a ~10^78-scale schema with the new default (128)', () => {
    const schema = bigSchema(33, 200); // 200^33 ~ 8.6e75
    const codec = new ConfigCodec(schema); // should not throw with default maxExponent=128
    expect(codec.combinationCount > 10n ** 75n).toBe(true);

    const config: Record<string, number> = {};
    for (let i = 0; i < 33; i++) config[`f${i}`] = 199;
    expect(codec.decode(codec.encode(config))).toEqual(config);
  });

  it('still throws for an intentionally tiny maxExponent, and the message names the option', () => {
    const schema = bigSchema(33, 200);
    expect(() => new ConfigCodec(schema, { maxExponent: 10 })).toThrow(/maxExponent/);
  });

  it('supports raising maxExponent further for even larger schemas', () => {
    const schema = bigSchema(40, 200); // 200^40, larger than the 128-exponent default's headroom is still fine, but check a very large explicit bound works
    const codec = new ConfigCodec(schema, { maxExponent: 300 });
    expect(codec.combinationCount > 10n ** 90n).toBe(true);
  });
});

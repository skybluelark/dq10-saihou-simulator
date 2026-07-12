import { describe, it, expect } from 'vitest';
import { ConfigCodec, type ConfigJsonSchema } from '../../../src/core/codec/index';

const itemSchema = () => ({
  type: 'object' as const,
  properties: { kind: { enum: ['atk', 'def', 'spd', 'heal', 'buff', 'debuff'] } },
});

describe('schema.order', () => {
  it('lets a schema declare the array field in a readable position while processing it first internally', () => {
    // properties の見た目の並びは「mode が先、buffs が後」のまま(可読性優先)。
    const schema: ConfigJsonSchema = {
      type: 'object',
      properties: {
        mode: { enum: ['m0', 'm1', 'm2', 'm3', 'm4'] },
        buffs: { type: 'array', maxItems: 60, items: itemSchema() },
      },
      order: ['buffs', 'mode'], // 内部処理順だけ buffs を先にする
    };

    const codec = new ConfigCodec(schema);
    const config = { mode: 'm4', buffs: [{ kind: 'atk' }, { kind: 'def' }] };
    const code = codec.encode(config);

    // properties宣言順どおり(order省略、mode->buffs)にした場合と比べて短くなる = 実際にbuffsが先に処理されている証拠
    const withoutOrder = new ConfigCodec({ type: 'object', properties: schema.properties });
    const codeWithoutOrder = withoutOrder.encode(config);
    expect(code.length).toBeLessThan(codeWithoutOrder.length);

    expect(codec.decode(code)).toEqual(config);
  });

  it('produces identical output length regardless of maxItems when the array is processed first via order', () => {
    const buildSchema = (maxItems: number): ConfigJsonSchema => ({
      type: 'object',
      properties: {
        mode: { enum: ['m0', 'm1', 'm2', 'm3', 'm4'] },
        buffs: { type: 'array', maxItems, items: itemSchema() },
      },
      order: ['buffs', 'mode'],
    });
    const config = { mode: 'm4', buffs: [{ kind: 'atk' }, { kind: 'def' }] };
    // maxItems=100 だと itemCombos^100 が大きくなりすぎてデフォルトのひらがな71種では
    // 構築時の目安チェック(alphabet.length^32)に引っかかるため、ここでは検証用に大きめのアルファベットを使う。
    const bigAlphabet = Array.from({ length: 500 }, (_, i) => String.fromCharCode(0x4e00 + i));

    const codec60 = new ConfigCodec(buildSchema(60), { alphabet: bigAlphabet });
    const codec100 = new ConfigCodec(buildSchema(100), { alphabet: bigAlphabet });
    expect(codec60.encode(config).length).toBe(codec100.encode(config).length);
  });

  it('rejects an order that is not an exact permutation of properties keys', () => {
    const missing: ConfigJsonSchema = {
      type: 'object',
      properties: { a: { enum: ['x'] }, b: { enum: ['y'] } },
      order: ['a'],
    };
    expect(() => new ConfigCodec(missing)).toThrow(/exactly the same keys/);

    const duplicated: ConfigJsonSchema = {
      type: 'object',
      properties: { a: { enum: ['x'] }, b: { enum: ['y'] } },
      order: ['a', 'a'],
    };
    expect(() => new ConfigCodec(duplicated)).toThrow(/duplicate/);

    const unknown: ConfigJsonSchema = {
      type: 'object',
      properties: { a: { enum: ['x'] }, b: { enum: ['y'] } },
      order: ['a', 'c'],
    };
    expect(() => new ConfigCodec(unknown)).toThrow(/exactly the same keys/);
  });

  it('still enforces dependsOn ordering relative to schema.order, not to properties declaration order', () => {
    // properties上は b が a より先に書かれているが、order で a を先に処理させる。
    const schema: ConfigJsonSchema = {
      type: 'object',
      properties: {
        b: { dependsOn: 'a', cases: { x1: ['p'], x2: ['q'] } },
        a: { enum: ['x1', 'x2'] },
      },
      order: ['a', 'b'],
    };
    const codec = new ConfigCodec(schema);
    expect(codec.decode(codec.encode({ a: 'x1', b: 'p' }))).toEqual({ a: 'x1', b: 'p' });
  });
});

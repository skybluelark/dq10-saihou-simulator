import { describe, it, expect } from 'vitest';
import { ConfigCodec, type ConfigJsonSchema } from '../../../src/core/codec/index';

describe('checksum weight coverage', () => {
  it('detects a substitution at payload position i=base-1 (index 9 for a base-10 alphabet)', () => {
    // 旧実装の重み (i+1)%base は base=10 のとき i=9 (payload 10文字目) で重み0になり、
    // その位置だけを別の文字に置き換えても checksum が変化しなかった。
    // enum長10のフィールドを11個並べ、全て最大値にして11桁ペイロード(index 0-10)を確保する。
    const properties: ConfigJsonSchema['properties'] = {};
    for (let i = 0; i < 11; i++) {
      properties[`f${i}`] = { enum: Array.from({ length: 10 }, (_, v) => v) };
    }
    const schema: ConfigJsonSchema = { type: 'object', properties };
    const codec = new ConfigCodec(schema, { alphabet: '0123456789'.split('') });

    const config: Record<string, number> = {};
    for (let i = 0; i < 11; i++) config[`f${i}`] = 9;
    const code = codec.encode(config);
    const payload = code.slice(0, -1);
    expect(payload.length).toBeGreaterThanOrEqual(10);

    const targetIndex = 9; // ペイロード10文字目 = index 9
    const chars = [...code];
    chars[targetIndex] = chars[targetIndex] === '0' ? '1' : '0';
    const tampered = chars.join('');

    expect(() => codec.decode(tampered)).toThrow(/checksum/);
  });
});

describe('checksumPrefix', () => {
  const schema: ConfigJsonSchema = {
    type: 'object',
    properties: {
      field1: { enum: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] },
      field2: { enum: [0, 1] },
    },
  };
  const config = { field1: 5, field2: 1 };

  it('round-trips successfully when checksumPrefix is specified', () => {
    const codec = new ConfigCodec(schema, { checksumPrefix: 'あ' });
    const code = codec.encode(config);
    expect(codec.decode(code)).toEqual(config);
  });

  it('produces a different checksum digit for the same schema/config when the prefix differs', () => {
    const codecA = new ConfigCodec(schema, { checksumPrefix: 'あ' });
    const codecB = new ConfigCodec(schema, { checksumPrefix: 'い' });
    const codeA = codecA.encode(config);
    const codeB = codecB.encode(config);
    // ペイロード部分(チェックデジットを除く)は同じはずだが、チェックデジットは異なる
    expect(codeA.slice(0, -1)).toBe(codeB.slice(0, -1));
    expect(codeA.slice(-1)).not.toBe(codeB.slice(-1));
  });

  it('rejects decoding with a mismatched prefix, simulating a mistyped version character', () => {
    const codecA = new ConfigCodec(schema, { checksumPrefix: 'あ' });
    const codecB = new ConfigCodec(schema, { checksumPrefix: 'い' });
    const code = codecA.encode(config);
    expect(() => codecB.decode(code)).toThrow(/checksum/);
  });

  it('throws at construction time when checksumPrefix contains a character outside the alphabet', () => {
    expect(() => new ConfigCodec(schema, { checksumPrefix: '0' })).toThrow(/checksumPrefix/);
  });
});

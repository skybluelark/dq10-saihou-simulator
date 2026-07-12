import { describe, it, expect } from 'vitest';
import { ConfigCodec, type ConfigJsonSchema } from '../../../src/core/codec/index';

const schema: ConfigJsonSchema = {
  type: 'object',
  properties: {
    field1: { enum: Array.from({ length: 10 }, (_, i) => i) },
    field2: { enum: [0, 1] },
    field3: { enum: [0, 1] },
    field4: { enum: [0, 1] },
    field5: { enum: [0, 1] },
    field6: { enum: [0, 1] },
    field7: { enum: [0, 1] },
    field8: { enum: [0, 1] },
    field9: { enum: ['a', 'b', 'c'] },
  },
};

describe('ConfigCodec', () => {
  it('computes total combination count from the example spec', () => {
    const codec = new ConfigCodec(schema);
    expect(codec.combinationCount).toBe(10n * 2n ** 7n * 3n);
  });

  it('round-trips every field to its minimum and maximum values', () => {
    const codec = new ConfigCodec(schema);
    const min = { field1: 0, field2: 0, field3: 0, field4: 0, field5: 0, field6: 0, field7: 0, field8: 0, field9: 'a' as const };
    const max = { field1: 9, field2: 1, field3: 1, field4: 1, field5: 1, field6: 1, field7: 1, field8: 1, field9: 'c' as const };

    expect(codec.decode(codec.encode(min))).toEqual(min);
    expect(codec.decode(codec.encode(max))).toEqual(max);
  });

  it('produces a 2-character payload plus 1 checksum char for the example spec (71-symbol alphabet)', () => {
    const codec = new ConfigCodec(schema);
    const code = codec.encode({ field1: 5, field2: 1, field3: 0, field4: 1, field5: 0, field6: 1, field7: 0, field8: 1, field9: 'b' });
    // 3840通り -> 71進数で最大2桁(71^2=5041) + チェックデジット1桁 = 3文字
    expect(code.length).toBe(3);
  });

  it('rejects a value outside the declared enum', () => {
    const codec = new ConfigCodec(schema);
    expect(() => codec.encode({ field1: 10, field2: 0, field3: 0, field4: 0, field5: 0, field6: 0, field7: 0, field8: 0, field9: 'a' })).toThrow();
  });

  it('detects a single mistyped character via the checksum', () => {
    const codec = new ConfigCodec(schema);
    const code = codec.encode({ field1: 5, field2: 1, field3: 0, field4: 1, field5: 0, field6: 1, field7: 0, field8: 1, field9: 'b' });
    const alphabet = [...code];
    const tampered = alphabet.map((ch, i) => (i === 0 ? (ch === 'あ' ? 'い' : 'あ') : ch)).join('');
    expect(() => codec.decode(tampered)).toThrow(/checksum/);
  });

  it('rejects codes shorter than the checksum length', () => {
    const codec = new ConfigCodec(schema);
    expect(() => codec.decode('あ')).toThrow(/too short/);
  });

  it('supports a custom alphabet', () => {
    const codec = new ConfigCodec(schema, { alphabet: '0123456789'.split('') });
    const value = { field1: 3, field2: 1, field3: 0, field4: 1, field5: 1, field6: 0, field7: 0, field8: 1, field9: 'c' as const };
    expect(codec.decode(codec.encode(value))).toEqual(value);
  });
});

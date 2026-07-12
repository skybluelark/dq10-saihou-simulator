import { describe, it, expect } from 'vitest';
import { ConfigCodec, HIRAGANA_71, type ConfigJsonSchema } from '../../../src/core/codec/index';
import { computeChecksumChar } from '../../../src/core/codec/checksum';

describe('non-canonical code rejection', () => {
  it('rejects a payload with a redundant leading zero-symbol even when the checksum is recomputed correctly', () => {
    const schema: ConfigJsonSchema = {
      type: 'object',
      properties: { field1: { enum: [0, 1, 2, 3, 4] } },
    };
    const codec = new ConfigCodec(schema);
    const code = codec.encode({ field1: 3 });
    const payload = code.slice(0, -1);

    // 先頭に alphabet[0]("あ") を挿入した、値としては同じだが表記が異なる非正準ペイロードを作り、
    // チェックデジットも正しく再計算して付け直す。
    const paddedPayload = HIRAGANA_71[0] + payload;
    const newChecksum = computeChecksumChar(paddedPayload, HIRAGANA_71);
    const paddedCode = paddedPayload + newChecksum;

    // チェックデジット自体は正しいので checksum エラーにはならないが、非正準表記として拒否される。
    expect(() => codec.decode(paddedCode)).toThrow(/non-canonical/);
    expect(codec.decode(code)).toEqual({ field1: 3 });
  });
});

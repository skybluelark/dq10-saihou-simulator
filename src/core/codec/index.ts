// config-compact-codec の vendoring スナップショット(取り込み 2026-07-13。原本: E:\dev\config-compact-codec)
// 以後の改修はこちら(src/core/codec)が正とする(ARCHITECTURE A11)。
import { deriveFields, type ConfigJsonSchema, type ConfigRecord, type FieldDef } from './schema';
import { rank, unrank, combosFrom } from './ranking';
import { encodeBaseN, decodeBaseN } from './baseN';
import { computeChecksumChar, verifyChecksum } from './checksum';
import { HIRAGANA_71 } from './alphabets';

export { HIRAGANA_71 } from './alphabets';
export type {
  ConfigJsonSchema,
  ConfigRecord,
  StaticFieldSchema,
  ConditionalFieldSchema,
  ArrayFieldSchema,
  IntegerFieldSchema,
  FieldSchema,
} from './schema';

export interface CodecOptions {
  alphabet?: readonly string[];
  /**
   * 組み合わせ数の目安チェックのしきい値: alphabet.length ** maxExponent を超えると構築時にエラーになる。
   * 誤って巨大すぎるスキーマ(enumの組み合わせ爆発など)を作ってしまった際に早期に気付くための安全弁であり、
   * 技術的な上限ではない(bigintなので計算自体はどれだけ桁数が増えても問題ない)。
   * 想定パターン数がデフォルトを超える場合は、この値を引き上げるか Infinity 相当の大きな値を指定する。
   * 省略時は128。
   */
  maxExponent?: number;
  /**
   * チェックデジットの計算・検証対象の先頭に付け足す固定文字列。
   * 例えば呼び出し側が`encode`の出力の外側に自前でバージョン文字を前置する設計(例: `version + codec.encode(config)`)の場合、
   * そのバージョン文字はチェックデジットの保護範囲外になり、バージョン文字だけが誤入力されても検出できない。
   * `checksumPrefix`にそのバージョン文字と同じ値を指定すると、チェックデジットは`checksumPrefix + payload`に対して
   * 計算・検証されるようになり、バージョン文字の誤字も検出対象に含められる。
   * 出力コード自体(`encode`の戻り値)にはprefixは含まれない。前置は呼び出し側の責務のまま。
   * 空文字は未指定と同義。省略時は''(従来どおりペイロードのみを保護)。
   * `checksumPrefix`に含まれる全文字は`alphabet`に含まれている必要があり、そうでなければ構築時エラーになる。
   */
  checksumPrefix?: string;
}

export class ConfigCodec {
  private readonly fields: FieldDef[];
  private readonly alphabet: readonly string[];
  private readonly checksumPrefix: string;

  constructor(schema: ConfigJsonSchema, options: CodecOptions = {}) {
    this.fields = deriveFields(schema);
    this.alphabet = options.alphabet ?? HIRAGANA_71;
    this.checksumPrefix = options.checksumPrefix ?? '';
    if (this.checksumPrefix) {
      const alphabetSet = new Set(this.alphabet);
      for (const ch of this.checksumPrefix) {
        if (!alphabetSet.has(ch)) {
          throw new Error(`checksumPrefix character "${ch}" is not in the alphabet`);
        }
      }
    }
    const maxExponent = options.maxExponent ?? 128;
    const combos = this.combinationCount;
    if (combos > BigInt(this.alphabet.length) ** BigInt(maxExponent)) {
      throw new Error(
        `combination count (${combos}) exceeds alphabet.length**${maxExponent}; ` +
          'raise CodecOptions.maxExponent (or use a larger alphabet) if this schema size is intentional',
      );
    }
  }

  get combinationCount(): bigint {
    return combosFrom(this.fields, 0, {}, new Map());
  }

  encode(config: ConfigRecord): string {
    const n = rank(this.fields, config);
    const payload = encodeBaseN(n, this.alphabet);
    const checksumChar = computeChecksumChar(this.checksumPrefix + payload, this.alphabet);
    return payload + checksumChar;
  }

  decode(code: string): ConfigRecord {
    if (code.length < 2) {
      throw new Error('code is too short to contain a checksum character');
    }
    const payload = code.slice(0, -1);
    const checksumChar = code.slice(-1);
    if (!verifyChecksum(this.checksumPrefix + payload, checksumChar, this.alphabet)) {
      throw new Error('checksum mismatch: code appears to be mistyped or corrupted');
    }
    // ペイロード先頭がアルファベットの0番目の文字だと、そのまま(あるいは何文字か)前に付け足しても
    // 数値としては同じ値になってしまう(先頭ゼロ詰め)。同じ設定に対して複数の表記が存在すると
    // 「正しいコードかどうか」を文字列比較で判断できなくなるため、非正準な表記はエラーにする。
    if (payload.length >= 2 && payload[0] === this.alphabet[0]) {
      throw new Error('non-canonical code: payload has a redundant leading zero-symbol and was not produced by encode()');
    }
    const n = decodeBaseN(payload, this.alphabet);
    return unrank(this.fields, n);
  }
}

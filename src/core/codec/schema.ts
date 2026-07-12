export interface StaticFieldSchema {
  enum: readonly (string | number)[];
}

export interface ConditionalFieldSchema {
  /** この項目の選択肢が依存する、より前に宣言されたフィールド名 */
  dependsOn: string;
  /** 親フィールドの値(文字列化したもの)ごとの選択肢一覧 */
  cases: Record<string, readonly (string | number)[]>;
  /** cases に一致しない親の値が来た場合のフォールバック選択肢 */
  default?: readonly (string | number)[];
}

export interface ArrayFieldSchema {
  type: 'array';
  items: ConfigJsonSchema;
  /** 省略時は0 */
  minItems?: number;
  maxItems: number;
}

export interface IntegerFieldSchema {
  type: 'integer';
  /** 両端を含む範囲(整数)。乱数シードのような広いレンジを想定。 */
  minimum: number;
  maximum: number;
}

export type FieldSchema = StaticFieldSchema | ConditionalFieldSchema | ArrayFieldSchema | IntegerFieldSchema;

export interface ConfigJsonSchema {
  type: 'object';
  properties: Record<string, FieldSchema>;
  /**
   * 内部の処理順(圧縮効率に影響する)を properties の宣言順から切り離したい場合に指定する。
   * properties の全キーちょうど1回ずつを含む配列である必要がある。省略時は properties の宣言順を使う。
   */
  order?: string[];
}

// 設定値の入出力型。list項目はConfigRecordの配列を値に持てる(入れ子も可能)。
export type ConfigValue = string | number;
export interface ConfigRecord {
  [key: string]: ConfigValue | ConfigRecord[];
}

export type FieldDef =
  | { key: string; kind: 'static'; values: readonly (string | number)[] }
  | {
      key: string;
      kind: 'conditional';
      dependsOn: string;
      cases: Record<string, readonly (string | number)[]>;
      default?: readonly (string | number)[];
    }
  | { key: string; kind: 'list'; itemFields: FieldDef[]; minItems: number; maxItems: number }
  | { key: string; kind: 'integer'; minimum: number; maximum: number };

function isConditional(def: FieldSchema): def is ConditionalFieldSchema {
  return 'dependsOn' in def;
}

function isArray(def: FieldSchema): def is ArrayFieldSchema {
  return 'type' in def && def.type === 'array';
}

function isInteger(def: FieldSchema): def is IntegerFieldSchema {
  return 'type' in def && def.type === 'integer';
}

// 選択肢配列内で String(値) 化した結果が重複していないか検証する。
// conditional の cases キーは String() でマッチングされるため、選択肢自体の重複だけでなく
// 文字列化後の衝突(例: [1, '1'] や [1, 1])も桁の意味を壊すので構築時エラーにする。
function checkNoDuplicateValues(values: readonly (string | number)[], context: string): void {
  const seen = new Set<string>();
  for (const v of values) {
    const s = String(v);
    if (seen.has(s)) {
      throw new Error(`${context} has duplicate values after String() conversion: ${JSON.stringify(s)}`);
    }
    seen.add(s);
  }
}

// 処理順は schema.order があればそれを使い、無ければ properties の宣言順
// (JSのオブジェクトは文字列キーの挿入順を保持する)を使う。
// dependsOn は必ず自分より前(=処理順で先)に宣言されたスカラー項目(static/conditional)のみ参照できる(list項目や前方参照は不可)。
export function deriveFields(schema: ConfigJsonSchema): FieldDef[] {
  const propertyKeys = Object.keys(schema.properties);
  const keys = schema.order ?? propertyKeys;

  if (schema.order) {
    const declared = new Set(propertyKeys);
    const ordered = new Set(schema.order);
    if (ordered.size !== schema.order.length) {
      throw new Error('schema.order contains duplicate keys');
    }
    if (declared.size !== ordered.size || [...declared].some((k) => !ordered.has(k))) {
      throw new Error('schema.order must contain exactly the same keys as properties, each exactly once');
    }
  }

  return keys.map((key, i) => {
    const def = schema.properties[key];

    if (isArray(def)) {
      const minItems = def.minItems ?? 0;
      if (minItems < 0 || def.maxItems < minItems) {
        throw new Error(`field "${key}" has invalid minItems/maxItems range`);
      }
      return { key, kind: 'list', itemFields: deriveFields(def.items), minItems, maxItems: def.maxItems };
    }

    if (isInteger(def)) {
      if (!Number.isSafeInteger(def.minimum) || !Number.isSafeInteger(def.maximum)) {
        throw new Error(`field "${key}" integer minimum/maximum must both be safe integers`);
      }
      if (def.minimum > def.maximum) {
        throw new Error(`field "${key}" integer minimum must be <= maximum`);
      }
      return { key, kind: 'integer', minimum: def.minimum, maximum: def.maximum };
    }

    if (isConditional(def)) {
      const parentIndex = keys.indexOf(def.dependsOn);
      if (parentIndex === -1) {
        throw new Error(`field "${key}" depends on unknown field "${def.dependsOn}"`);
      }
      if (parentIndex >= i) {
        throw new Error(`field "${key}" must be declared after its dependency "${def.dependsOn}"`);
      }
      const parentDef = schema.properties[def.dependsOn];
      if (isArray(parentDef)) {
        throw new Error(`field "${key}" cannot depend on array field "${def.dependsOn}"`);
      }
      if (isInteger(parentDef)) {
        throw new Error(
          `field "${key}" cannot depend on integer field "${def.dependsOn}" ` +
            '(integer fields can have an enormous range, so enumerating per-value cases is not supported)',
        );
      }
      if (Object.keys(def.cases).length === 0) {
        throw new Error(`field "${key}" must declare at least one case`);
      }
      for (const [caseKey, values] of Object.entries(def.cases)) {
        checkNoDuplicateValues(values, `field "${key}" case "${caseKey}"`);
      }
      if (def.default) {
        checkNoDuplicateValues(def.default, `field "${key}" default`);
      }
      return { key, kind: 'conditional', dependsOn: def.dependsOn, cases: def.cases, default: def.default };
    }

    if (!def.enum || def.enum.length < 1) {
      throw new Error(`field "${key}" must declare a non-empty enum`);
    }
    checkNoDuplicateValues(def.enum, `field "${key}"`);
    return { key, kind: 'static', values: def.enum };
  });
}

export function resolveValues(
  field: Extract<FieldDef, { kind: 'static' | 'conditional' }>,
  context: Readonly<Record<string, string | number>>,
): readonly (string | number)[] {
  if (field.kind === 'static') return field.values;
  const parentValue = context[field.dependsOn];
  const values = field.cases[String(parentValue)] ?? field.default;
  if (!values) {
    throw new Error(
      `field "${field.key}" has no case for ${field.dependsOn}=${JSON.stringify(parentValue)} and no default`,
    );
  }
  return values;
}

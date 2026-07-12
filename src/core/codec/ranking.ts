import { resolveValues, type ConfigRecord, type FieldDef } from './schema';

type Context = Readonly<Record<string, string | number>>;

// fields[i..]の中で dependsOn 参照されているキーだけを集める。
// これをメモ化キーに使うことで、依存関係のない項目同士は文脈が違っても
// 同じ部分問題として再利用され、単純な掛け算(独立項目)の場合と同じ計算量になる。
function relevantKeysFrom(fields: FieldDef[], i: number): string[] {
  const keys = new Set<string>();
  for (let j = i; j < fields.length; j++) {
    const f = fields[j];
    if (f.kind === 'conditional') keys.add(f.dependsOn);
  }
  return [...keys].sort();
}

function memoKey(i: number, context: Context, relevantKeys: string[]): string {
  return i + '|' + relevantKeys.map((k) => `${k}=${context[k]}`).join(',');
}

// base^L (L=fromInclusive..toExclusive-1) の総和。要素数の候補程度(せいぜい数十)を想定した単純ループ。
function sumOfPowers(base: bigint, fromInclusive: number, toExclusive: number): bigint {
  let total = 0n;
  let power = base ** BigInt(fromInclusive);
  for (let L = fromInclusive; L < toExclusive; L++) {
    total += power;
    power *= base;
  }
  return total;
}

// list項目1件あたりの組み合わせ数(itemFieldsは常にcontext {}から独立に評価する = 要素同士・外側との依存は無い前提)。
function itemCombosOf(field: Extract<FieldDef, { kind: 'list' }>): bigint {
  return combosFrom(field.itemFields, 0, {}, new Map());
}

// fields[i..]について、contextの下で有効な組み合わせの総数を数える。
export function combosFrom(fields: FieldDef[], i: number, context: Context, memo: Map<string, bigint>): bigint {
  if (i >= fields.length) return 1n;
  const field = fields[i];

  if (field.kind === 'list') {
    const key = memoKey(i, context, relevantKeysFrom(fields, i));
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    const suffixCombos = combosFrom(fields, i + 1, context, memo);
    const total = sumOfPowers(itemCombosOf(field), field.minItems, field.maxItems + 1) * suffixCombos;
    memo.set(key, total);
    return total;
  }

  if (field.kind === 'integer') {
    // 整数型は dependsOn の参照先として使えない(構築時に禁止)ため、選択肢数は文脈に依存しない定数。
    // レンジをループせず乗算1回で求めることで、2^32のような広いレンジでもO(1)で計算できる。
    const key = memoKey(i, context, relevantKeysFrom(fields, i));
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    const suffixCombos = combosFrom(fields, i + 1, context, memo);
    const total = BigInt(field.maximum - field.minimum + 1) * suffixCombos;
    memo.set(key, total);
    return total;
  }

  const relevant = relevantKeysFrom(fields, i);
  const key = memoKey(i, context, relevant);
  const cached = memo.get(key);
  if (cached !== undefined) return cached;

  let values: readonly (string | number)[];
  try {
    values = resolveValues(field, context);
  } catch {
    // このcontextでは有効な選択肢が無い(caseもdefaultも無い)= この分岐は0通り。
    // rank/unrankが実際にこの項目を選ぼうとした際は resolveValues が改めて例外を投げる。
    memo.set(key, 0n);
    return 0n;
  }
  let total = 0n;
  for (const v of values) {
    total += combosFrom(fields, i + 1, { ...context, [field.key]: v }, memo);
  }
  memo.set(key, total);
  return total;
}

// 先頭フィールドから順に「まだ試していない選択肢の分だけ既に消費された順位」を積算するランキング。
export function rank(fields: FieldDef[], config: ConfigRecord): bigint {
  const memo = new Map<string, bigint>();
  let context: Record<string, string | number> = {};
  let result = 0n;

  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];

    if (field.kind === 'list') {
      const items = config[field.key];
      if (!Array.isArray(items) || items.length < field.minItems || items.length > field.maxItems) {
        throw new Error(`field "${field.key}" must be an array with ${field.minItems}-${field.maxItems} items`);
      }
      const itemCombos = itemCombosOf(field);
      const suffixCombos = combosFrom(fields, i + 1, context, memo);
      const skippedTotal = sumOfPowers(itemCombos, field.minItems, items.length);
      let itemsLocalRank = 0n;
      for (const item of items) {
        itemsLocalRank = itemsLocalRank * itemCombos + rank(field.itemFields, item);
      }
      result += (skippedTotal + itemsLocalRank) * suffixCombos;
      continue;
    }

    if (field.kind === 'integer') {
      const value = config[field.key];
      if (typeof value !== 'number' || !Number.isInteger(value) || value < field.minimum || value > field.maximum) {
        throw new Error(
          `value ${JSON.stringify(value)} is out of range for integer field "${field.key}" (${field.minimum}-${field.maximum})`,
        );
      }
      // 選択肢数が文脈非依存の定数なので、skip分の合計はloopではなく乗算1回で求まる(O(1))。
      const suffixCombos = combosFrom(fields, i + 1, context, memo);
      result += BigInt(value - field.minimum) * suffixCombos;
      context = { ...context, [field.key]: value };
      continue;
    }

    const allowed = resolveValues(field, context);
    const chosen = config[field.key];
    const chosenIndex = allowed.indexOf(chosen as never);
    if (chosenIndex === -1) {
      throw new Error(`value ${JSON.stringify(chosen)} is not valid for field "${field.key}"`);
    }
    for (let j = 0; j < chosenIndex; j++) {
      result += combosFrom(fields, i + 1, { ...context, [field.key]: allowed[j] }, memo);
    }
    context = { ...context, [field.key]: chosen as string | number };
  }
  return result;
}

// rank の逆演算。各段で、残りランクがどの選択肢(あるいはlistの場合は長さ)のバケットに収まるかを順に絞り込む。
export function unrank(fields: FieldDef[], n: bigint): ConfigRecord {
  const memo = new Map<string, bigint>();
  let context: Record<string, string | number> = {};
  const result: ConfigRecord = {};
  let remaining = n;

  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];

    if (field.kind === 'list') {
      const itemCombos = itemCombosOf(field);
      const suffixCombos = combosFrom(fields, i + 1, context, memo);
      let chosenLength: number | undefined;
      for (let L = field.minItems; L <= field.maxItems; L++) {
        const bucketSize = itemCombos ** BigInt(L) * suffixCombos;
        if (remaining < bucketSize) {
          chosenLength = L;
          break;
        }
        remaining -= bucketSize;
      }
      if (chosenLength === undefined) {
        throw new Error(`decoded rank out of range for field "${field.key}"`);
      }
      const itemsLocalRank = remaining / suffixCombos;
      remaining = remaining % suffixCombos;

      const items: ConfigRecord[] = [];
      let rest = itemsLocalRank;
      let power = chosenLength > 0 ? itemCombos ** BigInt(chosenLength - 1) : 1n;
      for (let k = 0; k < chosenLength; k++) {
        const digit = rest / power;
        rest = rest % power;
        items.push(unrank(field.itemFields, digit));
        if (k < chosenLength - 1) power /= itemCombos;
      }
      result[field.key] = items;
      continue;
    }

    if (field.kind === 'integer') {
      // list の長さ選択のような値ごとのループは行わず、除算1回でレンジ内のオフセットを求める(O(1))。
      const rangeSize = BigInt(field.maximum - field.minimum + 1);
      const suffixCombos = combosFrom(fields, i + 1, context, memo);
      const offset = remaining / suffixCombos;
      if (offset >= rangeSize) {
        throw new Error(`decoded rank out of range for field "${field.key}"`);
      }
      remaining = remaining % suffixCombos;
      const value = field.minimum + Number(offset);
      context = { ...context, [field.key]: value };
      result[field.key] = value;
      continue;
    }

    const allowed = resolveValues(field, context);
    let chosen: string | number | undefined;
    for (const v of allowed) {
      const bucketSize = combosFrom(fields, i + 1, { ...context, [field.key]: v }, memo);
      if (remaining < bucketSize) {
        chosen = v;
        break;
      }
      remaining -= bucketSize;
    }
    if (chosen === undefined) {
      throw new Error(`decoded rank out of range for field "${field.key}"`);
    }
    context = { ...context, [field.key]: chosen };
    result[field.key] = chosen;
  }
  return result;
}

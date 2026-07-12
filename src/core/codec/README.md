# config-compact-codec

> vendoring スナップショット(2026-07-13)。原本: E:\dev\config-compact-codec。以後の改修はこちらが正(ARCHITECTURE A11)。

JSON Schemaの`enum`定義を前提に、設定値の組み合わせをmixed-radix変換で短い文字列へ圧縮/復元するライブラリ。

## 仕組み
1. スキーマの`properties`順を処理順とし、各項目の選択肢(enum)を先頭から順に確定させていく。
2. ある項目の選択肢は、`dependsOn`でより前の項目の値に依存させられる(後述)。実際に到達可能な組み合わせだけを数える**ランキング/アンランキング**方式で、単一の整数に合成する(独立項目のみのmixed-radixの一般化)。
3. 整数をカスタムアルファベット(デフォルト:ひらがな71種)で基数変換し、末尾にチェックデジット1文字を付与する。

全項目が独立(依存なし)なら、全パターン数は各項目のenum長の掛け算になる。項目間に依存がある場合は、実際に有効な組み合わせ数だけがカウントされるため、無駄なパターン分の圧縮ロスが生じない。

## 項目間の依存(条件付き選択肢)
ある項目の選択肢が、より前の項目の値によって変わる場合は`dependsOn`/`cases`を使う。

```ts
const schema = {
  type: 'object',
  properties: {
    fieldA: { enum: ['x1', 'x2', 'x3'] },
    fieldB: {
      dependsOn: 'fieldA',
      cases: {
        x1: ['p', 'q'],
        x2: ['p'],       // x1=x2 のときは選択肢が1個だけ -> その分圧縮される
        x3: ['p', 'q', 'r'],
      },
      // default: ['p'], // cases に該当が無い場合のフォールバック(省略可)
    },
  },
} as const;

const codec = new ConfigCodec(schema);
codec.combinationCount; // => 6n (2+1+3。3*3=9ではない)
```

制約:
- `dependsOn`は自分より前(properties順で先)に宣言された**スカラー項目**(static/conditional)のみ参照可能(前方参照・array項目への依存は構築時にエラー)。
- 現状は単一項目への依存のみサポート(複数項目の組み合わせに依存するケースは未対応)。

## 繰り返し項目(可変長配列)
要素数が可変で、各要素が複数の内部項目を持つ場合は`type: "array"`を使う。要素同士は独立(互いに依存しない)である前提。`maxItems`は圧縮計算に必須。

```ts
const schema = {
  type: 'object',
  properties: {
    buffs: {
      type: 'array',
      minItems: 0,   // 省略時は0
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
} as const;

const codec = new ConfigCodec(schema);
codec.combinationCount; // => 259n ( sum_{L=0}^{3} (3*2)^L = 1+6+36+216 )

const code = codec.encode({ buffs: [{ kind: 'atk', power: 1 }, { kind: 'def', power: 2 }] });
```

- 要素の順序は区別される(同じ組でも並び順が違えば別コードになる)。
- `items`の中で`dependsOn`(要素内の依存)も使える。要素間・外側の項目との依存は未対応。
- 組み合わせ数は「長さの選択」+「各要素の独立な選択」に分解して計算するため、無駄なパターンは生じない。

### 処理順とmaxItemsの影響

ランキング方式の性質上、**ある項目の「選択肢を1つ飛ばす」コストは、それより後ろ(=処理順で後)にある項目全部の組み合わせ数を掛けたもの**になります。そのため、可変長配列(array)より前に他の項目があると、他の項目が先頭以外の値を取るたびに、配列の`maxItems`に応じた(itemCombosのmaxItems乗のオーダーで増える)理論上限が乗算され、出力が長くなります。配列より後ろの項目はこの影響を受けません。

「他ケースとの共用のためmaxItemsに余裕を持たせたいが、propertiesの見た目の並び(可読性・既存JSON構造との整合)は変えたくない」という場合は、`order`でスキーマの内部処理順だけを指定できます。

```ts
const schema = {
  type: 'object',
  properties: {
    mode: { enum: ['m0', 'm1', 'm2', 'm3', 'm4'] }, // 見た目上は先に書く
    buffs: { type: 'array', maxItems: 100, items: { /* ... */ } },
  },
  order: ['buffs', 'mode'], // 内部処理だけ buffs を先にする -> maxItemsの余裕が他項目に波及しない
} as const;
```

`order`を指定すると`dependsOn`の前後関係チェックも`order`基準になる。`order`は`properties`の全キーをちょうど1回ずつ含む必要があり、そうでなければ構築時にエラーになる。

### maxItems拡大時の注意
`maxItems`を大きくすると`combinationCount`(理論上の総組み合わせ数)がitemCombosのmaxItems乗のオーダーで増える。デフォルトのコンストラクタは`combinationCount > alphabet.length^32`で「アルファベットが小さすぎる」エラーを投げる目安チェックを行っているため、余裕を持たせすぎると実データを一切エンコードする前に構築自体が失敗することがある。この場合はより大きなカスタムアルファベットを使うか、`maxItems`を実運用で本当に必要な値に近づけること。

## 整数レンジ項目
乱数シードのように取りうる値の範囲は広いが、選択肢を全部enumに書き下すのは非現実的な項目には`type: "integer"`を使う。

```ts
const schema = {
  type: 'object',
  properties: {
    seed: { type: 'integer', minimum: 0, maximum: 2 ** 32 - 1 }, // リプレイの乱数シード
  },
} as const;

const codec = new ConfigCodec(schema);
codec.combinationCount; // => 4294967296n (= maximum - minimum + 1)

const code = codec.encode({ seed: 123456789 });
codec.decode(code); // => { seed: 123456789 }
```

- `minimum`/`maximum`は両端を含む整数(`Number.isSafeInteger`を満たす値)で、`minimum <= maximum`である必要がある(違反は構築時エラー)。
- `encode`時、値が整数でない、または`minimum`〜`maximum`の範囲外の場合は例外を投げる。
- 整数項目は取りうる値の数が非常に多くなり得るため、**`dependsOn`の参照先(親)として使うことはできない**(構築時エラー)。他の項目の選択肢を整数項目の値ごとに`cases`で書き下すのは現実的でないための制約。整数項目自体は選択肢数が常に`minimum`/`maximum`だけで決まる(他項目の値に依存しない)ため、条件付き選択肢(`dependsOn`)の子側にもなれない。
- 内部的には、整数項目のスキップ分は選択肢を1つずつ数えるループではなく乗算・除算1回で計算されるため、`2^32`のような広いレンジでも実用的な速度で処理できる。

## 使い方
```ts
import { ConfigCodec } from 'config-compact-codec';

const schema = {
  type: 'object',
  properties: {
    field1: { enum: [0,1,2,3,4,5,6,7,8,9] }, // 10種
    field2: { enum: [0,1] },                  // 2種 (以下field8まで同様)
    // ...
    field9: { enum: ['a','b','c'] },          // 3種
  },
} as const;

const codec = new ConfigCodec(schema);
codec.combinationCount; // => 3840n

const code = codec.encode({ field1: 5, field2: 1, /* ... */ field9: 'b' });
// => 3文字(ペイロード2文字 + チェックデジット1文字)

const restored = codec.decode(code);
```

## 誤り検出
`decode`は末尾のチェックデジットを検証し、不一致なら例外を投げる(目視入力のタイプミス検知用)。完全な誤り訂正ではなく検出のみ。

また、`decode`はペイロード(チェックデジットを除いた部分)が2文字以上あり、かつ先頭の文字がアルファベットの0番目の文字(デフォルトのひらがなアルファベットでは「あ」)である場合も例外を投げる。これは`encode`が生成しない**非正準(non-canonical)な表記**で、先頭に0番目の文字を何文字挿入しても数値としては同じ値になってしまうため、同じ設定に対して複数の文字列表記が存在することを防ぐための制約。チェックデジット自体が正しく再計算されていても拒否される。

### checksumPrefix(コード外に付与する文字の保護)

`encode`の戻り値(ペイロード+チェックデジット)の外側に、呼び出し側が独自にバージョン文字などを前置する設計はよくある(例: リプレイコードの先頭1文字をフォーマットバージョンとして使う)。しかしその前置文字は`encode`が生成するチェックデジットの保護範囲外なので、前置文字だけが目視入力でタイプミスされてもデフォルトでは検出できない。

`CodecOptions.checksumPrefix`を指定すると、チェックデジットの計算・検証対象を`checksumPrefix + payload`に広げられる。出力コード自体にprefixは含まれない(前置は引き続き呼び出し側の責務)。

```ts
const codec = new ConfigCodec(schema, { checksumPrefix: 'v' }); // 'v' はバージョン文字の想定値

const code = 'v' + codec.encode(config); // 呼び出し側でバージョン文字を前置
// => decode時も同じ checksumPrefix: 'v' を指定した codec でなければチェックサムが一致しない
codec.decode(code.slice(1)); // 先頭のバージョン文字を取り除いてから渡す
```

- `checksumPrefix`に含まれる文字は全て`alphabet`に含まれている必要があり、そうでなければ構築時エラーになる。
- 空文字は未指定(従来どおりペイロードのみ保護)と同義。
- `encode`/`decode`で異なる`checksumPrefix`を指定したcodecを使うと、ペイロードが同一でもチェックデジットが一致せず`decode`は失敗する(バージョン文字の誤字を検出する仕組みとして機能する)。

## カスタムアルファベット
```ts
new ConfigCodec(schema, { alphabet: '0123456789'.split('') });
```

## 制約・注意点
- スキーマの`properties`の**列挙順**が桁の意味を持つため、スキーマを変更する際は既存コードとの互換性(順序・enum長)に注意すること。
- 現状は列挙型(enum)と整数レンジ型(`type: "integer"`、前述)のみサポート。それ以外の自由入力の文字列項目などはサポート対象外。
- `enum`(static項目)や`cases`/`default`(conditional項目)の選択肢リストは、各値を`String()`化した結果が重複してはならない(例: `[1, '1']`や`[1, 1]`は構築時エラー)。`cases`のキーは親の値を`String()`化した文字列でマッチングされるため、選択肢が文字列化後に衝突すると桁の意味が壊れるための制約。
- `decode`は非正準な表記(前述の「誤り検出」参照)を拒否する。

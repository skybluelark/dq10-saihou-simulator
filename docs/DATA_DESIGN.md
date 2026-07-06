# ドラクエ10 さいほうシミュレータ データ設計書 (v0.2)

作成日: 2026-07-03 / 状態: **承認済み (2026-07-03。修正2点を反映済み)**
関連文書: [SPEC.md](SPEC.md)(数値の正) / [ARCHITECTURE.md](ARCHITECTURE.md)(A5 データ読み込み方式)

## 0. 方針・共通規約

1. **数値の正は SPEC.md**。本書はその機械可読な形(スキーマ)を定義する。実データファイルは実装時(M1)に作成し、仕様書の数表との一致をユニットテストで検証する(転記ミス防止)。
2. **ID・enum値は半角英字**(ローマ字/英語)、表示名は `name` フィールドに日本語で持つ。UI・ログは name を使用。
3. すべてのデータファイルに `version` フィールドを持たせ、コア側で互換チェックする。
4. 確率は 0〜1 の小数で表現(例: 1% = 0.01)。
5. パラメータエディタ(F7)の編集対象は game-params.json のみ。他はデータ修正=ファイル編集。

### enum定義

| enum | 値 |
|---|---|
| 部位 category | `head` 頭 / `body_upper` 体上 / `body_lower` 体下 / `arm` 腕 / `leg` 足 / `doll` ぬいぐるみ / `rug` ラグ |
| 布タイプ cloth | `normal` 通常 / `regen` 再生 / `rainbow` 虹 / `light` 光 |
| ぬいパワー power | `weak` 弱い / `normal` 普通 / `strong` 強い / `strongest` 最強 / `critx2` 会心×2 / `unknown` ？ |
| 針 needle | `copper` 銅 / `iron` 鉄 / `silver` 銀 / `platinum` プラチナ / `super` 超 / `miracle` 奇跡 / `hikari` 光 |
| 評価 star | `star3` / `star2` / `star1` / `star0`(★なし) / `fail` |

## 1. game-params.json

ゲームルールの調整可能パラメータ。SPEC の各節と対応。

```jsonc
{
  "version": "1.0",
  "crit": {                          // §3.4 会心率式
    "kotsuBonus": 0.01,              // コツ(+1%)
    "passiveEffective": 0.001,       // パッシブ実効値(+0.1%、仮定§6-1)
    "aimMultiplier": 7,              // ねらい倍率
    "hissatsuMultiplier": 2,         // 必殺補正
    "shiftCritMultiplier": 2,        // シフト会心補正
    "randomCritMultiplier": 1,       // ランダム会心(補正なし、仮定§6-3)
    "fixedBonus": {
      "rainbowCritTurn": 0.24,       // 虹布の会心ターン
      "lightGlowCell": 0.24          // 光布の発光マス
    }
  },
  "hissatsuCharge": {                // §3.3 必殺チャージ(仮定§6-4,5)
    "baseRate": 0.00233
  },
  "clothTrait": {                    // §3.6
    "firstTurn": 5,                  // 初回発動ターン
    "interval": 4,                   // 以降の発動間隔
    "regenAmounts": [12, 13, 14, 15, 16],   // 再生布の回復量候補(等確率)
    "rainbowCostHalfFirst": true,    // 虹布の初回は半減
    "rainbowCostUpFactor": 1.5,      // 会心ターンの消費倍率
    "lightCellCorrection": 2         // 発光マスのマス補正
  },
  "concentrationRecovery": {         // §3.5 集中力の自動回復
    "threshold": 10, "chance": 0.1, "amount": 30, "oncePerSession": true
  },
  "gauge": {                         // §2 用語
    "yellowRange": 4,                // 黄色ゲージ: 誤差≤4
    "penaltyError": 9                // ゲージ外ペナルティの評価値(§3.7)
  },
  "evaluation": {                    // §3.7 評価境界(マス数→境界値)
    "9": { "star3": 8, "star2": 17, "star1": 36, "star0": 49 },
    "7": { "star3": 5, "star2": 17, "star1": 27, "star0": 30 },
    "6": { "star3": 4, "star2": 11, "star1": 24, "star0": 39 },
    "4": { "star3": 2, "star2": 7,  "star1": 16, "star0": 29 }
  }
}
```

- 丸め規則(正方向丸め、虹布の端数切り上げ)はパラメータではなく**コアの固定ロジック**とする。

## 2. ダメージ値の算出(データファイルなし)

**ダメージはコア側で計算式(SPEC §3.2)から算出する**。データファイル(damage-tables.json)は持たない。(2026-07-03 ユーザー決定: 計算結果にブレがない限り計算式実装で可)

- 乱数: 基礎値を 12〜18(縫い)/-6〜-9(糸ほぐし)から等確率で1つ選び、式と丸め規則を適用。
- 糸ほぐしは負のダメージとして同一経路で処理(SPEC §3.2 の負値表現)。
- 会心の2倍・マス補正・基準値/初期状態の頭打ちもコアの処理。
- **SPEC §3.2 のダメージテーブル(全24セル+糸ほぐし8セル)はユニットテストの期待値として全数突き合わせ、計算実装との完全一致を担保する**。

## 3. needles.json

§3.4 針テーブル+開幕効果。

```jsonc
{
  "version": "1.0",
  "needles": [
    { "id": "copper",   "name": "銅のさいほう針",     "concentration": 0,  "critRate": [0.010, 0.011, 0.012, 0.020] },
    { "id": "iron",     "name": "鉄のさいほう針",     "concentration": 10, "critRate": [0.015, 0.016, 0.017, 0.025] },
    { "id": "silver",   "name": "銀のさいほう針",     "concentration": 15, "critRate": [0.020, 0.021, 0.022, 0.030] },
    { "id": "platinum", "name": "プラチナさいほう針", "concentration": 25, "critRate": [0.025, 0.026, 0.027, 0.035] },
    { "id": "super",    "name": "超さいほう針",       "concentration": 35, "critRate": [0.030, 0.031, 0.032, 0.040] },
    { "id": "miracle",  "name": "奇跡のさいほう針",   "concentration": 50, "critRate": [0.033, 0.034, 0.035, 0.043],
      "openingEffect": { "type": "concentration", "chance": 0.3, "amount": 30 } },
    { "id": "hikari",   "name": "光のさいほう針",     "concentration": 45, "critRate": [0.036, 0.037, 0.038, 0.046],
      "openingEffect": { "type": "hissatsuCharge", "chance": 0.1 } }
  ]
}
```

- `critRate` は ★0〜★3 の順の4要素配列(基礎会心率+道具のできのよさの合算値)。

## 4. skills.json

§3.3 特技一覧。対象パターンは**アンカー(起点マス)からのオフセット配列**でデータ化する。

```jsonc
{
  "version": "1.0",
  "skills": [
    { "id": "nuu",            "name": "ぬう",             "learnLv": 1,  "cost": 5,  "kind": "sew",     "multiplier": 1,    "target": "single" },
    { "id": "yoko_nui",       "name": "ヨコぬい",         "learnLv": 2,  "cost": 8,  "kind": "sew",     "multiplier": 1,    "target": "row2" },
    { "id": "kagen_nui",      "name": "かげんぬい",       "learnLv": 3,  "cost": 10, "kind": "sew",     "multiplier": 0.5,  "target": "single" },
    { "id": "taki_nobori",    "name": "滝のぼり",         "learnLv": 5,  "cost": 8,  "kind": "sew",     "multiplier": 1,    "target": "col2" },
    { "id": "tasuki_nui",     "name": "たすきぬい",       "learnLv": 7,  "cost": 7,  "kind": "sew",     "multiplier": 1,    "target": "diag_up2" },
    { "id": "crit_up_10",     "name": "会心率アップ",     "learnLv": 10, "kind": "passive", "nominal": 0.001 },
    { "id": "nibai_nui",      "name": "2倍ぬい",          "learnLv": 13, "cost": 9,  "kind": "sew",     "multiplier": 2,    "target": "single" },
    { "id": "suihei_nui",     "name": "水平ぬい",         "learnLv": 15, "cost": 10, "kind": "sew",     "multiplier": 1,    "target": "row3" },
    { "id": "seishin_toitsu", "name": "精神統一",         "learnLv": 17, "cost": 7,  "kind": "support", "effect": "lockPower", "duration": 3 },
    { "id": "otaki_nobori",   "name": "大滝のぼり",       "learnLv": 19, "cost": 10, "kind": "sew",     "multiplier": 1,    "target": "col3" },
    { "id": "crit_up_20",     "name": "会心率アップ",     "learnLv": 20, "kind": "passive", "nominal": 0.002 },
    { "id": "nerai_nui",      "name": "ねらいぬい",       "learnLv": 23, "cost": 16, "kind": "sew",     "multiplier": 1,    "target": "single", "aim": true },
    { "id": "gyaku_tasuki",   "name": "逆たすきぬい",     "learnLv": 25, "cost": 7,  "kind": "sew",     "multiplier": 1,    "target": "diag_down2" },
    { "id": "ito_hogushi",    "name": "糸ほぐし",         "learnLv": 27, "cost": 16, "kind": "recover", "target": "single" },
    { "id": "crit_up_30",     "name": "会心率アップ",     "learnLv": 30, "kind": "passive", "nominal": 0.003 },
    { "id": "sanbai_nui",     "name": "3倍ぬい",          "learnLv": 33, "cost": 12, "kind": "sew",     "multiplier": 3,    "target": "single" },
    { "id": "power_shift",    "name": "ぬいパワーシフト", "learnLv": 38, "cost": 7,  "kind": "support", "effect": "shiftPower" },
    { "id": "hissatsu_up",    "name": "必殺率アップ",     "learnLv": 45, "kind": "passive" },
    { "id": "shitsuke_gake",  "name": "しつけがけ",       "learnLv": 47, "cost": 13, "kind": "support", "effect": "cellCorrection", "target": "single" },
    { "id": "makikomi_nui",   "name": "巻きこみぬい",     "learnLv": 52, "cost": 13, "kind": "sew",     "target": "plus5",
      "multipliers": { "center": 1.5, "around": 0.75 } },
    { "id": "han_kagen_nui",  "name": "半かげんぬい",     "learnLv": 75, "cost": 12, "kind": "sew",     "multiplier": 0.75, "target": "single" },
    { "id": "midare_nui",     "name": "みだれぬい",       "learnLv": 80, "cost": 7,  "kind": "sew",     "target": "random4",
      "multipliers": [2, 1, 1, 0.5] },
    { "id": "muga_no_kyochi", "name": "無我の境地",       "kind": "hissatsu", "cost": 0 }
  ],
  "targetPatterns": {                // アンカー(r,c)=(0,0) からのオフセット [dr, dc]
    "single":     [[0, 0]],
    "row2":       [[0, 0], [0, 1]],
    "col2":       [[0, 0], [-1, 0]],
    "diag_up2":   [[0, 0], [-1, 1]],
    "diag_down2": [[0, 0], [-1, -1]],
    "row3":       [[0, -1], [0, 0], [0, 1]],
    "col3":       [[-1, 0], [0, 0], [1, 0]],
    "plus5":      [[0, 0], [-1, 0], [1, 0], [0, -1], [0, 1]]
  }
}
```

- `kind`: `sew` 縫い / `recover` 糸ほぐし / `support` 補助 / `passive` パッシブ / `hissatsu` 必殺技。
- パッシブの実効値・必殺の効果は game-params.json / コアが持ち、ここでは存在・習得Lv・名目値のみ(W2のLv制限用)。
- アンカー規約は確定済み(2026-07-06、SPEC §4.3): 選択マス=アンカー。滝のぼりは「選択マスとその上」= col2 の [-1,0]。水平ぬい・大滝のぼりは選択マス中心の3マス。巻きこみぬい(plus5)のはみ出しは適用時に布外を無視(§3.3)。
- みだれぬいの `multipliers` は生成順(2倍→1倍→1倍→0.5倍)。対象選択・ソートはコアの処理。
- power_shift の effect: **使用ターンのぬいパワーを除く候補へのランダム変更**(プレイヤー選択なし。候補・確率は SPEC §6-10 の仮定)。

## 5. concentration.json

§3.5 レベル別集中力テーブル。

```jsonc
{
  "version": "1.0",
  "base": [50, 51, 54, /* …Lv順に80要素… */, 205, 207]   // index = レベル-1
}
```

## 6. recipes.csv → 内部モデルと検証

### 内部モデル(変換後)

```ts
interface RecipeDef {
  id: string;
  name: string;
  category: Category;
  clothType: ClothType;
  rows: number; cols: number;
  cells: { r: number; c: number; base: number }[];  // 存在するマスのみ
  powerCycle: Power[];                              // unknown 含む。critx2 は不可
}
```

### バリデーション規則

| # | 規則 | 違反時 |
|---|---|---|
| V1 | id: `^[a-z0-9_]+$` かつ全行で一意 | エラー |
| V2 | category / cloth_type が enum に含まれる | エラー |
| V3 | rows/cols が category の固定値と一致(leg=2×2、head=2×3、body_upper=3×3、body_lower=3×2、arm・rug=2×3、doll=3×3)。head はセル位置も固定((1,2),(2,1),(2,2),(2,3)の凸形) | エラー |
| V4 | (欠番: ラグの向き確定により V3 に統合) | - |
| V5 | セルは rows×cols の範囲内のみに存在し、値は正整数 | エラー |
| V6 | マス数が category と一致(head/leg=4、body_upper=9、body_lower/arm/rug=6、doll=7) | エラー |
| V7 | power_order: 1トークン以上、トークンは 弱い/普通/強い/最強/？ のみ(会心×2不可) | エラー |
| V8 | 空行・全列空はスキップ | 警告 |

- エラー行は読み込み対象から除外し、UI上に行番号つきで理由を表示する。
- CSVの日本語トークン(部位・布・パワー)→enumへの対訳表はローダが持つ。

## 7. 設計判断(2026-07-03 承認済み)

1. ID・enum値は半角英字、表示名は日本語 `name`(§0-2)
2. ~~糸ほぐしテーブルは負値で保持~~ → ダメージはコア側で計算式から算出し、データファイル化しない(§2。負値表現自体はコア内部で維持)
3. 特技の対象パターンは「アンカー+オフセット配列」でデータ化し、アンカー規約の最終確定はUI詳細設計に委ねる(§4)
4. パッシブ・必殺も skills.json に含める(実効値は game-params / コア側)(§4)
5. ~~ラグの rows/cols は向き確定まで両方許容~~ → ラグは腕と同じ2行×3列で確定(V3)
6. パラメータエディタ(F7)の編集対象は game-params.json のみ(§0-5)

## 8. レシピデータの将来の持ち方(W1: アプリ内入力画面)

スマホアプリ化(W1)でレシピ入力画面を設ける際も、**DBは導入せずCSV+端末内ストレージで対応する**方針。

- 内部モデル `RecipeDef`(§6)は保存形式に依存しないため、保存先の追加は `DataProvider`(ARCHITECTURE A5)の実装追加で済む。
- アプリ内で入力・編集したレシピは端末内ストレージ(IndexedDB。Capacitor化時はそのままWebViewのIndexedDBが使える)に構造化JSONとして保存する。
- CSVは「同梱マスタ+バックアップ/共有用のインポート・エクスポート形式」として残す。
- SQLite等のDBが必要になるのは「レシピ件数が数千超」「複雑な検索」「端末間同期」等の要件が出た場合のみで、現時点では想定しない。

**実行結果の保存・リプレイ検索機能を追加する場合(将来)も同方針で対応する:**

- 保存レコードは「検索用メタデータ(recipeId・日時・★・針・誤差合計・タグ)」と「リプレイ本体(シード+設定+行動列、A6形式)」の2層構造とし、IndexedDB に JSON のまま格納する。
- 検索はメタデータのインデックスで行い、本体は開くときのみ読む。個人利用の蓄積規模(数千件)では性能上の問題はない。
- 全文検索・数十万件規模の集計・端末間同期が必要になった時点が SQLite への乗り換え判断点。meta/本体分離をしておけば移行コストは小さい。

## 9. 更新履歴

- v0.2 (2026-07-03): 承認反映。ダメージテーブルのデータファイル化を廃止(コア計算式方式へ)、ラグ=2行×3列確定。レシピデータの将来の持ち方(§8)を追記。
- v0.1 (2026-07-03): 初版ドラフト。全データファイルのスキーマ、recipes.csv検証規則、設計判断6点を提示。

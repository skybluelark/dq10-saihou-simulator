# 公開・配信設計 (PUBLISHING)

Web版(ブラウザ=**デモアプリ**)の公開環境とデプロイ運用の正。環境・公開まわりの記録はこの文書に集約する(他文書とのコンフリクト回避のため、BACKEND_DESIGN.md / MOBILE_UI_DESIGN.md 等には環境事項を書き足さない)。

- 上位方針の正: [BACKEND_DESIGN.md](BACKEND_DESIGN.md) §2 / §11-4(Cloudflare Pages 移行・fluoritedq10 非公開リポジトリ・デモアプリ+仮公開ページ)
- 権利面の正: [MOBILE_UI_DESIGN.md](MOBILE_UI_DESIGN.md) §4.2(DQ10・スクウェア・エニックス関連の名称/素材の線引き)

## 1. 全体構成(確定: 2026-07-12)

```
[ skybluelark/dq10-saihou-simulator ]  … 開発リポジトリ(現行・公開)
        │  開発を継続。GitHub Actions(deploy.yml)で GitHub Pages に開発用公開(当面維持。§7.3 と同一のサブパス構成)
        │
        │  リリース時: git push でミラー
        ▼
[ fluoritedq10/FluoNote ]  … 公開リポジトリ(非公開)
        │  GitHub Actions(deploy-cloudflare.yml): 品質ゲート → build:site → wrangler pages deploy
        ▼
[ Cloudflare Pages: fluonote ]  … fluonote.pages.dev(サブパス構成・§7.3)
        ├─ /          … ランディング(site/index.html)
        ├─ /sample/   … 現行シンプルUI(vite dist/。base:'./' で相対解決)
        └─ /demo/     … 最終公開デモ(プレースホルダ。リッチUI配置予定)
```

- **デプロイ方式**: GitHub Actions + wrangler(Direct Upload)。Cloudflare 側の Git 連携ビルドは使わない。理由=現行の「品質ゲート(unit+stats+eslint+build)通過時のみ公開」を Actions 側で一元管理し続けるため。
- **リポジトリ構成**: 2リポジトリ・ミラー方式。開発は skybluelark で継続、公開は fluoritedq10(非公開)。BACKEND_DESIGN §2「現行=開発用/公開は別アカウント」に準拠。
- **仮公開ページ(§③)** とデモアプリの配置関係は §8 未決事項。

## 2. リポジトリ構成(2リポジトリ・ミラー方式)

- 開発リポジトリ(現行): `https://github.com/skybluelark/dq10-saihou-simulator.git`
- 公開リポジトリ(**非公開**・作成済 2026-07-12): `https://github.com/fluoritedq10/FluoNote.git`(非公開なので公開面への露出はない)
- 両リポジトリは同一ツリーをミラーする。ワークフローファイルは両方に同居し、`github.repository_owner` ガード(公開側 `fluoritedq10`)で動作先を振り分ける(§6)。
- ミラー手順(ローカルで一度だけリモート追加):
  ```
  git remote add fluorite https://github.com/fluoritedq10/FluoNote.git
  ```
  リリースのたびに:
  ```
  git push fluorite master
  ```

## 3. デプロイ方式(GitHub Actions + wrangler / Direct Upload)

- fluoritedq10 リポジトリの `.github/workflows/deploy-cloudflare.yml` が master への push で起動。
- ジョブ: `npm ci` → `npm test` → `npm run test:stats` → `npx eslint src tests scripts` → **`npm run build:site`**(vite build 後に `scripts/build-site.mjs` でサブパス配信ツリー `dist-site/` を組み立て) → `cloudflare/wrangler-action@v3` で `pages deploy`。
- Cloudflare 認証は GitHub Secrets の `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` を使用(コードには含めない)。
- Cloudflare Pages プロジェクトは **Direct Upload モード**(Git 未連携)で作成する(作成済 2026-07-12)。プロジェクト名は `wrangler.toml` の `name`(`fluonote`)と一致させる。

## 4. ユーザー実施事項(認証情報を扱う手順は必ずユーザー自身が行う)

> **§4-1〜7 は完了(2026-07-12)**。以降のデモ公開は `git push fluorite master` のみで自動化済み(§9 v0.7)。

エージェントは資格情報(アカウント・パスワード・APIトークン)を一切扱わない。以下は番号順にユーザーが実施する。

1. **Cloudflare アカウント作成**(公開用。fluoritedq10 名義で運用するなら、その運用に紐づくメールで作成)。
2. **fluoritedq10 の GitHub アカウント作成**と、**非公開リポジトリ** `FluoNote` の作成(完了 2026-07-12)。
3. **Cloudflare Pages プロジェクト作成**(Direct Upload。プロジェクト名 `fluonote` で作成済 2026-07-12)。参考:
   - ダッシュボード: Workers & Pages → Create → Pages → 「Direct Upload(直接アップロード)」→ プロジェクト名 `fluonote`。
   - または wrangler: `npx wrangler login`(ブラウザで OAuth 承認)後、`npx wrangler pages project create fluonote --production-branch master`。
4. **API トークン発行**(Cloudflare: My Profile → API Tokens → Create Token → Custom token)。権限は最小で **Account → Cloudflare Pages → Edit** のみ。対象アカウントを自分のアカウントに限定。
5. **Account ID の取得**(Cloudflare ダッシュボードのアカウント設定、または `npx wrangler whoami`)。
6. **GitHub Secrets 登録**(fluoritedq10 リポジトリ → Settings → Secrets and variables → Actions):
   - `CLOUDFLARE_API_TOKEN` = 手順4のトークン
   - `CLOUDFLARE_ACCOUNT_ID` = 手順5の Account ID
7. **GitHub Actions の有効化**(非公開リポジトリで Actions が無効なら Settings → Actions で許可)。

> エージェント担当分: `wrangler.toml`・両ワークフロー・本手順書・fluoritedq10 リポジトリ構成の設計(§1〜§3)。

## 5. デプロイ手順

### 5.1 通常リリース(自動)
1. skybluelark で開発・品質ゲート通過・コミット。
2. `git push fluorite master`(ミラー)。
3. fluoritedq10 の Actions が品質ゲート→`wrangler pages deploy` を実行。成功で `<project>.pages.dev` に反映。

### 5.2 初回デプロイ / ローカル手動フォールバック
CI を待たず動作確認したい場合(認証はユーザーがローカルで実施):
```
$env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')
npx wrangler login
npm run build:site   # dist-site/(= / + /sample/ + /demo/)を組み立て
npx wrangler pages deploy dist-site --project-name=fluonote --branch=master
```
> PATH 前置きは CLAUDE.md §6(このマシン固有)。

## 6. 設定ファイル一覧

| ファイル | 役割 |
|---|---|
| `wrangler.toml` | Cloudflare Pages プロジェクト設定(name=fluonote / **pages_build_output_dir=dist-site**) |
| `site/index.html` | ランディング(fluonote ルート `/`。CTA→`/sample/`)。旧 fluonote-landing から統合(§7.2) |
| `site/demo/index.html` | `/demo/` プレースホルダ(最終公開デモの配置予定地) |
| `scripts/build-site.mjs` | サブパス配信ツリー `dist-site/` を組み立てる(vite dist→/sample/、site→ルート)。`npm run build:site` から呼ぶ |
| `.github/workflows/deploy-cloudflare.yml` | fluoritedq10 でのみ動作(`repository_owner=='fluoritedq10'`)。品質ゲート→`build:site`→Cloudflare Pages デプロイ |
| `.github/workflows/deploy.yml` | skybluelark でのみ動作(`repository_owner=='skybluelark'`)。GitHub Pages デプロイ(当面維持。2026-07-13 から **`build:site` → `dist-site/` を公開し、Cloudflare と同一のサブパス構成**) |

- 両ワークフローが同一ツリーに同居してもオーナーガードで排他動作するため、ミラーでコンフリクトしない。

## 7. 確認チェックリスト

- [ ] `vite.config.ts` の `base: './'`(相対パス)で Cloudflare Pages ルート配信でもアセットが解決すること。`npm run build` 後の `dist/index.html` が `./assets/...` の相対参照になっていることを確認(2026-07-12: ビルド出力で相対参照を確認済み)。
- [ ] このアプリはクライアントルーティング無し(単一画面)のため SPA フォールバック(`_redirects`)は不要。
- [ ] 初回デプロイ後、`<project>.pages.dev` で操作フロー(特技選択→マスタップ→再タップ実行)とコンソールエラー無しを確認。
- [ ] fluoritedq10 リポジトリで Actions が緑、Cloudflare Pages のデプロイが Production として記録されること。
- [ ] Secrets(`CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID`)がコード・ログに露出していないこと。

### 7.1 デモアプリの検証UI (?verify)(§② 2026-07-12)

- ブラウザ版は**デモアプリ**として、検証/開発向けUI(シード指定・リプレイ入出力・マス別誤差内訳・ログのロール表示)を通常画面から隠す。
- これらは URL クエリ `?verify=1` を付けたときのみ表示される隠しフラグ(`App.tsx` の `devMode`)。公開デモの既定は非表示。開発・QA は `https://<host>/?verify=1` で従来機能を復帰できる。
- アンドゥ/リドゥ(1手戻す・1手進む)は検証UIから独立した**通常操作**として常時表示。
- **サイクル予告表示は ON 固定**(トグル・localStorage 設定を廃止。2026-07-12)。予告(次パワー・サイクル全体)は常時表示。
- **シンプルUIの最小調整(2026-07-13、リッチUIと非バッティング)**:
  - タイトルを「DQ10 さいほうシミュレータ」→「さいほうシミュレーター（デモ版）」に変更(H1・タブ<title>)。
  - ぬいパワー行の現在/次パワーのバッジにも布特性予告の下線を付加(サイクル表示の下線を流用)。
  - 布グリッド(凡例含む)を水平センタリング。
  - 特技欄を5行4列グリッドに整列し、**スマホ版のデフォルト配置(MOBILE_UI_DESIGN §5.3.1)の順(行優先・固定)**に合わせた(`SkillPanel` の `SKILL_ORDER`)。4列は均等可変幅(`minmax(0,1fr)`)でコンテナ幅=行動ログ幅に合わせ、4列目の右端がログ右端に一致・狭幅でも横あふれしない(2026-07-13 調整)。
- UI層のみの変更で `src/core` は不変。上記はデモ挙動のため、主セッションのUI設計書へ相互参照を残すかは主セッション判断。

### 7.2 ランディング(仮公開ページ)(§③)

- デモへのリンクを持つ**暫定公開ページ**。表示ブランド=**FluoNote**、`noindex`+「暫定公開版」バッジ付き。CTA「デモアプリを開く→」は `/sample/`(現行シンプルUI)へ。
- **2026-07-13 に simulator リポジトリへ統合**: ソースは `site/index.html`。`fluonote` プロジェクトの**ルート `/`** で配信(サブパス構成 §7.3)。自動デプロイ(`git push fluorite master`)の対象に含まれる。
- 権利方針(§③ 確定): **ゲーム名を記述的に言及+免責文**。『ドラゴンクエストX』を記述的に参照し、「スクウェア・エニックス社とは無関係の非公式ファンツール」「ゲーム内の画像・ロゴ・フォント・SS等の著作物は不使用」「『ドラゴンクエスト』は登録商標」を明記。§4.2 の流用不可を順守。
- **廃止(要ユーザー実施)**: 旧 **`fluonote-landing` Cloudflare プロジェクト**(`fluonote-landing.pages.dev`)と **`fluoritedq10/FluoNote-Landing` GitHub リポジトリ**、ローカル `E:\dev\dq10-saihou-landing` は統合により冗長。Cloudflare/GitHub 側の削除はユーザーが実施(ローカルフォルダは任意で削除)。

### 7.3 サブパス構成(2026-07-13 実装)

`fluonote` プロジェクト(1つ)を **`scripts/build-site.mjs`** でサブパスに組み立てて配信する:

| パス | 中身 | ソース |
|---|---|---|
| `/` | ランディング | `site/index.html` |
| `/sample/` | 現行シンプルUI(デモ) | vite `dist/`(`base:'./'` で相対解決) |
| `/demo/` | 最終公開デモ(**プレースホルダ**。リッチUI=主セッション管轄) | `site/demo/index.html` |

- ビルド: `npm run build:site`(= `npm run build` → `node scripts/build-site.mjs`)が `dist-site/` を生成。`wrangler.toml` の `pages_build_output_dir=dist-site`。
- `base:'./'` のためアプリはどの階層でも動く(`/sample/` で `./assets/…` が `/sample/assets/…` に解決。1280/375px+実配信ツリーで確認済)。SPAルーティング無しのため `_redirects` 不要。
- CTA/リンクは**相対パス+末尾スラッシュ**(`sample/`、`/demo/` からは `../sample/`)で参照する(2026-07-13 変更)。絶対パス `/sample/` はドメイン直下配信の Cloudflare でしか解決できず、リポジトリ名サブパス配下で配信される GitHub Pages で壊れるため。
- GitHub Pages(skybluelark)側も**同一のサブパス構成**で配信する(2026-07-13 変更。deploy.yml が `build:site` → `dist-site/` を公開)。開発確認と本番の配信構成が一致し、確認結果がそのまま本番の代表になる。URL はサブパスぶん深くなる: `https://skybluelark.github.io/dq10-saihou-simulator/`(ランディング)/ `…/sample/`(アプリ)。

## 8. 未決事項(申し送り)

1. ~~**Cloudflare Pages プロジェクト名 / pages.dev サブドメイン**~~ → **確定(2026-07-12)**: ブランド "FluoNote"。**命名規則=GitHub リポジトリはブランド表記(大文字可): `FluoNote` / `FluoNote-Landing`、Cloudflare Pages プロジェクトは英小文字: `fluonote`(`fluonote.pages.dev`) / `fluonote-landing`。** 以降の別アプリも同規則で。
2. ~~**仮公開ページ(§③)の配置**~~ → **解決(2026-07-12)**: デモとは別の小さな Pages プロジェクトで公開(§7.2)。ソースは `E:\dev\dq10-saihou-landing`。
3. **カスタムドメイン**: 当面 `*.pages.dev`。独自ドメインは仮公開の反応を見て判断。
4. **GitHub Pages(skybluelark)の廃止時期**: Cloudflare 仮公開の確認後に廃止を検討。それまでは開発用として維持。
5. **権利・ブランド**: ブランドは **"FluoNote"** 確定。公開物の名称/素材は §4.2 の線引き(記述的言及+免責・素材流用不可)に従う。デモアプリ内タイトルは **「さいほうシミュレーター（デモ版）」**(2026-07-13変更。従来の "DQ10 さいほうシミュレータ" から DQ10 表記を外し「デモ版」を明記)。ランディングの表示ブランドは "FluoNote" 確定(§7.2)。
6. ~~**配信構成の将来計画**~~ → **実装(2026-07-13、§7.3)**: `fluonote` を `/`=ランディング・`/sample/`=現行シンプルUI・`/demo/`=最終公開デモ(プレースホルダ)のサブパス構成にした。ランディングは統合(§7.2)。**残: /demo/ のリッチUI本体**(プレイ画面のみ・スマホUI寄せ。レシピ選択/ユーザー設定/リプレイ等は省く。**MOBILE_UI_DESIGN 方向=主セッション管轄**、私はサブパス/配信の土台のみ)。CTA の /demo/ 切替はリッチUI完成後。
7. **旧 fluonote-landing の廃止**: §7.2 のとおり Cloudflare プロジェクト・GitHub リポジトリの削除をユーザーが実施。

## 9. 更新履歴

- v0.14 (2026-07-13): **GitHub Pages(skybluelark)も Cloudflare と同一のサブパス構成に統一**(作業漏れの解消。ユーザー指示)。deploy.yml を `build:site` → `dist-site/` 公開に変更、`site/` 内のリンクを絶対パス `/sample/` から相対パス(`sample/`・`../sample/`)へ修正(GitHub Pages のリポジトリ名サブパス配下でも解決できるように)。§1/§6/§7.3 を更新。
- v0.13 (2026-07-13): **サブパス構成を実装(§7.3)**。`fluonote` を `/`(ランディング)・`/sample/`(現行シンプルUI)・`/demo/`(最終公開デモのプレースホルダ)に分割。ランディングを simulator へ統合(`site/`)し旧 `fluonote-landing` は廃止(削除はユーザー)。`scripts/build-site.mjs`+`build:site` 追加、`wrangler.toml` 出力を `dist-site` に、CI を `build:site` に変更。実配信ツリーで `/` `/sample/`(アセット `/sample/assets/` 解決)`/demo/` を確認。§8-6 を実装済へ。
- v0.12 (2026-07-13): 特技欄の列幅を固定104px→均等可変(`minmax(0,1fr)`)に変更。4列目の右端を行動ログ(=.app幅)の右端に一致させ、狭幅での横あふれを解消(1280px/375pxで確認)。
- v0.11 (2026-07-13): シンプルUIの最小調整4件(タイトル→「さいほうシミュレーター（デモ版）」/ぬいパワーのバッジに予告下線/布グリッド中央寄せ/特技欄を5行4列固定・§5.3.1順)。§7.1 に記録、§8-5 のタイトル記述を更新。UI層のみ・`src/core` 不変・全ゲート緑。
- v0.10 (2026-07-12): §8-6 追加 — 配信構成の将来計画(root=ランディング、シンプルUI/リッチUIをサブパス分離。実施は後日)。方針のみ記録、実装は未着手。
- v0.9 (2026-07-12): デモUI調整 — 「サイクル予告表示」をON固定化(トグル・設定廃止、UI層のみ・`src/core` 不変)。§7.1 に記録。
- v0.8 (2026-07-12): **仮公開ランディング公開完了**。表示ブランドを FluoNote に確定、ソースを `fluoritedq10/FluoNote-Landing`(非公開)へ push、Cloudflare `fluonote-landing` にデプロイ → `fluonote-landing.pages.dev` 稼働。これで ①環境/②デモUI/③仮公開ページ すべて公開まで到達。ランディングは CI 未設定(手動デプロイ)。
- v0.7 (2026-07-12): **デモの自動デプロイ完成・稼働確認**。APIトークン(無期限)・Account ID・GitHub Secrets 登録済。`fluoritedq10/FluoNote` の本番ブランチを `master` に設定 → `git push fluorite master`(ミラー)→ Actions 緑 → Cloudflare `fluonote` に Production/master デプロイ → `fluonote.pages.dev` 稼働を確認。認証は skybluelark→fluoritedq10 の切替が必要(GCM 資格情報の入れ替え)。以降のリリースは `git push fluorite master` のみ。
- v0.6 (2026-07-12): 命名規則を明確化。GitHub リポジトリはブランド表記(大文字可、ランディング=`FluoNote-Landing`)、Cloudflare/wrangler は英小文字(`fluonote-landing`)。デモの `FluoNote`↔`fluonote` と同じ対応。§7.2/§8-1 を更新。
- v0.5 (2026-07-12): デモ初回デプロイ確認済(`fluonote.pages.dev` 表示OK)。ランディング名称をユーザー決定によりGitHub/Cloudflare/wrangler すべて `fluonote-landing`(ハイフン)へ統一(アンダースコア案を撤回)。ローカル作業フォルダの改名は別プロセスのロックで保留。
- v0.4 (2026-07-12): ブランド "FluoNote" 確定を反映。デモ Cloudflare プロジェクト名を `fluonote`(`fluonote.pages.dev`)、公開リポジトリを `fluoritedq10/FluoNote`(作成済)、ランディングを `fluonote-landing`(pages.dev はアンダースコア不可)に更新。§8-1/§8-5 を確定へ。`wrangler.toml` の name を fluonote に変更。
- v0.3 (2026-07-12): §7.2 追加(仮公開ランディングページ=別 Pages プロジェクト・`E:\dev\dq10-saihou-landing`・権利方針=記述的言及+免責)。§8-2(配置)を解決に更新。
- v0.2 (2026-07-12): §7.1 追加。デモアプリの検証UIを `?verify` 隠しフラグ化(§②のUI整理)。アンドゥ/リドゥは常時表示へ昇格した旨を記録。
- v0.1 (2026-07-12): 初版。全体構成(2リポジトリ・ミラー方式 + GitHub Actions & wrangler / Direct Upload)、ユーザー実施事項、デプロイ手順、設定ファイル一覧、確認チェックリスト、未決事項を確定。`wrangler.toml`・`deploy-cloudflare.yml` 追加、`deploy.yml` をオーナーガード化。

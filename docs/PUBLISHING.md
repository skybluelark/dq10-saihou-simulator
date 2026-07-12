# 公開・配信設計 (PUBLISHING)

Web版(ブラウザ=**デモアプリ**)の公開環境とデプロイ運用の正。環境・公開まわりの記録はこの文書に集約する(他文書とのコンフリクト回避のため、BACKEND_DESIGN.md / MOBILE_UI_DESIGN.md 等には環境事項を書き足さない)。

- 上位方針の正: [BACKEND_DESIGN.md](BACKEND_DESIGN.md) §2 / §11-4(Cloudflare Pages 移行・fluoritedq10 非公開リポジトリ・デモアプリ+仮公開ページ)
- 権利面の正: [MOBILE_UI_DESIGN.md](MOBILE_UI_DESIGN.md) §4.2(DQ10・スクウェア・エニックス関連の名称/素材の線引き)

## 1. 全体構成(確定: 2026-07-12)

```
[ skybluelark/dq10-saihou-simulator ]  … 開発リポジトリ(現行・公開)
        │  開発を継続。GitHub Actions(deploy.yml)で GitHub Pages に開発用公開(当面維持)
        │
        │  リリース時: git push でミラー
        ▼
[ fluoritedq10/dq10-saihou-simulator ]  … 公開リポジトリ(非公開)
        │  GitHub Actions(deploy-cloudflare.yml): 品質ゲート → wrangler pages deploy
        ▼
[ Cloudflare Pages: dq10-saihou-sim ]  … デモアプリ本番(<project>.pages.dev)
```

- **デプロイ方式**: GitHub Actions + wrangler(Direct Upload)。Cloudflare 側の Git 連携ビルドは使わない。理由=現行の「品質ゲート(unit+stats+eslint+build)通過時のみ公開」を Actions 側で一元管理し続けるため。
- **リポジトリ構成**: 2リポジトリ・ミラー方式。開発は skybluelark で継続、公開は fluoritedq10(非公開)。BACKEND_DESIGN §2「現行=開発用/公開は別アカウント」に準拠。
- **仮公開ページ(§③)** とデモアプリの配置関係は §8 未決事項。

## 2. リポジトリ構成(2リポジトリ・ミラー方式)

- 開発リポジトリ(現行): `https://github.com/skybluelark/dq10-saihou-simulator.git`
- 公開リポジトリ(新規・**非公開**): `https://github.com/fluoritedq10/dq10-saihou-simulator.git`(名称は任意。非公開なので公開面への露出はない)
- 両リポジトリは同一ツリーをミラーする。ワークフローファイルは両方に同居し、`github.repository_owner` ガードで動作先を振り分ける(§6)。
- ミラー手順(ローカルで一度だけリモート追加):
  ```
  git remote add fluorite https://github.com/fluoritedq10/dq10-saihou-simulator.git
  ```
  リリースのたびに:
  ```
  git push fluorite master
  ```

## 3. デプロイ方式(GitHub Actions + wrangler / Direct Upload)

- fluoritedq10 リポジトリの `.github/workflows/deploy-cloudflare.yml` が master への push で起動。
- ジョブ: `npm ci` → `npm test` → `npm run test:stats` → `npx eslint src tests scripts` → `npm run build` → `cloudflare/wrangler-action@v3` で `pages deploy`。
- Cloudflare 認証は GitHub Secrets の `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` を使用(コードには含めない)。
- Cloudflare Pages プロジェクトは **Direct Upload モード**(Git 未連携)で作成する。プロジェクト名は `wrangler.toml` の `name`(既定 `dq10-saihou-sim`)と一致させる。

## 4. ユーザー実施事項(認証情報を扱う手順は必ずユーザー自身が行う)

エージェントは資格情報(アカウント・パスワード・APIトークン)を一切扱わない。以下は番号順にユーザーが実施する。

1. **Cloudflare アカウント作成**(公開用。fluoritedq10 名義で運用するなら、その運用に紐づくメールで作成)。
2. **fluoritedq10 の GitHub アカウント作成**と、**非公開リポジトリ**の作成(名称例 `dq10-saihou-simulator`)。
3. **Cloudflare Pages プロジェクト作成**(Direct Upload)。いずれか:
   - ダッシュボード: Workers & Pages → Create → Pages → 「Direct Upload(直接アップロード)」→ プロジェクト名 `dq10-saihou-sim`。
   - または wrangler: `npx wrangler login`(ブラウザで OAuth 承認)後、`npx wrangler pages project create dq10-saihou-sim --production-branch master`。
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
npm run build
npx wrangler pages deploy dist --project-name=dq10-saihou-sim --branch=master
```
> PATH 前置きは CLAUDE.md §6(このマシン固有)。

## 6. 設定ファイル一覧

| ファイル | 役割 |
|---|---|
| `wrangler.toml` | Cloudflare Pages プロジェクト設定(name / compatibility_date / pages_build_output_dir=dist) |
| `.github/workflows/deploy-cloudflare.yml` | fluoritedq10 でのみ動作(`repository_owner=='fluoritedq10'`)。品質ゲート→Cloudflare Pages デプロイ |
| `.github/workflows/deploy.yml` | skybluelark でのみ動作(`repository_owner=='skybluelark'`)。従来の GitHub Pages デプロイ(当面維持) |

- 両ワークフローが同一ツリーに同居してもオーナーガードで排他動作するため、ミラーでコンフリクトしない。

## 7. 確認チェックリスト

- [ ] `vite.config.ts` の `base: './'`(相対パス)で Cloudflare Pages ルート配信でもアセットが解決すること。`npm run build` 後の `dist/index.html` が `./assets/...` の相対参照になっていることを確認(2026-07-12: ビルド出力で相対参照を確認済み)。
- [ ] このアプリはクライアントルーティング無し(単一画面)のため SPA フォールバック(`_redirects`)は不要。
- [ ] 初回デプロイ後、`<project>.pages.dev` で操作フロー(特技選択→マスタップ→再タップ実行)とコンソールエラー無しを確認。
- [ ] fluoritedq10 リポジトリで Actions が緑、Cloudflare Pages のデプロイが Production として記録されること。
- [ ] Secrets(`CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID`)がコード・ログに露出していないこと。

## 8. 未決事項(申し送り)

1. **Cloudflare Pages プロジェクト名 / pages.dev サブドメイン**: 既定 `dq10-saihou-sim`。サブドメインは公開面に露出するため、ブランド文言(fluorite 等)の確定(§③のユーザー確認事項)に合わせて改名可否を決める。改名時は Cloudflare プロジェクト名・`wrangler.toml` の name・CI の一致を保つ。
2. **仮公開ページ(§③)の配置**: 別 Pages プロジェクト(例 ランディング→デモへリンク)か、同一ドメイン構成か。デモアプリの配信確立(本§①)後に §③ で設計。
3. **カスタムドメイン**: 当面 `*.pages.dev`。独自ドメインは仮公開の反応を見て判断。
4. **GitHub Pages(skybluelark)の廃止時期**: Cloudflare 仮公開の確認後に廃止を検討。それまでは開発用として維持。
5. **権利・ブランド**: 公開物(§③)の名称/素材は MOBILE_UI_DESIGN §4.2 の線引きに従う。デモアプリ内の表記(現行 "DQ10 さいほうシミュレータ")の公開可否も §③でユーザー確認。

## 9. 更新履歴

- v0.1 (2026-07-12): 初版。全体構成(2リポジトリ・ミラー方式 + GitHub Actions & wrangler / Direct Upload)、ユーザー実施事項、デプロイ手順、設定ファイル一覧、確認チェックリスト、未決事項を確定。`wrangler.toml`・`deploy-cloudflare.yml` 追加、`deploy.yml` をオーナーガード化。

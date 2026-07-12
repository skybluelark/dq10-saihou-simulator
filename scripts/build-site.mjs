// サブパス構成の配信ツリーを組み立てる (docs/PUBLISHING.md §7.3)。
//   dist-site/           … Cloudflare Pages("fluonote")へデプロイするルート
//   ├─ index.html        … ランディング(site/ の内容 = /)
//   ├─ demo/             … 最終公開デモの配置予定地(site/demo/ のプレースホルダ)
//   └─ sample/           … 現行シンプルUI(vite の dist/ = /sample/。base:'./' で相対解決)
//
// 前提: 先に `vite build` で dist/ を生成しておくこと(package.json の "build:site")。
// Node の fs.cpSync を使うので Windows(ローカル)・Ubuntu(CI)双方で動く。

import { rmSync, mkdirSync, cpSync, existsSync } from 'node:fs';

const DIST = 'dist'; // vite の出力(アプリ本体)
const SITE = 'site'; // ランディング + demo プレースホルダ(サイトの外殻)
const OUT = 'dist-site'; // 組み立て後の配信ルート

if (!existsSync(DIST)) {
  console.error(`[build-site] '${DIST}/' がありません。先に \`npm run build\` を実行してください。`);
  process.exit(1);
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

// site/ の内容(ランディング index.html + demo/ プレースホルダ)をルートへ
cpSync(SITE, OUT, { recursive: true });
// アプリ本体を /sample/ へ
cpSync(DIST, `${OUT}/sample`, { recursive: true });

console.log(`[build-site] assembled '${OUT}/': / (landing) + /sample/ (app) + /demo/ (placeholder)`);

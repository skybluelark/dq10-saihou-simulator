// デバッグモード判定 (SPEC §4.3)
// URLクエリ ?debug=1(ON)/ ?debug=0(OFF)が最優先。
// 省略時は ui-config.json の debugMode をデフォルトとして使う(後方互換)。
// URLはセッション中に変化しないため、モジュール読み込み時に一度だけ解決する。

import uiConfig from './ui-config.json';

function resolveDebugMode(): boolean {
  if (typeof window === 'undefined') return uiConfig.debugMode; // 非ブラウザ環境
  const param = new URLSearchParams(window.location.search).get('debug');
  if (param === null) return uiConfig.debugMode;
  return param === '1' || param === 'true';
}

export const DEBUG_MODE: boolean = resolveDebugMode();

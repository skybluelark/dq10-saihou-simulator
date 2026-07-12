// UI設定の localStorage 自動保存/復元 (ARCHITECTURE N4)
// 対象: レシピ選択・針(種類・★数)・サイクル予告表示トグル。

import type { NeedleType } from '../core';

export interface UiSettings {
  recipeId: string | null;
  needleType: NeedleType;
  needleStars: 0 | 1 | 2 | 3;
  showCyclePreview: boolean;
}

export const DEFAULT_SETTINGS: UiSettings = {
  recipeId: null,
  needleType: 'copper',
  needleStars: 0,
  showCyclePreview: true,
};

const STORAGE_KEY = 'dq10-saihou:ui-settings:v1';

const NEEDLE_TYPES: readonly NeedleType[] = [
  'copper',
  'iron',
  'silver',
  'platinum',
  'super',
  'miracle',
  'hikari',
];

export function loadSettings(): UiSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const p = JSON.parse(raw) as Partial<UiSettings>;
    return {
      recipeId: typeof p.recipeId === 'string' ? p.recipeId : null,
      needleType: NEEDLE_TYPES.includes(p.needleType as NeedleType)
        ? (p.needleType as NeedleType)
        : DEFAULT_SETTINGS.needleType,
      needleStars:
        p.needleStars === 0 || p.needleStars === 1 || p.needleStars === 2 || p.needleStars === 3
          ? p.needleStars
          : DEFAULT_SETTINGS.needleStars,
      showCyclePreview:
        typeof p.showCyclePreview === 'boolean'
          ? p.showCyclePreview
          : DEFAULT_SETTINGS.showCyclePreview,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings: UiSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // 保存失敗(プライベートモード等)は無視
  }
}

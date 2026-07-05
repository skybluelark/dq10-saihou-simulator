// ヘッダー (F1/N4): レシピ選択・針選択(7種+★0〜3)・サイクル予告トグル・新しく始める。

import type { NeedleDef, NeedleType, RecipeDef } from '../core';
import { CLOTH_LABELS } from './format';
import type { UiSettings } from './storage';
import styles from './App.module.css';

interface HeaderProps {
  recipes: RecipeDef[];
  needles: NeedleDef[];
  settings: UiSettings;
  activeRecipeId: string | null;
  onChangeSettings: (patch: Partial<UiSettings>) => void;
  onNewSession: () => void;
}

export function Header({
  recipes,
  needles,
  settings,
  activeRecipeId,
  onChangeSettings,
  onNewSession,
}: HeaderProps) {
  return (
    <header className={styles.header}>
      <h1 className={styles.headerTitle}>DQ10 さいほうシミュレータ</h1>
      <div className={styles.headerControls}>
        <label className={styles.field}>
          レシピ
          <select
            className={styles.select}
            value={activeRecipeId ?? ''}
            onChange={(e) => onChangeSettings({ recipeId: e.target.value })}
          >
            {recipes.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}({CLOTH_LABELS[r.clothType] ?? r.clothType})
              </option>
            ))}
          </select>
        </label>
        <label className={styles.field}>
          針
          <select
            className={styles.select}
            value={settings.needleType}
            onChange={(e) => onChangeSettings({ needleType: e.target.value as NeedleType })}
          >
            {needles.map((n) => (
              <option key={n.id} value={n.id}>
                {n.name}
              </option>
            ))}
          </select>
        </label>
        <label className={styles.field}>
          ★
          <select
            className={styles.select}
            value={settings.needleStars}
            onChange={(e) =>
              onChangeSettings({ needleStars: Number(e.target.value) as 0 | 1 | 2 | 3 })
            }
          >
            {[0, 1, 2, 3].map((s) => (
              <option key={s} value={s}>
                ★{s}
              </option>
            ))}
          </select>
        </label>
        <label className={styles.toggle}>
          <input
            type="checkbox"
            checked={settings.showCyclePreview}
            onChange={(e) => onChangeSettings({ showCyclePreview: e.target.checked })}
          />
          サイクル予告表示
        </label>
        <button type="button" className={styles.newButton} onClick={onNewSession}>
          新しく始める
        </button>
      </div>
    </header>
  );
}

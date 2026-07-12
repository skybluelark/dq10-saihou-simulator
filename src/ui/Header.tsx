// ヘッダー (F1/N4): レシピ選択・針選択(7種+★0〜3)・サイクル予告トグル・新しく始める。

import { useState } from 'react';
import type { NeedleDef, NeedleType, RecipeDef } from '../core';
import { copyReplayText } from './clipboard';
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
  // devMode(URL の ?verify で有効化): シード指定・リプレイ入出力の検証UIを表示する。
  // デモアプリでは非表示(§②)。アンドゥ/リドゥは devMode によらず常時表示。
  devMode: boolean;
  currentSeed: number | null;
  seedInput: string;
  onSeedInputChange: (value: string) => void;
  canUndo: boolean;
  onUndo: () => void;
  canRedo: boolean;
  onRedo: () => void;
  onBuildReplayText: () => string | null;
  onOpenReplayDialog: () => void;
}

export function Header({
  recipes,
  needles,
  settings,
  activeRecipeId,
  onChangeSettings,
  onNewSession,
  devMode,
  currentSeed,
  seedInput,
  onSeedInputChange,
  canUndo,
  onUndo,
  canRedo,
  onRedo,
  onBuildReplayText,
  onOpenReplayDialog,
}: HeaderProps) {
  const [copied, setCopied] = useState(false);
  const handleCopyReplay = () => {
    const text = onBuildReplayText();
    if (!text) return;
    copyReplayText(text, () => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
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
        {/* アンドゥ/リドゥは通常操作として常時表示(§②) */}
        <button
          type="button"
          className={styles.undoButton}
          disabled={!canUndo}
          onClick={onUndo}
        >
          1手戻す
        </button>
        <button
          type="button"
          className={styles.undoButton}
          disabled={!canRedo}
          onClick={onRedo}
        >
          1手進む
        </button>
        {/* 検証UI(シード指定・リプレイ入出力)は devMode 時のみ。デモでは非表示(§②) */}
        {devMode && (
          <>
            <span className={styles.seedDisplay}>シード: {currentSeed ?? '-'}</span>
            <input
              type="text"
              className={styles.seedInput}
              value={seedInput}
              placeholder="シード(空欄=自動)"
              onChange={(e) => onSeedInputChange(e.target.value)}
            />
            <button type="button" className={styles.undoButton} onClick={handleCopyReplay}>
              {copied ? 'コピーしました' : 'リプレイコピー'}
            </button>
            <button type="button" className={styles.undoButton} onClick={onOpenReplayDialog}>
              リプレイ読込
            </button>
          </>
        )}
        <button type="button" className={styles.newButton} onClick={onNewSession}>
          新しく始める
        </button>
      </div>
    </header>
  );
}

// リプレイ読込ダイアログ (F6・検証モード専用): リプレイJSONを貼り付けて読み込む。

import { useState } from 'react';
import styles from './App.module.css';

interface ReplayDialogProps {
  /** リプレイを読み込む。エラーメッセージを返す(成功時は null)。 */
  onImport: (text: string) => string | null;
  onClose: () => void;
}

export function ReplayDialog({ onImport, onClose }: ReplayDialogProps) {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);

  const handleImport = () => {
    const err = onImport(text);
    if (err) {
      setError(err);
    } else {
      onClose();
    }
  };

  return (
    <div className={styles.dialogOverlay}>
      <div className={styles.dialogPanel}>
        <h2 className={styles.dialogTitle}>リプレイ読込</h2>
        <textarea
          className={styles.dialogTextarea}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="リプレイのJSONを貼り付けてください"
          rows={8}
        />
        {error && <div className={styles.dialogError}>{error}</div>}
        <div className={styles.dialogActions}>
          <button type="button" className={styles.undoButton} onClick={onClose}>
            キャンセル
          </button>
          <button type="button" className={styles.newButton} onClick={handleImport}>
            読み込む
          </button>
        </div>
      </div>
    </div>
  );
}

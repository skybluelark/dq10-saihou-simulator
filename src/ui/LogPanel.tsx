// 行動ログ: 人間可読の1行整形済みログを新しい順に表示。
// 現在ターン(タイムライン上の現在位置)の行はハイライトする(SPEC v1.16 §4.3)。

import styles from './App.module.css';

interface LogItem {
  text: string;
  turn: number;
}

interface LogPanelProps {
  log: LogItem[]; // 古い順に格納
  currentTurn: number | null; // 次に実行されるターン(終了済みなら null)
}

export function LogPanel({ log, currentTurn }: LogPanelProps) {
  const newestFirst = [...log].reverse();
  return (
    <section className={styles.logPanel}>
      <h2 className={styles.sectionTitle}>行動ログ</h2>
      <div className={styles.logList}>
        {newestFirst.length === 0 && <div className={styles.logEmpty}>まだ行動がありません</div>}
        {newestFirst.map((item, i) => (
          <div
            key={newestFirst.length - i}
            className={`${styles.logLine} ${item.turn === currentTurn ? styles.logLineCurrent : ''}`}
          >
            {item.text}
          </div>
        ))}
      </div>
    </section>
  );
}

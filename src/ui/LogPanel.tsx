// 行動ログ: 人間可読の1行整形済みログを新しい順に表示。

import styles from './App.module.css';

interface LogPanelProps {
  log: string[]; // 古い順に格納
}

export function LogPanel({ log }: LogPanelProps) {
  const newestFirst = [...log].reverse();
  return (
    <section className={styles.logPanel}>
      <h2 className={styles.sectionTitle}>行動ログ</h2>
      <div className={styles.logList}>
        {newestFirst.length === 0 && <div className={styles.logEmpty}>まだ行動がありません</div>}
        {newestFirst.map((line, i) => (
          <div key={newestFirst.length - i} className={styles.logLine}>
            {line}
          </div>
        ))}
      </div>
    </section>
  );
}

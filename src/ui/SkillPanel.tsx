// 特技ボタン (F2): skills.json の全特技(パッシブ除く)+無我の境地+しあげる。
// 消費集中力表示(虹布発動ターンは補正後)・集中力不足の無効化・選択中ハイライト。

import type { GameParams, GameState, SkillDef } from '../core';
import { displayCost } from './helpers';
import styles from './App.module.css';

interface SkillPanelProps {
  skills: SkillDef[]; // パッシブ除外済み(無我含む)
  game: GameState;
  params: GameParams;
  selectedSkillId: string | null;
  onSkillClick: (skillId: string) => void;
  onFinish: () => void;
}

export function SkillPanel({
  skills,
  game,
  params,
  selectedSkillId,
  onSkillClick,
  onFinish,
}: SkillPanelProps) {
  return (
    <section className={styles.skills}>
      {skills.map((skill) => {
        const cost = displayCost(skill, game, params);
        const disabled =
          game.finished ||
          cost > game.concentration ||
          (skill.kind === 'hissatsu' && !game.hissatsuCharged);
        const selected = selectedSkillId === skill.id;
        return (
          <button
            key={skill.id}
            type="button"
            className={`${styles.skillButton} ${selected ? styles.skillSelected : ''}`}
            disabled={disabled}
            onClick={() => onSkillClick(skill.id)}
            title={skill.kind === 'hissatsu' ? '必殺チャージ時のみ使用可' : undefined}
          >
            <span className={styles.skillName}>{skill.name}</span>
            <span className={styles.skillCost}>{cost}</span>
          </button>
        );
      })}
      <button
        type="button"
        className={`${styles.skillButton} ${styles.finishButton}`}
        disabled={game.finished}
        onClick={onFinish}
      >
        <span className={styles.skillName}>しあげる</span>
        <span className={styles.skillCost}>0</span>
      </button>
    </section>
  );
}

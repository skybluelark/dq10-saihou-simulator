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

// スマホアプリ版のデフォルト配置(MOBILE_UI_DESIGN §5.3.1)に合わせた固定並び順。
// 5行4列・行優先(左→右, 上→下)で並べる。20マス目の「しあげる」は別ボタンとして末尾に描画。
const SKILL_ORDER: readonly string[] = [
  'yoko_nui', 'gyaku_tasuki', 'nibai_nui', 'power_shift',
  'suihei_nui', 'makikomi_nui', 'sanbai_nui', 'shitsuke_gake',
  'taki_nobori', 'midare_nui', 'nerai_nui', 'muga_no_kyochi',
  'otaki_nobori', 'kagen_nui', 'seishin_toitsu', 'nuu',
  'tasuki_nui', 'han_kagen_nui', 'ito_hogushi',
];

const orderIndex = (id: string): number => {
  const i = SKILL_ORDER.indexOf(id);
  return i === -1 ? SKILL_ORDER.length : i; // 未知の特技は末尾側(しあげるの直前)へ
};

export function SkillPanel({
  skills,
  game,
  params,
  selectedSkillId,
  onSkillClick,
  onFinish,
}: SkillPanelProps) {
  const ordered = [...skills].sort((a, b) => orderIndex(a.id) - orderIndex(b.id));
  return (
    <section className={styles.skills}>
      {ordered.map((skill) => {
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

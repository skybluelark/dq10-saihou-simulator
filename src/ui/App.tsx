// M2 最小UI (F1〜F4)。状態管理は useReducer + コアEngine(ARCHITECTURE A1/A3)。
// エンジン呼び出し(乱数消費を伴う)はイベントハンドラ側で行い、reducer は純粋に保つ。
// ターン進行: セッション開始時と各行動後に beginTurn を呼び、
// 当ターンのぬいパワー・発光・自動回復を行動前に表示へ反映する。

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { DEFAULT_CONFIG, Engine, Mulberry32 } from '../core';
import type {
  Action,
  GameState,
  JudgeResult,
  RecipeDef,
  Rng,
  SimulatorConfig,
} from '../core';
import { FetchDataProvider, loadGameData } from '../data';
import { ClothGrid } from './ClothGrid';
import { Header } from './Header';
import { LogPanel } from './LogPanel';
import { ResultPanel } from './ResultPanel';
import { RightPanel } from './RightPanel';
import { SkillPanel } from './SkillPanel';
import { formatEvents } from './format';
import { isTargetless, resolveTargetCells } from './helpers';
import { loadSettings, saveSettings, type UiSettings } from './storage';
import styles from './App.module.css';

// ---- UI状態(reducer は純粋。エンジン呼び出しはハンドラ側) ----

interface Session {
  seed: number;
  game: GameState; // beginTurn 済み(または finished)
  initialConcentration: number;
  log: string[]; // 古い順
  result: JudgeResult | null;
}

interface UiState {
  session: Session | null;
  selectedSkillId: string | null;
  anchor: { r: number; c: number } | null;
}

type UiEvent =
  | { type: 'sessionStarted'; session: Session }
  | { type: 'applied'; game: GameState; lines: string[]; result: JudgeResult | null }
  | { type: 'skillSelected'; skillId: string | null }
  | { type: 'anchorSet'; anchor: { r: number; c: number } | null };

function reducer(state: UiState, ev: UiEvent): UiState {
  switch (ev.type) {
    case 'sessionStarted':
      return { session: ev.session, selectedSkillId: null, anchor: null };
    case 'applied': {
      if (!state.session) return state;
      return {
        session: {
          ...state.session,
          game: ev.game,
          log: [...state.session.log, ...ev.lines],
          result: ev.result,
        },
        selectedSkillId: null,
        anchor: null,
      };
    }
    case 'skillSelected':
      return { ...state, selectedSkillId: ev.skillId, anchor: null };
    case 'anchorSet':
      return { ...state, anchor: ev.anchor };
  }
}

const INITIAL_UI: UiState = { session: null, selectedSkillId: null, anchor: null };

function App() {
  // バンドルデータとエンジン(不変)
  const data = useMemo(() => loadGameData(), []);
  const engine = useMemo(() => new Engine(data), [data]);
  const skillMap = useMemo(
    () => new Map(data.skills.skills.map((s) => [s.id, s])),
    [data],
  );
  const skillName = useCallback(
    (id: string) => skillMap.get(id)?.name ?? id,
    [skillMap],
  );
  const actionSkills = useMemo(
    () => data.skills.skills.filter((s) => s.kind !== 'passive'),
    [data],
  );

  // レシピCSV(実行時 fetch: ARCHITECTURE A5)
  const [recipes, setRecipes] = useState<RecipeDef[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    const provider = new FetchDataProvider(`${import.meta.env.BASE_URL}data/recipes.csv`);
    provider
      .loadRecipes()
      .then((res) => {
        if (cancelled) return;
        setRecipes(res.recipes);
        if (res.errors.length > 0) {
          setLoadError(
            `recipes.csv にエラー ${res.errors.length} 件(該当行はスキップ): ` +
              res.errors.map((e) => `L${e.line} ${e.message}`).join(' / '),
          );
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) setLoadError(`recipes.csv の読み込みに失敗しました: ${String(e)}`);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // UI設定(localStorage 自動保存/復元: N4)
  const [settings, setSettings] = useState<UiSettings>(loadSettings);
  useEffect(() => {
    saveSettings(settings);
  }, [settings]);
  const changeSettings = useCallback((patch: Partial<UiSettings>) => {
    setSettings((prev) => ({ ...prev, ...patch }));
  }, []);

  const config: SimulatorConfig = useMemo(
    () => ({
      ...DEFAULT_CONFIG,
      needle: { type: settings.needleType, stars: settings.needleStars },
    }),
    [settings.needleType, settings.needleStars],
  );

  const recipe = useMemo(() => {
    if (!recipes || recipes.length === 0) return null;
    return recipes.find((r) => r.id === settings.recipeId) ?? recipes[0];
  }, [recipes, settings.recipeId]);

  // セッション(乱数はセッションと同じ寿命の可変オブジェクトのため ref に保持)
  const [ui, dispatch] = useReducer(reducer, INITIAL_UI);
  const rngRef = useRef<Rng | null>(null);
  // 同一状態への二重適用ガード(再レンダー前に同一クリックが連続発火した場合の保険)
  const lastAppliedRef = useRef<GameState | null>(null);

  const startSession = useCallback(() => {
    if (!recipe) return;
    const seed = Date.now() >>> 0; // シードはセッション開始時に自動生成
    const rng = new Mulberry32(seed);
    const created = engine.createSession(recipe, config, rng);
    const begun = engine.beginTurn(created.state, rng);
    rngRef.current = rng;
    lastAppliedRef.current = null;
    const log = [
      ...formatEvents(created.events, 0, skillName),
      ...formatEvents(begun.events, begun.state.turn + 1, skillName),
    ];
    dispatch({
      type: 'sessionStarted',
      session: {
        seed,
        game: begun.state,
        initialConcentration: created.state.concentration,
        log,
        result: null,
      },
    });
  }, [engine, recipe, config, skillName]);

  // レシピ・針の変更(および初回ロード完了)で新しいセッションを開始
  useEffect(() => {
    startSession();
  }, [startSession]);

  const runAction = useCallback(
    (action: Action) => {
      const rng = rngRef.current;
      if (!rng || !ui.session || ui.session.game.finished) return;
      const before = ui.session.game;
      if (lastAppliedRef.current === before) return; // 同一状態への二重適用を防止
      lastAppliedRef.current = before;
      const applied = engine.applyAction(before, action, config, rng);
      let game = applied.state;
      let lines = formatEvents(applied.events, before.turn + 1, skillName);
      let result: JudgeResult | null = null;
      if (game.finished) {
        result = engine.judge(game);
      } else {
        // 各行動後に次ターンの開始処理(パワー・発光・回復)を先行実行して表示へ反映
        const begun = engine.beginTurn(game, rng);
        lines = [...lines, ...formatEvents(begun.events, game.turn + 1, skillName)];
        game = begun.state;
      }
      dispatch({ type: 'applied', game, lines, result });
    },
    [engine, config, ui.session, skillName],
  );

  // 操作フロー: 特技選択 → マスタップ(プレビュー) → 同マス再タップで実行
  const handleSkillClick = useCallback(
    (skillId: string) => {
      const skill = skillMap.get(skillId);
      if (!skill) return;
      if (isTargetless(skill)) {
        runAction({ type: 'skill', skillId });
      } else if (ui.selectedSkillId === skillId) {
        dispatch({ type: 'skillSelected', skillId: null }); // 再クリックで選択解除
      } else {
        dispatch({ type: 'skillSelected', skillId });
      }
    },
    [skillMap, runAction, ui.selectedSkillId],
  );

  const handleCellClick = useCallback(
    (r: number, c: number) => {
      if (!ui.selectedSkillId || !ui.session || ui.session.game.finished) return;
      if (ui.anchor && ui.anchor.r === r && ui.anchor.c === c) {
        runAction({ type: 'sew', skillId: ui.selectedSkillId, anchor: { r, c } });
      } else {
        dispatch({ type: 'anchorSet', anchor: { r, c } });
      }
    },
    [ui.selectedSkillId, ui.session, ui.anchor, runAction],
  );

  const handleFinish = useCallback(() => runAction({ type: 'finish' }), [runAction]);

  // 対象プレビュー(布外にはみ出すマスはハイライトしない)
  const previewTargets = useMemo(() => {
    if (!ui.session || !ui.selectedSkillId || !ui.anchor) return [];
    const skill = skillMap.get(ui.selectedSkillId);
    if (!skill) return [];
    return resolveTargetCells(data.skills, skill, ui.anchor, ui.session.game);
  }, [ui.session, ui.selectedSkillId, ui.anchor, skillMap, data]);

  // 誤差評価値(現在合計)は常時表示
  const currentJudge = useMemo(
    () => (ui.session ? engine.judge(ui.session.game) : null),
    [engine, ui.session],
  );

  const needle = useMemo(
    () => data.needles.needles.find((n) => n.id === settings.needleType) ?? data.needles.needles[0],
    [data, settings.needleType],
  );
  const levelBase = data.concentration.base[config.level - 1];

  if (loadError && !recipes) {
    return <div className={styles.loading}>{loadError}</div>;
  }
  if (!recipes) {
    return <div className={styles.loading}>レシピを読み込み中…</div>;
  }
  if (!recipe) {
    return (
      <div className={styles.loading}>
        有効なレシピがありません(data/recipes.csv を確認してください)。
      </div>
    );
  }

  const session = ui.session;
  const star3Line = session
    ? data.params.evaluation[String(session.game.massCount)].star3
    : 0;

  return (
    <div className={styles.app}>
      <Header
        recipes={recipes}
        needles={data.needles.needles}
        settings={settings}
        activeRecipeId={recipe.id}
        onChangeSettings={changeSettings}
        onNewSession={startSession}
      />
      {loadError && <div className={styles.csvWarning}>{loadError}</div>}

      {session && (
        <>
          {session.result && (
            <ResultPanel
              game={session.game}
              result={session.result}
              params={data.params}
              onNewSession={startSession}
            />
          )}

          <main className={styles.main}>
            <ClothGrid
              game={session.game}
              yellowRange={data.params.gauge.yellowRange}
              anchor={ui.anchor}
              targets={previewTargets}
              selectingTarget={ui.selectedSkillId !== null}
              totalError={currentJudge?.totalError ?? 0}
              star3Line={star3Line}
              onCellClick={handleCellClick}
            />
            <RightPanel
              game={session.game}
              params={data.params}
              needle={needle}
              levelBase={levelBase}
              initialConcentration={session.initialConcentration}
              showCyclePreview={settings.showCyclePreview}
            />
          </main>

          <SkillPanel
            skills={actionSkills}
            game={session.game}
            params={data.params}
            selectedSkillId={ui.selectedSkillId}
            onSkillClick={handleSkillClick}
            onFinish={handleFinish}
          />

          <LogPanel log={session.log} />
        </>
      )}
    </div>
  );
}

export default App;

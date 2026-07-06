// M2 最小UI (F1〜F4)。状態管理は useReducer + コアEngine(ARCHITECTURE A1/A3)。
// エンジン呼び出し(乱数消費を伴う)はイベントハンドラ側で行い、reducer は純粋に保つ。
// ターン進行: セッション開始時と各行動後に beginTurn を呼び、
// 当ターンのぬいパワー・発光・自動回復を行動前に表示へ反映する。

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { DEFAULT_CONFIG, Engine, Mulberry32, clampAnchorForPattern } from '../core';
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
import {
  deriveBalloons,
  isTargetless,
  previewPositions,
  resolveTargetCells,
  type Balloon,
} from './helpers';
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

  // ダメージ/回復バルーン(一時表示)。id をキーに独立したタイマーで除去するため、
  // 連続行動で前のバルーンが残っていても正しく積み上がり/消去される。
  const [balloons, setBalloons] = useState<Balloon[]>([]);
  const balloonTimersRef = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());
  const BALLOON_LIFETIME_MS = 750;

  // 遅延表示待ちのバルーン生成タイマー(再生布の回復分をダメージ表示後に出すため)
  const pendingSpawnTimersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());

  // 必殺チャージの一時演出(グリッド中央のオーバーレイ)。値はアニメーション再生成用キー。
  const [hissatsuFx, setHissatsuFx] = useState<number | null>(null);
  const hissatsuFxTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const HISSATSU_FX_MS = 1200;

  const spawnBalloons = useCallback((newOnes: Balloon[]) => {
    if (newOnes.length === 0) return;
    setBalloons((prev) => [...prev, ...newOnes]);
    for (const b of newOnes) {
      const timer = setTimeout(() => {
        setBalloons((prev) => prev.filter((x) => x.id !== b.id));
        balloonTimersRef.current.delete(b.id);
      }, BALLOON_LIFETIME_MS);
      balloonTimersRef.current.set(b.id, timer);
    }
  }, []);

  // 回復吹き出しの分離表示(SPEC §4.3): 同じ画面更新のダメージ吹き出しの表示後に出す
  const spawnBalloonsDelayed = useCallback(
    (newOnes: Balloon[], delayMs: number) => {
      if (newOnes.length === 0) return;
      const timer = setTimeout(() => {
        pendingSpawnTimersRef.current.delete(timer);
        spawnBalloons(newOnes);
      }, delayMs);
      pendingSpawnTimersRef.current.add(timer);
    },
    [spawnBalloons],
  );

  const triggerHissatsuFx = useCallback(() => {
    if (hissatsuFxTimerRef.current) clearTimeout(hissatsuFxTimerRef.current);
    setHissatsuFx(Date.now());
    hissatsuFxTimerRef.current = setTimeout(() => {
      setHissatsuFx(null);
      hissatsuFxTimerRef.current = null;
    }, HISSATSU_FX_MS);
  }, []);

  // アンマウント時にタイマーを掃除
  useEffect(() => {
    const timers = balloonTimersRef.current;
    const pending = pendingSpawnTimersRef.current;
    return () => {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
      for (const t of pending) clearTimeout(t);
      pending.clear();
      if (hissatsuFxTimerRef.current) clearTimeout(hissatsuFxTimerRef.current);
    };
  }, []);

  const startSession = useCallback(() => {
    if (!recipe) return;
    const seed = Date.now() >>> 0; // シードはセッション開始時に自動生成
    const rng = new Mulberry32(seed);
    const created = engine.createSession(recipe, config, rng);
    const begun = engine.beginTurn(created.state, rng);
    rngRef.current = rng;
    lastAppliedRef.current = null;
    // 新規ゲーム開始時は前ゲームのバルーン・演出(とタイマー)をクリアする
    for (const t of balloonTimersRef.current.values()) clearTimeout(t);
    balloonTimersRef.current.clear();
    for (const t of pendingSpawnTimersRef.current) clearTimeout(t);
    pendingSpawnTimersRef.current.clear();
    setBalloons([]);
    if (hissatsuFxTimerRef.current) {
      clearTimeout(hissatsuFxTimerRef.current);
      hissatsuFxTimerRef.current = null;
    }
    setHissatsuFx(null);
    // 開幕の必殺チャージ(光の針)も演出対象
    if (created.events.some((e) => e.kind === 'hissatsuCharge')) {
      triggerHissatsuFx();
    }
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
  }, [engine, recipe, config, skillName, triggerHissatsuFx]);

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
      // 行動(applied)由来の吹き出しは即時表示
      const actionBalloons = deriveBalloons(applied.events);
      let hissatsuCharged = applied.events.some((e) => e.kind === 'hissatsuCharge');
      if (game.finished) {
        result = engine.judge(game);
      } else {
        // 各行動後に次ターンの開始処理(パワー・発光・回復)を先行実行して表示へ反映
        const begun = engine.beginTurn(game, rng);
        lines = [...lines, ...formatEvents(begun.events, game.turn + 1, skillName)];
        // 次ターン開始(begun)由来の吹き出し(再生布の回復等)は、同じ画面更新の
        // ダメージ吹き出しの表示後に分けて表示する(SPEC §4.3)
        spawnBalloonsDelayed(deriveBalloons(begun.events), BALLOON_LIFETIME_MS);
        hissatsuCharged ||= begun.events.some((e) => e.kind === 'hissatsuCharge');
        game = begun.state;
      }
      spawnBalloons(actionBalloons);
      if (hissatsuCharged) triggerHissatsuFx();
      dispatch({ type: 'applied', game, lines, result });
    },
    [engine, config, ui.session, skillName, spawnBalloons, spawnBalloonsDelayed, triggerHissatsuFx],
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
      if (!ui.session || ui.session.game.finished) return;
      // 特技未選択でマスをタップした場合は「ぬう」を自動選択し、
      // そのタップを1タップ目(アンカー設定)として同様に処理する(SPEC)。
      const skillId = ui.selectedSkillId ?? 'nuu';
      const skill = skillMap.get(skillId);
      if (!skill) return;
      if (!ui.selectedSkillId) {
        dispatch({ type: 'skillSelected', skillId });
      }
      // タップ規則(SPEC §4.3): アンカー設定済みで青枠(アンカー+対象範囲。空きマス含む)内を
      // タップした場合のみ実行。青枠外は新たな1タップ目(アンカーの取り直し)として扱う。
      if (ui.selectedSkillId && ui.anchor) {
        const anchor = ui.anchor;
        const inPreview = previewPositions(data.skills, skill, anchor, ui.session.game).some(
          (p) => p.r === r && p.c === c,
        );
        if (inPreview) {
          runAction({ type: 'sew', skillId, anchor });
          return;
        }
      }
      // 1タップ目(アンカー設定/取り直し)。対象解決(アンカー自動置換適用後)で
      // 存在するマスが0となるタップは無効(行動不成立。プレビューも出さない)。
      const targets = resolveTargetCells(data.skills, skill, { r, c }, ui.session.game);
      if (targets.length === 0) return;
      // アンカーは置換後の座標で保存する(SPEC: 置換はアンカーそのものに適用。
      // 表示・以降の再タップ判定も置換後アンカーに対して行う)。
      const clamped = clampAnchorForPattern(
        skill.target ?? '',
        data.skills.targetPatterns[skill.target ?? ''] ?? [],
        { r, c },
        ui.session.game.rows,
        ui.session.game.cols,
      );
      dispatch({ type: 'anchorSet', anchor: clamped });
    },
    [ui.selectedSkillId, ui.session, ui.anchor, runAction, skillMap, data],
  );

  const handleFinish = useCallback(() => runAction({ type: 'finish' }), [runAction]);

  // 対象プレビュー(ライン系はアンカー自動置換後の範囲)。パターン範囲内の
  // グリッド位置すべてを青枠表示する(空きマス含む。ダメージが入るのは存在するマスのみ)。
  const previewTargets = useMemo(() => {
    if (!ui.session || !ui.selectedSkillId || !ui.anchor) return [];
    const skill = skillMap.get(ui.selectedSkillId);
    if (!skill) return [];
    return previewPositions(data.skills, skill, ui.anchor, ui.session.game);
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
              balloons={balloons}
              hissatsuFx={hissatsuFx}
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

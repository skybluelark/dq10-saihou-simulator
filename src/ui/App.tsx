// M2 最小UI (F1〜F4)。状態管理は useReducer + コアEngine(ARCHITECTURE A1/A3)。
// エンジン呼び出し(乱数消費を伴う)はイベントハンドラ側で行い、reducer は純粋に保つ。
// ターン進行: セッション開始時と各行動後に beginTurn を呼び、
// 当ターンのぬいパワー・発光・自動回復を行動前に表示へ反映する。

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import {
  DEFAULT_CONFIG,
  Engine,
  Mulberry32,
  clampAnchorForPattern,
  makeReplayCheck,
  matchesReplayCheck,
  parseReplay,
  serializeReplay,
} from '../core';
import type {
  Action,
  GameState,
  JudgeResult,
  ReplayData,
  Rng,
  SimulatorConfig,
  TurnEvent,
} from '../core';
import { loadGameData } from '../data';
import { ClothGrid } from './ClothGrid';
import { Header } from './Header';
import { LogPanel } from './LogPanel';
import { ReplayDialog } from './ReplayDialog';
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

interface LogEntry {
  turn: number;
  events: TurnEvent[];
}

interface HistoryEntry {
  game: GameState;
  rngState: number;
  logCount: number;
}

interface Session {
  seed: number;
  initialConcentration: number;
  actions: Action[]; // タイムライン上の全行動(次タスクのリプレイ出力用)
  history: HistoryEntry[]; // history[i] = actions[i] 適用直前の状態
  log: LogEntry[]; // タイムライン全体のログ(古い順。カーソル移動では消去しない)
  finalGame: GameState; // position === actions.length のときの表示状態(最新端)
  finalResult: JudgeResult | null; // finalGame.finished のときのみ非 null
  position: number; // 現在位置 0..actions.length
}

interface UiState {
  session: Session | null;
  selectedSkillId: string | null;
  anchor: { r: number; c: number } | null;
}

type UiEvent =
  | { type: 'sessionStarted'; session: Session }
  | {
      type: 'applied';
      game: GameState;
      entries: LogEntry[];
      result: JudgeResult | null;
      record?: { action: Action; historyEntry: HistoryEntry };
    }
  | { type: 'skillSelected'; skillId: string | null }
  | { type: 'anchorSet'; anchor: { r: number; c: number } | null }
  | { type: 'undone' }
  | { type: 'redone' };

function reducer(state: UiState, ev: UiEvent): UiState {
  switch (ev.type) {
    case 'sessionStarted':
      return { session: ev.session, selectedSkillId: null, anchor: null };
    case 'applied': {
      const s = state.session;
      if (!s) return state;
      const pos = s.position;
      let actions = s.actions;
      let history = s.history;
      let log = s.log;
      if (pos < actions.length) {
        // 過去位置からの分岐(SPEC §4.3): そのターンの行動以降の旧ログ・旧行動列を消去する。
        // history[pos].logCount はターン開始情報行までを含む位置なので、情報行は残る。
        log = log.slice(0, history[pos].logCount);
        actions = actions.slice(0, pos);
        history = history.slice(0, pos);
      }
      const newActions = ev.record ? [...actions, ev.record.action] : actions;
      const newHistory = ev.record ? [...history, ev.record.historyEntry] : history;
      return {
        session: {
          ...s,
          actions: newActions,
          history: newHistory,
          log: [...log, ...ev.entries],
          finalGame: ev.game,
          finalResult: ev.result,
          position: newActions.length,
        },
        selectedSkillId: null,
        anchor: null,
      };
    }
    case 'undone': {
      const session = state.session;
      if (!session || session.position === 0) return state;
      return {
        session: { ...session, position: session.position - 1 },
        selectedSkillId: null,
        anchor: null,
      };
    }
    case 'redone': {
      const session = state.session;
      if (!session || session.position >= session.actions.length) return state;
      return {
        session: { ...session, position: session.position + 1 },
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

  // レシピ(ビルド時バンドル: ARCHITECTURE A5)
  const recipes = data.recipes;

  // 検証モード: シード指定入力(App が保持。「新しく始める」で解決する)
  const [seedInput, setSeedInput] = useState('');

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
    if (recipes.length === 0) return null;
    return recipes.find((r) => r.id === settings.recipeId) ?? recipes[0];
  }, [recipes, settings.recipeId]);

  // セッション(乱数はセッションと同じ寿命の可変オブジェクトのため ref に保持)
  const [ui, dispatch] = useReducer(reducer, INITIAL_UI);
  const rngRef = useRef<Rng | null>(null);
  // 同一状態への二重適用ガード(再レンダー前に同一クリックが連続発火した場合の保険)
  const lastAppliedRef = useRef<GameState | null>(null);

  // タイムライン+カーソル(SPEC v1.16 §4.3): position が最新端かどうかで表示状態を導出する
  const currentGame: GameState | null = ui.session
    ? ui.session.position === ui.session.actions.length
      ? ui.session.finalGame
      : ui.session.history[ui.session.position].game
    : null;
  const currentResult: JudgeResult | null =
    ui.session && ui.session.position === ui.session.actions.length
      ? ui.session.finalResult
      : null;
  const currentTurn: number | null =
    currentGame && !currentGame.finished ? currentGame.turn + 1 : null;

  // リプレイ読込(F6): 読込後の警告バナー・ダイアログ開閉状態
  const [importWarning, setImportWarning] = useState<string | null>(null);
  const [showReplayDialog, setShowReplayDialog] = useState(false);
  // リプレイ読込がレシピ/針の settings を書き換えたとき、直後の自動再開始
  // useEffect(レシピ・針変更で発火)が読込済みセッションを潰さないよう抑止する
  const skipAutoStartRef = useRef(false);

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

  // バルーン・保留タイマー・必殺演出のクリア(新規セッション開始/アンドゥで共通)
  const clearTransientFx = useCallback(() => {
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

  const startSession = useCallback(
    (seedOverride?: number) => {
      if (!recipe) return;
      // シードは引数で受け取る(state を関数内で読まない)。省略時は自動生成。
      const seed = seedOverride ?? (Date.now() >>> 0);
      const rng = new Mulberry32(seed);
      const created = engine.createSession(recipe, config, rng);
      const begun = engine.beginTurn(created.state, rng);
      rngRef.current = rng;
      lastAppliedRef.current = null;
      // 新規ゲーム開始時は前ゲームのバルーン・演出(とタイマー)・リプレイ警告をクリアする
      clearTransientFx();
      setImportWarning(null);
      // 開幕の必殺チャージ(光の針)も演出対象
      if (created.events.some((e) => e.kind === 'hissatsuCharge')) {
        triggerHissatsuFx();
      }
      dispatch({
        type: 'sessionStarted',
        session: {
          seed,
          initialConcentration: created.state.concentration,
          actions: [],
          history: [],
          log: [
            { turn: 0, events: created.events },
            { turn: begun.state.turn + 1, events: begun.events },
          ],
          finalGame: begun.state,
          finalResult: null,
          position: 0,
        },
      });
    },
    [engine, recipe, config, triggerHissatsuFx, clearTransientFx],
  );

  // レシピ・針の変更(および初回ロード完了)で新しいセッションを開始。
  // ただしリプレイ読込が settings を書き換えた直後はこの発火をスキップする
  // (読込済みセッションを新規セッションで潰さないため)。
  useEffect(() => {
    if (skipAutoStartRef.current) {
      skipAutoStartRef.current = false;
      return;
    }
    startSession();
  }, [startSession]);

  const runAction = useCallback(
    (action: Action) => {
      const session = ui.session;
      if (!session) return;
      const pos = session.position;
      const atEdge = pos === session.actions.length;
      const before = atEdge ? session.finalGame : session.history[pos].game;
      if (before.finished) return;
      if (lastAppliedRef.current === before) return; // 同一状態への二重適用を防止
      lastAppliedRef.current = before;
      let rng: Rng;
      if (atEdge) {
        const r = rngRef.current;
        if (!r) return;
        rng = r;
      } else {
        // 過去位置からの分岐(SPEC §4.3): その時点の乱数状態から再開する
        rng = new Mulberry32(session.history[pos].rngState);
        rngRef.current = rng;
      }
      const rngStateBefore = rng.getState();
      const applied = engine.applyAction(before, action, config, rng);
      // 拒否行動(集中力不足・対象マスなし)は状態変更・乱数消費なし → 履歴・行動列に記録しない
      const rejected = applied.events.some(
        (e) => e.kind === 'insufficientConcentration' || e.kind === 'invalidTarget',
      );
      if (rejected && !atEdge) {
        // 過去位置での拒否行動は分岐させない(何も起きない)
        lastAppliedRef.current = null;
        return;
      }
      let game = applied.state;
      const entries: LogEntry[] = [{ turn: before.turn + 1, events: applied.events }];
      let result: JudgeResult | null = null;
      // 行動(applied)由来の吹き出しは即時表示
      const actionBalloons = deriveBalloons(applied.events);
      let hissatsuCharged = applied.events.some((e) => e.kind === 'hissatsuCharge');
      if (game.finished) {
        result = engine.judge(game);
      } else {
        // 各行動後に次ターンの開始処理(パワー・発光・回復)を先行実行して表示へ反映
        const begun = engine.beginTurn(game, rng);
        entries.push({ turn: game.turn + 1, events: begun.events });
        // 次ターン開始(begun)由来の吹き出し(再生布の回復等)は、同じ画面更新の
        // ダメージ吹き出しの表示後に分けて表示する(SPEC §4.3)
        spawnBalloonsDelayed(deriveBalloons(begun.events), BALLOON_LIFETIME_MS);
        hissatsuCharged ||= begun.events.some((e) => e.kind === 'hissatsuCharge');
        game = begun.state;
      }
      spawnBalloons(actionBalloons);
      if (hissatsuCharged) triggerHissatsuFx();
      const record = rejected
        ? undefined
        : {
            action,
            historyEntry: {
              game: before,
              rngState: rngStateBefore,
              logCount: atEdge ? session.log.length : session.history[pos].logCount,
            },
          };
      dispatch({ type: 'applied', game, entries, result, record });
    },
    [engine, config, ui.session, spawnBalloons, spawnBalloonsDelayed, triggerHissatsuFx],
  );

  const canUndo = ui.session !== null && ui.session.position > 0;
  const canRedo = ui.session !== null && ui.session.position < ui.session.actions.length;

  const handleUndo = useCallback(() => {
    if (!ui.session || ui.session.position === 0) return;
    lastAppliedRef.current = null;
    clearTransientFx();
    dispatch({ type: 'undone' });
  }, [ui.session, clearTransientFx]);

  const handleRedo = useCallback(() => {
    if (!ui.session || ui.session.position >= ui.session.actions.length) return;
    lastAppliedRef.current = null;
    clearTransientFx();
    dispatch({ type: 'redone' });
  }, [ui.session, clearTransientFx]);

  // 「新しく始める」: シード入力欄に有効な数値があればそのシードで、なければ自動生成で開始する
  const handleNewSession = useCallback(() => {
    const trimmed = seedInput.trim();
    if (trimmed !== '' && Number.isFinite(Number(trimmed))) {
      startSession(Number(trimmed) >>> 0);
    } else {
      startSession();
    }
  }, [seedInput, startSession]);

  // リプレイ出力 (F6): 現セッションを「シード+設定+レシピid+行動列」へ変換する。
  // 検証モード中はプレイ途中(未終了)でもその時点までの行動列でコピー可。
  const buildReplayText = useCallback((): string | null => {
    const s = ui.session;
    if (!s || !recipe) return null;
    const replay: ReplayData = { v: 1, seed: s.seed, recipeId: recipe.id, config, actions: s.actions };
    if (s.finalResult && s.finalGame.finished) replay.check = makeReplayCheck(s.finalResult, s.finalGame);
    return serializeReplay(replay);
  }, [ui.session, recipe, config]);

  // リプレイ読込 (F6・検証モードのみ): ライブプレイの runAction と同じ呼び出し列で
  // セッションを再構築する。戻り値はエラーメッセージ(成功時 null)。
  const handleImportReplay = useCallback(
    (text: string): string | null => {
      const parsed = parseReplay(text);
      if (!parsed.ok) return parsed.error;
      const replay = parsed.replay;
      const rcp = recipes.find((r) => r.id === replay.recipeId);
      if (!rcp) return `レシピ '${replay.recipeId}' がレシピ一覧にありません`;

      const rng = new Mulberry32(replay.seed);
      const created = engine.createSession(rcp, replay.config, rng);
      const begun = engine.beginTurn(created.state, rng);
      const log: LogEntry[] = [
        { turn: 0, events: created.events },
        { turn: begun.state.turn + 1, events: begun.events },
      ];
      const history: HistoryEntry[] = [];
      const actions: Action[] = [];
      let game = begun.state;
      let result: JudgeResult | null = null;
      for (const action of replay.actions) {
        const before = game;
        if (before.finished) {
          return '終了後の行動が含まれています';
        }
        const rngStateBefore = rng.getState();
        const applied = engine.applyAction(before, action, replay.config, rng);
        const rejected = applied.events.some(
          (e) => e.kind === 'insufficientConcentration' || e.kind === 'invalidTarget',
        );
        if (rejected) {
          return `行動${actions.length + 1}がこの環境では成立しません(データ・仕様バージョン差の可能性)`;
        }
        history.push({ game: before, rngState: rngStateBefore, logCount: log.length });
        actions.push(action);
        log.push({ turn: before.turn + 1, events: applied.events });
        game = applied.state;
        if (game.finished) {
          result = engine.judge(game);
        } else {
          const b2 = engine.beginTurn(game, rng);
          log.push({ turn: game.turn + 1, events: b2.events });
          game = b2.state;
        }
      }

      // check 照合(あれば): 不一致は警告のみ(読込自体は成功させる)
      let warning: string | null = null;
      if (replay.check && (!result || !matchesReplayCheck(replay.check, result, game))) {
        warning = 'リプレイの最終結果が一致しません(仕様バージョン差の可能性)';
      }
      // needle 以外の config が既定値と異なる場合も別途警告(check警告とは独立)
      const configDefaultsDiffer =
        replay.config.level !== DEFAULT_CONFIG.level ||
        replay.config.kotsu !== DEFAULT_CONFIG.kotsu ||
        replay.config.passives.critUp !== DEFAULT_CONFIG.passives.critUp ||
        replay.config.passives.hissatsuUp !== DEFAULT_CONFIG.passives.hissatsuUp;
      if (configDefaultsDiffer) {
        const extra =
          'リプレイの設定(レベル等)が既定値と異なります。読込後の追加操作は既定値で計算されます';
        warning = warning ? `${warning} / ${extra}` : extra;
      }

      // レシピ・針を settings へ反映(変化がある場合のみ、自動再開始 effect を抑止)
      const needleChanged =
        replay.recipeId !== recipe?.id ||
        replay.config.needle.type !== settings.needleType ||
        replay.config.needle.stars !== settings.needleStars;
      if (needleChanged) {
        skipAutoStartRef.current = true;
        setSettings((prev) => ({
          ...prev,
          recipeId: replay.recipeId,
          needleType: replay.config.needle.type,
          needleStars: replay.config.needle.stars,
        }));
      }

      setImportWarning(warning);
      rngRef.current = rng;
      lastAppliedRef.current = null;
      clearTransientFx();
      dispatch({
        type: 'sessionStarted',
        session: {
          seed: replay.seed,
          initialConcentration: created.state.concentration,
          actions,
          history,
          log,
          finalGame: game,
          finalResult: result,
          position: 0, // 1ターン目の状態で復元(SPEC v1.16)
        },
      });
      return null;
    },
    [recipes, recipe, settings.needleType, settings.needleStars, engine, clearTransientFx],
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
      if (!currentGame || currentGame.finished) return;
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
        const inPreview = previewPositions(data.skills, skill, anchor, currentGame).some(
          (p) => p.r === r && p.c === c,
        );
        if (inPreview) {
          runAction({ type: 'sew', skillId, anchor });
          return;
        }
      }
      // 1タップ目(アンカー設定/取り直し)。対象解決(アンカー自動置換適用後)で
      // 存在するマスが0となるタップは無効(行動不成立。プレビューも出さない)。
      const targets = resolveTargetCells(data.skills, skill, { r, c }, currentGame);
      if (targets.length === 0) return;
      // アンカーは置換後の座標で保存する(SPEC: 置換はアンカーそのものに適用。
      // 表示・以降の再タップ判定も置換後アンカーに対して行う)。
      const clamped = clampAnchorForPattern(
        skill.target ?? '',
        data.skills.targetPatterns[skill.target ?? ''] ?? [],
        { r, c },
        currentGame.rows,
        currentGame.cols,
      );
      dispatch({ type: 'anchorSet', anchor: clamped });
    },
    [ui.selectedSkillId, currentGame, ui.anchor, runAction, skillMap, data],
  );

  const handleFinish = useCallback(() => runAction({ type: 'finish' }), [runAction]);

  // 対象プレビュー(ライン系はアンカー自動置換後の範囲)。パターン範囲内の
  // グリッド位置すべてを青枠表示する(空きマス含む。ダメージが入るのは存在するマスのみ)。
  const previewTargets = useMemo(() => {
    if (!currentGame || !ui.selectedSkillId || !ui.anchor) return [];
    const skill = skillMap.get(ui.selectedSkillId);
    if (!skill) return [];
    return previewPositions(data.skills, skill, ui.anchor, currentGame);
  }, [currentGame, ui.selectedSkillId, ui.anchor, skillMap, data]);

  // 誤差評価値(現在合計)は常時表示
  const currentJudge = useMemo(
    () => (currentGame ? engine.judge(currentGame) : null),
    [engine, currentGame],
  );

  // 行動ログ表示行(現在ターンのハイライト用にターン番号を付与。検証モードのトグルで
  // 過去ログ含め即時に切り替わるよう、毎回整形し直す)
  const logItems = useMemo(
    () =>
      ui.session
        ? ui.session.log.flatMap((e) =>
            formatEvents(e.events, e.turn, skillName, { showRolls: settings.verifyMode }).map(
              (text) => ({ text, turn: e.turn }),
            ),
          )
        : [],
    [ui.session, skillName, settings.verifyMode],
  );

  const needle = useMemo(
    () => data.needles.needles.find((n) => n.id === settings.needleType) ?? data.needles.needles[0],
    [data, settings.needleType],
  );
  const levelBase = data.concentration.base[config.level - 1];

  if (!recipe) {
    return (
      <div className={styles.loading}>
        有効なレシピがありません(src/data/recipes.json を確認してください)。
      </div>
    );
  }

  const session = ui.session;
  const star3Line = currentGame
    ? data.params.evaluation[String(currentGame.massCount)].star3
    : 0;

  return (
    <div className={styles.app}>
      <Header
        recipes={recipes}
        needles={data.needles.needles}
        settings={settings}
        activeRecipeId={recipe.id}
        onChangeSettings={changeSettings}
        onNewSession={handleNewSession}
        currentSeed={session?.seed ?? null}
        seedInput={seedInput}
        onSeedInputChange={setSeedInput}
        canUndo={canUndo}
        onUndo={handleUndo}
        canRedo={canRedo}
        onRedo={handleRedo}
        onBuildReplayText={buildReplayText}
        onOpenReplayDialog={() => setShowReplayDialog(true)}
      />
      {importWarning && <div className={styles.csvWarning}>{importWarning}</div>}

      {showReplayDialog && (
        <ReplayDialog
          onImport={handleImportReplay}
          onClose={() => setShowReplayDialog(false)}
        />
      )}

      {session && currentGame && (
        <>
          {currentResult && (
            <ResultPanel
              game={currentGame}
              result={currentResult}
              params={data.params}
              onNewSession={handleNewSession}
              verifyMode={settings.verifyMode}
              onUndo={handleUndo}
              onBuildReplayText={buildReplayText}
            />
          )}

          <main className={styles.main}>
            <ClothGrid
              game={currentGame}
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
              game={currentGame}
              params={data.params}
              needle={needle}
              levelBase={levelBase}
              initialConcentration={session.initialConcentration}
              showCyclePreview={settings.showCyclePreview}
            />
          </main>

          <SkillPanel
            skills={actionSkills}
            game={currentGame}
            params={data.params}
            selectedSkillId={ui.selectedSkillId}
            onSkillClick={handleSkillClick}
            onFinish={handleFinish}
          />

          <LogPanel log={logItems} currentTurn={currentTurn} />
        </>
      )}
    </div>
  );
}

export default App;

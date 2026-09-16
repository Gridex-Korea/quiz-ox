// 게임 엔진. 모든 규칙은 DOCS/design/game-flow.md를 따른다.
// 순수 함수: (state, command, now) → { state, effects, error? }. 부수효과(소켓 전송·타이머·저장)는 effects로만 표현한다.
import {
  S2C,
  countByStatus,
  currentQuestion,
  effectiveTimeLimit,
  eligibleStatus,
  findQuestion,
  isLiveMoves,
  isPractice,
  nextNormalQuestion,
  nextRevivalQuestion,
  type AvatarSpec,
  type Choice,
  type Counts,
  type Outcome,
  type Player,
  type PlayerStatus,
  type Question,
  type QuestionInput,
  type QuestionPublic,
  type RoomConfig,
  type RoomState,
  type RoomStatus,
  type RoundMode,
  type RoundResult,
} from '@ox/shared';
import { cloneState, createRoom, newId, snapshotPlayers } from './state';

export type Target = 'all' | 'players' | 'screen' | 'host' | 'screenHost';
export type ScheduleKey = 'autostart' | 'finale' | 'lock';

export type Effect =
  | { type: 'broadcast'; to: Target; event: string; payload: unknown }
  | { type: 'toPlayer'; playerId: string; event: string; payload: unknown }
  | { type: 'toEachPlayer'; event: string; payloadFor: (playerId: string) => unknown }
  | { type: 'timer:set'; deadline: number }
  | { type: 'timer:clear' }
  /** 예약 명령: at 시각에 방이 여전히 onlyIf 상태·문제이면 command를 실행(자동 타이머 시작, 결승 발표 전환) */
  | { type: 'schedule'; key: ScheduleKey; at: number; command: Command; onlyIf: { status: RoomStatus; index: number } }
  | { type: 'unschedule'; key: ScheduleKey | 'all' }
  | { type: 'disconnect'; playerId: string; delayMs: number }
  | { type: 'alert'; level: 'info' | 'warning' | 'error'; message: string }
  | { type: 'stateChanged' };

export type RegisterOutcome = { kind: 'created' | 'rejoined'; playerId: string };

export interface Result {
  state: RoomState;
  effects: Effect[];
  error?: string;
  /** registerPlayer 명령의 결과 */
  registered?: RegisterOutcome;
}

export type Command =
  | { type: 'registerPlayer'; phone: string; name: string; avatar: AvatarSpec; tokenHash: string }
  | { type: 'rotateToken'; playerId: string; tokenHash: string }
  | { type: 'setConnected'; playerId: string; connected: boolean }
  | { type: 'lock' }
  | { type: 'cancelLock' }
  | { type: 'unlock' }
  | { type: 'showQuestion'; index?: number; mode?: RoundMode }
  | { type: 'startRevival'; index?: number; force?: boolean }
  | { type: 'startTimer'; seconds?: number }
  | { type: 'extendTimer'; seconds: number }
  | { type: 'endTimerNow' }
  | { type: 'timeUp' }
  | { type: 'choose'; playerId: string; index: number; choice: Choice }
  | { type: 'reveal' }
  | { type: 'undoReveal' }
  | { type: 'cancelRound' }
  | { type: 'next' }
  | { type: 'end' }
  | { type: 'setWinner'; playerId: string }
  | { type: 'restore'; playerId: string }
  | { type: 'kick'; playerId: string }
  | { type: 'removePlayer'; playerId: string }
  | { type: 'updateConfig'; patch: Partial<RoomConfig> }
  | { type: 'questionsReplace'; questions: QuestionInput[] }
  | { type: 'questionUpsert'; question: QuestionInput }
  | { type: 'questionDelete'; id: string }
  | { type: 'resetRoom'; keepQuestions: boolean }
  | { type: 'purgePhones' };

/** 사회자에게 보여줄 오류 문구 */
export const ERROR_MESSAGES: Record<string, string> = {
  invalid_state: '지금 상태에서는 할 수 없는 동작입니다.',
  locked: '이미 시작된 게임입니다. 새로 입장할 수 없습니다.',
  eliminated: '탈락 처리된 참가자입니다.',
  name_mismatch: '이미 등록된 번호입니다. 처음 입력한 이름을 정확히 입력해 주세요.',
  no_question: '낼 수 있는 문제가 없습니다. 문제를 추가해 주세요.',
  question_used: '이미 출제한 문제입니다.',
  no_waiting: '대기실에 아무도 없어 패자부활전을 열 수 없습니다.',
  revival_used: '패자부활전은 이미 한 번 열었습니다. 비상 상황이면 확인 후 다시 눌러 주세요.',
  not_eligible: '이번 라운드에 답할 수 없는 참가자입니다.',
  too_late: '마감 이후에 도착한 답입니다.',
  rate_limited: '너무 빠르게 선택을 바꿨습니다.',
  wrong_index: '다른 문제에 대한 답입니다.',
  unknown_player: '참가자를 찾을 수 없습니다.',
  not_survivor: '무대 생존자 중에서만 우승자를 고를 수 있습니다.',
  config_locked: '게임 중에는 부활전 시점과 이동 공개 시점만 바꿀 수 있습니다.',
  question_in_use: '진행 중이거나 출제한 문제는 삭제할 수 없습니다.',
};

function ok(state: RoomState, effects: Effect[] = []): Result {
  return { state, effects };
}

function fail(state: RoomState, error: string): Result {
  return { state, effects: [], error };
}

function touch(state: RoomState, now: number): void {
  state.room.updatedAt = now;
}

export function questionPublic(state: RoomState, q: Question, includeExplanation: boolean): QuestionPublic {
  return {
    id: q.id,
    index: q.orderNo,
    total: state.questions.length,
    kind: q.kind,
    text: q.text,
    imageUrl: q.imageUrl,
    timeLimitSec: effectiveTimeLimit(q, state.room.config),
    explanation: includeExplanation ? q.explanation : null,
    practice: isPractice(state.room.config, q.orderNo, state.room.roundMode ?? 'NORMAL'),
  };
}

function eligiblePlayers(state: RoomState): Player[] {
  const mode = state.room.roundMode ?? 'NORMAL';
  const want = eligibleStatus(mode);
  return Object.values(state.players).filter((p) => p.status === want);
}

/** 참가자의 이번 라운드 선택. TIME_UP에 확정된 기록이 있으면 그것이 우선(서버 재시작 뒤에도 유지) */
function choiceOf(state: RoomState, q: Question | undefined, playerId: string): Choice | null {
  const recorded = q ? state.answers[q.id]?.[playerId] : undefined;
  if (recorded) return recorded.choice;
  return state.currentAnswers[playerId]?.choice ?? null;
}

function countChoices(state: RoomState, q: Question | undefined, eligible: Player[]): Counts {
  const counts: Counts = { O: 0, X: 0, none: 0 };
  for (const p of eligible) {
    const c = choiceOf(state, q, p.id);
    if (!c) counts.none += 1;
    else counts[c] += 1;
  }
  return counts;
}

// ---------------------------------------------------------------------------
// 명령 처리
// ---------------------------------------------------------------------------

export function reduce(prev: RoomState, cmd: Command, now: number): Result {
  const state = cloneState(prev);
  switch (cmd.type) {
    case 'registerPlayer':
      return registerPlayer(state, cmd, now);
    case 'rotateToken': {
      const p = state.players[cmd.playerId];
      if (!p) return fail(prev, 'unknown_player');
      p.sessionTokenHash = cmd.tokenHash;
      touch(state, now);
      return ok(state, [{ type: 'stateChanged' }]);
    }
    case 'setConnected': {
      const p = state.players[cmd.playerId];
      if (!p) return fail(prev, 'unknown_player');
      if (p.connected === cmd.connected) return ok(prev);
      p.connected = cmd.connected;
      return ok(state, [
        { type: 'broadcast', to: 'screenHost', event: S2C.playerConnection, payload: { playerId: p.id, connected: p.connected } },
      ]);
    }
    case 'lock': {
      if (state.room.status !== 'LOBBY') return fail(prev, 'invalid_state');
      const seconds = state.room.config.lockCountdownSec;
      // 카운트다운 중에 다시 누르면 즉시 마감. 그 전에는 카운트다운만 시작하고 입장은 계속 열어 둔다
      if (state.room.lockAt === null && seconds > 0) {
        const lockAt = now + seconds * 1000;
        state.room.lockAt = lockAt;
        touch(state, now);
        return ok(state, [
          { type: 'schedule', key: 'lock', at: lockAt, command: { type: 'lock' }, onlyIf: { status: 'LOBBY', index: state.room.currentIndex } },
          { type: 'broadcast', to: 'all', event: S2C.roomLocking, payload: { lockAt, serverNow: now } },
          { type: 'stateChanged' },
        ]);
      }
      state.room.status = 'LOCKED';
      state.room.lockAt = null;
      touch(state, now);
      return ok(state, [
        { type: 'unschedule', key: 'lock' },
        { type: 'broadcast', to: 'all', event: S2C.roomLocked, payload: { playerCount: Object.keys(state.players).length } },
        { type: 'stateChanged' },
      ]);
    }
    case 'cancelLock': {
      if (state.room.status !== 'LOBBY' || state.room.lockAt === null) return fail(prev, 'invalid_state');
      state.room.lockAt = null;
      touch(state, now);
      return ok(state, [
        { type: 'unschedule', key: 'lock' },
        { type: 'broadcast', to: 'all', event: S2C.roomLockCancelled, payload: {} },
        { type: 'stateChanged' },
      ]);
    }
    case 'unlock': {
      if (state.room.status !== 'LOCKED') return fail(prev, 'invalid_state');
      state.room.status = 'LOBBY';
      state.room.lockAt = null;
      touch(state, now);
      return ok(state, [{ type: 'broadcast', to: 'all', event: S2C.roomUnlocked, payload: {} }, { type: 'stateChanged' }]);
    }
    case 'showQuestion':
      return showQuestion(state, prev, cmd.index, cmd.mode, now);
    case 'startRevival': {
      if (state.room.status !== 'REVEALED') return fail(prev, 'invalid_state');
      if (countByStatus(state).WAITING === 0) return fail(prev, 'no_waiting');
      if (state.room.revivalUsedCount >= 1 && !cmd.force) return fail(prev, 'revival_used');
      const q = cmd.index !== undefined ? findQuestion(state, cmd.index) : nextRevivalQuestion(state);
      if (!q) return fail(prev, 'no_question');
      return showQuestion(state, prev, q.orderNo, 'REVIVAL', now);
    }
    case 'startTimer': {
      if (state.room.status !== 'QUESTION_SHOWN') return fail(prev, 'invalid_state');
      const q = currentQuestion(state);
      if (!q) return fail(prev, 'no_question');
      const seconds = cmd.seconds ?? effectiveTimeLimit(q, state.room.config);
      const deadline = now + seconds * 1000;
      state.room.status = 'ANSWERING';
      state.room.deadlineAt = deadline;
      state.room.autoStartAt = null;
      state.currentAnswers = {};
      touch(state, now);
      return ok(state, [
        { type: 'unschedule', key: 'autostart' },
        // 화면 카운트다운은 deadline에 0이 되지만, 늦게 도착한 답을 받아 주기 위해 집계는 유예 뒤에 한다
        { type: 'timer:set', deadline: deadline + state.room.config.answerGraceMs },
        { type: 'broadcast', to: 'all', event: S2C.questionStart, payload: { index: q.orderNo, deadline, serverNow: now } },
        { type: 'stateChanged' },
      ]);
    }
    case 'extendTimer': {
      if (state.room.status !== 'ANSWERING' || state.room.deadlineAt === null) return fail(prev, 'invalid_state');
      const base = Math.max(state.room.deadlineAt, now);
      const deadline = base + cmd.seconds * 1000;
      state.room.deadlineAt = deadline;
      touch(state, now);
      return ok(state, [
        { type: 'timer:set', deadline: deadline + state.room.config.answerGraceMs },
        { type: 'broadcast', to: 'all', event: S2C.questionExtended, payload: { deadline, serverNow: now } },
        { type: 'stateChanged' },
      ]);
    }
    case 'endTimerNow':
    case 'timeUp':
      return timeUp(state, prev, now);
    case 'choose':
      return choose(state, prev, cmd, now);
    case 'reveal':
      return reveal(state, prev, now);
    case 'undoReveal':
      return undoReveal(state, prev, now);
    case 'cancelRound': {
      if (state.room.status !== 'ANSWERING' && state.room.status !== 'TIME_UP') return fail(prev, 'invalid_state');
      const q = currentQuestion(state);
      state.room.status = 'QUESTION_SHOWN';
      state.room.deadlineAt = null;
      state.room.autoStartAt = null; // 사고 대응 중이므로 자동 시작하지 않는다. 사회자가 다시 시작
      state.room.finaleAt = null;
      state.currentAnswers = {};
      if (q) delete state.answers[q.id];
      touch(state, now);
      return ok(state, [
        { type: 'timer:clear' },
        { type: 'unschedule', key: 'all' },
        { type: 'broadcast', to: 'all', event: S2C.roundCancelled, payload: { index: state.room.currentIndex } },
        { type: 'stateChanged' },
      ]);
    }
    case 'next': {
      if (state.room.status !== 'REVEALED') return fail(prev, 'invalid_state');
      const q = nextNormalQuestion(state);
      if (!q) return endGame(state, now);
      return showQuestion(state, prev, q.orderNo, 'NORMAL', now);
    }
    case 'end': {
      if (state.room.status === 'LOBBY' || state.room.status === 'ENDED') return fail(prev, 'invalid_state');
      return endGame(state, now);
    }
    case 'setWinner': {
      if (state.room.status !== 'ENDED') return fail(prev, 'invalid_state');
      const p = state.players[cmd.playerId];
      if (!p) return fail(prev, 'unknown_player');
      if (p.status !== 'ACTIVE') return fail(prev, 'not_survivor');
      state.room.winnerPlayerId = p.id;
      touch(state, now);
      return ok(state, [
        { type: 'broadcast', to: 'all', event: S2C.gameWinner, payload: { playerId: p.id } },
        { type: 'stateChanged' },
      ]);
    }
    case 'restore': {
      const p = state.players[cmd.playerId];
      if (!p) return fail(prev, 'unknown_player');
      if (p.status === 'ELIMINATED') {
        p.status = 'WAITING';
        p.eliminatedAtIndex = null;
      } else if (p.status === 'WAITING') {
        p.status = 'ACTIVE';
      }
      p.strikes = Math.max(0, p.strikes - 1);
      touch(state, now);
      return ok(state, [
        { type: 'alert', level: 'info', message: `${p.name} 참가자를 복구했습니다 (스트라이크 ${p.strikes}, ${p.status}).` },
        { type: 'stateChanged' },
      ]);
    }
    case 'kick': {
      const p = state.players[cmd.playerId];
      if (!p) return fail(prev, 'unknown_player');
      p.status = 'ELIMINATED';
      p.strikes = Math.max(p.strikes, state.room.config.maxStrikes);
      p.eliminatedAtIndex = state.room.currentIndex;
      delete state.currentAnswers[p.id];
      touch(state, now);
      return ok(state, [
        {
          type: 'toPlayer',
          playerId: p.id,
          event: S2C.playerEliminated,
          payload: { atQuestion: state.room.currentIndex, message: '사회자에 의해 퇴장 처리되었습니다.' },
        },
        { type: 'disconnect', playerId: p.id, delayMs: 1500 },
        { type: 'stateChanged' },
      ]);
    }
    case 'removePlayer': {
      // 탈락과 달리 방에서 완전히 지운다(집계·명단·CSV에서 사라짐). 리허설 계정·행사용 봇 정리용
      const p = state.players[cmd.playerId];
      if (!p) return fail(prev, 'unknown_player');
      delete state.players[p.id];
      delete state.currentAnswers[p.id];
      if (state.room.winnerPlayerId === p.id) state.room.winnerPlayerId = null;
      touch(state, now);
      return ok(state, [
        { type: 'toPlayer', playerId: p.id, event: S2C.playerRemoved, payload: { message: '사회자가 참가를 취소했습니다.' } },
        { type: 'disconnect', playerId: p.id, delayMs: 500 },
        { type: 'stateChanged' },
      ]);
    }
    case 'updateConfig': {
      const inGame = !['LOBBY', 'LOCKED'].includes(state.room.status);
      const patch = { ...cmd.patch };
      if (inGame) {
        const allowedInGame: (keyof RoomConfig)[] = ['revivalAfterOrderNo', 'liveMovesUntilOrderNo', 'autoStart', 'autoStartDelaySec', 'finalistThreshold', 'chatEnabled'];
        for (const key of Object.keys(patch) as (keyof RoomConfig)[]) {
          if (!allowedInGame.includes(key)) return fail(prev, 'config_locked');
        }
      }
      state.room.config = { ...state.room.config, ...patch };
      touch(state, now);
      return ok(state, [{ type: 'stateChanged' }]);
    }
    case 'questionsReplace': {
      const byId = new Map(state.questions.map((q) => [q.id, q]));
      const byText = new Map(state.questions.map((q) => [q.text, q]));
      const merged = cmd.questions
        .map((input, i) => ({ input, key: input.orderNo ?? i, i }))
        .sort((a, b) => a.key - b.key || a.i - b.i)
        .map(({ input }, pos) => {
          const existing = (input.id && byId.get(input.id)) || byText.get(input.text);
          return toQuestion(input, pos, existing);
        });
      if (!canReorder(state, merged)) return fail(prev, 'question_in_use');
      state.questions = merged;
      touch(state, now);
      return ok(state, [{ type: 'stateChanged' }]);
    }
    case 'questionUpsert': {
      const inGame = !['LOBBY', 'LOCKED'].includes(state.room.status);
      const idx = cmd.question.id ? state.questions.findIndex((q) => q.id === cmd.question.id) : -1;
      const list = [...state.questions];
      if (idx >= 0) {
        const existing = list[idx]!;
        const orderNo = inGame && existing.usedAt !== null ? existing.orderNo : (cmd.question.orderNo ?? existing.orderNo);
        list[idx] = toQuestion({ ...cmd.question, orderNo }, orderNo, existing);
      } else {
        const maxOrder = list.reduce((m, q) => Math.max(m, q.orderNo), -1);
        const orderNo = inGame ? maxOrder + 1 : (cmd.question.orderNo ?? maxOrder + 1);
        list.push(toQuestion({ ...cmd.question, orderNo }, orderNo));
      }
      const renumbered = renumber(list);
      if (!canReorder(state, renumbered)) return fail(prev, 'question_in_use');
      state.questions = renumbered;
      touch(state, now);
      return ok(state, [{ type: 'stateChanged' }]);
    }
    case 'questionDelete': {
      const q = state.questions.find((x) => x.id === cmd.id);
      if (!q) return ok(prev);
      if (q.usedAt !== null) return fail(prev, 'question_in_use');
      state.questions = state.questions.filter((x) => x.id !== cmd.id);
      touch(state, now);
      return ok(state, [{ type: 'stateChanged' }]);
    }
    case 'resetRoom': {
      const config = state.room.config;
      const questions = cmd.keepQuestions ? state.questions.map((q) => ({ ...q, usedAt: null })) : [];
      const fresh: RoomState = {
        room: { ...createRoom(now), config },
        players: {},
        questions,
        currentAnswers: {},
        answers: {},
        roundResults: {},
      };
      return ok(fresh, [
        { type: 'timer:clear' },
        { type: 'unschedule', key: 'all' },
        { type: 'broadcast', to: 'all', event: S2C.roomReset, payload: { roomCode: fresh.room.code } },
        { type: 'stateChanged' },
      ]);
    }
    case 'purgePhones': {
      for (const p of Object.values(state.players)) p.phone = null;
      state.room.phonesPurgedAt = now;
      touch(state, now);
      return ok(state, [{ type: 'alert', level: 'info', message: '전화번호를 모두 삭제했습니다.' }, { type: 'stateChanged' }]);
    }
    default:
      return fail(prev, 'invalid_state');
  }
}

/** orderNo가 겹치지 않게 0..n-1로 다시 매긴다(기존 순서 유지, 같은 값은 입력 순) */
function renumber(list: Question[]): Question[] {
  return list
    .map((q, i) => ({ q, i }))
    .sort((a, b) => a.q.orderNo - b.q.orderNo || a.i - b.i)
    .map(({ q }, pos) => ({ ...q, orderNo: pos }));
}

/** 이미 출제한 문제의 orderNo가 바뀌면 currentIndex가 어긋나므로 게임 중에는 막는다 */
function canReorder(state: RoomState, next: Question[]): boolean {
  if (['LOBBY', 'LOCKED'].includes(state.room.status)) return true;
  const nextById = new Map(next.map((q) => [q.id, q]));
  return state.questions.every((q) => q.usedAt === null || nextById.get(q.id)?.orderNo === q.orderNo);
}

function toQuestion(input: QuestionInput, orderNo: number, existing?: Question): Question {
  return {
    id: existing?.id ?? input.id ?? newId(),
    orderNo: input.orderNo ?? orderNo,
    kind: input.kind ?? 'NORMAL',
    text: input.text,
    answer: input.answer,
    timeLimitSec: input.timeLimitSec ?? null,
    imageUrl: input.imageUrl ?? null,
    explanation: input.explanation ?? null,
    usedAt: existing?.usedAt ?? null,
  };
}

function registerPlayer(state: RoomState, cmd: Extract<Command, { type: 'registerPlayer' }>, now: number): Result {
  const existing = Object.values(state.players).find((p) => p.phone === cmd.phone);
  if (existing) {
    if (existing.status === 'ELIMINATED') return fail(state, 'eliminated');
    if (existing.name.trim().toLowerCase() !== cmd.name.trim().toLowerCase()) return fail(state, 'name_mismatch');
    existing.sessionTokenHash = cmd.tokenHash;
    touch(state, now);
    return { state, effects: [{ type: 'stateChanged' }], registered: { kind: 'rejoined', playerId: existing.id } };
  }
  if (state.room.status !== 'LOBBY') return fail(state, 'locked');
  const player: Player = {
    id: newId(),
    phone: cmd.phone,
    name: cmd.name.trim(),
    avatar: cmd.avatar,
    strikes: 0,
    status: 'ACTIVE',
    sessionTokenHash: cmd.tokenHash,
    connected: false,
    joinedAt: now,
    consentAt: now,
    eliminatedAtIndex: null,
    revivedAtIndex: null,
  };
  state.players[player.id] = player;
  touch(state, now);
  return {
    state,
    effects: [
      { type: 'broadcast', to: 'screenHost', event: S2C.playerJoined, payload: { player: publicPlayerBase(player) } },
      { type: 'stateChanged' },
    ],
    registered: { kind: 'created', playerId: player.id },
  };
}

export function publicPlayerBase(p: Player) {
  return {
    id: p.id,
    name: p.name,
    avatar: p.avatar,
    status: p.status,
    strikes: p.strikes,
    connected: p.connected,
    eliminatedAtIndex: p.eliminatedAtIndex,
    revivedAtIndex: p.revivedAtIndex,
  };
}

function showQuestion(state: RoomState, prev: RoomState, index: number | undefined, mode: RoundMode | undefined, now: number): Result {
  const from = state.room.status;
  if (from !== 'LOCKED' && from !== 'REVEALED' && from !== 'QUESTION_SHOWN') return fail(prev, 'invalid_state');
  const q = index !== undefined ? findQuestion(state, index) : nextNormalQuestion(state);
  if (!q) return fail(prev, 'no_question');
  if (q.usedAt !== null && q.orderNo !== state.room.currentIndex) return fail(prev, 'question_used');
  const resolvedMode: RoundMode = mode ?? (q.kind === 'REVIVAL' ? 'REVIVAL' : 'NORMAL');
  if (resolvedMode === 'REVIVAL' && countByStatus(state).WAITING === 0) return fail(prev, 'no_waiting');

  // 타이머를 켜기 전에 다른 문제로 바꾸면 이전 문제는 다시 미출제로 돌린다.
  if (from === 'QUESTION_SHOWN') {
    const prevQ = currentQuestion(state);
    if (prevQ && prevQ.id !== q.id) prevQ.usedAt = null;
    if (state.room.roundMode === 'REVIVAL' && resolvedMode !== 'REVIVAL') state.room.revivalUsedCount = Math.max(0, state.room.revivalUsedCount - 1);
    if (state.room.roundMode !== 'REVIVAL' && resolvedMode === 'REVIVAL') state.room.revivalUsedCount += 1;
  } else if (resolvedMode === 'REVIVAL') {
    state.room.revivalUsedCount += 1;
  }

  state.room.status = 'QUESTION_SHOWN';
  state.room.roundMode = resolvedMode;
  state.room.currentIndex = q.orderNo;
  state.room.deadlineAt = null;
  state.room.finaleAt = null;
  if (resolvedMode === 'REVIVAL') state.room.pendingRevival = false;
  state.currentAnswers = {};
  q.usedAt = q.usedAt ?? now;
  // 문제 공개와 함께 준비 카운트 뒤 타이머 자동 시작(설정). 사회자는 "지금 시작"으로 건너뛸 수 있다
  const autoStartAt = state.room.config.autoStart ? now + Math.max(0, state.room.config.autoStartDelaySec) * 1000 : null;
  state.room.autoStartAt = autoStartAt;
  touch(state, now);

  const base = {
    index: q.orderNo,
    total: state.questions.length,
    mode: resolvedMode,
    eligible: eligibleStatus(resolvedMode),
    liveMoves: isLiveMoves(state.room.config, q.orderNo),
    question: questionPublic(state, q, false),
    autoStartAt,
  };
  const scheduling: Effect[] =
    autoStartAt !== null
      ? [{ type: 'schedule', key: 'autostart', at: autoStartAt, command: { type: 'startTimer' }, onlyIf: { status: 'QUESTION_SHOWN', index: q.orderNo } }]
      : [{ type: 'unschedule', key: 'autostart' }];
  return ok(state, [
    { type: 'timer:clear' },
    { type: 'unschedule', key: 'finale' },
    ...scheduling,
    { type: 'broadcast', to: 'players', event: S2C.questionShow, payload: base },
    { type: 'broadcast', to: 'screen', event: S2C.questionShow, payload: base },
    { type: 'broadcast', to: 'host', event: S2C.questionShow, payload: { ...base, answer: q.answer } },
    { type: 'stateChanged' },
  ]);
}

function choose(state: RoomState, prev: RoomState, cmd: Extract<Command, { type: 'choose' }>, now: number): Result {
  if (state.room.status !== 'ANSWERING' || state.room.deadlineAt === null) return fail(prev, 'invalid_state');
  if (cmd.index !== state.room.currentIndex) return fail(prev, 'wrong_index');
  if (now > state.room.deadlineAt + state.room.config.answerGraceMs) return fail(prev, 'too_late');
  const p = state.players[cmd.playerId];
  if (!p) return fail(prev, 'unknown_player');
  if (p.status !== eligibleStatus(state.room.roundMode ?? 'NORMAL')) return fail(prev, 'not_eligible');

  const previous = state.currentAnswers[p.id];
  const effects: Effect[] = [];
  const ack: Effect = {
    type: 'toPlayer',
    playerId: p.id,
    event: S2C.answerAck,
    payload: { index: cmd.index, choice: cmd.choice, acceptedAt: now },
  };
  if (previous && previous.choice === cmd.choice) return ok(prev, [ack]);
  if (previous && now - previous.answeredAt < state.room.config.answerRateLimitMs) return fail(prev, 'rate_limited');

  state.currentAnswers[p.id] = {
    choice: cmd.choice,
    answeredAt: now,
    changeCount: previous ? previous.changeCount + 1 : 0,
  };
  effects.push(ack);
  const moved = { playerId: p.id, choice: cmd.choice };
  if (isLiveMoves(state.room.config, state.room.currentIndex)) {
    effects.push({ type: 'broadcast', to: 'screenHost', event: S2C.answerMoved, payload: moved });
  } else {
    effects.push({ type: 'broadcast', to: 'host', event: S2C.answerMoved, payload: moved });
    if (!previous) effects.push({ type: 'broadcast', to: 'screen', event: S2C.answerLocked, payload: { playerId: p.id } });
  }
  return ok(state, effects);
}

function timeUp(state: RoomState, prev: RoomState, now: number): Result {
  if (state.room.status !== 'ANSWERING') return fail(prev, 'invalid_state');
  const q = currentQuestion(state);
  if (!q) return fail(prev, 'no_question');
  const eligible = eligiblePlayers(state);
  const counts = countChoices(state, undefined, eligible);
  const records: RoomState['answers'][string] = {};
  for (const p of eligible) {
    const a = state.currentAnswers[p.id];
    records[p.id] = {
      choice: a?.choice ?? null,
      answeredAt: a?.answeredAt ?? null,
      changeCount: a?.changeCount ?? 0,
      isCorrect: null,
    };
  }
  state.answers[q.id] = records;
  state.room.status = 'TIME_UP';
  touch(state, now);
  const choices = eligible
    .filter((p) => state.currentAnswers[p.id])
    .map((p) => ({ playerId: p.id, choice: state.currentAnswers[p.id]!.choice }));
  return ok(state, [
    { type: 'timer:clear' },
    { type: 'broadcast', to: 'players', event: S2C.questionTimeup, payload: { index: q.orderNo, counts } },
    { type: 'broadcast', to: 'screenHost', event: S2C.questionTimeup, payload: { index: q.orderNo, counts, choices } },
    { type: 'stateChanged' },
  ]);
}

/** 판정. DOCS/design/game-flow.md "판정 규칙" 그대로 */
export function judge(state: RoomState, q: Question): { outcomes: Outcome[]; newlyEliminated: string[] } {
  const mode = state.room.roundMode ?? 'NORMAL';
  const { maxStrikes } = state.room.config;
  // 맛보기 문제(기본 1번)는 틀려도 아무도 떨어지지 않는다. 규칙을 몸으로 익히게 하는 라운드
  const practice = isPractice(state.room.config, q.orderNo, mode);
  const outcomes: Outcome[] = [];
  const newlyEliminated: string[] = [];
  for (const p of eligiblePlayers(state)) {
    const choice = choiceOf(state, q, p.id);
    const correct = choice === q.answer;
    let revived = false;
    if (correct) {
      if (mode === 'REVIVAL') {
        p.status = 'ACTIVE';
        p.revivedAtIndex = q.orderNo;
        revived = true;
      }
    } else if (!practice) {
      p.strikes += 1;
      if (p.strikes >= maxStrikes) {
        p.status = 'ELIMINATED';
        p.eliminatedAtIndex = q.orderNo;
        newlyEliminated.push(p.id);
      } else {
        p.status = 'WAITING';
      }
    }
    const rec = state.answers[q.id]?.[p.id];
    if (rec) rec.isCorrect = correct;
    outcomes.push({ playerId: p.id, choice, correct, strikesAfter: p.strikes, statusAfter: p.status, revived, practice });
  }
  return { outcomes, newlyEliminated };
}

function reveal(state: RoomState, prev: RoomState, now: number): Result {
  if (state.room.status !== 'TIME_UP') return fail(prev, 'invalid_state');
  const q = currentQuestion(state);
  if (!q) return fail(prev, 'no_question');
  const mode = state.room.roundMode ?? 'NORMAL';
  const snapshotBefore = snapshotPlayers(state);
  const counts = countChoices(state, q, eligiblePlayers(state));
  const { outcomes, newlyEliminated } = judge(state, q);
  const result: RoundResult = {
    questionId: q.id,
    index: q.orderNo,
    mode,
    counts,
    outcomes,
    snapshotBefore,
    revealedAt: now,
    undone: false,
  };
  state.roundResults[q.id] = result;
  state.room.status = 'REVEALED';
  touch(state, now);

  const by = countByStatus(state);
  const outcomeById = new Map(outcomes.map((o) => [o.playerId, o]));
  const effects: Effect[] = [
    {
      type: 'broadcast',
      to: 'screenHost',
      event: S2C.questionReveal,
      payload: {
        index: q.orderNo,
        mode,
        answer: q.answer,
        explanation: q.explanation,
        outcomes,
        survivors: by.ACTIVE,
        waiting: by.WAITING,
        eliminatedCount: by.ELIMINATED,
      },
    },
    {
      type: 'toEachPlayer',
      event: S2C.questionReveal,
      payloadFor: (playerId) => ({
        index: q.orderNo,
        mode,
        answer: q.answer,
        explanation: q.explanation,
        me: outcomeById.get(playerId) ?? null,
      }),
    },
  ];
  for (const id of newlyEliminated) {
    effects.push({
      type: 'toPlayer',
      playerId: id,
      event: S2C.playerEliminated,
      payload: { atQuestion: q.orderNo, message: '아쉽지만 탈락했습니다. 스크린으로 끝까지 응원해 주세요!' },
    });
    effects.push({ type: 'disconnect', playerId: id, delayMs: 3000 });
  }
  // 결승 규칙: 생존자가 결승 인원 이하가 되면 (1) 부활전을 아직 안 열었고 대기실이 있으면 부활전을 먼저, (2) 아니면 잠시 뒤 결승 진출자 발표
  const threshold = state.room.config.finalistThreshold;
  state.room.pendingRevival = false;
  state.room.finaleAt = null;
  if (by.ACTIVE === 0) {
    effects.push({
      type: 'alert',
      level: 'warning',
      message:
        by.WAITING > 0
          ? `무대 생존자가 0명입니다. 대기실 ${by.WAITING}명으로 패자부활전을 열어 이어가거나, 판정을 취소할 수 있습니다.`
          : '무대 생존자가 0명이고 대기실도 비었습니다. 판정 취소 또는 게임 종료를 선택해 주세요.',
    });
  } else if (threshold > 0 && by.ACTIVE <= threshold) {
    if (state.room.revivalUsedCount === 0 && by.WAITING > 0) {
      state.room.pendingRevival = true;
      effects.push({
        type: 'alert',
        level: 'info',
        message: `무대 생존자 ${by.ACTIVE}명. 아직 패자부활전을 열지 않았으니 먼저 패자부활전을 진행합니다. 준비되면 "패자부활전 시작"을 눌러 주세요.`,
      });
    } else {
      const finaleAt = now + 6000;
      state.room.finaleAt = finaleAt;
      effects.push({ type: 'schedule', key: 'finale', at: finaleAt, command: { type: 'end' }, onlyIf: { status: 'REVEALED', index: q.orderNo } });
      effects.push({ type: 'alert', level: 'info', message: `무대 생존자 ${by.ACTIVE}명. 6초 뒤 결승 진출자 축하 화면으로 넘어갑니다. 무대로 불러 현장 결승을 진행해 주세요.` });
    }
  }
  effects.push({ type: 'stateChanged' });
  return ok(state, effects);
}

function undoReveal(state: RoomState, prev: RoomState, now: number): Result {
  if (state.room.status !== 'REVEALED') return fail(prev, 'invalid_state');
  const q = currentQuestion(state);
  if (!q) return fail(prev, 'no_question');
  const result = state.roundResults[q.id];
  if (!result) return fail(prev, 'invalid_state');
  for (const snap of result.snapshotBefore) {
    const p = state.players[snap.id];
    if (!p) continue;
    p.strikes = snap.strikes;
    p.status = snap.status;
    p.eliminatedAtIndex = snap.eliminatedAtIndex;
    p.revivedAtIndex = snap.revivedAtIndex;
  }
  result.undone = true;
  const recs = state.answers[q.id];
  if (recs) for (const r of Object.values(recs)) r.isCorrect = null;
  state.room.status = 'TIME_UP';
  state.room.pendingRevival = false;
  state.room.finaleAt = null;
  touch(state, now);
  return ok(state, [
    { type: 'unschedule', key: 'finale' },
    { type: 'broadcast', to: 'all', event: S2C.roundUndone, payload: { index: q.orderNo } },
    { type: 'alert', level: 'info', message: '직전 판정을 취소했습니다. 정답을 확인한 뒤 다시 공개해 주세요.' },
    { type: 'stateChanged' },
  ]);
}

function endGame(state: RoomState, now: number): Result {
  state.room.status = 'ENDED';
  state.room.deadlineAt = null;
  state.room.autoStartAt = null;
  state.room.pendingRevival = false;
  state.room.finaleAt = null;
  touch(state, now);
  const survivors = Object.values(state.players)
    .filter((p) => p.status === 'ACTIVE')
    .map(publicPlayerBase);
  const totalQuestions = state.questions.filter((q) => q.usedAt !== null).length;
  return ok(state, [
    { type: 'timer:clear' },
    { type: 'unschedule', key: 'all' },
    { type: 'broadcast', to: 'all', event: S2C.gameEnded, payload: { survivors, totalQuestions } },
    { type: 'stateChanged' },
  ]);
}

export function statusOf(state: RoomState, playerId: string): PlayerStatus | undefined {
  return state.players[playerId]?.status;
}

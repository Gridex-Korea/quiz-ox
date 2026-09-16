// 역할별 room:state 투영. 스크린에는 숨김 모드의 ANSWERING 중 선택 방향을 절대 넣지 않는다.
import {
  currentQuestion,
  eligibleStatus,
  isLiveMoves,
  type Outcome,
  type PublicPlayer,
  type RoomState,
  type RoomStateForHost,
  type RoomStateForPlayer,
  type RoomStateForScreen,
} from '@ox/shared';
import { publicPlayerBase, questionPublic } from './reducer';

function currentOutcomes(state: RoomState): Outcome[] | null {
  if (state.room.status !== 'REVEALED') return null;
  const q = currentQuestion(state);
  if (!q) return null;
  const r = state.roundResults[q.id];
  return r && !r.undone ? r.outcomes : null;
}

function currentCounts(state: RoomState) {
  if (state.room.status !== 'TIME_UP' && state.room.status !== 'REVEALED') return null;
  const q = currentQuestion(state);
  if (!q) return null;
  const recs = state.answers[q.id];
  if (!recs) return null;
  const counts = { O: 0, X: 0, none: 0 };
  for (const r of Object.values(recs)) {
    if (r.choice === null) counts.none += 1;
    else counts[r.choice] += 1;
  }
  return counts;
}

/** 스크린이 선택 방향을 볼 수 있는가: 실시간 모드이거나 마감 이후 */
export function screenMaySeeChoices(state: RoomState): boolean {
  const { status, currentIndex, config } = state.room;
  if (status === 'TIME_UP' || status === 'REVEALED') return true;
  if (status === 'ANSWERING') return isLiveMoves(config, currentIndex);
  return false;
}

function playersFor(state: RoomState, audience: 'screen' | 'host'): PublicPlayer[] {
  const seeChoices = audience === 'host' || screenMaySeeChoices(state);
  const inRound = ['ANSWERING', 'TIME_UP', 'REVEALED'].includes(state.room.status);
  const q = currentQuestion(state);
  return Object.values(state.players).map((p) => {
    const base: PublicPlayer = publicPlayerBase(p);
    if (!inRound) return base;
    const live = state.currentAnswers[p.id];
    const recorded = q ? state.answers[q.id]?.[p.id] : undefined;
    const choice = live?.choice ?? recorded?.choice ?? undefined;
    if (choice && seeChoices) base.choice = choice;
    if (live || recorded?.choice) base.hasAnswered = true;
    return base;
  });
}

export function screenView(state: RoomState, now: number, joinUrl: string): RoomStateForScreen {
  const q = currentQuestion(state);
  const revealed = state.room.status === 'REVEALED';
  return {
    status: state.room.status,
    mode: state.room.roundMode,
    liveMoves: state.room.currentIndex >= 0 ? isLiveMoves(state.room.config, state.room.currentIndex) : true,
    roomCode: state.room.code,
    joinUrl,
    players: playersFor(state, 'screen'),
    question: q && state.room.status !== 'LOBBY' && state.room.status !== 'LOCKED' ? questionPublic(state, q, revealed) : null,
    deadline: state.room.deadlineAt,
    autoStartAt: state.room.status === 'QUESTION_SHOWN' ? state.room.autoStartAt : null,
    counts: currentCounts(state),
    answer: revealed && q ? q.answer : null,
    outcomes: currentOutcomes(state),
    winnerId: state.room.winnerPlayerId,
    serverNow: now,
  };
}

export function hostView(state: RoomState, now: number, joinUrl: string): RoomStateForHost {
  const base = screenView(state, now, joinUrl);
  const phones: Record<string, string | null> = {};
  for (const p of Object.values(state.players)) phones[p.id] = p.phone;
  return {
    ...base,
    players: playersFor(state, 'host'),
    questions: state.questions,
    currentIndex: state.room.currentIndex,
    config: state.room.config,
    revivalUsedCount: state.room.revivalUsedCount,
    phones,
    phonesPurgedAt: state.room.phonesPurgedAt,
    createdAt: state.room.createdAt,
  };
}

export function playerView(state: RoomState, playerId: string, now: number): RoomStateForPlayer | null {
  const p = state.players[playerId];
  if (!p) return null;
  const q = currentQuestion(state);
  const mode = state.room.roundMode;
  const status = state.room.status;
  const canAnswer = status === 'ANSWERING' && p.status === eligibleStatus(mode ?? 'NORMAL');
  const me: PublicPlayer = publicPlayerBase(p);
  const live = state.currentAnswers[p.id];
  const recorded = q ? state.answers[q.id]?.[p.id] : undefined;
  const choice = live?.choice ?? recorded?.choice ?? undefined;
  if (choice && ['ANSWERING', 'TIME_UP', 'REVEALED'].includes(status)) me.choice = choice;
  const outcomes = currentOutcomes(state);
  const survivors =
    status === 'ENDED'
      ? Object.values(state.players)
          .filter((x) => x.status === 'ACTIVE')
          .map(publicPlayerBase)
      : null;
  return {
    status,
    mode,
    liveMoves: state.room.currentIndex >= 0 ? isLiveMoves(state.room.config, state.room.currentIndex) : true,
    me,
    canAnswer,
    question: q && status !== 'LOBBY' && status !== 'LOCKED' ? questionPublic(state, q, status === 'REVEALED') : null,
    deadline: state.room.deadlineAt,
    autoStartAt: status === 'QUESTION_SHOWN' ? state.room.autoStartAt : null,
    playerCount: Object.keys(state.players).length,
    counts: currentCounts(state),
    answer: status === 'REVEALED' && q ? q.answer : null,
    myOutcome: outcomes?.find((o) => o.playerId === playerId) ?? null,
    survivors,
    winnerId: state.room.winnerPlayerId,
    serverNow: now,
  };
}

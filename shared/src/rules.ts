// 서버·웹이 같은 답을 내야 하는 작은 규칙 함수들
import type { PlayerStatus, Question, RoomConfig, RoomState, RoundMode } from './types';

/** 이 문제에서 아바타 이동을 실시간으로 보여주는가 */
export function isLiveMoves(config: RoomConfig, index: number): boolean {
  return index <= config.liveMovesUntilOrderNo;
}

/** 라운드 모드별 답변 자격 상태 */
export function eligibleStatus(mode: RoundMode): PlayerStatus {
  return mode === 'REVIVAL' ? 'WAITING' : 'ACTIVE';
}

export function effectiveTimeLimit(q: Question, config: RoomConfig): number {
  return q.timeLimitSec ?? config.defaultTimeLimitSec;
}

export function findQuestion(state: RoomState, index: number): Question | undefined {
  return state.questions.find((q) => q.orderNo === index);
}

export function currentQuestion(state: RoomState): Question | undefined {
  return state.room.currentIndex >= 0 ? findQuestion(state, state.room.currentIndex) : undefined;
}

/** 다음에 낼 일반 문제(미출제, kind NORMAL). 없으면 undefined */
export function nextNormalQuestion(state: RoomState): Question | undefined {
  return [...state.questions]
    .sort((a, b) => a.orderNo - b.orderNo)
    .find((q) => q.usedAt === null && q.kind === 'NORMAL');
}

/** 패자부활전에 낼 문제: REVIVAL 표시 문제 우선, 없으면 아무 미출제 문제 */
export function nextRevivalQuestion(state: RoomState): Question | undefined {
  const unused = [...state.questions].sort((a, b) => a.orderNo - b.orderNo).filter((q) => q.usedAt === null);
  return unused.find((q) => q.kind === 'REVIVAL') ?? unused[0];
}

export function countByStatus(state: RoomState): Record<PlayerStatus, number> {
  const c: Record<PlayerStatus, number> = { ACTIVE: 0, WAITING: 0, ELIMINATED: 0 };
  for (const p of Object.values(state.players)) c[p.status] += 1;
  return c;
}

/**
 * 콘솔의 "다음 단계" 라벨 판단: 방금 공개한 문제가 예정 시점(revivalAfterOrderNo)이고
 * 아직 부활전을 안 열었고 대기실이 있으면 패자부활전을 제안한다.
 */
export function shouldSuggestRevival(state: RoomState): boolean {
  if (state.room.status !== 'REVEALED') return false;
  if (state.room.revivalUsedCount > 0) return false;
  if (state.room.roundMode !== 'NORMAL') return false;
  if (state.room.currentIndex < state.room.config.revivalAfterOrderNo) return false;
  return countByStatus(state).WAITING > 0;
}

/** 전화번호 정규화: 숫자만 남기고 +82 → 0 */
export function normalizePhone(raw: string): string {
  let digits = raw.replace(/\D/g, '');
  if (digits.startsWith('82') && digits.length >= 11) digits = '0' + digits.slice(2);
  return digits;
}

export function formatPhone(digits: string | null): string {
  if (!digits) return '';
  if (digits.length === 11) return `${digits.slice(0, 3)}-${digits.slice(3, 7)}-${digits.slice(7)}`;
  if (digits.length === 10) return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
  return digits;
}

export function maskPhone(digits: string | null): string {
  if (!digits) return '(삭제됨)';
  const f = formatPhone(digits);
  const parts = f.split('-');
  if (parts.length === 3) return `${parts[0]}-****-${parts[2]}`;
  return f.slice(0, 3) + '****' + f.slice(-4);
}

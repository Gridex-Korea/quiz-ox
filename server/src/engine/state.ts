import { randomBytes, randomUUID } from 'node:crypto';
import { DEFAULT_CONFIG, type PlayerSnapshot, type Room, type RoomConfig, type RoomState } from '@ox/shared';

/** 혼동 문자(0/O/1/I)를 뺀 방 코드 */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function generateRoomCode(length = 4): string {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += CODE_ALPHABET[bytes[i]! % CODE_ALPHABET.length];
  return out;
}

export function newId(): string {
  return randomUUID();
}

export function createRoom(now: number, config: Partial<RoomConfig> = {}): Room {
  return {
    id: newId(),
    code: generateRoomCode(),
    status: 'LOBBY',
    roundMode: null,
    currentIndex: -1,
    deadlineAt: null,
    revivalUsedCount: 0,
    winnerPlayerId: null,
    config: { ...DEFAULT_CONFIG, ...config },
    createdAt: now,
    updatedAt: now,
    phonesPurgedAt: null,
  };
}

export function createInitialState(now: number, config: Partial<RoomConfig> = {}): RoomState {
  return {
    room: createRoom(now, config),
    players: {},
    questions: [],
    currentAnswers: {},
    answers: {},
    roundResults: {},
  };
}

export function snapshotPlayers(state: RoomState): PlayerSnapshot[] {
  return Object.values(state.players).map((p) => ({
    id: p.id,
    strikes: p.strikes,
    status: p.status,
    eliminatedAtIndex: p.eliminatedAtIndex,
    revivedAtIndex: p.revivedAtIndex,
  }));
}

export function cloneState(state: RoomState): RoomState {
  return structuredClone(state);
}

// GameService: 효과(타이머·자동 시작)를 실제 setTimeout으로 실행하는 부분을 가짜 타이머로 검증한다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { S2C } from '@ox/shared';
import { reduce } from './engine/reducer';
import { createInitialState } from './engine/state';
import { GameService, type Emitter } from './game';

const T0 = 1_700_000_000_000;

function fakeEmitter() {
  const sent: { target: string; event: string; payload: unknown }[] = [];
  const emitter: Emitter = {
    toTarget: (target, event, payload) => void sent.push({ target, event, payload }),
    toPlayer: (playerId, event, payload) => void sent.push({ target: `p:${playerId}`, event, payload }),
    toEachPlayer: () => undefined,
    disconnectPlayer: () => undefined,
    pushViews: () => undefined,
  };
  return { emitter, sent };
}

function lockedRoom() {
  let s = createInitialState(T0);
  const step = (r: ReturnType<typeof reduce>) => {
    if (r.error) throw new Error(r.error);
    return r.state;
  };
  s = step(
    reduce(
      s,
      {
        type: 'questionsReplace',
        questions: [
          { text: 'Q0', answer: 'O', kind: 'NORMAL', timeLimitSec: 10, imageUrl: null, explanation: null },
          { text: 'Q1', answer: 'X', kind: 'NORMAL', timeLimitSec: 10, imageUrl: null, explanation: null },
        ],
      },
      T0,
    ),
  );
  s = step(reduce(s, { type: 'registerPlayer', phone: '01011112222', name: 'A', avatar: { body: 0, face: 0, hair: 0 }, tokenHash: 'h' }, T0));
  s = step(reduce(s, { type: 'lock' }, T0));
  return s;
}

describe('GameService 자동 시작', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('문제 공개 3초 뒤 타이머가 자동으로 시작되고, 제한시간이 끝나면 마감된다', () => {
    const { emitter, sent } = fakeEmitter();
    const game = new GameService(null, lockedRoom(), { info: () => undefined, error: () => undefined });
    game.attach(emitter);
    expect(game.dispatch({ type: 'showQuestion' }).error).toBeUndefined();
    expect(game.state.room.status).toBe('QUESTION_SHOWN');

    vi.advanceTimersByTime(2999);
    expect(game.state.room.status).toBe('QUESTION_SHOWN');
    vi.advanceTimersByTime(1);
    expect(game.state.room.status).toBe('ANSWERING');
    expect(game.state.room.deadlineAt).toBe(T0 + 3000 + 10_000);
    expect(sent.some((m) => m.event === S2C.questionStart)).toBe(true);

    vi.advanceTimersByTime(10_000);
    expect(game.state.room.status).toBe('TIME_UP');
    game.dispose();
  });

  it('사회자가 먼저 시작하면 자동 시작은 무효가 되어 두 번 시작되지 않는다', () => {
    const { emitter, sent } = fakeEmitter();
    const game = new GameService(null, lockedRoom(), { info: () => undefined, error: () => undefined });
    game.attach(emitter);
    game.dispatch({ type: 'showQuestion' });
    vi.advanceTimersByTime(1000);
    expect(game.dispatch({ type: 'startTimer' }).error).toBeUndefined();
    const deadline = game.state.room.deadlineAt;
    vi.advanceTimersByTime(2500); // 원래 자동 시작 시각을 지나도
    expect(game.state.room.status).toBe('ANSWERING');
    expect(game.state.room.deadlineAt).toBe(deadline);
    expect(sent.filter((m) => m.event === S2C.questionStart)).toHaveLength(1);
    game.dispose();
  });

  it('준비 카운트 중 다른 문제로 바꾸면 새 문제 기준으로 자동 시작된다', () => {
    const { emitter } = fakeEmitter();
    const game = new GameService(null, lockedRoom(), { info: () => undefined, error: () => undefined });
    game.attach(emitter);
    game.dispatch({ type: 'showQuestion', index: 0 });
    vi.advanceTimersByTime(2000);
    game.dispatch({ type: 'showQuestion', index: 1 });
    vi.advanceTimersByTime(1500); // 첫 예약 시각(3초)은 지났지만 두 번째 예약(5초)은 아직
    expect(game.state.room.status).toBe('QUESTION_SHOWN');
    expect(game.state.room.currentIndex).toBe(1);
    vi.advanceTimersByTime(1500);
    expect(game.state.room.status).toBe('ANSWERING');
    expect(game.state.room.currentIndex).toBe(1);
    game.dispose();
  });

  it('생존자가 결승 인원 이하면 정답 공개 6초 뒤 자동으로 결승 발표(ENDED)로 넘어가고, 그 사이 다음 문제로 가면 취소된다', () => {
    const { emitter } = fakeEmitter();
    const game = new GameService(null, lockedRoom(), { info: () => undefined, error: () => undefined });
    game.attach(emitter);
    const playerId = Object.keys(game.state.players)[0]!;
    game.dispatch({ type: 'showQuestion' });
    vi.advanceTimersByTime(3000); // 자동 시작
    game.dispatch({ type: 'choose', playerId, index: 0, choice: 'O' });
    vi.advanceTimersByTime(10_000); // 마감
    game.dispatch({ type: 'reveal' });
    expect(game.state.room.status).toBe('REVEALED');
    expect(game.state.room.finaleAt).not.toBeNull();
    vi.advanceTimersByTime(6000);
    expect(game.state.room.status).toBe('ENDED');

    // 다음 문제로 넘어가면 예약이 무효
    const game2 = new GameService(null, lockedRoom(), { info: () => undefined, error: () => undefined });
    game2.attach(fakeEmitter().emitter);
    const p2 = Object.keys(game2.state.players)[0]!;
    game2.dispatch({ type: 'showQuestion' });
    vi.advanceTimersByTime(3000);
    game2.dispatch({ type: 'choose', playerId: p2, index: 0, choice: 'O' });
    vi.advanceTimersByTime(10_000);
    game2.dispatch({ type: 'reveal' });
    game2.dispatch({ type: 'next' });
    expect(game2.state.room.status).toBe('QUESTION_SHOWN');
    vi.advanceTimersByTime(2000);
    expect(game2.state.room.status).toBe('QUESTION_SHOWN');
    vi.advanceTimersByTime(10_000);
    expect(game2.state.room.status).not.toBe('ENDED');
    game.dispose();
    game2.dispose();
  });

  it('라운드 취소 뒤에는 자동 시작하지 않는다', () => {
    const { emitter } = fakeEmitter();
    const game = new GameService(null, lockedRoom(), { info: () => undefined, error: () => undefined });
    game.attach(emitter);
    game.dispatch({ type: 'showQuestion' });
    vi.advanceTimersByTime(3000);
    expect(game.state.room.status).toBe('ANSWERING');
    game.dispatch({ type: 'cancelRound' });
    expect(game.state.room.status).toBe('QUESTION_SHOWN');
    vi.advanceTimersByTime(10_000);
    expect(game.state.room.status).toBe('QUESTION_SHOWN');
    game.dispose();
  });
});

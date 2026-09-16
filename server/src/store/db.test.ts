import { describe, expect, it } from 'vitest';
import type { RoomState } from '@ox/shared';
import { reduce } from '../engine/reducer';
import { createInitialState } from '../engine/state';
import { Store } from './db';

const T0 = 1_700_000_000_000;

function sampleState(): RoomState {
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
          { text: 'Q0', answer: 'O', kind: 'NORMAL', timeLimitSec: 20, imageUrl: null, explanation: '해설' },
          { text: 'Q1', answer: 'X', kind: 'REVIVAL', timeLimitSec: null, imageUrl: 'http://img', explanation: null },
        ],
      },
      T0,
    ),
  );
  const ids: string[] = [];
  for (let i = 0; i < 3; i++) {
    const r = reduce(s, { type: 'registerPlayer', phone: `0101234567${i}`, name: `참가자${i}`, avatar: { body: i, face: i, hair: i }, tokenHash: `hash${i}` }, T0);
    s = step(r);
    ids.push(r.registered!.playerId);
  }
  s = step(reduce(s, { type: 'lock' }, T0));
  s = step(reduce(s, { type: 'showQuestion' }, T0));
  s = step(reduce(s, { type: 'startTimer' }, T0));
  s = step(reduce(s, { type: 'choose', playerId: ids[0]!, index: 0, choice: 'O' }, T0 + 1000));
  s = step(reduce(s, { type: 'choose', playerId: ids[1]!, index: 0, choice: 'X' }, T0 + 1000));
  s = step(reduce(s, { type: 'timeUp' }, T0 + 16_000));
  s = step(reduce(s, { type: 'reveal' }, T0 + 17_000));
  return s;
}

describe('Store', () => {
  it('저장 후 불러오면 같은 상태(currentAnswers 제외)', () => {
    const store = new Store(':memory:');
    const state = sampleState();
    store.save(state);
    const loaded = store.load();
    expect(loaded).not.toBeNull();
    const { currentAnswers: _a, ...expected } = state;
    const { currentAnswers: _b, ...actual } = loaded!;
    expect(actual).toEqual(expected);
    expect(loaded!.currentAnswers).toEqual({});
    store.close();
  });

  it('두 번 저장해도 행이 중복되지 않는다(전체 교체)', () => {
    const store = new Store(':memory:');
    const state = sampleState();
    store.save(state);
    store.save(state);
    const loaded = store.load()!;
    expect(Object.keys(loaded.players)).toHaveLength(3);
    expect(loaded.questions).toHaveLength(2);
    store.close();
  });

  it('빈 DB는 null', () => {
    const store = new Store(':memory:');
    expect(store.load()).toBeNull();
    store.close();
  });

  it('전화번호 파기 상태(null)도 그대로 저장된다', () => {
    const store = new Store(':memory:');
    let state = sampleState();
    state = reduce(state, { type: 'purgePhones' }, T0 + 50_000).state;
    store.save(state);
    const loaded = store.load()!;
    expect(Object.values(loaded.players).every((p) => p.phone === null)).toBe(true);
    expect(loaded.room.phonesPurgedAt).toBe(T0 + 50_000);
    store.close();
  });
});

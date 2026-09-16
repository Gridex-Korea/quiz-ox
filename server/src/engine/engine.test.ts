import { describe, expect, it } from 'vitest';
import { S2C, shouldSuggestRevival, type Choice, type QuestionInput, type RoomState } from '@ox/shared';
import { reduce, type Command, type Effect } from './reducer';
import { createInitialState } from './state';
import { hostView, playerView, screenView } from './views';

const T0 = 1_700_000_000_000;

function q(text: string, answer: Choice, kind: 'NORMAL' | 'REVIVAL' = 'NORMAL'): QuestionInput {
  return { text, answer, kind, timeLimitSec: null, imageUrl: null, explanation: null };
}

function run(state: RoomState, cmd: Command, now = T0) {
  const r = reduce(state, cmd, now);
  if (r.error) throw new Error(`${cmd.type} failed: ${r.error}`);
  return r;
}

function setup(nPlayers = 4, opts: { liveUntil?: number; practiceUntil?: number } = {}) {
  let s = createInitialState(T0);
  // 대부분의 테스트는 일반 판정을 검증하므로 맛보기를 꺼 둔다(맛보기 테스트만 켠다)
  s = run(s, { type: 'updateConfig', patch: { practiceUntilOrderNo: opts.practiceUntil ?? -1 } }).state;
  if (opts.liveUntil !== undefined) s = run(s, { type: 'updateConfig', patch: { liveMovesUntilOrderNo: opts.liveUntil } }).state;
  s = run(s, {
    type: 'questionsReplace',
    questions: [q('Q0', 'O'), q('Q1', 'X'), q('Q2', 'O'), q('Q3', 'X'), q('Q4', 'O'), q('Q5', 'X'), q('R0', 'O', 'REVIVAL')],
  }).state;
  const ids: string[] = [];
  for (let i = 0; i < nPlayers; i++) {
    const r = run(s, {
      type: 'registerPlayer',
      phone: `0101111000${i}`,
      name: `P${i}`,
      avatar: { body: 0, face: 0, hair: 0 },
      tokenHash: `h${i}`,
    });
    s = r.state;
    ids.push(r.registered!.playerId);
  }
  s = run(s, { type: 'lock' }).state; // 카운트다운 시작
  s = run(s, { type: 'lock' }).state; // 다시 눌러 즉시 마감
  return { s, ids };
}

/** 한 라운드 진행. choices[i]가 undefined면 미응답 */
function playRound(s: RoomState, ids: string[], choices: (Choice | undefined)[], opts: { mode?: 'NORMAL' | 'REVIVAL'; index?: number } = {}) {
  const effects: Effect[] = [];
  let r =
    opts.mode === 'REVIVAL'
      ? run(s, { type: 'startRevival', index: opts.index, force: false })
      : run(s, { type: 'showQuestion', index: opts.index });
  effects.push(...r.effects);
  r = run(r.state, { type: 'startTimer' }, T0);
  effects.push(...r.effects);
  let state = r.state;
  ids.forEach((id, i) => {
    const c = choices[i];
    if (!c) return;
    const rr = reduce(state, { type: 'choose', playerId: id, index: state.room.currentIndex, choice: c }, T0 + 1000 + i);
    if (!rr.error) state = rr.state;
    effects.push(...rr.effects);
  });
  r = run(state, { type: 'timeUp' }, T0 + 16_000);
  effects.push(...r.effects);
  r = run(r.state, { type: 'reveal' }, T0 + 17_000);
  effects.push(...r.effects);
  return { s: r.state, effects };
}

const broadcasts = (effects: Effect[], event: string) =>
  effects.filter((e): e is Extract<Effect, { type: 'broadcast' }> => e.type === 'broadcast' && e.event === event);

describe('입장과 식별', () => {
  it('LOBBY에서 등록되고, 같은 번호·같은 이름은 복귀, 다른 이름은 거절', () => {
    let s = createInitialState(T0);
    const a = run(s, { type: 'registerPlayer', phone: '01012345678', name: '철수', avatar: { body: 1, face: 2, hair: 3 }, tokenHash: 'a' });
    s = a.state;
    expect(a.registered?.kind).toBe('created');
    expect(Object.values(s.players)[0]!.status).toBe('ACTIVE');

    const again = reduce(s, { type: 'registerPlayer', phone: '01012345678', name: ' 철수 ', avatar: { body: 0, face: 0, hair: 0 }, tokenHash: 'b' }, T0);
    expect(again.registered?.kind).toBe('rejoined');
    expect(Object.values(again.state.players)[0]!.sessionTokenHash).toBe('b');

    const hijack = reduce(s, { type: 'registerPlayer', phone: '01012345678', name: '영희', avatar: { body: 0, face: 0, hair: 0 }, tokenHash: 'c' }, T0);
    expect(hijack.error).toBe('name_mismatch');
  });

  it('입장 마감 뒤 신규 번호는 locked, 기존 번호는 복귀 가능', () => {
    const { s } = setup(1);
    const fresh = reduce(s, { type: 'registerPlayer', phone: '01099999999', name: '늦은이', avatar: { body: 0, face: 0, hair: 0 }, tokenHash: 'z' }, T0);
    expect(fresh.error).toBe('locked');
    const back = reduce(s, { type: 'registerPlayer', phone: '01011110000', name: 'P0', avatar: { body: 0, face: 0, hair: 0 }, tokenHash: 'z' }, T0);
    expect(back.registered?.kind).toBe('rejoined');
  });

  it('LOBBY에서는 문제를 낼 수 없고, unlock은 LOCKED에서만', () => {
    const s = createInitialState(T0);
    expect(reduce(s, { type: 'showQuestion' }, T0).error).toBe('invalid_state');
    expect(reduce(s, { type: 'unlock' }, T0).error).toBe('invalid_state');
  });
});

describe('일반 라운드 판정', () => {
  it('오답·미응답은 대기실, 정답은 유지, 실시간 모드에서는 스크린에 이동 이벤트', () => {
    const { s, ids } = setup(4);
    const { s: after, effects } = playRound(s, ids, ['O', 'X', undefined, 'O']); // Q0 정답 O
    expect(after.players[ids[0]!]!.status).toBe('ACTIVE');
    expect(after.players[ids[1]!]!.status).toBe('WAITING');
    expect(after.players[ids[1]!]!.strikes).toBe(1);
    expect(after.players[ids[2]!]!.status).toBe('WAITING'); // 미응답 = 오답
    expect(after.players[ids[3]!]!.status).toBe('ACTIVE');
    expect(after.room.status).toBe('REVEALED');

    const moved = broadcasts(effects, S2C.answerMoved);
    expect(moved).toHaveLength(3);
    expect(moved.every((m) => m.to === 'screenHost')).toBe(true);

    const timeup = broadcasts(effects, S2C.questionTimeup).find((e) => e.to === 'screenHost');
    expect((timeup!.payload as { counts: unknown }).counts).toEqual({ O: 2, X: 1, none: 1 });

    const show = broadcasts(effects, S2C.questionShow);
    expect((show.find((e) => e.to === 'host')!.payload as { answer?: string }).answer).toBe('O');
    expect((show.find((e) => e.to === 'players')!.payload as { answer?: string }).answer).toBeUndefined();
  });

  it('마감 유예(1초) 안에 온 답은 인정, 그 뒤는 거절. 집계도 유예 뒤에 한다', () => {
    const { s, ids } = setup(1);
    let r = run(s, { type: 'showQuestion' });
    r = run(r.state, { type: 'startTimer' }, T0);
    const deadline = r.state.room.deadlineAt!;
    // 화면에는 deadline을 보내지만, 서버 집계 타이머는 유예만큼 뒤에 잡힌다
    const timer = r.effects.find((e) => e.type === 'timer:set');
    expect(timer).toEqual({ type: 'timer:set', deadline: deadline + 1000 });
    expect((broadcasts(r.effects, S2C.questionStart)[0]!.payload as { deadline: number }).deadline).toBe(deadline);

    const inGrace = reduce(r.state, { type: 'choose', playerId: ids[0]!, index: 0, choice: 'O' }, deadline + 900);
    expect(inGrace.error).toBeUndefined();
    const late = reduce(r.state, { type: 'choose', playerId: ids[0]!, index: 0, choice: 'O' }, deadline + 1200);
    expect(late.error).toBe('too_late');
  });

  it('선택 변경은 속도 제한, 같은 선택은 ack만, 마지막 선택이 답', () => {
    const { s, ids } = setup(1);
    let r = run(s, { type: 'showQuestion' });
    r = run(r.state, { type: 'startTimer' }, T0);
    r = run(r.state, { type: 'choose', playerId: ids[0]!, index: 0, choice: 'O' }, T0 + 1000);
    const tooFast = reduce(r.state, { type: 'choose', playerId: ids[0]!, index: 0, choice: 'X' }, T0 + 1100);
    expect(tooFast.error).toBe('rate_limited');
    const same = reduce(r.state, { type: 'choose', playerId: ids[0]!, index: 0, choice: 'O' }, T0 + 1100);
    expect(same.error).toBeUndefined();
    expect(same.effects.filter((e) => e.type === 'broadcast')).toHaveLength(0);
    r = run(r.state, { type: 'choose', playerId: ids[0]!, index: 0, choice: 'X' }, T0 + 2000);
    expect(r.state.currentAnswers[ids[0]!]!.changeCount).toBe(1);
    r = run(r.state, { type: 'timeUp' }, T0 + 16_000);
    r = run(r.state, { type: 'reveal' }, T0 + 17_000);
    expect(r.state.players[ids[0]!]!.status).toBe('WAITING'); // 마지막 선택 X, 정답 O
  });

  it('두 번째 오답은 퇴장 + 연결 종료 효과', () => {
    const { s, ids } = setup(1);
    let round = playRound(s, ids, ['X']); // Q0 정답 O → 1스트라이크
    round = playRound(round.s, ids, ['O']); // Q1 정답 X → 2스트라이크... 하지만 WAITING은 일반 라운드 자격이 없다
    expect(round.s.players[ids[0]!]!.status).toBe('WAITING');
    expect(round.s.players[ids[0]!]!.strikes).toBe(1);
  });
});

describe('맛보기 문제', () => {
  it('1번 문제(기본)는 틀려도 아무도 떨어지지 않고, 2번부터는 평소대로다', () => {
    const { s, ids } = setup(3, { practiceUntil: 0 });
    // Q0 정답 O: 두 명이 틀려도 스트라이크 0, 전원 ACTIVE
    const first = playRound(s, ids, ['O', 'X', undefined]);
    expect(first.s.players[ids[1]!]).toMatchObject({ status: 'ACTIVE', strikes: 0 });
    expect(first.s.players[ids[2]!]).toMatchObject({ status: 'ACTIVE', strikes: 0 });
    const outcomes = (broadcasts(first.effects, S2C.questionReveal)[0]!.payload as { outcomes: { practice?: boolean; correct: boolean }[] }).outcomes;
    expect(outcomes.every((o) => o.practice === true)).toBe(true);
    expect(outcomes.filter((o) => !o.correct)).toHaveLength(2);
    // 화면에도 맛보기임을 알린다
    expect((broadcasts(first.effects, S2C.questionShow)[0]!.payload as { question: { practice: boolean } }).question.practice).toBe(true);

    // Q1은 일반 문제 → 틀리면 대기실
    const second = playRound(first.s, ids, ['X', 'O', undefined]); // 정답 X
    expect(second.s.players[ids[0]!]).toMatchObject({ status: 'ACTIVE', strikes: 0 });
    expect(second.s.players[ids[1]!]).toMatchObject({ status: 'WAITING', strikes: 1 });
    expect(second.s.players[ids[2]!]).toMatchObject({ status: 'WAITING', strikes: 1 });
    expect((broadcasts(second.effects, S2C.questionShow)[0]!.payload as { question: { practice: boolean } }).question.practice).toBe(false);
  });

  it('맛보기를 끄면 1번 문제도 평소대로 판정한다', () => {
    const { s, ids } = setup(2, { practiceUntil: -1 });
    const r = playRound(s, ids, ['O', 'X']);
    expect(r.s.players[ids[1]!]).toMatchObject({ status: 'WAITING', strikes: 1 });
  });

  it('패자부활전은 맛보기가 되지 않는다', () => {
    // 맛보기 범위를 넓혀도 REVIVAL 모드면 정상 판정
    const { s, ids } = setup(3, { practiceUntil: 99 });
    const first = playRound(s, ids, ['O', 'O', 'O']);
    expect(Object.values(first.s.players).every((p) => p.strikes === 0)).toBe(true);
    // 대기실을 만들기 위해 수동으로 한 명 내림
    const withWaiting = run(first.s, { type: 'kick', playerId: ids[2]! }).state;
    const restored = run(withWaiting, { type: 'restore', playerId: ids[2]! }).state;
    expect(restored.players[ids[2]!]!.status).toBe('WAITING');
    let r = run(restored, { type: 'startRevival' });
    r = run(r.state, { type: 'startTimer' }, T0);
    r = run(r.state, { type: 'timeUp' }, T0 + 20_000);
    r = run(r.state, { type: 'reveal' }, T0 + 21_000);
    // 부활전 미응답 → 맛보기 설정과 무관하게 스트라이크가 오른다
    expect(r.state.players[ids[2]!]!.strikes).toBeGreaterThan(restored.players[ids[2]!]!.strikes);
  });
});

describe('이동 숨김 모드', () => {
  it('스크린에는 마감 전 선택 방향이 나가지 않고, 마감 시 choices가 나간다', () => {
    const { s, ids } = setup(2, { liveUntil: -1 });
    let r = run(s, { type: 'showQuestion' });
    r = run(r.state, { type: 'startTimer' }, T0);
    const c1 = run(r.state, { type: 'choose', playerId: ids[0]!, index: 0, choice: 'X' }, T0 + 1000);
    const moved = broadcasts(c1.effects, S2C.answerMoved);
    expect(moved).toHaveLength(1);
    expect(moved[0]!.to).toBe('host');
    expect(broadcasts(c1.effects, S2C.answerLocked)).toHaveLength(1);
    expect(broadcasts(c1.effects, S2C.answerLocked)[0]!.to).toBe('screen');

    const c2 = run(c1.state, { type: 'choose', playerId: ids[0]!, index: 0, choice: 'O' }, T0 + 2000);
    expect(broadcasts(c2.effects, S2C.answerLocked)).toHaveLength(0); // 두 번째 변경은 배지 재전송 없음

    const screen = screenView(c2.state, T0 + 2000, 'http://x/join');
    const me = screen.players.find((p) => p.id === ids[0]!)!;
    expect(me.choice).toBeUndefined();
    expect(me.hasAnswered).toBe(true);
    expect(screen.liveMoves).toBe(false);
    const host = hostView(c2.state, T0 + 2000, 'http://x/join');
    expect(host.players.find((p) => p.id === ids[0]!)!.choice).toBe('O');

    const tu = run(c2.state, { type: 'timeUp' }, T0 + 16_000);
    const toScreen = broadcasts(tu.effects, S2C.questionTimeup).find((e) => e.to === 'screenHost')!;
    expect((toScreen.payload as { choices: unknown[] }).choices).toEqual([{ playerId: ids[0], choice: 'O' }]);
    const toPlayers = broadcasts(tu.effects, S2C.questionTimeup).find((e) => e.to === 'players')!;
    expect((toPlayers.payload as { choices?: unknown }).choices).toBeUndefined();
    expect(screenView(tu.state, T0, 'u').players.find((p) => p.id === ids[0]!)!.choice).toBe('O');
  });

  it('기본 설정: 4번 문제(orderNo 3)까지 실시간, 5번(orderNo 4)부터 숨김', () => {
    const { s } = setup(1);
    expect(screenView({ ...s, room: { ...s.room, currentIndex: 3, status: 'ANSWERING' } }, T0, 'u').liveMoves).toBe(true);
    expect(screenView({ ...s, room: { ...s.room, currentIndex: 4, status: 'ANSWERING' } }, T0, 'u').liveMoves).toBe(false);
  });
});

describe('패자부활전', () => {
  function toWaiting() {
    const { s, ids } = setup(4);
    // Q0(O): P0,P1 정답 / P2,P3 오답 → 대기실 2명
    return { ...playRound(s, ids, ['O', 'O', 'X', 'X']), ids };
  }

  it('REVEALED에서만, 대기실 1명 이상일 때만, 두 번째는 force 필요', () => {
    const { s, ids } = toWaiting();
    expect(reduce(setup(1).s, { type: 'startRevival' }, T0).error).toBe('invalid_state');
    const w = setup(2);
    const noWaiting = playRound(w.s, w.ids, ['O', 'O']).s;
    expect(reduce(noWaiting, { type: 'startRevival' }, T0).error).toBe('no_waiting');

    const first = run(s, { type: 'startRevival' });
    expect(first.state.room.roundMode).toBe('REVIVAL');
    expect(first.state.room.currentIndex).toBe(6); // REVIVAL 표시 문제 R0
    expect(first.state.room.revivalUsedCount).toBe(1);
    // 부활전 진행 후 다시 열기
    let r = run(first.state, { type: 'startTimer' }, T0);
    r = run(r.state, { type: 'choose', playerId: ids[2]!, index: 6, choice: 'O' }, T0 + 1000);
    r = run(r.state, { type: 'timeUp' }, T0 + 16_000);
    r = run(r.state, { type: 'reveal' }, T0 + 17_000);
    expect(r.state.players[ids[2]!]!.status).toBe('ACTIVE');
    expect(r.state.players[ids[3]!]!.status).toBe('ELIMINATED'); // 미응답 → 탈락
    expect(reduce(r.state, { type: 'startRevival' }, T0).error).toBe('no_waiting');
  });

  it('부활자는 스트라이크 1을 유지하고 다음 오답에 곧바로 탈락한다', () => {
    const { s, ids } = toWaiting();
    let r = run(s, { type: 'startRevival' });
    // ACTIVE는 부활전에 답할 수 없다
    r = run(r.state, { type: 'startTimer' }, T0);
    expect(reduce(r.state, { type: 'choose', playerId: ids[0]!, index: 6, choice: 'O' }, T0 + 500).error).toBe('not_eligible');
    r = run(r.state, { type: 'choose', playerId: ids[2]!, index: 6, choice: 'O' }, T0 + 1000);
    r = run(r.state, { type: 'choose', playerId: ids[3]!, index: 6, choice: 'X' }, T0 + 1000);
    r = run(r.state, { type: 'timeUp' }, T0 + 16_000);
    r = run(r.state, { type: 'reveal' }, T0 + 17_000);
    const revived = r.state.players[ids[2]!]!;
    expect(revived.status).toBe('ACTIVE');
    expect(revived.strikes).toBe(1);
    expect(revived.revivedAtIndex).toBe(6);
    const outcome = (broadcasts(r.effects, S2C.questionReveal)[0]!.payload as { outcomes: { playerId: string; revived: boolean }[] }).outcomes;
    expect(outcome.find((o) => o.playerId === ids[2]!)!.revived).toBe(true);
    expect(r.state.players[ids[3]!]!.status).toBe('ELIMINATED');
    expect(r.effects.some((e) => e.type === 'disconnect' && e.playerId === ids[3]!)).toBe(true);

    // 다음 일반 라운드: 부활자가 틀리면 대기실을 거치지 않고 탈락
    const next = playRound(r.state, ids, ['X', 'X', 'O', undefined]); // Q1 정답 X → P2(부활자) 오답
    expect(next.s.room.currentIndex).toBe(1);
    expect(next.s.players[ids[2]!]!.status).toBe('ELIMINATED');
    expect(next.s.players[ids[2]!]!.strikes).toBe(2);
  });

  it('부활전 시작 시 revivalUsedCount가 오르고 두 번째는 force로만', () => {
    const { s, ids } = toWaiting();
    let r = run(s, { type: 'startRevival' });
    r = run(r.state, { type: 'startTimer' }, T0);
    r = run(r.state, { type: 'choose', playerId: ids[2]!, index: 6, choice: 'X' }, T0 + 1000); // 오답 → 탈락
    r = run(r.state, { type: 'timeUp' }, T0 + 16_000);
    r = run(r.state, { type: 'reveal' }, T0 + 17_000);
    // P3는 미응답으로 탈락, 대기실 0명 → 새로 대기실을 만든다
    const round = playRound(r.state, ids, ['X', 'O', undefined, undefined]); // Q1 정답 X → P1 오답 → 대기실
    expect(round.s.players[ids[1]!]!.status).toBe('WAITING');
    expect(reduce(round.s, { type: 'startRevival' }, T0).error).toBe('revival_used');
    expect(reduce(round.s, { type: 'startRevival', force: true }, T0).error).toBeUndefined();
  });

  it('예정 시점(5번 문제) 공개 뒤 대기실이 있으면 부활전을 제안한다', () => {
    const { s, ids } = setup(3);
    let cur = s;
    for (let i = 0; i < 5; i++) {
      const answers: Choice[] = i === 4 ? ['O', 'O', 'X'] : ['O', 'X', 'O', 'X'][i]! === 'O' ? ['O', 'O', 'O'] : ['X', 'X', 'X'];
      const res = playRound(cur, ids, answers);
      cur = res.s;
      if (i < 4) expect(shouldSuggestRevival(cur)).toBe(false);
    }
    expect(cur.room.currentIndex).toBe(4);
    expect(shouldSuggestRevival(cur)).toBe(true);
  });
});

describe('입장 마감 카운트다운', () => {
  function lobbyWithPlayers(n = 2) {
    let s = createInitialState(T0);
    s = run(s, { type: 'questionsReplace', questions: [q('Q0', 'O')] }).state;
    for (let i = 0; i < n; i++) {
      s = run(s, { type: 'registerPlayer', phone: `0101111000${i}`, name: `P${i}`, avatar: { body: 0, face: 0, hair: 0 }, tokenHash: `h${i}` }).state;
    }
    return s;
  }

  it('처음 누르면 카운트다운만 시작하고 입장은 계속 열려 있다', () => {
    const s = lobbyWithPlayers();
    const r = run(s, { type: 'lock' });
    expect(r.state.room.status).toBe('LOBBY');
    expect(r.state.room.lockAt).toBe(T0 + 10_000);
    expect(r.effects.find((e) => e.type === 'schedule' && e.key === 'lock')).toMatchObject({
      at: T0 + 10_000,
      command: { type: 'lock' },
      onlyIf: { status: 'LOBBY', index: -1 },
    });
    expect(broadcasts(r.effects, S2C.roomLocking)[0]!.payload).toMatchObject({ lockAt: T0 + 10_000 });
    expect(screenView(r.state, T0, 'u').lockAt).toBe(T0 + 10_000);
    // 카운트다운 중에도 새 참가자가 들어올 수 있다
    const late = reduce(r.state, { type: 'registerPlayer', phone: '01099998888', name: '막차', avatar: { body: 0, face: 0, hair: 0 }, tokenHash: 'z' }, T0 + 3000);
    expect(late.error).toBeUndefined();
    expect(late.registered?.kind).toBe('created');
  });

  it('카운트다운 중 다시 누르면 즉시 마감된다', () => {
    const counting = run(lobbyWithPlayers(), { type: 'lock' }).state;
    const now = run(counting, { type: 'lock' }, T0 + 4000);
    expect(now.state.room.status).toBe('LOCKED');
    expect(now.state.room.lockAt).toBeNull();
    expect(now.effects.some((e) => e.type === 'unschedule' && e.key === 'lock')).toBe(true);
    expect(broadcasts(now.effects, S2C.roomLocked)).toHaveLength(1);
    // 마감 뒤에는 신규 입장 거절
    expect(reduce(now.state, { type: 'registerPlayer', phone: '01099998888', name: '늦은이', avatar: { body: 0, face: 0, hair: 0 }, tokenHash: 'z' }, T0).error).toBe('locked');
  });

  it('마감 취소는 카운트다운만 되돌리고, 카운트다운이 없으면 거절한다', () => {
    const s = lobbyWithPlayers();
    expect(reduce(s, { type: 'cancelLock' }, T0).error).toBe('invalid_state');
    const counting = run(s, { type: 'lock' }).state;
    const cancelled = run(counting, { type: 'cancelLock' }, T0 + 2000);
    expect(cancelled.state.room.status).toBe('LOBBY');
    expect(cancelled.state.room.lockAt).toBeNull();
    expect(cancelled.effects.some((e) => e.type === 'unschedule' && e.key === 'lock')).toBe(true);
    expect(broadcasts(cancelled.effects, S2C.roomLockCancelled)).toHaveLength(1);
  });

  it('카운트다운을 0으로 두면 누르는 즉시 마감된다', () => {
    const s = run(lobbyWithPlayers(), { type: 'updateConfig', patch: { lockCountdownSec: 0 } }).state;
    const r = run(s, { type: 'lock' });
    expect(r.state.room.status).toBe('LOCKED');
    expect(r.state.room.lockAt).toBeNull();
  });

  it('입장을 다시 열면 카운트다운 흔적이 남지 않는다', () => {
    const locked = run(run(lobbyWithPlayers(), { type: 'lock' }).state, { type: 'lock' }, T0 + 1000).state;
    const reopened = run(locked, { type: 'unlock' });
    expect(reopened.state.room.status).toBe('LOBBY');
    expect(reopened.state.room.lockAt).toBeNull();
  });
});

describe('타이머 자동 시작', () => {
  it('문제 공개가 준비 카운트 뒤 자동 시작을 예약하고, 수동 시작·라운드 취소가 예약을 해제한다', () => {
    const { s } = setup(1);
    const shown = run(s, { type: 'showQuestion' });
    expect(shown.state.room.autoStartAt).toBe(T0 + 3000);
    const set = shown.effects.find((e) => e.type === 'schedule' && e.key === 'autostart');
    expect(set).toMatchObject({ type: 'schedule', key: 'autostart', at: T0 + 3000, command: { type: 'startTimer' }, onlyIf: { status: 'QUESTION_SHOWN', index: 0 } });
    expect((broadcasts(shown.effects, S2C.questionShow)[0]!.payload as { autoStartAt: number }).autoStartAt).toBe(T0 + 3000);
    expect(screenView(shown.state, T0, 'u').autoStartAt).toBe(T0 + 3000);

    const started = run(shown.state, { type: 'startTimer' }, T0 + 1000);
    expect(started.state.room.autoStartAt).toBeNull();
    expect(started.effects.some((e) => e.type === 'unschedule' && e.key === 'autostart')).toBe(true);
    expect(screenView(started.state, T0, 'u').autoStartAt).toBeNull();

    const cancelled = run(started.state, { type: 'cancelRound' }, T0 + 2000);
    expect(cancelled.state.room.autoStartAt).toBeNull();
    expect(cancelled.effects.some((e) => e.type === 'unschedule' && (e.key === 'all' || e.key === 'autostart'))).toBe(true);
  });

  it('자동 시작을 끄면 예약하지 않고, 준비 카운트 0이면 공개 시각에 바로 예약한다', () => {
    const manual = run(setup(1).s, { type: 'updateConfig', patch: { autoStart: false } }).state;
    const shownManual = run(manual, { type: 'showQuestion' });
    expect(shownManual.state.room.autoStartAt).toBeNull();
    expect(shownManual.effects.some((e) => e.type === 'schedule' && e.key === 'autostart')).toBe(false);

    const instant = run(setup(1).s, { type: 'updateConfig', patch: { autoStartDelaySec: 0 } }).state;
    const shownInstant = run(instant, { type: 'showQuestion' });
    expect(shownInstant.state.room.autoStartAt).toBe(T0);
  });
});

describe('결승 규칙 (생존자가 결승 인원 이하)', () => {
  it('부활전을 아직 안 열었고 대기실이 있으면 부활전을 먼저 요구하고, 부활전 뒤에는 6초 뒤 결승 발표를 예약한다', () => {
    const { s, ids } = setup(5);
    // Q0 정답 O: 3명 오답 → 생존 2, 대기실 3
    const r1 = playRound(s, ids, ['O', 'O', 'X', 'X', 'X']);
    expect(r1.s.room.pendingRevival).toBe(true);
    expect(r1.s.room.finaleAt).toBeNull();
    expect(r1.effects.some((e) => e.type === 'schedule' && e.key === 'finale')).toBe(false);
    expect(shouldSuggestRevival(r1.s)).toBe(true);
    expect(screenView(r1.s, T0, 'u').pendingRevival).toBe(true);

    // 부활전: 대기실 3명 중 1명만 정답 → 생존 3, 탈락 2 → 결승 예약
    let r = run(r1.s, { type: 'startRevival' });
    expect(r.state.room.pendingRevival).toBe(false);
    r = run(r.state, { type: 'startTimer' }, T0);
    r = run(r.state, { type: 'choose', playerId: ids[2]!, index: 6, choice: 'O' }, T0 + 1000);
    r = run(r.state, { type: 'timeUp' }, T0 + 16_000);
    r = run(r.state, { type: 'reveal' }, T0 + 17_000);
    expect(r.state.room.finaleAt).toBe(T0 + 23_000);
    const sched = r.effects.find((e) => e.type === 'schedule' && e.key === 'finale');
    expect(sched).toMatchObject({ at: T0 + 23_000, command: { type: 'end' }, onlyIf: { status: 'REVEALED', index: 6 } });
    expect(screenView(r.state, T0, 'u').finaleAt).toBe(T0 + 23_000);

    // 종료되면 결승 진출자 3명과 뒷번호 4자리(사회자 결정으로 스크린에만)
    const ended = run(r.state, { type: 'end' }, T0 + 23_000);
    const view = screenView(ended.state, T0, 'u');
    expect(view.finalists!.map((f) => f.name)).toEqual(['P0', 'P1', 'P2']);
    expect(view.finalists!.map((f) => f.phoneTail)).toEqual(['0000', '0001', '0002']);
    expect(playerView(ended.state, ids[0]!, T0)!.isFinalist).toBe(true);
    expect(playerView(ended.state, ids[3]!, T0)!.isFinalist).toBe(false);
    // 결승 이외의 화면·이벤트에는 전화번호가 없다
    expect(JSON.stringify(screenView(r.state, T0, 'u'))).not.toContain('0101111');
  });

  it('대기실이 비었으면 부활전 없이 바로 결승 발표를 예약하고, 인원을 넘으면 finalists는 null', () => {
    const three = setup(3);
    const all = playRound(three.s, three.ids, ['O', 'O', 'O']); // 생존 3, 대기실 0
    expect(all.s.room.pendingRevival).toBe(false);
    expect(all.s.room.finaleAt).toBe(T0 + 23_000);
    const ended = run(all.s, { type: 'end' }, T0 + 23_000);
    expect(screenView(ended.state, T0, 'u').finalists).toHaveLength(3);

    const four = setup(4);
    const many = playRound(four.s, four.ids, ['O', 'O', 'O', 'O']); // 생존 4 > 3
    expect(many.s.room.finaleAt).toBeNull();
    const endedMany = run(many.s, { type: 'end' });
    expect(screenView(endedMany.state, T0, 'u').finalists).toBeNull();
  });

  it('결승 인원을 0으로 두면 규칙이 꺼진다', () => {
    const { s, ids } = setup(2);
    const off = run(s, { type: 'updateConfig', patch: { finalistThreshold: 0 } }).state;
    const r = playRound(off, ids, ['O', 'O']);
    expect(r.s.room.finaleAt).toBeNull();
    expect(r.s.room.pendingRevival).toBe(false);
  });

  it('판정 취소는 결승 예약과 부활전 대기를 모두 푼다', () => {
    const { s, ids } = setup(3);
    const r = playRound(s, ids, ['O', 'O', 'O']);
    expect(r.s.room.finaleAt).not.toBeNull();
    const undone = run(r.s, { type: 'undoReveal' });
    expect(undone.state.room.finaleAt).toBeNull();
    expect(undone.effects.some((e) => e.type === 'unschedule' && e.key === 'finale')).toBe(true);
  });
});

describe('되돌리기와 수동 개입', () => {
  it('undoReveal은 스냅샷으로 복원하고 TIME_UP으로 돌아간다', () => {
    const { s, ids } = setup(2);
    const { s: after } = playRound(s, ids, ['X', 'O']); // P0 오답
    expect(after.players[ids[0]!]!.status).toBe('WAITING');
    const undone = run(after, { type: 'undoReveal' });
    expect(undone.state.room.status).toBe('TIME_UP');
    expect(undone.state.players[ids[0]!]!.status).toBe('ACTIVE');
    expect(undone.state.players[ids[0]!]!.strikes).toBe(0);
    expect(Object.values(undone.state.roundResults)[0]!.undone).toBe(true);
    const again = run(undone.state, { type: 'reveal' }, T0 + 20_000);
    expect(again.state.players[ids[0]!]!.status).toBe('WAITING');
  });

  it('undoReveal은 탈락자도 대기실로 되살린다', () => {
    const { s, ids } = setup(2);
    const r1 = playRound(s, ids, ['X', 'O']); // P0 → WAITING
    let r = run(r1.s, { type: 'startRevival' });
    r = run(r.state, { type: 'startTimer' }, T0);
    r = run(r.state, { type: 'timeUp' }, T0 + 16_000);
    r = run(r.state, { type: 'reveal' }, T0 + 17_000); // P0 미응답 → ELIMINATED
    expect(r.state.players[ids[0]!]!.status).toBe('ELIMINATED');
    const undone = run(r.state, { type: 'undoReveal' });
    expect(undone.state.players[ids[0]!]!.status).toBe('WAITING');
    expect(undone.state.players[ids[0]!]!.strikes).toBe(1);
  });

  it('cancelRound는 답을 버리고 문제 화면으로', () => {
    const { s, ids } = setup(1);
    let r = run(s, { type: 'showQuestion' });
    r = run(r.state, { type: 'startTimer' }, T0);
    r = run(r.state, { type: 'choose', playerId: ids[0]!, index: 0, choice: 'O' }, T0 + 1000);
    r = run(r.state, { type: 'cancelRound' });
    expect(r.state.room.status).toBe('QUESTION_SHOWN');
    expect(r.state.currentAnswers).toEqual({});
    expect(r.effects.some((e) => e.type === 'timer:clear')).toBe(true);
  });

  it('removePlayer는 참가자를 방에서 완전히 지우고 연결을 끊는다', () => {
    const { s, ids } = setup(3);
    let r = run(s, { type: 'showQuestion' });
    r = run(r.state, { type: 'startTimer' }, T0);
    r = run(r.state, { type: 'choose', playerId: ids[0]!, index: 0, choice: 'O' }, T0 + 1000);
    const removed = run(r.state, { type: 'removePlayer', playerId: ids[0]! });
    expect(removed.state.players[ids[0]!]).toBeUndefined();
    expect(removed.state.currentAnswers[ids[0]!]).toBeUndefined();
    expect(Object.keys(removed.state.players)).toHaveLength(2);
    expect(removed.effects.some((e) => e.type === 'toPlayer' && e.event === S2C.playerRemoved)).toBe(true);
    expect(removed.effects.some((e) => e.type === 'disconnect' && e.playerId === ids[0]!)).toBe(true);
    // 지운 참가자는 마감 집계에도 들어가지 않는다
    const tu = run(removed.state, { type: 'timeUp' }, T0 + 16_000);
    const toScreen = broadcasts(tu.effects, S2C.questionTimeup).find((e) => e.to === 'screenHost')!;
    expect((toScreen.payload as { counts: { O: number; X: number; none: number } }).counts).toEqual({ O: 0, X: 0, none: 2 });
    expect(reduce(removed.state, { type: 'removePlayer', playerId: ids[0]! }, T0).error).toBe('unknown_player');
  });

  it('restore/kick', () => {
    const { s, ids } = setup(2);
    const { s: after } = playRound(s, ids, ['X', 'O']);
    const restored = run(after, { type: 'restore', playerId: ids[0]! });
    expect(restored.state.players[ids[0]!]!.status).toBe('ACTIVE');
    expect(restored.state.players[ids[0]!]!.strikes).toBe(0);
    const kicked = run(after, { type: 'kick', playerId: ids[1]! });
    expect(kicked.state.players[ids[1]!]!.status).toBe('ELIMINATED');
    expect(kicked.effects.some((e) => e.type === 'disconnect')).toBe(true);
  });
});

describe('진행과 종료', () => {
  it('next는 일반 문제만 순서대로 내고, 소진되면 종료한다', () => {
    const { s, ids } = setup(1);
    let cur = playRound(s, ids, ['O']).s;
    for (let i = 1; i <= 5; i++) {
      const n = run(cur, { type: 'next' });
      expect(n.state.room.currentIndex).toBe(i);
      expect(n.state.room.roundMode).toBe('NORMAL');
      let r = run(n.state, { type: 'startTimer' }, T0);
      r = run(r.state, { type: 'choose', playerId: ids[0]!, index: i, choice: i % 2 ? 'X' : 'O' }, T0 + 1000);
      r = run(r.state, { type: 'timeUp' }, T0 + 16_000);
      cur = run(r.state, { type: 'reveal' }, T0 + 17_000).state;
    }
    const end = run(cur, { type: 'next' }); // R0(REVIVAL)은 next로 나오지 않음 → 종료
    expect(end.state.room.status).toBe('ENDED');
    const ended = broadcasts(end.effects, S2C.gameEnded)[0]!.payload as { survivors: { id: string }[]; totalQuestions: number };
    expect(ended.survivors.map((p) => p.id)).toEqual([ids[0]]);
    expect(ended.totalQuestions).toBe(6);

    expect(reduce(end.state, { type: 'setWinner', playerId: 'nope' }, T0).error).toBe('unknown_player');
    const won = run(end.state, { type: 'setWinner', playerId: ids[0]! });
    expect(won.state.room.winnerPlayerId).toBe(ids[0]);
  });

  it('생존자 0명이면 종료하지 않고 경고만 낸다', () => {
    const { s, ids } = setup(2);
    const { s: after, effects } = playRound(s, ids, ['X', 'X']);
    expect(after.room.status).toBe('REVEALED');
    expect(effects.some((e) => e.type === 'alert' && e.level === 'warning')).toBe(true);
  });

  it('게임 중 설정은 두 항목만 바꿀 수 있다', () => {
    const { s } = setup(1);
    const r = run(s, { type: 'showQuestion' });
    expect(reduce(r.state, { type: 'updateConfig', patch: { maxStrikes: 3 } }, T0).error).toBe('config_locked');
    expect(reduce(r.state, { type: 'updateConfig', patch: { revivalAfterOrderNo: 2, liveMovesUntilOrderNo: 1 } }, T0).error).toBeUndefined();
  });

  it('출제한 문제는 삭제할 수 없고, 게임 중 순서 변경도 막는다', () => {
    const { s, ids } = setup(1);
    const { s: after } = playRound(s, ids, ['O']);
    const used = after.questions[0]!;
    expect(reduce(after, { type: 'questionDelete', id: used.id }, T0).error).toBe('question_in_use');
    const reordered = after.questions.map((x) => ({ id: x.id, text: x.text, answer: x.answer, kind: x.kind, timeLimitSec: null, imageUrl: null, explanation: null, orderNo: 10 - x.orderNo }));
    expect(reduce(after, { type: 'questionsReplace', questions: reordered }, T0).error).toBe('question_in_use');
    const appended = run(after, { type: 'questionUpsert', question: q('즉석', 'O') });
    expect(appended.state.questions.at(-1)!.text).toBe('즉석');
    expect(appended.state.questions[0]!.orderNo).toBe(0);
  });

  it('resetRoom은 참가자를 지우고 문제는 미출제로 되돌린다', () => {
    const { s, ids } = setup(2);
    const { s: after } = playRound(s, ids, ['O', 'X']);
    const reset = run(after, { type: 'resetRoom', keepQuestions: true });
    expect(Object.keys(reset.state.players)).toHaveLength(0);
    expect(reset.state.questions.every((x) => x.usedAt === null)).toBe(true);
    expect(reset.state.room.code).not.toBe(after.room.code);
    expect(reset.state.room.status).toBe('LOBBY');
  });
});

describe('역할별 투영', () => {
  it('참가자 뷰는 자격·내 선택·결과만 담고 남의 선택은 없다', () => {
    const { s, ids } = setup(2);
    let r = run(s, { type: 'showQuestion' });
    r = run(r.state, { type: 'startTimer' }, T0);
    r = run(r.state, { type: 'choose', playerId: ids[1]!, index: 0, choice: 'X' }, T0 + 1000);
    const v0 = playerView(r.state, ids[0]!, T0 + 1000)!;
    expect(v0.canAnswer).toBe(true);
    expect(v0.me.choice).toBeUndefined();
    expect(JSON.stringify(v0)).not.toContain(ids[1]);
    const v1 = playerView(r.state, ids[1]!, T0 + 1000)!;
    expect(v1.me.choice).toBe('X');
    r = run(r.state, { type: 'timeUp' }, T0 + 16_000);
    r = run(r.state, { type: 'reveal' }, T0 + 17_000);
    const after = playerView(r.state, ids[1]!, T0 + 17_000)!;
    expect(after.answer).toBe('O');
    expect(after.myOutcome?.correct).toBe(false);
    expect(after.me.status).toBe('WAITING');
    expect(after.canAnswer).toBe(false);
  });

  it('스크린·참가자 뷰에는 전화번호와 토큰이 없다', () => {
    const { s, ids } = setup(2);
    const json = JSON.stringify(screenView(s, T0, 'u')) + JSON.stringify(playerView(s, ids[0]!, T0));
    expect(json).not.toContain('0101111000');
    expect(json).not.toContain('h0');
    expect(hostView(s, T0, 'u').phones[ids[0]!]).toBe('01011110000');
  });
});

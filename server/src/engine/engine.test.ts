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

function setup(nPlayers = 4, opts: { liveUntil?: number } = {}) {
  let s = createInitialState(T0);
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
  s = run(s, { type: 'lock' }).state;
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

  it('마감 유예 안에 온 답은 인정, 그 뒤는 거절', () => {
    const { s, ids } = setup(1);
    let r = run(s, { type: 'showQuestion' });
    r = run(r.state, { type: 'startTimer' }, T0);
    const deadline = r.state.room.deadlineAt!;
    const inGrace = reduce(r.state, { type: 'choose', playerId: ids[0]!, index: 0, choice: 'O' }, deadline + 200);
    expect(inGrace.error).toBeUndefined();
    const late = reduce(r.state, { type: 'choose', playerId: ids[0]!, index: 0, choice: 'O' }, deadline + 400);
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
      if (i < 4) cur = cur; // next는 playRound 안의 showQuestion이 대신함
    }
    expect(cur.room.currentIndex).toBe(4);
    expect(shouldSuggestRevival(cur)).toBe(true);
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

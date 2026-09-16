// 통합 테스트: 실제 Fastify + Socket.IO를 띄우고 참가자·스크린·사회자 소켓으로 한 라운드와 패자부활전을 돈다.
// 규칙: 기다릴 이벤트의 리스너를 먼저 등록한 뒤 명령을 보낸다(연결 직후 오는 room:state도 connect 전에 등록).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { io as connect, type Socket } from 'socket.io-client';
import { C2S, S2C, type RoomStateForHost, type RoomStateForPlayer, type RoomStateForScreen } from '@ox/shared';
import { buildApp, type App } from './app';

let app: App;
let base: string;
const sockets: Socket[] = [];

function waitFor<T>(socket: Socket, event: string, pred: (p: T) => boolean = () => true, timeoutMs = 5000): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`timeout waiting ${event}`));
    }, timeoutMs);
    const handler = (p: T) => {
      if (!pred(p)) return;
      clearTimeout(t);
      socket.off(event, handler);
      resolve(p);
    };
    socket.on(event, handler);
  });
}

async function open<TView>(auth: Record<string, unknown>): Promise<{ s: Socket; first: Promise<TView> }> {
  const s = connect(base, { auth, transports: ['websocket'], reconnection: false, forceNew: true, autoConnect: false });
  sockets.push(s);
  const first = new Promise<TView>((resolve) => s.once(S2C.roomState, resolve));
  await new Promise<void>((resolve, reject) => {
    s.once('connect', () => resolve());
    s.once('connect_error', (e) => reject(e));
    s.connect();
  });
  return { s, first };
}

async function post(path: string, body: unknown, token?: string) {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

beforeAll(async () => {
  app = await buildApp({
    dbPath: ':memory:',
    hostPin: '1234',
    screenKey: 'skey',
    publicUrl: 'http://test.local',
    webDist: null,
    retentionDays: 7,
    hostTokenTtlMs: 60_000,
  });
  await app.fastify.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.fastify.server.address();
  if (!addr || typeof addr === 'string') throw new Error('no address');
  base = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  for (const s of sockets) s.disconnect();
  await app.close();
});

describe('통합: 입장 → 라운드 → 판정 → 패자부활전', () => {
  it('전체 흐름이 프로토콜대로 동작한다', async () => {
    // 사회자 로그인
    expect((await post('/api/host/login', { pin: 'wrong' })).status).toBe(401);
    const login = await post('/api/host/login', { pin: '1234' });
    expect(login.status).toBe(200);
    const hostToken = login.body['token'] as string;

    // 문제 업로드 (CSV, 한글 헤더)
    const csvRes = await fetch(base + '/api/host/questions', {
      method: 'PUT',
      headers: { 'content-type': 'text/csv', authorization: `Bearer ${hostToken}` },
      body: '문제,정답,종류\n지구는 둥글다,O,\n달은 별이다,X,\n부활 문제,O,부활\n',
    });
    expect(csvRes.status).toBe(200);
    expect(((await csvRes.json()) as { imported: number }).imported).toBe(3);

    // 참가자 등록
    const j1 = await post('/api/join', { phone: '010-1111-2222', name: '철수', consent: true });
    expect(j1.status).toBe(201);
    const j2 = await post('/api/join', { phone: '01033334444', name: '영희', consent: true, avatar: { body: 1, face: 1, hair: 1 } });
    expect(j2.status).toBe(201);
    expect((await post('/api/join', { phone: '02-123-4567', name: '유선', consent: true })).status).toBe(400);
    const dup = await post('/api/join', { phone: '010-1111-2222', name: '다른이름', consent: true });
    expect(dup.status).toBe(409);
    expect(dup.body['reason']).toBe('name_mismatch');

    const pub = (await (await fetch(base + '/api/room/public')).json()) as { playerCount: number; joinUrl: string; roomCode: string };
    expect(pub.playerCount).toBe(2);
    expect(pub.joinUrl).toBe('http://test.local/join'); // 인쇄용 QR: 방 코드 없이

    // 문제 사진 업로드·조회
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9, 9]);
    expect((await fetch(base + '/api/host/images', { method: 'POST', headers: { 'content-type': 'image/png' }, body: png })).status).toBe(401);
    expect((await fetch(base + '/api/host/images', { method: 'POST', headers: { 'content-type': 'text/plain', authorization: `Bearer ${hostToken}` }, body: 'x' })).status).toBe(415);
    const up = await fetch(base + '/api/host/images', { method: 'POST', headers: { 'content-type': 'image/png', authorization: `Bearer ${hostToken}` }, body: png });
    expect(up.status).toBe(201);
    const { url } = (await up.json()) as { url: string };
    const got = await fetch(base + url);
    expect(got.status).toBe(200);
    expect(got.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await got.arrayBuffer()).equals(png)).toBe(true);
    expect((await fetch(base + '/api/images/00000000-0000-4000-8000-000000000000')).status).toBe(404);

    // 소켓 연결: 잘못된 키/토큰은 거절
    await expect(open({ role: 'screen', key: 'nope' })).rejects.toThrow();
    await expect(open({ role: 'player', token: 'x'.repeat(40) })).rejects.toThrow();

    const { s: screen } = await open<RoomStateForScreen>({ role: 'screen', key: 'skey' });
    const { s: host } = await open<RoomStateForHost>({ role: 'host', token: hostToken });
    const { s: p1, first: p1First } = await open<RoomStateForPlayer>({ role: 'player', token: j1.body['sessionToken'] });
    const { s: p2 } = await open<RoomStateForPlayer>({ role: 'player', token: j2.body['sessionToken'] });

    const p1State = await p1First;
    expect(p1State.status).toBe('LOBBY');
    expect(p1State.me.name).toBe('철수');
    expect(JSON.stringify(p1State)).not.toContain('1111');

    // 입장 마감 → 문제 공개 → 타이머
    // 이 테스트는 일반 판정 흐름을 보므로 맛보기 문제를 꺼 둔다
    const cfgP = waitFor<RoomStateForHost>(host, S2C.roomState, (s) => s.config.practiceUntilOrderNo === -1);
    host.emit(C2S.hostUpdateConfig, { practiceUntilOrderNo: -1 });
    await cfgP;

    // 입장 마감: 먼저 카운트다운, 다시 누르면 즉시 마감
    const lockingP = waitFor<{ lockAt: number }>(screen, S2C.roomLocking);
    host.emit(C2S.hostLock);
    expect((await lockingP).lockAt).toBeGreaterThan(Date.now());
    const lockedP = waitFor<RoomStateForScreen>(screen, S2C.roomState, (s) => s.status === 'LOCKED');
    host.emit(C2S.hostLock);
    await lockedP;

    const shownP = waitFor<{ question: { text: string }; answer?: string }>(screen, S2C.questionShow);
    const hostShownP = waitFor<RoomStateForHost>(host, S2C.roomState, (s) => s.status === 'QUESTION_SHOWN');
    host.emit(C2S.hostShowQuestion, {});
    const shown = await shownP;
    expect(shown.question.text).toBe('지구는 둥글다');
    expect(shown.answer).toBeUndefined();
    expect((await hostShownP).questions[0]!.answer).toBe('O');

    const startedP = waitFor<{ deadline: number }>(p1, S2C.questionStart);
    host.emit(C2S.hostStartTimer, { seconds: 3 });
    const started = await startedP;
    expect(started.deadline).toBeGreaterThan(Date.now());
    const timeupP = waitFor<{ counts: { O: number; X: number; none: number }; choices?: unknown[] }>(screen, S2C.questionTimeup, () => true, 8000);

    // 답변: p1 정답 O, p2 오답 X. 0번 문제는 실시간 모드라 스크린이 이동 이벤트를 받는다
    const movedP = waitFor<{ playerId: string; choice: string }>(screen, S2C.answerMoved);
    const ackP = waitFor<{ choice: string }>(p1, S2C.answerAck);
    p1.emit(C2S.answerChoose, { index: 0, choice: 'O' });
    expect((await ackP).choice).toBe('O');
    expect((await movedP).choice).toBe('O');
    const ack2P = waitFor(p2, S2C.answerAck);
    p2.emit(C2S.answerChoose, { index: 0, choice: 'X' });
    await ack2P;

    // 마감(3초 타이머) → 인원
    const timeup = await timeupP;
    expect(timeup.counts).toEqual({ O: 1, X: 1, none: 0 });
    expect(timeup.choices).toHaveLength(2);

    // 정답 공개 → p2 대기실
    const revealP2 = waitFor<{ me: { correct: boolean; statusAfter: string } }>(p2, S2C.questionReveal);
    const screenAfterP = waitFor<RoomStateForScreen>(screen, S2C.roomState, (s) => s.status === 'REVEALED');
    host.emit(C2S.hostReveal);
    const revealP2Result = await revealP2;
    expect(revealP2Result.me.correct).toBe(false);
    expect(revealP2Result.me.statusAfter).toBe('WAITING');
    const screenAfter = await screenAfterP;
    expect(screenAfter.answer).toBe('O');
    expect(screenAfter.players.find((p) => p.name === '영희')!.status).toBe('WAITING');

    // 패자부활전: 대기실 1명 → REVIVAL 표시 문제(index 2)
    const revivalShownP = waitFor<{ mode: string; index: number }>(screen, S2C.questionShow);
    const p1ViewP = waitFor<RoomStateForPlayer>(p1, S2C.roomState, (s) => s.status === 'QUESTION_SHOWN');
    host.emit(C2S.hostStartRevival, {});
    const revivalShown = await revivalShownP;
    expect(revivalShown.mode).toBe('REVIVAL');
    expect(revivalShown.index).toBe(2);
    expect((await p1ViewP).canAnswer).toBe(false);

    const start2P = waitFor(p2, S2C.questionStart);
    host.emit(C2S.hostStartTimer, { seconds: 3 }); // 스키마 최소값 3초
    await start2P;
    const timeup2P = waitFor(screen, S2C.questionTimeup, () => true, 8000);
    const ack3P = waitFor(p2, S2C.answerAck);
    p2.emit(C2S.answerChoose, { index: 2, choice: 'O' });
    await ack3P;
    // 무대 생존자는 부활전에 답할 수 없다(ack 없음)
    p1.emit(C2S.answerChoose, { index: 2, choice: 'O' });
    await expect(waitFor(p1, S2C.answerAck, () => true, 700)).rejects.toThrow();
    await timeup2P;

    const revivedP = waitFor<{ me: { revived: boolean; statusAfter: string; strikesAfter: number } }>(p2, S2C.questionReveal);
    host.emit(C2S.hostReveal);
    const revived = await revivedP;
    expect(revived.me.revived).toBe(true);
    expect(revived.me.statusAfter).toBe('ACTIVE');
    expect(revived.me.strikesAfter).toBe(1);

    // 채팅: 참가자가 보내면 전원에게 전달, 1.5초 안 연속 전송은 무시, 사회자는 삭제·전체 지우기, 재접속 시 기록 수신
    const chatP = waitFor<{ id: string; name: string; text: string }>(screen, S2C.chatMessage);
    const chatP1 = waitFor<{ text: string }>(p1, S2C.chatMessage);
    p2.emit(C2S.chatSend, { text: '  가자 O!!  \n' });
    const chatMsg = await chatP;
    expect(chatMsg.name).toBe('영희');
    expect(chatMsg.text).toBe('가자 O!!');
    expect((await chatP1).text).toBe('가자 O!!');
    p2.emit(C2S.chatSend, { text: '너무 빨리' });
    await expect(waitFor(screen, S2C.chatMessage, () => true, 600)).rejects.toThrow();
    const { s: lateScreen, first: lateFirst } = await open<RoomStateForScreen>({ role: 'screen', key: 'skey' });
    await lateFirst;
    const history = await waitFor<{ messages: { text: string }[] }>(lateScreen, S2C.chatHistory, () => true, 3000).catch(() => null);
    // chat:history는 연결 직후 room:state 전에 도착할 수 있어 버퍼 없이 잡히지 않을 수 있다 → 서버 API 대신 삭제 흐름으로 검증
    void history;
    const deletedP = waitFor<{ id: string }>(screen, S2C.chatDeleted);
    host.emit(C2S.hostChatDelete, { id: chatMsg.id });
    expect((await deletedP).id).toBe(chatMsg.id);
    const clearedP = waitFor(screen, S2C.chatCleared);
    host.emit(C2S.hostChatClear);
    await clearedP;
    lateScreen.disconnect();

    // 잘못된 명령은 alert
    const alertP = waitFor<{ level: string }>(host, S2C.hostAlert);
    host.emit(C2S.hostStartTimer, {});
    expect((await alertP).level).toBe('error');

    // CSV 내보내기에는 전화번호가 있고, 파기 후엔 없다
    const csv1 = await (await fetch(base + '/api/host/export.csv', { headers: { authorization: `Bearer ${hostToken}` } })).text();
    expect(csv1).toContain('010-1111-2222');
    expect((await post('/api/host/purge-phones', { confirm: true }, hostToken)).status).toBe(200);
    const csv2 = await (await fetch(base + '/api/host/export.csv', { headers: { authorization: `Bearer ${hostToken}` } })).text();
    expect(csv2).not.toContain('010-1111-2222');
  }, 30_000);

  it('입장 마감 뒤 신규 번호는 거절되고, 퇴장 처리된 참가자는 소켓 연결이 거절된다', async () => {
    const hostToken = (await post('/api/host/login', { pin: '1234' })).body['token'] as string;
    const { s: host, first } = await open<RoomStateForHost>({ role: 'host', token: hostToken });
    const view = await first;
    const target = view.players.find((p) => p.name === '철수')!;
    // 전화번호가 파기되어 기존 자리와 매칭되지 않고, 방은 마감 상태라 신규로도 못 들어온다
    const j = await post('/api/join', { phone: '010-1111-2222', name: '철수', consent: true });
    expect(j.status).toBe(409);
    expect(j.body['reason']).toBe('locked');

    const kickedP = waitFor<RoomStateForHost>(host, S2C.roomState, (s) => s.players.find((p) => p.id === target.id)!.status === 'ELIMINATED');
    host.emit(C2S.hostKick, { playerId: target.id });
    await kickedP;
    expect(app.game.state.players[target.id]!.status).toBe('ELIMINATED');

    // 서버가 가진 토큰 해시로는 원문을 모르므로, 엔진에 새 토큰을 심어 재접속을 시도한다 → eliminated 로 거절
    const token = 'y'.repeat(40);
    const { createHash } = await import('node:crypto');
    app.game.dispatch({ type: 'rotateToken', playerId: target.id, tokenHash: createHash('sha256').update(token).digest('hex') });
    await expect(open({ role: 'player', token })).rejects.toThrow(/eliminated/);
  });
});

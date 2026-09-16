// 가상 참가자 시뮬레이터 / 부하 테스트.
//   npm run simulate -- --players 100 --questions 5 --url http://localhost:3000 --pin 1234 [--storm]
// 방을 초기화하고(문제 유지) N명을 등록·접속시킨 뒤, 사회자 명령으로 문제를 진행하며 답변 지연을 측정한다.
import { io, type Socket } from 'socket.io-client';

interface Args {
  players: number;
  questions: number;
  url: string;
  pin: string;
  seconds: number;
  storm: boolean;
}

function parseArgs(): Args {
  const a = process.argv.slice(2);
  const get = (k: string, d: string) => {
    const i = a.indexOf(`--${k}`);
    return i >= 0 ? (a[i + 1] ?? d) : d;
  };
  return {
    players: Number(get('players', '100')),
    questions: Number(get('questions', '5')),
    url: get('url', 'http://localhost:3000'),
    pin: get('pin', '1234'),
    seconds: Number(get('seconds', '6')),
    storm: a.includes('--storm'),
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pct = (xs: number[], p: number) => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
};

function waitEvent<T>(s: Socket, event: string, pred: (p: T) => boolean = () => true, timeoutMs = 20_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      s.off(event, h);
      reject(new Error(`timeout ${event}`));
    }, timeoutMs);
    const h = (p: T) => {
      if (!pred(p)) return;
      clearTimeout(t);
      s.off(event, h);
      resolve(p);
    };
    s.on(event, h);
  });
}

async function main() {
  const args = parseArgs();
  const t0 = Date.now();
  const log = (m: string) => console.log(`[+${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);

  // 사회자
  const login = await fetch(`${args.url}/api/host/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pin: args.pin }) });
  if (!login.ok) throw new Error(`사회자 로그인 실패 ${login.status}`);
  const { token } = (await login.json()) as { token: string };
  const host = io(args.url, { auth: { role: 'host', token }, transports: ['websocket'] });
  await new Promise<void>((r, j) => {
    host.once('connect', () => r());
    host.once('connect_error', j);
  });
  const hostState = (v: unknown) => (v as { status: string }).status;
  let view = await waitEvent<{ status: string; questions: { id: string; kind: string; usedAt: number | null }[] }>(host, 'room:state');
  log(`현재 방 상태 ${view.status}, 문제 ${view.questions.length}개 → 초기화(문제 유지)`);
  host.emit('host:resetRoom', { confirm: true, keepQuestions: true });
  view = await waitEvent(host, 'room:state', (v) => hostState(v) === 'LOBBY');
  if (view.questions.length < args.questions) {
    const qs = Array.from({ length: args.questions }, (_, i) => ({ text: `부하 테스트 문제 ${i + 1}`, answer: i % 2 ? 'X' : 'O', kind: 'NORMAL' }));
    const r = await fetch(`${args.url}/api/host/questions`, { method: 'PUT', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ questions: qs }) });
    if (!r.ok) throw new Error('문제 업로드 실패');
    log(`문제 ${args.questions}개 업로드`);
  }

  // 스크린 (answer:moved 수신 지연 측정)
  const screenKey = process.env['SCREEN_KEY'] ?? 'screen';
  const screen = io(args.url, { auth: { role: 'screen', key: screenKey }, transports: ['websocket'] });
  await new Promise<void>((r, j) => {
    screen.once('connect', () => r());
    screen.once('connect_error', j);
  });
  const sentAt = new Map<string, number>();
  const screenLatency: number[] = [];
  screen.on('answer:moved', (p: { playerId: string }) => {
    const t = sentAt.get(p.playerId);
    if (t) screenLatency.push(Date.now() - t);
  });

  // 참가자 등록·접속
  const joinStart = Date.now();
  const players: { id: string; socket: Socket; token: string }[] = [];
  const joinErrors: string[] = [];
  const batchSize = 20;
  for (let i = 0; i < args.players; i += batchSize) {
    const batch = Array.from({ length: Math.min(batchSize, args.players - i) }, (_, k) => i + k);
    await Promise.all(
      batch.map(async (n) => {
        const phone = `0109${String(n).padStart(7, '0')}`;
        const res = await fetch(`${args.url}/api/join`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phone, name: `가상${n + 1}`, consent: true }) });
        if (!res.ok) {
          joinErrors.push(`${n}: ${res.status}`);
          return;
        }
        const j = (await res.json()) as { playerId: string; sessionToken: string };
        const socket = io(args.url, { auth: { role: 'player', token: j.sessionToken }, transports: ['websocket'], reconnectionDelay: 300 });
        await new Promise<void>((r, rej) => {
          socket.once('connect', () => r());
          socket.once('connect_error', rej);
        });
        players.push({ id: j.playerId, socket, token: j.sessionToken });
      }),
    );
  }
  log(`참가자 ${players.length}명 접속 완료 (${Date.now() - joinStart}ms, 실패 ${joinErrors.length})`);

  // 사회자 뷰의 참가자 상태를 계속 추적해 자격자만 답하게 한다
  const statusOf = new Map<string, string>();
  host.on('room:state', (v: { players?: { id: string; status: string }[] }) => {
    for (const p of v.players ?? []) statusOf.set(p.id, p.status);
  });

  host.emit('host:lock');
  await waitEvent(host, 'room:state', (v) => hostState(v) === 'LOCKED');

  const ackLatency: number[] = [];
  const stateFanout: number[] = [];
  let missingAcks = 0;

  for (let q = 0; q < args.questions; q++) {
    const shown = waitEvent<{ index: number; liveMoves: boolean; mode: string; question: { text: string } }>(host, 'question:show');
    host.emit(q === 0 ? 'host:showQuestion' : 'host:next', {});
    const shownP = await shown;
    const started = waitEvent<{ deadline: number }>(host, 'question:start');
    host.emit('host:startTimer', { seconds: args.seconds });
    await started;
    // 마감 이벤트 대기는 답변 전에 등록한다(답변 단계가 길어져도 놓치지 않게)
    const timeupP = waitEvent<{ counts: { O: number; X: number; none: number } }>(host, 'question:timeup', () => true, (args.seconds + 10) * 1000);
    const eligibleStatus = shownP.mode === 'REVIVAL' ? 'WAITING' : 'ACTIVE';
    const eligible = players.filter((p) => (statusOf.get(p.id) ?? 'ACTIVE') === eligibleStatus);
    log(`Q${shownP.index + 1} 시작 (이동 ${shownP.liveMoves ? '실시간' : '숨김'}, 자격자 ${eligible.length}명)`);

    // 자격자는 창 안에서 임의 시각에 답하고, 30%는 한 번 바꾼다
    const answerWindow = (args.seconds - 1.5) * 1000;
    const answerOnce = async (p: { id: string; socket: Socket }, choice: 'O' | 'X') => {
      const t = Date.now();
      sentAt.set(p.id, t);
      const ackP = waitEvent<{ acceptedAt: number }>(p.socket, 'answer:ack', () => true, 3000).then(
        () => ackLatency.push(Date.now() - t),
        () => {
          missingAcks += 1;
        },
      );
      p.socket.emit('answer:choose', { index: shownP.index, choice });
      await ackP;
    };
    await Promise.all(
      eligible.map(async (p) => {
        await sleep(Math.random() * answerWindow);
        const first: 'O' | 'X' = Math.random() < 0.5 ? 'O' : 'X';
        await answerOnce(p, first);
        if (Math.random() < 0.3) {
          await sleep(400 + Math.random() * 500);
          await answerOnce(p, first === 'O' ? 'X' : 'O');
        }
      }),
    );
    const timeup = await timeupP;
    log(`Q${shownP.index + 1} 마감 O ${timeup.counts.O} / X ${timeup.counts.X} / 미응답 ${timeup.counts.none}`);

    const revealSent = Date.now();
    const allPlayersReveal = Promise.all(players.map((p) => waitEvent(p.socket, 'question:reveal', () => true, 10_000).catch(() => null)));
    host.emit('host:reveal');
    await waitEvent(host, 'room:state', (v) => hostState(v) === 'REVEALED');
    await allPlayersReveal;
    stateFanout.push(Date.now() - revealSent);

    if (args.storm && q === 0) {
      log('재접속 폭주: 전원 끊고 다시 연결');
      const t = Date.now();
      await Promise.all(
        players.map(async (p) => {
          p.socket.disconnect();
          await sleep(Math.random() * 500);
          p.socket.connect();
          await new Promise<void>((r) => p.socket.once('connect', () => r()));
        }),
      );
      log(`재접속 완료 ${Date.now() - t}ms`);
    }
  }

  host.emit('host:end');
  await waitEvent(host, 'room:state', (v) => hostState(v) === 'ENDED');
  log('게임 종료');

  console.log('\n=== 결과 ===');
  console.log(`참가자 ${players.length}명, 문제 ${args.questions}개, 답변 ${ackLatency.length}건, ack 누락 ${missingAcks}건, 입장 실패 ${joinErrors.length}건`);
  console.log(`답변 → ack(참가자 왕복)  p50 ${pct(ackLatency, 50)}ms  p95 ${pct(ackLatency, 95)}ms  max ${pct(ackLatency, 100)}ms`);
  console.log(`답변 → 스크린 이동 수신   p50 ${pct(screenLatency, 50)}ms  p95 ${pct(screenLatency, 95)}ms  max ${pct(screenLatency, 100)}ms  (${screenLatency.length}건, 실시간 모드 문제만)`);
  console.log(`정답 공개 → 전원 수신     p50 ${pct(stateFanout, 50)}ms  max ${pct(stateFanout, 100)}ms`);

  for (const p of players) p.socket.disconnect();
  screen.disconnect();
  host.disconnect();
  const ok = missingAcks === 0 && joinErrors.length === 0 && pct(ackLatency, 95) < 500;
  console.log(ok ? '\n판정: 통과 (ack 누락 0, p95 < 500ms)' : '\n판정: 실패');
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

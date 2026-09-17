// 사회자 조작 없이 한 판을 끝까지 자동 진행한다(리허설·데모용).
//   npm run autoplay -- --url http://localhost:3000 --pin 1234 [--seconds 15] [--lock-now]
// 봇(npm run bots)이 함께 떠 있어야 참가자가 있다. 실제 행사에서는 쓰지 않는다.
import { io, type Socket } from 'socket.io-client';

interface Args {
  url: string;
  pin: string;
  seconds: number | null;
  lockNow: boolean;
}

function parseArgs(): Args {
  const a = process.argv.slice(2);
  const get = (k: string, d: string) => {
    const i = a.indexOf(`--${k}`);
    return i >= 0 ? (a[i + 1] ?? d) : d;
  };
  const sec = get('seconds', '');
  return {
    url: get('url', 'http://localhost:3000'),
    pin: get('pin', '1234'),
    seconds: sec ? Number(sec) : null,
    lockNow: a.includes('--lock-now'),
  };
}

interface HostView {
  status: string;
  mode: string | null;
  currentIndex: number;
  lockAt: number | null;
  pendingRevival: boolean;
  finaleAt: number | null;
  finalists: { id: string; name: string; phoneTail: string | null }[] | null;
  players: { id: string; name: string; status: string; strikes: number }[];
  questions: { orderNo: number; kind: string; usedAt: number | null; text: string }[];
  question: { index: number; text: string; practice: boolean } | null;
  config: { lockCountdownSec: number };
}

const t0 = Date.now();
const log = (m: string) => console.log(`[+${((Date.now() - t0) / 1000).toFixed(0).padStart(3)}s] ${m}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function counts(v: HostView) {
  const c = { ACTIVE: 0, WAITING: 0, ELIMINATED: 0 } as Record<string, number>;
  for (const p of v.players) c[p.status] = (c[p.status] ?? 0) + 1;
  return c;
}

async function main() {
  const args = parseArgs();
  const login = await fetch(`${args.url}/api/host/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pin: args.pin }),
  });
  if (!login.ok) throw new Error(`사회자 로그인 실패(${login.status})`);
  const { token } = (await login.json()) as { token: string };

  const s: Socket = io(args.url, { auth: { role: 'host', token }, transports: ['websocket'] });
  let view!: HostView;
  s.on('room:state', (v: HostView) => {
    view = v;
  });
  s.on('host:alert', (a: { level: string; message: string }) => log(`  콘솔 알림(${a.level}): ${a.message}`));
  await new Promise<void>((r, j) => {
    s.once('connect', () => r());
    s.once('connect_error', j);
  });
  await new Promise((r) => s.once('room:state', r));

  const until = (pred: (v: HostView) => boolean, ms = 90_000) =>
    new Promise<void>((res, rej) => {
      if (pred(view)) return res();
      const t = setTimeout(() => rej(new Error(`시간 초과 (상태 ${view.status})`)), ms);
      const h = (v: HostView) => {
        if (pred(v)) {
          clearTimeout(t);
          s.off('room:state', h);
          res();
        }
      };
      s.on('room:state', h);
    });

  if (view.status !== 'LOBBY') {
    log('진행 중인 게임을 초기화합니다(문제 유지)');
    s.emit('host:resetRoom', { confirm: true, keepQuestions: true });
    await until((v) => v.status === 'LOBBY' && v.players.length === 0);
    log('봇이 다시 입장할 때까지 대기…');
    await until((v) => v.players.length > 0, 40_000).catch(() => log('  (봇이 없습니다 — npm run bots 를 먼저 실행하세요)'));
    await sleep(3000);
  }
  if (view.players.length === 0) throw new Error('참가자가 없습니다. npm run bots 를 먼저 실행하세요.');

  // 1) 입장 마감
  log(`입장 ${view.players.length}명 · 마감 카운트다운 시작`);
  s.emit('host:lock');
  if (args.lockNow) {
    await sleep(1200);
    s.emit('host:lock');
    log('  카운트다운 건너뛰고 즉시 마감');
  } else {
    log(`  ${view.config.lockCountdownSec}초 뒤 자동 마감`);
  }
  await until((v) => v.status === 'LOCKED', 40_000);
  log(`입장 마감 · 참가자 ${view.players.length}명`);

  // 2) 라운드 반복
  // view는 소켓 이벤트로 계속 바뀌므로 타입 좁히기를 피해 매번 읽는다
  const status = (): string => view.status;
  for (let round = 1; round <= 30; round++) {
    if (status() === 'ENDED') break;
    if (view.players.length === 0) {
      log('참가자가 모두 사라져 게임을 종료합니다(봇이 --until 설정대로 퇴장했을 수 있음)');
      s.emit('host:end');
      await until((v) => v.status === 'ENDED', 20_000).catch(() => undefined);
      break;
    }

    if (status() === 'LOCKED' || status() === 'REVEALED') {
      if (view.pendingRevival) {
        log(`패자부활전 시작 (대기실 ${counts(view).WAITING}명)`);
        s.emit('host:startRevival', {});
      } else if (view.finaleAt) {
        log('결승 진출 확정 · 발표 대기');
        await until((v) => v.status === 'ENDED', 20_000);
        break;
      } else if (status() === 'LOCKED') {
        s.emit('host:showQuestion', {});
      } else {
        s.emit('host:next');
      }
      await until((v) => v.status === 'QUESTION_SHOWN' || v.status === 'ENDED', 20_000);
      if (status() === 'ENDED') break;
    }

    const q = view.question!;
    const mode = view.mode === 'REVIVAL' ? '패자부활전' : q.practice ? '맛보기' : '일반';
    log(`Q${q.index + 1} (${mode}) "${q.text}"`);
    if (args.seconds) s.emit('host:startTimer', { seconds: args.seconds });
    await until((v) => v.status === 'ANSWERING', 20_000);
    await until((v) => v.status === 'TIME_UP', 180_000);
    s.emit('host:reveal');
    await until((v) => v.status === 'REVEALED', 20_000);
    const c = counts(view);
    log(`  공개 → 생존 ${c.ACTIVE} · 대기실 ${c.WAITING} · 탈락 ${c.ELIMINATED}`);

    if (view.finaleAt) {
      log('  생존자가 결승 인원 이하 · 곧 결승 진출자 발표');
      await until((v) => v.status === 'ENDED', 20_000);
      break;
    }
    if (!view.pendingRevival && !view.questions.some((x) => x.usedAt === null && x.kind === 'NORMAL')) {
      log('  남은 일반 문제가 없어 종료합니다');
      s.emit('host:end');
      await until((v) => v.status === 'ENDED', 20_000);
      break;
    }
  }

  // 3) 결과
  await sleep(1500);
  const finalists = view.finalists ?? [];
  if (finalists.length > 0) {
    log(`결승 진출자 ${finalists.length}명: ${finalists.map((f) => `${f.name}(뒷번호 ${f.phoneTail ?? '-'})`).join(', ')}`);
    // 실제 행사에서는 무대에서 결승을 치른 뒤 사회자가 지정한다. 여기서는 데모로 임의 지정
    const winner = finalists[Math.floor(Math.random() * finalists.length)]!;
    s.emit('host:setWinner', { playerId: winner.id });
    await sleep(1200);
    log(`우승자 지정(데모): ${winner.name} 👑`);
  } else {
    const survivors = view.players.filter((p) => p.status === 'ACTIVE');
    log(`최종 생존자 ${survivors.length}명: ${survivors.map((p) => p.name).join(', ') || '없음'}`);
  }
  const c = counts(view);
  log(`한 판 종료 · 생존 ${c.ACTIVE} · 대기실 ${c.WAITING} · 탈락 ${c.ELIMINATED}`);
  s.disconnect();
  process.exit(0);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});

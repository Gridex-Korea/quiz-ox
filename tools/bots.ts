// 리허설용 가상 참가자 봇. 사회자가 혼자 콘솔을 눌러 보며 연습할 수 있게, 실제 사람처럼 입장하고 답한다.
//   npm run bots -- --count 6 --url http://localhost:3000 --pin 1234 --skill 0.7 --minutes 90
// 봇은 사회자 명령을 내리지 않는다. 정답을 알기 위해서만 사회자 토큰으로 문제 목록을 읽는다(정답률 = skill).
import { io, type Socket } from 'socket.io-client';

interface Args {
  count: number;
  url: string;
  pin: string;
  skill: number;
  minutes: number;
}

function parseArgs(): Args {
  const a = process.argv.slice(2);
  const get = (k: string, d: string) => {
    const i = a.indexOf(`--${k}`);
    return i >= 0 ? (a[i + 1] ?? d) : d;
  };
  return {
    count: Number(get('count', '6')),
    url: get('url', 'http://localhost:3000'),
    pin: get('pin', '1234'),
    skill: Number(get('skill', '0.7')),
    minutes: Number(get('minutes', '90')),
  };
}

const NAMES = ['민준', '서연', '도윤', '하은', '지호', '수아', '예준', '지우', '시우', '하윤', '유준', '서윤', '주원', '민서', '건우', '지민', '현우', '아린', '우진', '채원'];
const t0 = Date.now();
const log = (m: string) => console.log(`[+${((Date.now() - t0) / 1000).toFixed(0).padStart(3)}s] ${m}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rand = (a: number, b: number) => a + Math.random() * (b - a);

interface PlayerView {
  status: string;
  canAnswer: boolean;
  question: { index: number } | null;
  deadline: number | null;
  me: { status: string; strikes: number };
  answer: string | null;
  myOutcome: { correct: boolean; statusAfter: string; revived: boolean } | null;
}

class Bot {
  socket: Socket | null = null;
  playerId = '';
  answered = new Set<number>();
  eliminated = false;
  skill: number;

  constructor(
    public name: string,
    public phone: string,
    baseSkill: number,
    private answers: () => Map<number, 'O' | 'X'>,
    private base: string,
  ) {
    this.skill = Math.min(0.95, Math.max(0.35, baseSkill + rand(-0.2, 0.2)));
  }

  async join(): Promise<boolean> {
    const res = await fetch(`${this.base}/api/join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ phone: this.phone, name: this.name, consent: true }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { message?: string };
      log(`${this.name} 입장 실패: ${body.message ?? res.status}`);
      return false;
    }
    const j = (await res.json()) as { playerId: string; sessionToken: string; rejoined: boolean };
    this.playerId = j.playerId;
    this.answered.clear();
    this.eliminated = false;
    this.connect(j.sessionToken);
    log(`${this.name} ${j.rejoined ? '자리 복귀' : '입장'} (실력 ${Math.round(this.skill * 100)}%)`);
    return true;
  }

  private connect(token: string) {
    this.socket?.disconnect();
    const s = io(this.base, { auth: { role: 'player', token }, transports: ['websocket'], reconnectionDelay: 500 });
    this.socket = s;
    s.on('room:state', (v: PlayerView) => this.onState(v));
    s.on('question:reveal', (p: { answer: string; me: PlayerView['myOutcome'] }) => {
      if (!p.me) return;
      if (p.me.correct) log(`  ${this.name}: 정답! ${p.me.revived ? '무대로 복귀 🎉' : '생존'}`);
      else log(`  ${this.name}: 오답… ${p.me.statusAfter === 'ELIMINATED' ? '탈락 😢' : '대기실로'}`);
    });
    s.on('player:eliminated', () => {
      this.eliminated = true;
    });
    s.on('room:reset', () => {
      log(`${this.name}: 방이 초기화됨 → 다시 입장`);
      setTimeout(() => void this.join(), rand(800, 3000));
    });
    s.on('connect_error', (e: Error) => {
      if (e.message === 'eliminated') {
        this.eliminated = true;
        s.disconnect();
      }
    });
  }

  private onState(v: PlayerView) {
    if (v.status !== 'ANSWERING' || !v.canAnswer || !v.question || !v.deadline) return;
    const idx = v.question.index;
    if (this.answered.has(idx)) return;
    this.answered.add(idx);
    const remaining = v.deadline - Date.now();
    const thinkMs = Math.max(600, Math.min(rand(1200, 7000), remaining - 900));
    setTimeout(() => this.answer(idx, remaining - thinkMs), thinkMs);
  }

  private answer(idx: number, leftMs: number) {
    const correct = this.answers().get(idx);
    if (!correct || !this.socket) return;
    const wrong: 'O' | 'X' = correct === 'O' ? 'X' : 'O';
    let choice: 'O' | 'X' = Math.random() < this.skill ? correct : wrong;
    this.socket.emit('answer:choose', { index: idx, choice });
    log(`  ${this.name} → ${choice}`);
    // 25%는 한 번 고민하다 바꾼다(그중 절반은 다시 되돌린다)
    if (Math.random() < 0.25 && leftMs > 2500) {
      setTimeout(() => {
        choice = choice === 'O' ? 'X' : 'O';
        this.socket?.emit('answer:choose', { index: idx, choice });
        log(`  ${this.name} → ${choice} (바꿈)`);
        if (Math.random() < 0.5 && leftMs > 4500) {
          setTimeout(() => {
            choice = choice === 'O' ? 'X' : 'O';
            this.socket?.emit('answer:choose', { index: idx, choice });
            log(`  ${this.name} → ${choice} (다시 바꿈)`);
          }, rand(900, 1600));
        }
      }, rand(900, 1800));
    }
  }
}

async function main() {
  const args = parseArgs();
  const login = await fetch(`${args.url}/api/host/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pin: args.pin }) });
  if (!login.ok) throw new Error(`사회자 로그인 실패(${login.status}) — 정답을 읽기 위해 PIN이 필요합니다`);
  const { token } = (await login.json()) as { token: string };

  // 정답표: 사회자 뷰에서만 읽는다(봇은 명령을 보내지 않는다)
  const answers = new Map<number, 'O' | 'X'>();
  const host = io(args.url, { auth: { role: 'host', token }, transports: ['websocket'] });
  host.on('room:state', (v: { status: string; questions: { orderNo: number; answer: 'O' | 'X' }[]; players: { name: string; status: string }[]; winnerId: string | null }) => {
    answers.clear();
    for (const q of v.questions) answers.set(q.orderNo, q.answer);
    if (v.status !== lastStatus) {
      lastStatus = v.status;
      const alive = v.players.filter((p) => p.status === 'ACTIVE').length;
      const waiting = v.players.filter((p) => p.status === 'WAITING').length;
      const out = v.players.filter((p) => p.status === 'ELIMINATED').length;
      log(`방 상태 ${v.status} · 생존 ${alive} · 대기실 ${waiting} · 탈락 ${out}`);
      if (v.status === 'ENDED') log('게임 종료. 사회자가 우승자를 지정하면 왕관이 뜹니다. 게임 초기화를 하면 봇들이 다시 입장합니다.');
    }
  });
  let lastStatus = '';
  await new Promise<void>((r, j) => {
    host.once('connect', () => r());
    host.once('connect_error', j);
  });

  const picked = [...NAMES].sort(() => Math.random() - 0.5).slice(0, Math.min(args.count, NAMES.length));
  const bots = picked.map((name, i) => new Bot(name, `0108${String(1000000 + i).padStart(7, '0')}`, args.skill, () => answers, args.url));
  for (const b of bots) {
    await b.join();
    await sleep(rand(700, 2200)); // 한 명씩 들어오는 느낌
  }
  log(`봇 ${bots.length}명 준비 완료. 콘솔에서 입장 마감 → 문제 공개 → 타이머 시작을 눌러 주세요.`);

  setTimeout(() => {
    log(`${args.minutes}분이 지나 봇을 종료합니다.`);
    for (const b of bots) b.socket?.disconnect();
    host.disconnect();
    process.exit(0);
  }, args.minutes * 60_000);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

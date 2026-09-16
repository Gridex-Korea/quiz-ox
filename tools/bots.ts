// 가상 참가자 봇(아바타). 리허설 연습용이자, 행사에서 초반 무대를 채우는 NPC용.
//   npm run bots -- --count 10 --until 5 --url http://localhost:3000 --pin 1234 --skill 0.7 --minutes 120
// - 실제 사람처럼 입장하고, 실력(정답률)대로 시간을 끌며 답하고, 가끔 마음을 바꾼다.
// - --until N: N번 문제 정답 공개까지만 함께 뛰고, 그 뒤 명단에서 조용히 사라진다(탈락으로 집계되지 않음). 0이면 끝까지.
// - 봇은 진행 명령을 내리지 않는다. 정답을 알기 위해서만 사회자 토큰으로 문제 목록을 읽는다.
import { io, type Socket } from 'socket.io-client';

interface Args {
  count: number;
  url: string;
  pin: string;
  skill: number;
  minutes: number;
  until: number;
}

function parseArgs(): Args {
  const a = process.argv.slice(2);
  const get = (k: string, d: string) => {
    const i = a.indexOf(`--${k}`);
    return i >= 0 ? (a[i + 1] ?? d) : d;
  };
  return {
    count: Number(get('count', '10')),
    url: get('url', 'http://localhost:3000'),
    pin: get('pin', '1234'),
    skill: Number(get('skill', '0.7')),
    minutes: Number(get('minutes', '120')),
    until: Number(get('until', '5')),
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
}

class Bot {
  socket: Socket | null = null;
  playerId = '';
  answered = new Set<number>();
  gone = false;
  skill: number;

  constructor(
    public name: string,
    public phone: string,
    baseSkill: number,
    private answers: () => Map<number, 'O' | 'X'>,
    private base: string,
    /** 지금 라운드에 답해도 되는가(일반 문제 N번까지 + 그 전에 열린 부활전). 문제 번호가 아니라 진행 순서로 판단 */
    private gate: () => boolean,
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
    this.gone = false;
    this.connect(j.sessionToken);
    log(`${this.name} ${j.rejoined ? '자리 복귀' : '입장'} (실력 ${Math.round(this.skill * 100)}%)`);
    return true;
  }

  private connect(token: string) {
    this.socket?.disconnect();
    const s = io(this.base, { auth: { role: 'player', token }, transports: ['websocket'], reconnectionDelay: 500 });
    this.socket = s;
    s.on('room:state', (v: PlayerView) => this.onState(v));
    s.on('question:reveal', (p: { me: { correct: boolean; statusAfter: string; revived: boolean } | null }) => {
      if (!p.me) return;
      if (p.me.correct) log(`  ${this.name}: 정답! ${p.me.revived ? '무대로 복귀 🎉' : '생존'}`);
      else log(`  ${this.name}: 오답… ${p.me.statusAfter === 'ELIMINATED' ? '탈락 😢' : '대기실로'}`);
    });
    s.on('player:eliminated', () => {
      this.gone = true;
    });
    s.on('player:removed', () => {
      this.gone = true;
    });
    s.on('room:reset', () => {
      log(`${this.name}: 방이 초기화됨 → 다시 입장`);
      setTimeout(() => void this.join(), rand(800, 3000));
    });
    s.on('connect_error', (e: Error) => {
      if (e.message === 'eliminated' || e.message === 'invalid_token') {
        this.gone = true;
        s.disconnect();
      }
    });
  }

  private onState(v: PlayerView) {
    if (v.status !== 'ANSWERING' || !v.canAnswer || !v.question || !v.deadline) return;
    const idx = v.question.index;
    if (!this.gate()) return;
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
  const lastIndex = args.until > 0 ? args.until - 1 : -1;
  const login = await fetch(`${args.url}/api/host/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pin: args.pin }) });
  if (!login.ok) throw new Error(`사회자 로그인 실패(${login.status}) — 정답을 읽기 위해 PIN이 필요합니다`);
  const { token } = (await login.json()) as { token: string };

  const answers = new Map<number, 'O' | 'X'>();
  const host = io(args.url, { auth: { role: 'host', token }, transports: ['websocket'] });
  let lastStatus = '';
  let leaving = false;
  const bots: Bot[] = [];
  // 몇 번째 일반 문제인지 진행 순서로 센다(부활전 문제는 번호가 뒤쪽이라 번호로 판단하면 안 됨)
  const seenNormal = new Set<number>();
  const normalRounds = () => seenNormal.size;
  /** 아직 퇴장 전이고, 일반 문제 N번 이내(또는 그 사이 부활전)면 답한다 */
  const gate = () => !leaving && (lastIndex < 0 || normalRounds() <= lastIndex + 1);

  const leaveAll = async (reason: string) => {
    if (leaving) return;
    leaving = true;
    log(`${reason} → 아바타 ${bots.length}명이 조용히 퇴장합니다`);
    await sleep(3000); // 정답 공개 연출이 끝난 뒤
    for (const b of bots) {
      if (!b.playerId || b.gone) continue;
      host.emit('host:removePlayer', { playerId: b.playerId });
      b.gone = true;
      await sleep(rand(150, 350));
    }
    log('아바타 퇴장 완료. 이후 실제 참가자만 남습니다. (게임 초기화 시 다시 입장)');
  };

  host.on(
    'room:state',
    (v: {
      status: string;
      mode: string | null;
      currentIndex: number;
      questions: { orderNo: number; answer: 'O' | 'X' }[];
      players: { name: string; status: string }[];
    }) => {
      answers.clear();
      for (const q of v.questions) answers.set(q.orderNo, q.answer);
      const inRound = ['QUESTION_SHOWN', 'ANSWERING', 'TIME_UP', 'REVEALED'].includes(v.status);
      if (inRound && v.mode === 'NORMAL' && v.currentIndex >= 0) seenNormal.add(v.currentIndex);
      if (v.status !== lastStatus) {
        lastStatus = v.status;
        const alive = v.players.filter((p) => p.status === 'ACTIVE').length;
        const waiting = v.players.filter((p) => p.status === 'WAITING').length;
        const out = v.players.filter((p) => p.status === 'ELIMINATED').length;
        log(`방 상태 ${v.status}${inRound ? ` (${v.mode === 'REVIVAL' ? '부활전' : `일반 ${normalRounds()}번째`})` : ''} · 생존 ${alive} · 대기실 ${waiting} · 탈락 ${out}`);
        if (v.status === 'LOBBY') {
          leaving = false;
          seenNormal.clear();
        }
        if (v.status === 'ENDED') log('게임 종료. 게임 초기화를 하면 아바타들이 다시 입장합니다.');
      }
      if (lastIndex >= 0 && v.status === 'REVEALED' && v.mode === 'NORMAL' && normalRounds() >= lastIndex + 1 && !leaving) {
        void leaveAll(`일반 ${lastIndex + 1}번째 문제 정답 공개`);
      }
    },
  );
  await new Promise<void>((r, j) => {
    host.once('connect', () => r());
    host.once('connect_error', j);
  });

  const picked = NAMES.slice(0, Math.min(args.count, NAMES.length)); // 같은 순서라 다시 켜도 같은 사람이 복귀
  for (let i = 0; i < picked.length; i++) {
    bots.push(new Bot(picked[i]!, `0108${String(1000000 + i).padStart(7, '0')}`, args.skill, () => answers, args.url, gate));
  }
  for (const b of bots) {
    await b.join();
    await sleep(rand(700, 2200)); // 한 명씩 들어오는 느낌
  }
  log(`아바타 ${bots.length}명 준비 완료${lastIndex >= 0 ? ` (일반 문제 ${lastIndex + 1}번째까지 함께 뛰고 퇴장, 그 사이 부활전에도 참여)` : ''}. 콘솔에서 입장 마감 → 문제 공개 → 타이머 시작을 눌러 주세요.`);

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

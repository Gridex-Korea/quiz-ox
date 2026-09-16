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
const CHEERS = ['가자!!', 'O 아니야?', 'X 확실함', '헐 어렵다', '이건 알지 ㅋㅋ', '떨린다…', '나 살았다!', 'ㅠㅠ 아깝다', '부활하자!!', '다들 화이팅', '🔥🔥🔥', '👏👏👏', '5초 남았어', '오늘 컨디션 좋다', '이 문제 낚시 아님?', '사회자님 힌트요'];
/** 마감 몇 ms 전에 최종 선택으로 옮겨가는가 */
const FINAL_WINDOW_MS = 5000;
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

  private joining = false;

  async join(): Promise<boolean> {
    if (this.joining) return false;
    this.joining = true;
    try {
      return await this.doJoin();
    } finally {
      this.joining = false;
    }
  }

  private async doJoin(): Promise<boolean> {
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

  private lastChatStatus = '';

  /** 상태가 바뀔 때 가끔 응원 채팅을 보낸다(문제 공개·정답 공개 뒤 30%) */
  private maybeChat(v: PlayerView) {
    if (v.status === this.lastChatStatus) return;
    this.lastChatStatus = v.status;
    if (!['QUESTION_SHOWN', 'REVEALED', 'LOCKED'].includes(v.status) || Math.random() > 0.3) return;
    setTimeout(() => {
      if (this.gone || !this.socket?.connected) return;
      this.socket.emit('chat:send', { text: CHEERS[Math.floor(Math.random() * CHEERS.length)] });
    }, rand(500, 5000));
  }

  private onState(v: PlayerView) {
    this.maybeChat(v);
    if (v.status !== 'ANSWERING' || !v.canAnswer || !v.question || !v.deadline) return;
    const idx = v.question.index;
    if (!this.gate()) return;
    if (this.answered.has(idx)) return;
    this.answered.add(idx);
    this.playRound(idx, v.deadline);
  }

  /**
   * 무대가 심심하지 않게: 초반에는 O/X를 거의 반반으로 오가며 서성이다가,
   * 마감 5초 전(FINAL_WINDOW_MS)에 실력에 따라 정답 또는 오답으로 최종 이동한다.
   */
  private playRound(idx: number, deadline: number) {
    const correct = this.answers().get(idx);
    if (!correct) return;
    const wrong: 'O' | 'X' = correct === 'O' ? 'X' : 'O';
    const final: 'O' | 'X' = Math.random() < this.skill ? correct : wrong;
    const send = (choice: 'O' | 'X', tag = '') => {
      if (this.gone || !this.socket?.connected) return;
      this.socket.emit('answer:choose', { index: idx, choice });
      log(`  ${this.name} → ${choice}${tag}`);
    };

    const now = Date.now();
    const decideAt = deadline - FINAL_WINDOW_MS;
    // 서성이는 구간: 첫 선택은 1~3초 뒤, 그 뒤 1.2~2.5초 간격으로 좌우를 오간다
    let t = now + rand(900, 3000);
    let wander: 'O' | 'X' = Math.random() < 0.5 ? 'O' : 'X';
    let moves = 0;
    while (t < decideAt - 600 && moves < 6) {
      const at = t;
      const choice = wander;
      setTimeout(() => send(choice), at - now);
      wander = wander === 'O' ? 'X' : 'O';
      t += rand(1200, 2500);
      moves += 1;
    }
    // 마지막 5초: 실력대로 최종 선택. 사람처럼 조금 흩어지게 0~1.5초 지연
    setTimeout(() => send(final, ' (최종)'), Math.max(300, decideAt - now + rand(0, 1500)));
  }
}

async function main() {
  const args = parseArgs();
  const lastIndex = args.until > 0 ? args.until - 1 : -1;
  const hostLogin = async () => {
    const login = await fetch(`${args.url}/api/host/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pin: args.pin }) });
    if (!login.ok) throw new Error(`사회자 로그인 실패(${login.status}) — 정답을 읽기 위해 PIN이 필요합니다`);
    return ((await login.json()) as { token: string }).token;
  };
  const token = await hostLogin();

  const answers = new Map<number, 'O' | 'X'>();
  const host = io(args.url, { auth: { role: 'host', token }, transports: ['websocket'] });
  // 서버가 재시작되면 사회자 토큰이 사라지므로 다시 로그인해 붙는다
  host.on('connect_error', (e: Error) => {
    if (e.message !== 'invalid_host') return;
    void hostLogin()
      .then((t) => {
        (host.auth as Record<string, unknown>)['token'] = t;
        host.connect();
      })
      .catch((err) => log(`사회자 재로그인 실패: ${(err as Error).message}`));
  });
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
  // 입장에 실패했거나(탈락 등) 퇴장한 봇은 소켓이 없어 초기화 신호를 못 받으므로, 사회자 채널에서 초기화를 감지해 다시 들여보낸다
  host.on('room:reset', () => {
    leaving = false;
    seenNormal.clear();
    for (const b of bots) if (!b.socket?.connected) setTimeout(() => void b.join(), rand(800, 4000));
  });
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

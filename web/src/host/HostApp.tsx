// 사회자 콘솔. 설계: DOCS/design/screens.md "3. 사회자 콘솔"
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  C2S,
  S2C,
  countByStatus,
  formatPhone,
  maskPhone,
  type Choice,
  type PublicPlayer,
  type Question,
  type QuestionInput,
  type RoomConfig,
  type RoomStateForHost,
} from '@ox/shared';
import QRCode from 'qrcode';
import { api, ApiError } from '../shared/api';
import { Avatar } from '../shared/Avatar';
import { loadJson, removeKey, saveJson } from '../shared/storage';
import { useCountdown, useRoom } from '../shared/socket';
import './host.css';

const TOKEN_KEY = 'ox.hostToken';

interface Toast {
  id: number;
  level: 'info' | 'warning' | 'error';
  message: string;
}

export function HostApp() {
  const [token, setToken] = useState<string | null>(() => loadJson<string>(TOKEN_KEY));
  const auth = useMemo(() => (token ? { role: 'host', token } : null), [token]);
  const room = useRoom<RoomStateForHost>(auth);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastId = useRef(0);

  const toast = (level: Toast['level'], message: string) => {
    const id = ++toastId.current;
    setToasts((t) => [...t, { id, level, message }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), level === 'error' ? 6000 : 4000);
  };

  useEffect(() => {
    if (room.status === 'error' && room.error === 'invalid_host') {
      removeKey(TOKEN_KEY);
      setToken(null);
    }
  }, [room.status, room.error]);

  useEffect(() => room.on(S2C.hostAlert, (p) => {
    const a = p as Toast;
    toast(a.level, a.message);
  }), [room]);

  if (!token) {
    return (
      <Login
        onLogin={(t) => {
          saveJson(TOKEN_KEY, t);
          setToken(t);
        }}
      />
    );
  }

  return (
    <div className="host">
      {room.view ? (
        <Console view={room.view} room={room} token={token} toast={toast} onLogout={() => { removeKey(TOKEN_KEY); setToken(null); }} />
      ) : (
        <div className="host-loading">{room.status === 'error' ? `연결 오류: ${room.error}` : '연결 중…'}</div>
      )}
      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.level}`} onClick={() => setToasts((x) => x.filter((y) => y.id !== t.id))}>
            {t.message}
          </div>
        ))}
      </div>
    </div>
  );
}

function Login({ onLogin }: { onLogin: (token: string) => void }) {
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.hostLogin(pin);
      onLogin(r.token);
    } catch (e) {
      setError((e as ApiError).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="host-login">
      <div className="card stack" style={{ width: 340 }}>
        <h1 style={{ margin: 0, fontSize: 22 }}>🎤 사회자 콘솔</h1>
        <label htmlFor="pin">PIN</label>
        <input id="pin" type="password" value={pin} inputMode="numeric" autoFocus onChange={(e) => setPin(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} />
        {error && <p className="field-error">{error}</p>}
        <button className="primary" disabled={!pin || busy} onClick={submit}>
          로그인
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

type Tab = 'players' | 'questions' | 'settings';

const STATUS_KO: Record<string, string> = {
  LOBBY: '입장 접수 중',
  LOCKED: '입장 마감',
  QUESTION_SHOWN: '문제 공개',
  ANSWERING: '답변 중',
  TIME_UP: '마감',
  REVEALED: '정답 공개',
  ENDED: '종료',
};

function Console({
  view,
  room,
  token,
  toast,
  onLogout,
}: {
  view: RoomStateForHost;
  room: ReturnType<typeof useRoom<RoomStateForHost>>;
  token: string;
  toast: (level: Toast['level'], message: string) => void;
  onLogout: () => void;
}) {
  const [tab, setTab] = useState<Tab>('players');
  const remaining = useCountdown(view.status === 'ANSWERING' ? view.deadline : null, room.now);
  const pre = useCountdown(view.status === 'QUESTION_SHOWN' ? view.autoStartAt : null, room.now);
  const counts = useMemo(() => {
    const c: Record<string, number> = { ACTIVE: 0, WAITING: 0, ELIMINATED: 0 };
    for (const p of view.players) c[p.status] = (c[p.status] ?? 0) + 1;
    return c;
  }, [view.players]);
  const live = useMemo(() => {
    const c = { O: 0, X: 0, none: 0 };
    const eligible = view.mode === 'REVIVAL' ? 'WAITING' : 'ACTIVE';
    for (const p of view.players) {
      if (p.status !== eligible) continue;
      if (p.choice) c[p.choice] += 1;
      else c.none += 1;
    }
    return c;
  }, [view.players, view.mode]);

  const question = view.question ? view.questions.find((q) => q.orderNo === view.question!.index) : undefined;
  const nextNormal = view.questions.find((q) => q.usedAt === null && q.kind === 'NORMAL');
  const suggestRevival =
    view.status === 'REVEALED' && view.revivalUsedCount === 0 && view.mode === 'NORMAL' && view.currentIndex >= view.config.revivalAfterOrderNo && counts['WAITING']! > 0;

  const emit = (event: string, payload?: unknown) => room.emit(event, payload);

  const primary = (() => {
    switch (view.status) {
      case 'LOBBY':
        return { label: `입장 마감 (${view.players.length}명)`, onClick: () => emit(C2S.hostLock), disabled: view.players.length === 0 };
      case 'LOCKED':
        return { label: nextNormal ? `첫 문제 공개 · Q${nextNormal.orderNo + 1}` : '문제를 먼저 등록하세요', onClick: () => emit(C2S.hostShowQuestion, {}), disabled: !nextNormal };
      case 'QUESTION_SHOWN':
        return {
          label:
            pre !== null && pre > 0
              ? `${Math.ceil(pre / 1000)}초 뒤 자동 시작 · 지금 시작 (${view.question?.timeLimitSec ?? 0}초)`
              : `타이머 시작 (${view.question?.timeLimitSec ?? 0}초)`,
          onClick: () => emit(C2S.hostStartTimer, {}),
          disabled: false,
        };
      case 'ANSWERING':
        return { label: `답변 중… ${remaining !== null ? Math.ceil(remaining / 1000) : ''}초`, onClick: () => undefined, disabled: true };
      case 'TIME_UP':
        return { label: '정답 공개', onClick: () => emit(C2S.hostReveal), disabled: false };
      case 'REVEALED':
        if (suggestRevival) return { label: `🔥 패자부활전 시작 (대기실 ${counts['WAITING']}명)`, onClick: () => emit(C2S.hostStartRevival, {}), disabled: false };
        return nextNormal
          ? { label: `다음 문제 · Q${nextNormal.orderNo + 1}`, onClick: () => emit(C2S.hostNext), disabled: false }
          : { label: '게임 종료 · 생존자 발표', onClick: () => emit(C2S.hostNext), disabled: false };
      case 'ENDED':
        return { label: '게임 종료됨 · 아래에서 우승자를 지정하세요', onClick: () => undefined, disabled: true };
      default:
        return { label: '…', onClick: () => undefined, disabled: true };
    }
  })();

  return (
    <>
      <header className="host-header">
        <div className="row">
          <strong>OX 퀴즈 콘솔</strong>
          <span className="badge">방 {view.roomCode}</span>
          <span className={`badge status-${view.status}`}>{STATUS_KO[view.status]}</span>
          {view.mode === 'REVIVAL' && view.status !== 'LOBBY' && <span className="badge danger">패자부활전</span>}
          {view.status === 'ANSWERING' && remaining !== null && <span className={`badge ${remaining <= 5000 ? 'danger' : ''}`}>⏱ {Math.ceil(remaining / 1000)}</span>}
        </div>
        <div className="row">
          <a className="button-like" href={`/screen`} target="_blank" rel="noreferrer">
            스크린 열기 ↗
          </a>
          <button className="ghost small" onClick={onLogout}>
            로그아웃
          </button>
        </div>
      </header>

      <main className="host-main">
        <section className="panel progress">
          <h2>진행</h2>
          {view.question ? (
            <div className="qcard">
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <span className="muted">
                  {view.mode === 'REVIVAL' ? '패자부활전 · ' : ''}Q{view.question.index + 1} / {view.question.total}
                  {view.liveMoves ? ' · 이동 실시간' : ' · 이동 숨김'}
                </span>
                {question && <span className={`badge ${question.answer === 'O' ? 'o' : 'x'}`}>정답 {question.answer} (스크린엔 안 보임)</span>}
              </div>
              <p className="qtext">{view.question.text}</p>
              {question?.explanation && <p className="muted">해설: {question.explanation}</p>}
              <div className="live-counts">
                <span className="o">O {live.O}</span>
                <span className="x">X {live.X}</span>
                <span className="muted">미응답 {live.none}</span>
              </div>
            </div>
          ) : (
            <div className="qcard muted">
              {view.status === 'LOBBY' || view.status === 'LOCKED'
                ? `참가자 ${view.players.length}명 입장 · 문제 ${view.questions.length}개 등록`
                : '문제 없음'}
            </div>
          )}

          <button className="primary next-step" disabled={primary.disabled} onClick={primary.onClick}>
            {primary.label}
          </button>

          <div className="subactions">
            {view.status === 'LOCKED' && (
              <button className="ghost small" onClick={() => emit(C2S.hostUnlock)}>
                입장 다시 열기
              </button>
            )}
            {view.status === 'QUESTION_SHOWN' && (
              <select
                className="small"
                value=""
                onChange={(e) => {
                  if (e.target.value !== '') emit(C2S.hostShowQuestion, { index: Number(e.target.value) });
                }}
              >
                <option value="">다른 문제로 바꾸기…</option>
                {view.questions
                  .filter((q) => q.usedAt === null || q.orderNo === view.currentIndex)
                  .map((q) => (
                    <option key={q.id} value={q.orderNo}>
                      Q{q.orderNo + 1} {q.kind === 'REVIVAL' ? '♻ ' : ''}
                      {q.text.slice(0, 24)}
                    </option>
                  ))}
              </select>
            )}
            {view.status === 'ANSWERING' && (
              <>
                <button className="small" onClick={() => emit(C2S.hostExtendTimer, { seconds: 10 })}>
                  +10초
                </button>
                <button className="small" onClick={() => emit(C2S.hostEndTimerNow)}>
                  지금 마감
                </button>
              </>
            )}
            {(view.status === 'ANSWERING' || view.status === 'TIME_UP') && (
              <button className="ghost small" onClick={() => confirm('이번 문제의 답변을 모두 버리고 문제 화면으로 돌아갑니까?') && emit(C2S.hostCancelRound)}>
                라운드 취소
              </button>
            )}
            {view.status === 'REVEALED' && (
              <>
                <button className="ghost small" onClick={() => confirm('직전 판정을 취소하고 마감 상태로 되돌립니까? 탈락자는 다시 접속할 수 있게 됩니다.') && emit(C2S.hostUndoReveal)}>
                  판정 취소
                </button>
                {!suggestRevival && counts['WAITING']! > 0 && (
                  <button
                    className="ghost small"
                    onClick={() => {
                      if (view.revivalUsedCount > 0) {
                        if (confirm('패자부활전은 이미 한 번 열었습니다. 비상 상황으로 추가 부활전을 엽니까?')) emit(C2S.hostStartRevival, { force: true });
                      } else emit(C2S.hostStartRevival, {});
                    }}
                  >
                    {view.revivalUsedCount > 0 ? `추가 부활전 (비상용, 대기실 ${counts['WAITING']}명)` : `패자부활전 시작 (대기실 ${counts['WAITING']}명)`}
                  </button>
                )}
                {suggestRevival && (
                  <button className="ghost small" onClick={() => emit(C2S.hostNext)}>
                    부활전 없이 다음 문제
                  </button>
                )}
              </>
            )}
            {view.status !== 'LOBBY' && view.status !== 'ENDED' && (
              <button className="ghost small danger-text" onClick={() => confirm('게임을 지금 종료하고 생존자를 발표합니까?') && emit(C2S.hostEnd)}>
                게임 종료
              </button>
            )}
          </div>

          {view.status === 'ENDED' && <WinnerPicker view={view} onPick={(id) => emit(C2S.hostSetWinner, { playerId: id })} />}

          <div className="summary">
            <span className="badge ok">생존 {counts['ACTIVE']}</span>
            <span className="badge warn">대기실 {counts['WAITING']}</span>
            <span className="badge">탈락 {counts['ELIMINATED']}</span>
            <span className="muted">부활전 {view.revivalUsedCount}회</span>
          </div>
        </section>

        <section className="panel side">
          <nav className="tabs">
            {(['players', 'questions', 'settings'] as Tab[]).map((t) => (
              <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
                {t === 'players' ? `참가자 (${view.players.length})` : t === 'questions' ? `문제 (${view.questions.length})` : '설정'}
              </button>
            ))}
          </nav>
          {tab === 'players' && <Players view={view} emit={emit} />}
          {tab === 'questions' && <Questions view={view} emit={emit} token={token} toast={toast} />}
          {tab === 'settings' && <Settings view={view} emit={emit} token={token} toast={toast} />}
        </section>
      </main>
    </>
  );
}

// ---------------------------------------------------------------------------

function WinnerPicker({ view, onPick }: { view: RoomStateForHost; onPick: (id: string) => void }) {
  const survivors = view.players.filter((p) => p.status === 'ACTIVE');
  return (
    <div className="winner-picker">
      <p className="muted" style={{ margin: '0 0 6px' }}>
        무대에서 결승(추가 문제·가위바위보)을 끝낸 뒤 우승자를 고르면 스크린에 왕관이 뜹니다.
      </p>
      <div className="row">
        {survivors.length === 0 && <span className="muted">생존자가 없습니다.</span>}
        {survivors.map((p) => (
          <button key={p.id} className={`small ${view.winnerId === p.id ? 'primary' : ''}`} onClick={() => onPick(p.id)}>
            {view.winnerId === p.id ? '👑 ' : ''}
            {p.name}
          </button>
        ))}
      </div>
    </div>
  );
}

function Players({ view, emit }: { view: RoomStateForHost; emit: (e: string, p?: unknown) => void }) {
  const [q, setQ] = useState('');
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return [...view.players]
      .filter((p) => !needle || p.name.toLowerCase().includes(needle) || (view.phones[p.id] ?? '').includes(needle.replace(/\D/g, '')))
      .sort((a, b) => a.name.localeCompare(b.name, 'ko'));
  }, [view.players, view.phones, q]);

  return (
    <div className="players">
      <input placeholder="이름 또는 번호 검색" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th></th>
              <th>이름</th>
              <th>전화번호</th>
              <th>상태</th>
              <th>선택</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {list.map((p) => (
              <tr key={p.id} className={p.connected ? '' : 'offline'}>
                <td>
                  <Avatar spec={p.avatar} size={28} dim={!p.connected} />
                </td>
                <td>
                  {p.name}
                  {!p.connected && <span className="muted"> ⚡</span>}
                </td>
                <td className="phone" onClick={() => setRevealed((r) => ({ ...r, [p.id]: !r[p.id] }))} title="클릭하면 전체 표시">
                  {revealed[p.id] ? formatPhone(view.phones[p.id] ?? null) || '(삭제됨)' : maskPhone(view.phones[p.id] ?? null)}
                </td>
                <td>
                  <StatusBadge p={p} />
                </td>
                <td>{p.choice ? <span className={`badge ${p.choice.toLowerCase()}`}>{p.choice}</span> : p.hasAnswered ? '✓' : ''}</td>
                <td className="actions">
                  {p.status !== 'ACTIVE' && (
                    <button className="small" title="스트라이크를 하나 줄이고 한 단계 복구" onClick={() => emit(C2S.hostRestore, { playerId: p.id })}>
                      복구
                    </button>
                  )}
                  {p.status !== 'ELIMINATED' && (
                    <button className="small ghost danger-text" onClick={() => confirm(`${p.name} 참가자를 퇴장시킵니까?`) && emit(C2S.hostKick, { playerId: p.id })}>
                      퇴장
                    </button>
                  )}
                  {(p.status === 'ELIMINATED' || view.status === 'LOBBY' || view.status === 'LOCKED') && (
                    <button
                      className="small ghost"
                      title="명단·집계·CSV에서 완전히 제거"
                      onClick={() => confirm(`${p.name} 참가자를 명단에서 완전히 지웁니까? 집계와 CSV에서도 사라집니다.`) && emit(C2S.hostRemovePlayer, { playerId: p.id })}
                    >
                      삭제
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function StatusBadge({ p }: { p: PublicPlayer }) {
  if (p.status === 'ACTIVE') return <span className="badge ok">생존{p.strikes > 0 ? ` · 기회 ${Math.max(0, 2 - p.strikes)}` : ''}</span>;
  if (p.status === 'WAITING') return <span className="badge warn">대기실</span>;
  return <span className="badge">탈락{p.eliminatedAtIndex !== null ? ` Q${p.eliminatedAtIndex + 1}` : ''}</span>;
}

// ---------------------------------------------------------------------------

const SAMPLE_QUESTIONS: QuestionInput[] = [
  { text: '지구는 태양 주위를 1년에 한 번 돈다.', answer: 'O', kind: 'NORMAL', timeLimitSec: null, imageUrl: null, explanation: '공전 주기는 약 365.25일이다.' },
  { text: '물은 섭씨 90도에서 끓는다.', answer: 'X', kind: 'NORMAL', timeLimitSec: null, imageUrl: null, explanation: '1기압에서는 100도.' },
  { text: '대한민국의 수도는 서울이다.', answer: 'O', kind: 'NORMAL', timeLimitSec: null, imageUrl: null, explanation: null },
  { text: '문어의 심장은 하나다.', answer: 'X', kind: 'NORMAL', timeLimitSec: null, imageUrl: null, explanation: '문어는 심장이 셋이다.' },
  { text: '소리는 진공에서도 전달된다.', answer: 'X', kind: 'NORMAL', timeLimitSec: null, imageUrl: null, explanation: '매질이 없으면 전달되지 않는다.' },
  { text: '피아노는 현악기로 분류되기도 한다.', answer: 'O', kind: 'NORMAL', timeLimitSec: null, imageUrl: null, explanation: '건반으로 현을 치는 타현악기.' },
  { text: '올림픽은 4년마다 열린다.', answer: 'O', kind: 'NORMAL', timeLimitSec: null, imageUrl: null, explanation: null },
  { text: '바나나는 나무에서 자란다.', answer: 'X', kind: 'NORMAL', timeLimitSec: null, imageUrl: null, explanation: '바나나는 거대한 풀이다.' },
  { text: '빛은 1초에 지구를 약 7바퀴 반 돈다.', answer: 'O', kind: 'NORMAL', timeLimitSec: null, imageUrl: null, explanation: '약 30만 km/s.' },
  { text: '사람의 뼈는 어른이 되면 더 많아진다.', answer: 'X', kind: 'NORMAL', timeLimitSec: null, imageUrl: null, explanation: '자라면서 뼈가 합쳐져 206개가 된다.' },
  { text: '[부활전] 한글은 1443년에 창제되었다.', answer: 'O', kind: 'REVIVAL', timeLimitSec: null, imageUrl: null, explanation: '반포는 1446년.' },
  { text: '[부활전] 토마토는 채소로만 분류된다.', answer: 'X', kind: 'REVIVAL', timeLimitSec: null, imageUrl: null, explanation: '식물학적으로는 과일.' },
];

function Questions({ view, emit, token, toast }: { view: RoomStateForHost; emit: (e: string, p?: unknown) => void; token: string; toast: (l: Toast['level'], m: string) => void }) {
  const [editing, setEditing] = useState<Partial<Question> | null>(null);
  const [importText, setImportText] = useState('');
  const [showImport, setShowImport] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const doImport = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    try {
      let r;
      if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
        const parsed = JSON.parse(trimmed) as QuestionInput[] | { questions: QuestionInput[] };
        r = await api.importJson(token, Array.isArray(parsed) ? parsed : parsed.questions);
      } else r = await api.importCsv(token, trimmed);
      toast(r.errors.length ? 'warning' : 'info', `${r.imported}개 가져옴${r.errors.length ? `, 오류 ${r.errors.length}건: ${r.errors.slice(0, 3).join(' / ')}` : ''}`);
      setShowImport(false);
      setImportText('');
    } catch (e) {
      toast('error', (e as ApiError).message);
    }
  };

  const save = () => {
    if (!editing?.text || !editing.answer) return;
    const payload: QuestionInput & { id?: string } = {
      id: editing.id,
      text: editing.text,
      answer: editing.answer as Choice,
      kind: (editing.kind as QuestionInput['kind']) ?? 'NORMAL',
      timeLimitSec: editing.timeLimitSec ?? null,
      imageUrl: editing.imageUrl || null,
      explanation: editing.explanation || null,
    };
    emit(C2S.hostQuestionUpsert, payload);
    setEditing(null);
  };

  return (
    <div className="questions">
      <div className="row">
        <button className="small primary" onClick={() => setEditing({ kind: 'NORMAL', answer: 'O', timeLimitSec: null })}>
          + 문제 추가
        </button>
        <button className="small" onClick={() => setShowImport((s) => !s)}>
          CSV/JSON 불러오기
        </button>
        <button className="small ghost" onClick={() => confirm('샘플 문제 12개(부활전용 2개 포함)로 목록을 바꿉니까?') && doImport(JSON.stringify(SAMPLE_QUESTIONS))}>
          샘플 문제
        </button>
      </div>
      {showImport && (
        <div className="card stack">
          <p className="muted" style={{ margin: 0 }}>
            CSV 열: <code>order,kind,text,answer,timeLimitSec,imageUrl,explanation</code> (한글 헤더 문제/정답/종류/제한시간/해설도 됨). 목록 전체가 교체됩니다.
          </p>
          <textarea rows={6} value={importText} onChange={(e) => setImportText(e.target.value)} placeholder={'문제,정답,종류\n지구는 둥글다,O,\n...'} />
          <div className="row">
            <input ref={fileRef} type="file" accept=".csv,.txt,.json" style={{ width: 'auto' }} onChange={async (e) => {
              const f = e.target.files?.[0];
              if (f) setImportText(await f.text());
            }} />
            <button className="small primary" onClick={() => doImport(importText)} disabled={!importText.trim()}>
              가져오기
            </button>
          </div>
        </div>
      )}
      {editing && (
        <div className="card stack editor">
          <input placeholder="지문" value={editing.text ?? ''} onChange={(e) => setEditing({ ...editing, text: e.target.value })} />
          <div className="row">
            <label className="row" style={{ margin: 0 }}>
              정답
              <select value={editing.answer ?? 'O'} onChange={(e) => setEditing({ ...editing, answer: e.target.value as Choice })} style={{ width: 80 }}>
                <option value="O">O</option>
                <option value="X">X</option>
              </select>
            </label>
            <label className="row" style={{ margin: 0 }}>
              종류
              <select value={editing.kind ?? 'NORMAL'} onChange={(e) => setEditing({ ...editing, kind: e.target.value as Question['kind'] })} style={{ width: 130 }}>
                <option value="NORMAL">일반</option>
                <option value="REVIVAL">패자부활전용</option>
              </select>
            </label>
            <label className="row" style={{ margin: 0 }}>
              제한시간
              <input type="number" min={3} max={300} placeholder="기본" value={editing.timeLimitSec ?? ''} onChange={(e) => setEditing({ ...editing, timeLimitSec: e.target.value ? Number(e.target.value) : null })} style={{ width: 90 }} />
            </label>
          </div>
          <input placeholder="해설(선택)" value={editing.explanation ?? ''} onChange={(e) => setEditing({ ...editing, explanation: e.target.value })} />
          <input placeholder="이미지 URL(선택)" value={editing.imageUrl ?? ''} onChange={(e) => setEditing({ ...editing, imageUrl: e.target.value })} />
          <div className="row">
            <button className="small primary" onClick={save} disabled={!editing.text}>
              저장
            </button>
            <button className="small ghost" onClick={() => setEditing(null)}>
              취소
            </button>
          </div>
        </div>
      )}
      <ol className="qlist">
        {view.questions.map((q) => (
          <li key={q.id} className={`${q.orderNo === view.currentIndex && view.status !== 'LOBBY' && view.status !== 'LOCKED' ? 'current' : ''} ${q.usedAt !== null ? 'used' : ''}`}>
            <span className="qno">Q{q.orderNo + 1}</span>
            {q.kind === 'REVIVAL' && <span className="badge danger small-badge">♻ 부활전</span>}
            <span className="qtext">{q.text}</span>
            <span className={`badge ${q.answer === 'O' ? 'o' : 'x'}`}>{q.answer}</span>
            <span className="muted">{q.timeLimitSec ?? view.config.defaultTimeLimitSec}초</span>
            {q.usedAt !== null && <span className="muted">✓ 출제</span>}
            <span className="spacer" />
            <button className="small ghost" onClick={() => setEditing({ ...q })}>
              편집
            </button>
            {q.usedAt === null && (
              <button className="small ghost danger-text" onClick={() => confirm('이 문제를 삭제합니까?') && emit(C2S.hostQuestionDelete, { id: q.id })}>
                삭제
              </button>
            )}
          </li>
        ))}
        {view.questions.length === 0 && <li className="muted">문제가 없습니다. 샘플 문제로 시작해 보세요.</li>}
      </ol>
    </div>
  );
}

// ---------------------------------------------------------------------------

function Settings({ view, emit, token, toast }: { view: RoomStateForHost; emit: (e: string, p?: unknown) => void; token: string; toast: (l: Toast['level'], m: string) => void }) {
  const [cfg, setCfg] = useState<RoomConfig>(view.config);
  const [qr, setQr] = useState<string | null>(null);
  const inGame = !['LOBBY', 'LOCKED'].includes(view.status);
  const screenUrl = `${window.location.origin}/screen`;

  useEffect(() => setCfg(view.config), [view.config]);
  useEffect(() => {
    QRCode.toDataURL(view.joinUrl, { width: 320, margin: 1 }).then(setQr).catch(() => setQr(null));
  }, [view.joinUrl]);

  const save = () => emit(C2S.hostUpdateConfig, cfg);

  return (
    <div className="settings stack">
      <div className="card stack">
        <h3>게임 규칙</h3>
        <div className="grid2">
          <label>
            기본 제한시간(초)
            <input type="number" min={3} max={300} value={cfg.defaultTimeLimitSec} disabled={inGame} onChange={(e) => setCfg({ ...cfg, defaultTimeLimitSec: Number(e.target.value) })} />
          </label>
          <label>
            탈락 스트라이크
            <input type="number" min={1} max={5} value={cfg.maxStrikes} disabled={inGame} onChange={(e) => setCfg({ ...cfg, maxStrikes: Number(e.target.value) })} />
          </label>
          <label>
            패자부활전 예정: N번 문제 뒤
            <input type="number" min={1} max={999} value={cfg.revivalAfterOrderNo + 1} onChange={(e) => setCfg({ ...cfg, revivalAfterOrderNo: Number(e.target.value) - 1 })} />
          </label>
          <label>
            아바타 이동 실시간 공개: N번 문제까지
            <input type="number" min={0} max={999} value={cfg.liveMovesUntilOrderNo + 1} onChange={(e) => setCfg({ ...cfg, liveMovesUntilOrderNo: Number(e.target.value) - 1 })} />
          </label>
          <label>
            마감 유예(ms)
            <input type="number" min={0} max={3000} value={cfg.answerGraceMs} disabled={inGame} onChange={(e) => setCfg({ ...cfg, answerGraceMs: Number(e.target.value) })} />
          </label>
          <label className="row" style={{ alignItems: 'center', marginTop: 22 }}>
            <input type="checkbox" checked={cfg.autoStart} style={{ width: 20, height: 20 }} onChange={(e) => setCfg({ ...cfg, autoStart: e.target.checked })} />
            문제 공개 시 타이머 자동 시작
          </label>
          <label>
            자동 시작 준비 카운트(초, 0이면 즉시)
            <input type="number" min={0} max={30} value={cfg.autoStartDelaySec} disabled={!cfg.autoStart} onChange={(e) => setCfg({ ...cfg, autoStartDelaySec: Number(e.target.value) })} />
          </label>
        </div>
        <p className="muted" style={{ margin: 0 }}>
          미응답은 항상 오답입니다. 게임 중에는 부활전 시점, 이동 공개 시점, 자동 시작만 바꿀 수 있습니다.
        </p>
        <button className="small primary" onClick={save}>
          설정 저장
        </button>
      </div>

      <div className="card stack">
        <h3>접속 정보</h3>
        <p style={{ margin: 0 }}>
          참가자 URL: <code>{view.joinUrl}</code>
        </p>
        <p style={{ margin: 0 }}>
          스크린 URL: <code>{screenUrl}</code> <span className="muted">(스크린 키는 서버 환경변수 SCREEN_KEY, 첫 접속 때 입력)</span>
        </p>
        {qr && (
          <div className="row">
            <img src={qr} alt="참가 QR" width={160} height={160} style={{ background: '#fff', borderRadius: 8, padding: 6 }} />
            <a className="button-like small" href={qr} download={`ox-join-${view.roomCode}.png`}>
              QR 이미지 저장(인쇄용)
            </a>
          </div>
        )}
      </div>

      <div className="card stack danger-zone">
        <h3>정리</h3>
        <div className="row">
          <button className="small" onClick={() => api.downloadCsv(token, `ox-participants-${view.roomCode}.csv`).catch((e) => toast('error', (e as Error).message))}>
            참가자 CSV 내보내기
          </button>
          <button
            className="small danger"
            disabled={view.phonesPurgedAt !== null}
            onClick={async () => {
              if (!confirm('모든 참가자의 전화번호를 삭제합니다. 되돌릴 수 없습니다. 먼저 CSV를 내려받았습니까?')) return;
              if (!confirm('정말 삭제합니까?')) return;
              try {
                await api.purgePhones(token);
                toast('info', '전화번호를 삭제했습니다.');
              } catch (e) {
                toast('error', (e as ApiError).message);
              }
            }}
          >
            {view.phonesPurgedAt ? '전화번호 삭제됨' : '전화번호 전체 삭제'}
          </button>
          <button
            className="small danger"
            onClick={() => {
              if (!confirm('게임을 초기화합니다. 참가자와 진행 기록이 모두 지워지고 새 방 코드가 생깁니다.')) return;
              const keep = confirm('문제 목록은 유지합니까? (취소를 누르면 문제도 삭제)');
              if (!confirm('정말 초기화합니까?')) return;
              emit(C2S.hostResetRoom, { confirm: true, keepQuestions: keep });
            }}
          >
            게임 초기화(새 게임)
          </button>
        </div>
        <p className="muted" style={{ margin: 0 }}>
          전화번호는 {new Date(view.createdAt + 7 * 86400000).toLocaleDateString('ko-KR')}에 자동 삭제되며, 수집 목적(경품 지급·본인 확인)이 끝나면 즉시 삭제해 주세요.
        </p>
      </div>
    </div>
  );
}

export { countByStatus };

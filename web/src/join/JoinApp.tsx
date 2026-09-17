// 참가자 폰 화면. 설계: DOCS/design/screens.md "1. 참가자 폰"
import { useCallback, useEffect, useMemo, useState } from 'react';
import { C2S, S2C, formatPhone, normalizePhone, PHONE_DIGITS_RE, type AvatarSpec, type Choice, type RoomStateForPlayer } from '@ox/shared';
import { api, ApiError } from '../shared/api';
import { Avatar, randomAvatar } from '../shared/Avatar';
import { loadJson, queryParam, removeKey, saveJson } from '../shared/storage';
import { useCountdown, useRoom } from '../shared/socket';
import { ChatDrawer } from './ChatDrawer';
import './join.css';

interface Session {
  token: string;
  playerId: string;
  name: string;
  avatar: AvatarSpec;
  roomCode: string;
  eliminatedAt?: number | null;
}

const SESSION_KEY = 'ox.session';

export function JoinApp() {
  const [session, setSession] = useState<Session | null>(() => loadJson<Session>(SESSION_KEY));
  const [notice, setNotice] = useState<string | null>(null);

  const auth = useMemo(() => (session && session.eliminatedAt == null ? { role: 'player', token: session.token } : null), [session]);
  const room = useRoom<RoomStateForPlayer>(auth);

  const clearSession = useCallback((msg?: string) => {
    removeKey(SESSION_KEY);
    setSession(null);
    if (msg) setNotice(msg);
  }, []);

  // 인증 실패 처리
  useEffect(() => {
    if (room.status !== 'error' || !room.error) return;
    if (room.error === 'invalid_token') clearSession('접속 정보가 만료되었습니다. 같은 번호와 이름으로 다시 입장하면 자리가 복구됩니다.');
    if (room.error === 'eliminated' && session) {
      const s = { ...session, eliminatedAt: session.eliminatedAt ?? null };
      saveJson(SESSION_KEY, s);
      setSession(s);
    }
  }, [room.status, room.error, session, clearSession]);

  // 서버 이벤트: 탈락·세션 교체·방 초기화
  useEffect(() => {
    const offs = [
      room.on(S2C.playerEliminated, (p) => {
        const at = (p as { atQuestion: number }).atQuestion;
        setSession((cur) => {
          if (!cur) return cur;
          const next = { ...cur, eliminatedAt: at };
          saveJson(SESSION_KEY, next);
          return next;
        });
      }),
      room.on(S2C.sessionReplaced, () => setNotice('다른 기기에서 같은 번호로 접속해 이 화면의 연결이 끊어졌습니다.')),
      room.on(S2C.roomReset, () => clearSession('사회자가 게임을 초기화했습니다. 다시 입장해 주세요.')),
      room.on(S2C.playerRemoved, () => clearSession('사회자가 참가를 취소했습니다.')),
      room.on(S2C.answerAck, () => navigator.vibrate?.(20)),
    ];
    return () => offs.forEach((off) => off());
  }, [room, clearSession]);

  if (session?.eliminatedAt != null) {
    return <Eliminated at={session.eliminatedAt} name={session.name} avatar={session.avatar} onLeave={() => clearSession()} />;
  }

  if (!session) {
    return (
      <JoinForm
        notice={notice}
        onJoined={(s) => {
          saveJson(SESSION_KEY, s);
          setNotice(null);
          setSession(s);
          requestWakeLock();
        }}
      />
    );
  }

  return (
    <div className="join">
      <ConnectionBar status={room.status} />
      {notice && (
        <div className="notice" onClick={() => setNotice(null)}>
          {notice}
        </div>
      )}
      {room.view ? <Playing view={room.view} session={session} room={room} /> : <Waiting text="접속 중…" />}
    </div>
  );
}

// ---------------------------------------------------------------------------

function ConnectionBar({ status }: { status: string }) {
  if (status === 'connected') return null;
  const text = status === 'connecting' ? '연결 중…' : status === 'disconnected' ? '연결이 끊겼습니다. 다시 연결 중…' : '연결 오류';
  return <div className="connbar">{text}</div>;
}

function Waiting({ text }: { text: string }) {
  return (
    <div className="screen-center">
      <div className="spinner" />
      <p className="muted">{text}</p>
    </div>
  );
}

let wakeLock: { release: () => Promise<void> } | null = null;
async function requestWakeLock() {
  try {
    const nav = navigator as Navigator & { wakeLock?: { request: (t: 'screen') => Promise<{ release: () => Promise<void> }> } };
    if (!nav.wakeLock || wakeLock) return;
    wakeLock = await nav.wakeLock.request('screen');
    document.addEventListener('visibilitychange', async () => {
      if (document.visibilityState === 'visible' && nav.wakeLock) wakeLock = await nav.wakeLock.request('screen');
    });
  } catch {
    /* 지원하지 않는 브라우저 */
  }
}

// ---------------------------------------------------------------------------

function JoinForm({ notice, onJoined }: { notice: string | null; onJoined: (s: Session) => void }) {
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [consent, setConsent] = useState(false);
  const [avatar, setAvatar] = useState<AvatarSpec>(() => randomAvatar());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [roomInfo, setRoomInfo] = useState<{ status: string; playerCount: number } | null>(null);
  const roomCode = queryParam('room') ?? '';

  useEffect(() => {
    api.roomPublic().then(setRoomInfo).catch(() => setRoomInfo(null));
  }, []);

  const digits = normalizePhone(phone);
  const phoneOk = PHONE_DIGITS_RE.test(digits);
  const canSubmit = name.trim().length > 0 && phoneOk && consent && !busy;
  const locked = roomInfo && roomInfo.status !== 'LOBBY';

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.join({ phone: digits, name: name.trim(), avatar, consent: true, roomCode: roomCode || undefined });
      onJoined({ token: res.sessionToken, playerId: res.playerId, name: res.name, avatar: res.avatar, roomCode: res.roomCode });
    } catch (e) {
      const err = e as ApiError;
      setError(err.message || '입장에 실패했습니다.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="join form-page">
      <header className="form-header">
        <h1>OX 퀴즈 라이브</h1>
        {roomInfo && (
          <p className="muted">
            {locked ? '이미 시작된 게임입니다. 기존 참가자만 복귀할 수 있습니다.' : `현재 ${roomInfo.playerCount}명 입장`}
          </p>
        )}
      </header>
      {notice && <div className="notice">{notice}</div>}

      <div className="avatar-pick">
        <div className="avatar-frame">
          <Avatar spec={avatar} size={96} />
        </div>
        <button type="button" className="ghost small" onClick={() => setAvatar(randomAvatar())}>
          ↻ 다른 모양
        </button>
      </div>

      <div className="stack">
        <div>
          <label htmlFor="name">이름(별명)</label>
          <input id="name" value={name} maxLength={12} placeholder="스크린에 표시될 이름" autoComplete="nickname" onChange={(e) => setName(e.target.value)} />
        </div>
        <div>
          <label htmlFor="phone">휴대폰 번호</label>
          <input
            id="phone"
            value={phone}
            inputMode="numeric"
            autoComplete="tel"
            placeholder="010-0000-0000"
            onChange={(e) => setPhone(formatPhone(normalizePhone(e.target.value).slice(0, 11)) || e.target.value.replace(/[^\d-]/g, ''))}
          />
          {phone && !phoneOk && <p className="field-error">휴대폰 번호 11자리를 입력해 주세요.</p>}
        </div>
        <label className="consent">
          <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
          <span>
            경품 지급과 본인 확인을 위해 휴대폰 번호를 수집하는 데 동의합니다. 번호는 사회자만 볼 수 있고 행사 후 삭제됩니다.
          </span>
        </label>
        {error && <div className="notice error">{error}</div>}
        <button type="button" className="primary big" disabled={!canSubmit} onClick={submit}>
          {busy ? '입장 중…' : locked ? '자리 복귀하기' : '입장하기'}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function Playing({ view, session, room }: { view: RoomStateForPlayer; session: Session; room: ReturnType<typeof useRoom<RoomStateForPlayer>> }) {
  const remaining = useCountdown(view.status === 'ANSWERING' ? view.deadline : null, room.now);
  const pre = useCountdown(view.status === 'QUESTION_SHOWN' ? view.autoStartAt : null, room.now);
  const lockIn = useCountdown(view.status === 'LOBBY' ? view.lockAt : null, room.now);
  const [pending, setPending] = useState<Choice | null>(null);

  useEffect(() => {
    if (view.me.choice) setPending(null);
  }, [view.me.choice]);
  useEffect(() => {
    if (view.status !== 'ANSWERING') setPending(null);
  }, [view.status]);

  const choose = (c: Choice) => {
    if (!view.canAnswer || !view.question) return;
    navigator.vibrate?.(30);
    setPending(c);
    room.emit(C2S.answerChoose, { index: view.question.index, choice: c });
  };

  const isRevival = view.mode === 'REVIVAL';
  const me = view.me;
  const selected = view.me.choice ?? pending;
  /** 이번 라운드 답변 자격(타이머 시작 전에도 버튼을 보여주되 잠가 둔다) */
  const eligible = me.status === (isRevival ? 'WAITING' : 'ACTIVE');

  const banner = (() => {
    if (view.status === 'LOBBY' || view.status === 'LOCKED' || view.status === 'ENDED') return null;
    if (view.question?.practice) return { cls: 'practice', text: '🎈 맛보기 문제 · 틀려도 탈락하지 않아요' };
    if (me.status === 'WAITING' && isRevival) return { cls: 'revival', text: '🔥 패자부활전! 맞히면 복귀, 틀리면 탈락' };
    if (me.status === 'WAITING') return { cls: 'waiting', text: '대기실 · 관전 중 · 패자부활전을 기다려 주세요' };
    if (me.status === 'ACTIVE' && isRevival) return { cls: 'spectate', text: '패자부활전 진행 중 · 무대 생존자는 관전합니다' };
    if (me.status === 'ACTIVE' && me.strikes > 0) return { cls: 'lastlife', text: `남은 기회 ${Math.max(0, 2 - me.strikes)}회 · 부활자` };
    return null;
  })();

  return (
    <div className="play">
      <header className="play-header">
        <div className="me">
          <Avatar spec={me.avatar} size={40} />
          <span>{me.name}</span>
        </div>
        {view.question && view.status !== 'ENDED' && (
          <span className="qno">
            {isRevival ? '부활전' : `Q${view.question.index + 1}/${view.question.total}`}
          </span>
        )}
      </header>
      {banner && <div className={`banner ${banner.cls}`}>{banner.text}</div>}

      {(view.status === 'LOBBY' || view.status === 'LOCKED') && (
        <section className="screen-center">
          <Avatar spec={me.avatar} size={120} />
          <h2>입장 완료!</h2>
          <p className="muted">현재 {view.playerCount}명 입장</p>
          {lockIn !== null && lockIn > 0 ? (
            <p className="lock-notice">입장 마감까지 {Math.ceil(lockIn / 1000)}초</p>
          ) : (
            <p className="muted">{view.status === 'LOCKED' ? '곧 시작합니다. 스크린을 봐 주세요.' : '사회자가 시작할 때까지 잠시만 기다려 주세요.'}</p>
          )}
        </section>
      )}

      {(view.status === 'QUESTION_SHOWN' || view.status === 'ANSWERING') && view.question && (
        <section className="question">
          <div className="timer-row">
            {view.status === 'ANSWERING' && remaining !== null ? (
              <span className={`timer ${remaining <= 5000 ? 'urgent' : ''}`}>⏱ {Math.ceil(remaining / 1000)}</span>
            ) : pre !== null ? (
              <span className="timer pre">곧 시작 {Math.ceil(pre / 1000)}</span>
            ) : (
              <span className="timer muted">⏱ 대기</span>
            )}
          </div>
          <p className="qtext">{view.question.text}</p>
          {view.question.imageUrl && (
            <img className="qimg" src={view.question.imageUrl} alt="" onError={(e) => (e.currentTarget.style.display = 'none')} />
          )}
          {eligible ? (
            <div className="ox">
              <button type="button" className={`ox-btn o ${selected === 'O' ? 'selected' : ''}`} onClick={() => choose('O')} disabled={!view.canAnswer}>
                O
              </button>
              <button type="button" className={`ox-btn x ${selected === 'X' ? 'selected' : ''}`} onClick={() => choose('X')} disabled={!view.canAnswer}>
                X
              </button>
            </div>
          ) : (
            <div className="spectate-box">
              <p>{me.status === 'WAITING' && !isRevival ? '이번 문제는 답할 수 없습니다.' : '관전 중입니다.'}</p>
              <p className="muted">스크린을 봐 주세요</p>
            </div>
          )}
          {eligible && (
            <p className="ack">
              {view.status !== 'ANSWERING'
                ? pre !== null
                  ? '잠시 후 자동으로 시작됩니다'
                  : '사회자가 타이머를 시작하면 버튼이 열립니다'
                : view.me.choice
                  ? `✓ ${view.me.choice} 선택됨 (마감 전까지 변경 가능)`
                  : pending
                    ? '전송 중…'
                    : 'O 또는 X를 눌러 주세요'}
            </p>
          )}
        </section>
      )}

      {view.status === 'TIME_UP' && (
        <section className="screen-center">
          <h2>⏱ 마감!</h2>
          <p className="muted">결과를 기다려 주세요</p>
          {view.me.choice && <p className={`badge ${view.me.choice.toLowerCase()}`}>내 선택: {view.me.choice}</p>}
          {view.counts && (
            <p className="muted">
              O {view.counts.O}명 · X {view.counts.X}명 · 미응답 {view.counts.none}명
            </p>
          )}
        </section>
      )}

      {view.status === 'REVEALED' && <Result view={view} />}

      {view.status === 'ENDED' && <Ended view={view} myId={session.playerId} />}

      <ChatDrawer room={room} view={view} />
    </div>
  );
}

function Result({ view }: { view: RoomStateForPlayer }) {
  const o = view.myOutcome;
  const answer = view.answer;
  return (
    <section className="screen-center result">
      <p className="muted">정답은</p>
      <div className={`answer-big ${answer === 'O' ? 'o' : 'x'}`}>{answer}</div>
      {view.question?.explanation && <p className="explain">{view.question.explanation}</p>}
      {view.pendingRevival && view.me.status === 'WAITING' && <p className="badge warn">🔥 곧 패자부활전이 열립니다. 준비하세요!</p>}
      {view.finaleAt && view.me.status === 'ACTIVE' && <p className="badge ok">🎉 결승 진출! 잠시 후 발표됩니다</p>}
      {o === null ? (
        <p className="muted">관전 라운드였습니다. 다음 문제를 기다려 주세요.</p>
      ) : o.practice && !o.correct ? (
        <div className="outcome warn">
          <h2>🎈 맛보기라 통과!</h2>
          <p className="muted">다음 문제부터는 틀리면 대기실로 갑니다.</p>
        </div>
      ) : o.correct ? (
        <div className="outcome ok">
          <h2>{o.revived ? '🎉 부활! 무대로 복귀' : '🎉 생존!'}</h2>
          <p className="muted">{o.revived ? '남은 기회 1회. 이제 한 번만 더 틀리면 탈락입니다.' : '다음 문제를 기다려 주세요.'}</p>
        </div>
      ) : o.statusAfter === 'ELIMINATED' ? (
        <div className="outcome bad">
          <h2>😢 탈락</h2>
          <p className="muted">잠시 후 화면이 바뀝니다.</p>
        </div>
      ) : (
        <div className="outcome warn">
          <h2>틀렸습니다 → 대기실로</h2>
          <p className="muted">남은 기회 1회. 패자부활전에서 맞히면 무대로 돌아옵니다.</p>
        </div>
      )}
    </section>
  );
}

function Ended({ view, myId }: { view: RoomStateForPlayer; myId: string }) {
  const winner = view.survivors?.find((p) => p.id === view.winnerId);
  const iWon = view.winnerId === myId;
  const iSurvived = view.survivors?.some((p) => p.id === myId);
  return (
    <section className="screen-center">
      {iWon ? (
        <>
          <div className="crown">👑</div>
          <h2>우승을 축하합니다!</h2>
        </>
      ) : winner ? (
        <>
          <h2>우승자</h2>
          <Avatar spec={winner.avatar} size={96} />
          <p className="winner-name">{winner.name}</p>
        </>
      ) : view.isFinalist ? (
        <>
          <div className="crown">🎉</div>
          <h2>축하합니다! 결승 진출</h2>
          <p className="muted">사회자의 안내에 따라 무대로 나와 주세요. 현장 결승으로 우승자를 정합니다.</p>
        </>
      ) : (
        <>
          <h2>게임 종료</h2>
          <p className="muted">{iSurvived ? '최종 생존! 사회자의 안내에 따라 무대로 나와 주세요.' : '참여해 주셔서 감사합니다.'}</p>
        </>
      )}
      {view.survivors && view.survivors.length > 0 && (
        <div className="survivors">
          <p className="muted">최종 생존자 {view.survivors.length}명</p>
          <div className="row" style={{ justifyContent: 'center' }}>
            {view.survivors.map((p) => (
              <span key={p.id} className="badge">
                {p.name}
              </span>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

function Eliminated({ at, name, avatar, onLeave }: { at: number; name: string; avatar: AvatarSpec; onLeave: () => void }) {
  return (
    <div className="join screen-center eliminated">
      <Avatar spec={avatar} size={110} dim />
      <h1>😢 탈락했습니다</h1>
      <p>
        {name} · {at + 1}번 문제
      </p>
      <p className="muted">끝까지 응원해 주세요! 스크린을 봐 주세요.</p>
      <button type="button" className="ghost small" onClick={onLeave} style={{ marginTop: 32 }}>
        처음 화면으로
      </button>
    </div>
  );
}

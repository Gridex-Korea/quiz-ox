// 대형 스크린. 설계: DOCS/design/screens.md "2. 대형 스크린"
import { useEffect, useMemo, useRef, useState } from 'react';
import confetti from 'canvas-confetti';
import QRCode from 'qrcode';
import { S2C, type Choice, type Outcome, type PublicPlayer, type RoomStateForScreen } from '@ox/shared';
import { Avatar } from '../shared/Avatar';
import { isSoundEnabled, play, unlockSound } from '../shared/sounds';
import { loadJson, queryParam, saveJson } from '../shared/storage';
import { useCountdown, useRoom } from '../shared/socket';
import { QUESTION_IMAGE_RECT, STAGE_H, STAGE_W, SlotAllocator, ZONES, hash, positionsFor, zoneOf, zoneRects, type RevealPhase, type Slot, type ZoneKey, type ZoneName } from './layout';
import './screen.css';

const KEY_STORAGE = 'ox.screenKey';

export function ScreenApp() {
  const [key, setKey] = useState<string | null>(() => queryParam('key') ?? loadJson<string>(KEY_STORAGE));
  useEffect(() => {
    if (key) saveJson(KEY_STORAGE, key);
  }, [key]);
  const auth = useMemo(() => (key ? { role: 'screen', key } : null), [key]);
  const room = useRoom<RoomStateForScreen>(auth);

  useEffect(() => {
    if (room.status === 'error' && room.error === 'invalid_key') setKey(null);
  }, [room.status, room.error]);

  if (!key) return <KeyPrompt onSubmit={setKey} />;
  return (
    <ScaledStage>
      {room.view ? <Stage view={room.view} room={room} /> : <div className="screen-msg">{room.status === 'error' ? `연결 오류: ${room.error}` : '연결 중…'}</div>}
      {room.status === 'disconnected' && <div className="disconnected">연결이 끊겼습니다. 다시 연결 중…</div>}
    </ScaledStage>
  );
}

function KeyPrompt({ onSubmit }: { onSubmit: (k: string) => void }) {
  const [v, setV] = useState('');
  return (
    <div className="host-login" style={{ minHeight: '100dvh', display: 'grid', placeItems: 'center' }}>
      <div className="card stack" style={{ width: 360 }}>
        <h1 style={{ margin: 0, fontSize: 22 }}>🖥️ 스크린 키</h1>
        <p className="muted" style={{ margin: 0 }}>서버 환경변수 SCREEN_KEY 값을 입력하세요. 이 브라우저에 저장됩니다.</p>
        <input type="password" value={v} autoFocus onChange={(e) => setV(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && v && onSubmit(v)} />
        <button className="primary" disabled={!v} onClick={() => onSubmit(v)}>
          스크린 시작
        </button>
      </div>
    </div>
  );
}

/** 1920×1080 무대를 창 크기에 맞춰 축소·확대 */
function ScaledStage({ children }: { children: React.ReactNode }) {
  const [scale, setScale] = useState(1);
  useEffect(() => {
    const update = () => setScale(Math.min(window.innerWidth / STAGE_W, window.innerHeight / STAGE_H));
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);
  return (
    <div className="screen-root">
      <div className="stage" style={{ width: STAGE_W, height: STAGE_H, transform: `translate(-50%, -50%) scale(${scale})` }}>
        {children}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

interface Leaving {
  player: PublicPlayer;
  slot: Slot;
  until: number;
}

function Stage({ view, room }: { view: RoomStateForScreen; room: ReturnType<typeof useRoom<RoomStateForScreen>> }) {
  const [phase, setPhase] = useState<RevealPhase>('none');
  const [countsVisible, setCountsVisible] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const [leaving, setLeaving] = useState<Leaving[]>([]);
  const [sound, setSound] = useState(isSoundEnabled());
  const allocRef = useRef(new SlotAllocator());
  const lastSlots = useRef(new Map<string, Slot>());
  const lastTick = useRef<number>(-1);
  const lastPre = useRef<number>(-1);
  const remaining = useCountdown(view.status === 'ANSWERING' ? view.deadline : null, room.now);
  const pre = useCountdown(view.status === 'QUESTION_SHOWN' ? view.autoStartAt : null, room.now);

  // 카운트다운 마지막 5초 틱
  useEffect(() => {
    if (remaining === null) return;
    const sec = Math.ceil(remaining / 1000);
    if (sec <= 5 && sec > 0 && sec !== lastTick.current) {
      lastTick.current = sec;
      play('tick');
    }
  }, [remaining]);

  // 자동 시작 준비 카운트(3·2·1) 틱
  useEffect(() => {
    if (pre === null) {
      lastPre.current = -1;
      return;
    }
    const sec = Math.ceil(pre / 1000);
    if (sec > 0 && sec !== lastPre.current) {
      lastPre.current = sec;
      play('tick');
    }
  }, [pre]);

  // 이벤트 기반 연출
  useEffect(() => {
    const offs = [
      room.on(S2C.questionShow, (p) => {
        setPhase('none');
        setCountsVisible(false);
        setFlash(null);
        if ((p as { mode: string }).mode === 'REVIVAL') play('swap');
      }),
      room.on(S2C.questionStart, () => {
        lastTick.current = -1;
        setCountsVisible(false);
      }),
      room.on(S2C.questionTimeup, () => {
        play('timeup');
        setFlash('마감!');
        setTimeout(() => setFlash(null), 1200);
        // 숨김 모드였다면 일제 이동(1.2초) 뒤에 숫자 공개
        setTimeout(() => setCountsVisible(true), view.liveMoves ? 300 : 1400);
      }),
      room.on(S2C.questionReveal, (p) => {
        const payload = p as { outcomes: Outcome[]; answer: Choice };
        setPhase('hold');
        const anyWrong = payload.outcomes.some((o) => !o.correct);
        const anyElim = payload.outcomes.some((o) => o.statusAfter === 'ELIMINATED');
        const anyRevived = payload.outcomes.some((o) => o.revived);
        play(anyRevived ? 'revive' : 'correct');
        if (anyWrong) setTimeout(() => play(anyElim ? 'eliminated' : 'wrong'), 500);
        burst(payload.answer === 'O' ? 0.18 : 0.82);
        setTimeout(() => {
          setPhase('none');
          // 탈락자는 잠시 남아 사라지는 연출
          const gone = payload.outcomes.filter((o) => o.statusAfter === 'ELIMINATED');
          if (gone.length) {
            const until = Date.now() + 1600;
            const additions: Leaving[] = [];
            for (const o of gone) {
              const player = view.players.find((pl) => pl.id === o.playerId);
              const slot = lastSlots.current.get(o.playerId);
              if (player && slot) additions.push({ player: { ...player, status: 'ELIMINATED' }, slot, until });
            }
            setLeaving((cur) => [...cur, ...additions]);
            setTimeout(() => setLeaving((cur) => cur.filter((l) => l.until > Date.now())), 1700);
          }
        }, 1600);
      }),
      room.on(S2C.playerJoined, () => play('join')),
      room.on(S2C.gameWinner, () => {
        play('fanfare');
        burst(0.5, 200);
        setTimeout(() => burst(0.3, 120), 400);
        setTimeout(() => burst(0.7, 120), 800);
      }),
      room.on(S2C.gameEnded, (p) => {
        // 결승 진출자 축하 화면이면 팡파르 + 색종이
        const survivors = (p as { survivors: unknown[] }).survivors;
        if (survivors.length > 0 && survivors.length <= 3) {
          play('fanfare');
          burst(0.25, 160);
          setTimeout(() => burst(0.75, 160), 350);
        }
      }),
      room.on(S2C.roundUndone, () => {
        setPhase('none');
        setLeaving([]);
      }),
      room.on(S2C.roomReset, () => allocRef.current.reset()),
    ];
    return () => offs.forEach((off) => off());
  }, [room, view.liveMoves, view.players]);

  // 마감 이후·공개 상태로 새로 접속했을 때는 연출 없이 숫자를 바로 보여준다
  useEffect(() => {
    if (view.status === 'TIME_UP' || view.status === 'REVEALED') setCountsVisible(true);
  }, [view.status]);

  // ---- 배치 계산 ----
  const inRoundNow = ['QUESTION_SHOWN', 'ANSWERING', 'TIME_UP', 'REVEALED'].includes(view.status);
  const questionImage = inRoundNow ? view.question?.imageUrl ?? null : null;
  const { slots, dims } = useMemo(() => {
    const byZone = new Map<ZoneKey, string[]>();
    for (const p of view.players) {
      const z = zoneOf(p, view, phase);
      if (z === 'hidden') continue;
      const arr = byZone.get(z) ?? [];
      arr.push(p.id);
      byZone.set(z, arr);
    }
    const rects = zoneRects(!!questionImage);
    const slots = new Map<string, Slot>();
    for (const zone of Object.keys(ZONES) as ZoneName[]) {
      const members = byZone.get(zone) ?? [];
      const seats = allocRef.current.assign(zone, members);
      for (const [id, s] of positionsFor(zone, seats, zone === 'strip', rects[zone])) slots.set(id, s);
    }
    const dims = new Set<string>();
    if (view.status === 'REVEALED' && view.outcomes) for (const o of view.outcomes) if (!o.correct) dims.add(o.playerId);
    return { slots, dims };
  }, [view, phase, questionImage]);

  useEffect(() => {
    for (const [id, s] of slots) lastSlots.current.set(id, s);
  }, [slots]);

  const isRevival = view.mode === 'REVIVAL';
  const inRound = ['QUESTION_SHOWN', 'ANSWERING', 'TIME_UP', 'REVEALED'].includes(view.status);
  const eligibleStatus = isRevival ? 'WAITING' : 'ACTIVE';
  const stripPlayers = view.players.filter((p) => p.status !== 'ELIMINATED' && p.status !== eligibleStatus);
  const stageCounts = {
    active: view.players.filter((p) => p.status === 'ACTIVE').length,
    waiting: view.players.filter((p) => p.status === 'WAITING').length,
    eliminated: view.players.filter((p) => p.status === 'ELIMINATED').length,
  };
  const showZones = inRound;
  const winner = view.winnerId ? view.players.find((p) => p.id === view.winnerId) : undefined;

  return (
    <>
      {/* 상단 */}
      <header className="s-header">
        <div className="s-title">
          <span className="logo">OX 퀴즈 라이브</span>
          {view.question && inRound && (
            <span className="qno">{isRevival ? '🔥 패자부활전' : `Q${view.question.index + 1} / ${view.question.total}`}</span>
          )}
        </div>
        <div className="s-question">
          {inRound && view.question ? view.question.text : view.status === 'ENDED' ? '게임 종료' : ''}
        </div>
        <div className="s-timer">
          {view.status === 'ANSWERING' && remaining !== null && (
            <span className={remaining <= 5000 ? 'urgent' : ''}>⏱ {String(Math.ceil(remaining / 1000)).padStart(2, '0')}</span>
          )}
          {view.status === 'QUESTION_SHOWN' &&
            (pre !== null && pre > 0 ? <span className="pre">{Math.ceil(pre / 1000)}</span> : <span className="muted">⏱ 준비</span>)}
          {view.status === 'TIME_UP' && <span className="done">마감</span>}
          {view.status === 'REVEALED' && view.answer && <span className={`answer ${view.answer === 'O' ? 'o' : 'x'}`}>정답 {view.answer}</span>}
        </div>
      </header>

      {/* 안내 자막 */}
      {inRound && isRevival && view.status !== 'REVEALED' && (
        <div className="s-banner revival">🔥 패자부활전 · 대기실 {stageCounts.waiting}명 도전 · 맞히면 무대 복귀, 틀리면 탈락</div>
      )}
      {inRound && !isRevival && !view.liveMoves && view.status !== 'REVEALED' && <div className="s-banner hidden-mode">🙈 이번 문제부터 선택은 마감 후 공개됩니다</div>}
      {view.status === 'REVEALED' && view.pendingRevival && (
        <div className="s-banner revival">🔥 무대 생존자 {stageCounts.active}명! 잠시 후 패자부활전이 시작됩니다</div>
      )}
      {view.status === 'REVEALED' && view.finaleAt && !view.pendingRevival && (
        <div className="s-banner finale">🎉 결승 진출자 확정! 잠시 후 발표합니다</div>
      )}
      {view.status === 'REVEALED' && view.question?.explanation && !view.pendingRevival && !view.finaleAt && <div className="s-banner explain">{view.question.explanation}</div>}

      {/* 사진 문제 */}
      {questionImage && (
        <div className="qimage-frame" style={rectStyle(QUESTION_IMAGE_RECT)}>
          <img className="qimage" src={questionImage} alt="" />
        </div>
      )}

      {/* 구역 */}
      {showZones && (
        <>
          <Zone rect={ZONES.O} cls={`zone o ${view.status === 'REVEALED' ? (view.answer === 'O' ? 'correct' : 'wrong') : ''}`} label="O" count={countsVisible && view.counts ? view.counts.O : null} />
          <Zone rect={ZONES.center} cls="zone center" label="" count={countsVisible && view.counts && view.counts.none > 0 ? view.counts.none : null} countLabel="미응답" />
          <Zone rect={ZONES.X} cls={`zone x ${view.status === 'REVEALED' ? (view.answer === 'X' ? 'correct' : 'wrong') : ''}`} label="X" count={countsVisible && view.counts ? view.counts.X : null} />
        </>
      )}
      {(inRound || view.status === 'ENDED') && (
        <div className="strip" style={rectStyle(ZONES.strip)}>
          <span className="strip-label">
            {view.status === 'ENDED' ? `대기실·탈락 ${stageCounts.waiting + stageCounts.eliminated}명` : isRevival ? `생존자석 ${stripPlayers.length}명` : `대기실 ${stripPlayers.length}명`}
          </span>
        </div>
      )}

      {/* 로비 */}
      {(view.status === 'LOBBY' || view.status === 'LOCKED') && <LobbyPanel view={view} />}

      {/* 아바타 */}
      <div className="sprites">
        {view.players.map((p) => {
          const slot = slots.get(p.id);
          if (!slot) return null;
          const dim = dims.has(p.id) || !p.connected;
          const isWinner = winner?.id === p.id;
          return (
            <Sprite key={p.id} player={p} slot={slot} dim={dim} winner={isWinner} showCheck={!view.liveMoves && view.status === 'ANSWERING' && !!p.hasAnswered} />
          );
        })}
        {leaving.map((l) => (
          <Sprite key={`leaving-${l.player.id}`} player={l.player} slot={l.slot} dim leaving />
        ))}
      </div>

      {/* 오버레이 */}
      {flash && <div className="flash">{flash}</div>}
      {view.status === 'ENDED' && <EndedPanel view={view} winner={winner} />}
      {view.status === 'REVEALED' && (
        <div className="s-footer">
          생존 {stageCounts.active}명 · 대기실 {stageCounts.waiting}명 · 탈락 {stageCounts.eliminated}명
        </div>
      )}

      <button
        className={`sound-toggle ${sound ? 'on' : ''}`}
        onClick={async () => {
          const ok = await unlockSound();
          setSound(ok);
        }}
        title="효과음"
      >
        {sound ? '🔊 사운드 켜짐' : '🔇 사운드 켜기'}
      </button>
    </>
  );
}

function rectStyle(r: { x: number; y: number; w: number; h: number }): React.CSSProperties {
  return { left: r.x, top: r.y, width: r.w, height: r.h };
}

function Zone({ rect, cls, label, count, countLabel }: { rect: { x: number; y: number; w: number; h: number }; cls: string; label: string; count: number | null; countLabel?: string }) {
  return (
    <div className={cls} style={rectStyle(rect)}>
      {label && <span className="zone-label">{label}</span>}
      {count !== null && (
        <span className="zone-count">
          {countLabel ? `${countLabel} ` : ''}
          {count}명
        </span>
      )}
    </div>
  );
}

function Sprite({ player, slot, dim, winner, showCheck, leaving }: { player: PublicPlayer; slot: Slot; dim: boolean; winner?: boolean; showCheck?: boolean; leaving?: boolean }) {
  const h = hash(player.id);
  const style: React.CSSProperties & Record<string, string | number> = {
    transform: `translate(${slot.x - slot.size / 2}px, ${slot.y - slot.size / 2}px)`,
    width: slot.size,
    '--dx1': `${(h % 11) - 5}px`,
    '--dy1': `${((h >> 3) % 9) - 4}px`,
    '--dx2': `${((h >> 6) % 11) - 5}px`,
    '--dy2': `${((h >> 9) % 9) - 4}px`,
    '--dx3': `${((h >> 12) % 11) - 5}px`,
    '--dy3': `${((h >> 15) % 9) - 4}px`,
    '--drift-dur': `${5 + (h % 5)}s`,
    '--bob-dur': `${1.1 + ((h >> 4) % 6) / 10}s`,
  };
  return (
    <div className={`sprite ${leaving ? 'leaving' : ''} ${winner ? 'winner' : ''}`} style={style}>
      <div className="drift">
        <div className="bob">
          {winner && <div className="crown">👑</div>}
          {showCheck && <div className="check">✓</div>}
          {leaving && <div className="out-tag">탈락</div>}
          <Avatar spec={player.avatar} size={slot.size} dim={dim} />
          <div className="name" style={{ fontSize: Math.max(12, slot.size * 0.24) }}>
            {player.name}
            {!player.connected && !leaving ? ' ⚡' : ''}
          </div>
        </div>
      </div>
    </div>
  );
}

function LobbyPanel({ view }: { view: RoomStateForScreen }) {
  const [qr, setQr] = useState<string | null>(null);
  useEffect(() => {
    QRCode.toDataURL(view.joinUrl, { width: 420, margin: 1, color: { dark: '#0f172a', light: '#ffffff' } }).then(setQr).catch(() => setQr(null));
  }, [view.joinUrl]);
  const url = view.joinUrl.replace(/^https?:\/\//, '');
  return (
    <div className="lobby">
      <div className="lobby-card">
        {qr ? <img src={qr} alt="참가 QR" width={300} height={300} /> : <div className="qr-placeholder" />}
        <div className="lobby-text">
          <h2>QR을 스캔해 입장하세요</h2>
          <p className="url">{url}</p>
          <p className="muted">이름(별명)과 휴대폰 번호를 입력하면 아바타가 무대에 나타납니다</p>
          <p className="count">
            입장 <strong>{view.players.length}</strong>명{view.status === 'LOCKED' && <span className="locked"> · 입장 마감 · 곧 시작합니다</span>}
          </p>
        </div>
      </div>
    </div>
  );
}

function EndedPanel({ view, winner }: { view: RoomStateForScreen; winner?: PublicPlayer }) {
  const survivors = view.players.filter((p) => p.status === 'ACTIVE');
  if (view.finalists) {
    return (
      <div className="finale-panel">
        <div className="finale-title">🎉 축하합니다!</div>
        <div className="finale-sub">현장 결승 진출 {view.finalists.length}명 · 무대로 나와 주세요</div>
        <div className="finale-cards">
          {view.finalists.map((f) => (
            <div key={f.id} className={`finale-card ${winner?.id === f.id ? 'winner' : ''}`}>
              {winner?.id === f.id && <div className="finale-crown">👑 우승</div>}
              <Avatar spec={f.avatar} size={150} />
              <div className="finale-name">{f.name}</div>
              <div className="finale-phone">{f.phoneTail ? `뒷번호 ${f.phoneTail}` : '번호 없음'}</div>
            </div>
          ))}
        </div>
      </div>
    );
  }
  return (
    <div className="ended">
      {winner ? (
        <>
          <div className="ended-title">👑 우승</div>
          <div className="ended-winner">{winner.name}</div>
        </>
      ) : (
        <>
          <div className="ended-title">최종 생존자 {survivors.length}명</div>
          <div className="ended-names">{survivors.map((p) => p.name).join(' · ')}</div>
          {survivors.length > 1 && <div className="muted">무대로 나와 결승을 진행해 주세요</div>}
        </>
      )}
    </div>
  );
}

function burst(x: number, count = 140) {
  try {
    confetti({ particleCount: count, spread: 80, origin: { x, y: 0.4 }, zIndex: 50, disableForReducedMotion: true });
  } catch {
    /* 무시 */
  }
}

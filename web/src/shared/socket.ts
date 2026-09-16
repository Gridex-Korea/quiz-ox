// Socket.IO 연결과 room:state 동기화 훅. 서버가 보내는 상태를 그대로 그리고, 답변 이동 같은 델타만 얹는다.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import { S2C, type PublicPlayer } from '@ox/shared';

export type ConnStatus = 'idle' | 'connecting' | 'connected' | 'disconnected' | 'error';

type Listener = (payload: unknown) => void;

export interface RoomConnection<TView> {
  view: TView | null;
  status: ConnStatus;
  /** connect_error 의 메시지: invalid_token, eliminated, invalid_key, invalid_host ... */
  error: string | null;
  emit: (event: string, payload?: unknown) => void;
  /** 애니메이션·효과음용 이벤트 구독. 반환값을 호출하면 해제 */
  on: (event: string, handler: Listener) => () => void;
  /** 서버 시각 추정 */
  now: () => number;
  reconnect: () => void;
}

interface WithPlayers {
  players: PublicPlayer[];
}
interface WithMe {
  me: PublicPlayer;
}

function hasPlayers(v: unknown): v is WithPlayers {
  return !!v && Array.isArray((v as WithPlayers).players);
}
function hasMe(v: unknown): v is WithMe {
  return !!v && typeof (v as WithMe).me === 'object';
}

/** room:state 사이에 도착하는 델타를 뷰에 반영한다 */
function applyDelta<TView>(view: TView, event: string, payload: unknown): TView {
  const p = payload as Record<string, unknown>;
  if (hasPlayers(view)) {
    const update = (id: string, fn: (pl: PublicPlayer) => PublicPlayer) => ({
      ...view,
      players: view.players.map((pl) => (pl.id === id ? fn(pl) : pl)),
    }) as TView;
    switch (event) {
      case S2C.answerMoved:
        return update(String(p['playerId']), (pl) => ({ ...pl, choice: p['choice'] as PublicPlayer['choice'], hasAnswered: true }));
      case S2C.answerLocked:
        return update(String(p['playerId']), (pl) => ({ ...pl, hasAnswered: true }));
      case S2C.playerConnection:
        return update(String(p['playerId']), (pl) => ({ ...pl, connected: Boolean(p['connected']) }));
      case S2C.playerJoined: {
        const player = p['player'] as PublicPlayer;
        if (view.players.some((pl) => pl.id === player.id)) return view;
        return { ...view, players: [...view.players, player] } as TView;
      }
      case S2C.questionTimeup: {
        const choices = p['choices'] as { playerId: string; choice: PublicPlayer['choice'] }[] | undefined;
        if (!choices) return view;
        const byId = new Map(choices.map((c) => [c.playerId, c.choice]));
        return { ...view, players: view.players.map((pl) => (byId.has(pl.id) ? { ...pl, choice: byId.get(pl.id), hasAnswered: true } : pl)) } as TView;
      }
      case S2C.questionStart:
      case S2C.questionExtended:
        return { ...view, deadline: p['deadline'] } as TView;
      default:
        return view;
    }
  }
  if (hasMe(view)) {
    switch (event) {
      case S2C.answerAck:
        return { ...view, me: { ...view.me, choice: p['choice'] as PublicPlayer['choice'] } } as TView;
      case S2C.questionStart:
      case S2C.questionExtended:
        return { ...view, deadline: p['deadline'] } as TView;
      default:
        return view;
    }
  }
  return view;
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? 0;
};

/**
 * auth 가 null 이면 연결하지 않는다. auth 객체의 내용이 바뀌면 재연결한다.
 */
export function useRoom<TView>(auth: Record<string, unknown> | null): RoomConnection<TView> {
  const [view, setView] = useState<TView | null>(null);
  const [status, setStatus] = useState<ConnStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const socketRef = useRef<Socket | null>(null);
  const listeners = useRef(new Map<string, Set<Listener>>());
  const offsetRef = useRef(0);
  const authKey = auth ? JSON.stringify(auth) : null;

  useEffect(() => {
    if (!authKey) {
      setStatus('idle');
      return;
    }
    const parsedAuth = JSON.parse(authKey) as Record<string, unknown>;
    const socket = io({
      auth: parsedAuth,
      autoConnect: false,
      reconnection: true,
      reconnectionDelay: 500,
      reconnectionDelayMax: 5000,
      timeout: 10_000,
    });
    socketRef.current = socket;
    setStatus('connecting');
    setError(null);

    const samples: number[] = [];
    const ping = () => {
      socket.emit('time:ping', { clientSent: Date.now() });
    };
    let pingTimer: ReturnType<typeof setInterval> | null = null;

    socket.on('connect', () => {
      setStatus('connected');
      setError(null);
      samples.length = 0;
      for (let i = 0; i < 5; i++) setTimeout(ping, i * 150);
      if (pingTimer) clearInterval(pingTimer);
      pingTimer = setInterval(ping, 30_000);
    });
    socket.on('disconnect', () => setStatus('disconnected'));
    socket.on('connect_error', (e: Error) => {
      setStatus('error');
      setError(e.message);
      // 인증 실패는 재시도해도 소용없다
      if (['invalid_token', 'eliminated', 'invalid_key', 'invalid_host', 'invalid_role'].includes(e.message)) socket.disconnect();
    });
    socket.on(S2C.timePong, (p: { clientSent: number; serverNow: number }) => {
      const nowMs = Date.now();
      const rtt = nowMs - p.clientSent;
      samples.push(p.serverNow + rtt / 2 - nowMs);
      if (samples.length > 9) samples.shift();
      offsetRef.current = median(samples);
    });
    socket.on(S2C.roomState, (v: TView) => setView(v));
    socket.onAny((event: string, payload: unknown) => {
      if (event !== S2C.roomState) setView((cur) => (cur ? applyDelta(cur, event, payload) : cur));
      const set = listeners.current.get(event);
      if (set) for (const fn of set) fn(payload);
    });
    socket.connect();

    return () => {
      if (pingTimer) clearInterval(pingTimer);
      socket.removeAllListeners();
      socket.disconnect();
      socketRef.current = null;
    };
  }, [authKey]);

  const emit = useCallback((event: string, payload?: unknown) => {
    socketRef.current?.emit(event, payload);
  }, []);

  const on = useCallback((event: string, handler: Listener) => {
    const set = listeners.current.get(event) ?? new Set<Listener>();
    set.add(handler);
    listeners.current.set(event, set);
    return () => {
      set.delete(handler);
    };
  }, []);

  const now = useCallback(() => Date.now() + offsetRef.current, []);
  const reconnect = useCallback(() => {
    socketRef.current?.connect();
  }, []);

  return useMemo(() => ({ view, status, error, emit, on, now, reconnect }), [view, status, error, emit, on, now, reconnect]);
}

/** 남은 시간(ms)을 100ms 간격으로 갱신 */
export function useCountdown(deadline: number | null | undefined, now: () => number): number | null {
  const [remaining, setRemaining] = useState<number | null>(null);
  useEffect(() => {
    if (!deadline) {
      setRemaining(null);
      return;
    }
    const tick = () => setRemaining(Math.max(0, deadline - now()));
    tick();
    const t = setInterval(tick, 100);
    return () => clearInterval(t);
  }, [deadline, now]);
  return remaining;
}

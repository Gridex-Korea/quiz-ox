// Socket.IO 게이트웨이: 인증, 룸 배정, 이벤트 검증, 역할별 room:state 전송. 프로토콜: DOCS/design/realtime-protocol.md
import { createHash } from 'node:crypto';
import type { Server, Socket } from 'socket.io';
import {
  C2S,
  S2C,
  answerChooseSchema,
  extendTimerSchema,
  playerIdSchema,
  questionDeleteSchema,
  questionInputSchema,
  questionsReplaceSchema,
  resetRoomSchema,
  showQuestionSchema,
  startRevivalSchema,
  startTimerSchema,
  timePingSchema,
  updateConfigSchema,
} from '@ox/shared';
import type { ZodType } from 'zod';
import type { Command, Target } from '../engine/reducer';
import { hostView, playerView, screenView } from '../engine/views';
import type { Emitter, GameService } from '../game';
import type { HostTokens } from './hostTokens';

type Role = 'player' | 'screen' | 'host';

interface SocketData {
  role: Role;
  playerId?: string;
}

export interface GatewayDeps {
  screenKey: string;
  hostTokens: HostTokens;
  joinUrl: () => string;
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function createGateway(io: Server, game: GameService, deps: GatewayDeps): Emitter {
  const playerSockets = new Map<string, Socket>();

  const targetRooms = (t: Target): string[] => {
    switch (t) {
      case 'players':
        return ['players'];
      case 'screen':
        return ['screen'];
      case 'host':
        return ['host'];
      case 'screenHost':
        return ['screen', 'host'];
      case 'all':
      default:
        return [];
    }
  };

  const emitter: Emitter = {
    toTarget(target, event, payload) {
      const rooms = targetRooms(target);
      if (rooms.length === 0) io.emit(event, payload);
      else io.to(rooms).emit(event, payload);
    },
    toPlayer(playerId, event, payload) {
      io.to(`p:${playerId}`).emit(event, payload);
    },
    toEachPlayer(event, payloadFor) {
      for (const [playerId, socket] of playerSockets) socket.emit(event, payloadFor(playerId));
    },
    disconnectPlayer(playerId) {
      const s = playerSockets.get(playerId);
      if (s) s.disconnect(true);
    },
    pushViews() {
      const now = game.now();
      const url = deps.joinUrl();
      for (const [playerId, socket] of [...playerSockets]) {
        const view = playerView(game.state, playerId, now);
        if (!view) {
          // 방이 초기화되어 참가자가 사라진 경우
          socket.emit(S2C.roomReset, { roomCode: game.state.room.code });
          socket.disconnect(true);
          continue;
        }
        socket.emit(S2C.roomState, view);
      }
      io.to('screen').emit(S2C.roomState, screenView(game.state, now, url));
      io.to('host').emit(S2C.roomState, hostView(game.state, now, url));
    },
  };

  // ---- 인증 ----
  io.use((socket, next) => {
    const auth = (socket.handshake.auth ?? {}) as Record<string, unknown>;
    const role = auth['role'];
    const data = socket.data as SocketData;
    if (role === 'player') {
      const token = auth['token'];
      if (typeof token !== 'string' || token.length < 16) return next(new Error('invalid_token'));
      const hash = hashToken(token);
      const player = Object.values(game.state.players).find((p) => p.sessionTokenHash === hash);
      if (!player) return next(new Error('invalid_token'));
      if (player.status === 'ELIMINATED') return next(new Error('eliminated'));
      data.role = 'player';
      data.playerId = player.id;
      return next();
    }
    if (role === 'screen') {
      if (auth['key'] !== deps.screenKey) return next(new Error('invalid_key'));
      data.role = 'screen';
      return next();
    }
    if (role === 'host') {
      if (!deps.hostTokens.verify(auth['token'])) return next(new Error('invalid_host'));
      data.role = 'host';
      return next();
    }
    return next(new Error('invalid_role'));
  });

  io.on('connection', (socket) => {
    const data = socket.data as SocketData;
    const now = game.now();
    const url = deps.joinUrl();

    socket.on(C2S.timePing, (raw: unknown) => {
      const p = timePingSchema.safeParse(raw);
      if (!p.success) return;
      socket.emit(S2C.timePong, { clientSent: p.data.clientSent, serverNow: game.now() });
    });

    if (data.role === 'player' && data.playerId) {
      const playerId = data.playerId;
      const prev = playerSockets.get(playerId);
      if (prev && prev.id !== socket.id) {
        prev.emit(S2C.sessionReplaced, {});
        prev.disconnect(true);
      }
      playerSockets.set(playerId, socket);
      socket.join(['players', `p:${playerId}`]);
      game.dispatch({ type: 'setConnected', playerId, connected: true });
      const view = playerView(game.state, playerId, now);
      if (view) socket.emit(S2C.roomState, view);

      socket.on(C2S.answerChoose, (raw: unknown) => {
        const p = answerChooseSchema.safeParse(raw);
        if (process.env['OX_DEBUG']) console.log(`[ox] answer:choose from ${playerId}`, JSON.stringify(raw), p.success ? 'valid' : 'invalid');
        if (!p.success) return;
        game.dispatch({ type: 'choose', playerId, index: p.data.index, choice: p.data.choice });
      });

      socket.on('disconnect', () => {
        if (playerSockets.get(playerId) === socket) {
          playerSockets.delete(playerId);
          if (game.state.players[playerId]) game.dispatch({ type: 'setConnected', playerId, connected: false });
        }
      });
      return;
    }

    if (data.role === 'screen') {
      socket.join('screen');
      socket.emit(S2C.roomState, screenView(game.state, now, url));
      return;
    }

    if (data.role === 'host') {
      socket.join('host');
      socket.emit(S2C.roomState, hostView(game.state, now, url));
      for (const a of game.bootAlerts) socket.emit(S2C.hostAlert, a);
      game.bootAlerts.length = 0;

      const handle = <T>(event: string, schema: ZodType<T> | null, toCommand: (payload: T) => Command) => {
        socket.on(event, (raw: unknown) => {
          let payload: T;
          if (schema) {
            const parsed = schema.safeParse(raw ?? {});
            if (!parsed.success) {
              socket.emit(S2C.hostAlert, { level: 'error', message: `잘못된 요청입니다 (${event}).` });
              return;
            }
            payload = parsed.data;
          } else payload = undefined as T;
          const r = game.dispatch(toCommand(payload));
          if (r.error) socket.emit(S2C.hostAlert, { level: 'error', message: game.errorMessage(r.error) });
        });
      };

      handle(C2S.hostLock, null, () => ({ type: 'lock' }));
      handle(C2S.hostUnlock, null, () => ({ type: 'unlock' }));
      handle(C2S.hostShowQuestion, showQuestionSchema, (p) => ({ type: 'showQuestion', index: p.index, mode: p.mode }));
      handle(C2S.hostStartTimer, startTimerSchema, (p) => ({ type: 'startTimer', seconds: p.seconds }));
      handle(C2S.hostExtendTimer, extendTimerSchema, (p) => ({ type: 'extendTimer', seconds: p.seconds }));
      handle(C2S.hostEndTimerNow, null, () => ({ type: 'endTimerNow' }));
      handle(C2S.hostReveal, null, () => ({ type: 'reveal' }));
      handle(C2S.hostUndoReveal, null, () => ({ type: 'undoReveal' }));
      handle(C2S.hostCancelRound, null, () => ({ type: 'cancelRound' }));
      handle(C2S.hostNext, null, () => ({ type: 'next' }));
      handle(C2S.hostEnd, null, () => ({ type: 'end' }));
      handle(C2S.hostStartRevival, startRevivalSchema, (p) => ({ type: 'startRevival', index: p.index, force: p.force }));
      handle(C2S.hostRestore, playerIdSchema, (p) => ({ type: 'restore', playerId: p.playerId }));
      handle(C2S.hostKick, playerIdSchema, (p) => ({ type: 'kick', playerId: p.playerId }));
      handle(C2S.hostRemovePlayer, playerIdSchema, (p) => ({ type: 'removePlayer', playerId: p.playerId }));
      handle(C2S.hostSetWinner, playerIdSchema, (p) => ({ type: 'setWinner', playerId: p.playerId }));
      handle(C2S.hostUpdateConfig, updateConfigSchema, (p) => ({ type: 'updateConfig', patch: p }));
      handle(C2S.hostQuestionsReplace, questionsReplaceSchema, (p) => ({ type: 'questionsReplace', questions: p.questions }));
      handle(C2S.hostQuestionUpsert, questionInputSchema, (p) => ({ type: 'questionUpsert', question: p }));
      handle(C2S.hostQuestionDelete, questionDeleteSchema, (p) => ({ type: 'questionDelete', id: p.id }));
      handle(C2S.hostResetRoom, resetRoomSchema, (p) => ({ type: 'resetRoom', keepQuestions: p.keepQuestions }));
      return;
    }
  });

  return emitter;
}

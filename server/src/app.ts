// 서버 조립. index.ts(실행)와 통합 테스트가 같이 쓴다.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { Server as IOServer } from 'socket.io';
import type { RoomState } from '@ox/shared';
import { createInitialState } from './engine/state';
import { GameService } from './game';
import { registerRoutes } from './http/routes';
import { Store } from './store/db';
import { createSnapshotter, restoreFromGcs, type Snapshotter } from './store/gcs';
import { createGateway } from './ws/gateway';
import { HostTokens } from './ws/hostTokens';

export interface AppOptions {
  dbPath: string | null;
  hostPin: string;
  screenKey: string;
  publicUrl: string;
  webDist: string | null;
  retentionDays: number;
  hostTokenTtlMs: number;
  logger?: boolean;
  initialState?: RoomState;
  /** 설정 시 SQLite 스냅샷을 이 버킷에 복사하고 기동 시 복원한다 */
  gcsBucket?: string;
}

export interface App {
  fastify: FastifyInstance;
  io: IOServer;
  game: GameService;
  store: Store | null;
  close: () => Promise<void>;
}

export async function buildApp(opts: AppOptions): Promise<App> {
  const fastify = Fastify({ logger: opts.logger ?? false, trustProxy: true, bodyLimit: 2 * 1024 * 1024 });
  const info = (m: string) => fastify.log.info(m);
  const useGcs = !!opts.gcsBucket && !!opts.dbPath && opts.dbPath !== ':memory:';
  if (useGcs) await restoreFromGcs(opts.gcsBucket!, opts.dbPath!, info);
  const store = opts.dbPath ? new Store(opts.dbPath) : null;
  let snapshotter: Snapshotter | null = null;
  if (useGcs && store) {
    snapshotter = createSnapshotter(opts.gcsBucket!, (p) => store.copyTo(p), opts.dbPath!, info);
    store.onSaved = () => snapshotter?.schedule();
    info(`GCS 스냅샷 활성: gs://${opts.gcsBucket}`);
  }
  const now = Date.now();
  let state = opts.initialState ?? store?.load() ?? createInitialState(now);

  // 보관 기간이 지난 방의 전화번호 자동 파기
  const retentionMs = opts.retentionDays * 24 * 60 * 60 * 1000;
  if (state.room.phonesPurgedAt === null && now - state.room.createdAt > retentionMs) {
    for (const p of Object.values(state.players)) p.phone = null;
    state = { ...state, room: { ...state.room, phonesPurgedAt: now } };
    fastify.log.warn('보관 기간이 지나 전화번호를 자동 삭제했습니다.');
  }

  const game = new GameService(store, state, fastify.log);
  const hostTokens = new HostTokens(opts.hostTokenTtlMs);
  // QR은 인쇄해서 배포하므로 방 코드를 넣지 않는다. 게임 초기화로 코드가 바뀌어도 인쇄물이 계속 유효하다
  const joinUrl = () => `${opts.publicUrl}/join`;

  const io = new IOServer(fastify.server, {
    cors: { origin: true, credentials: true },
    pingInterval: 10_000,
    pingTimeout: 20_000,
    maxHttpBufferSize: 64 * 1024,
  });
  const emitter = createGateway(io, game, { screenKey: opts.screenKey, hostTokens, joinUrl });
  game.attach(emitter);

  registerRoutes(fastify, game, { hostPin: opts.hostPin, hostTokens, joinUrl, store });

  if (opts.webDist && existsSync(join(opts.webDist, 'index.html'))) {
    const indexHtml = readFileSync(join(opts.webDist, 'index.html'));
    await fastify.register(fastifyStatic, { root: opts.webDist, wildcard: false, index: false });
    fastify.get('/', async (_req, reply) => reply.type('text/html').send(indexHtml));
    fastify.setNotFoundHandler(async (req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api') && !req.url.startsWith('/socket.io')) {
        return reply.type('text/html').send(indexHtml);
      }
      return reply.code(404).send({ message: 'Not found' });
    });
  } else {
    fastify.get('/', async () => ({ message: 'OX 퀴즈 서버. 웹 빌드(web/dist)가 없어 API만 제공합니다.' }));
  }

  const close = async () => {
    game.dispose();
    io.disconnectSockets(true);
    await new Promise<void>((resolve) => io.close(() => resolve()));
    await fastify.close();
    await snapshotter?.flush();
    store?.close();
  };

  return { fastify, io, game, store, close };
}

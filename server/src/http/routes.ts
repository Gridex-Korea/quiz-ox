// HTTP API: 입장 등록, 공개 정보, 사회자 로그인·문제 업로드·CSV·전화번호 파기. 프로토콜: DOCS/design/realtime-protocol.md
import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  AVATAR_PARTS,
  PHONE_DIGITS_RE,
  hostLoginSchema,
  joinRequestSchema,
  normalizePhone,
  purgeSchema,
  questionsReplaceSchema,
  type AvatarSpec,
} from '@ox/shared';
import { hostView } from '../engine/views';
import type { GameService } from '../game';
import { participantsCsv, questionsFromCsv } from '../csv';
import { HostTokens, RateLimiter, safeEqual } from '../ws/hostTokens';
import { hashToken } from '../ws/gateway';

export interface RoutesDeps {
  hostPin: string;
  hostTokens: HostTokens;
  joinUrl: () => string;
}

function randomAvatar(): AvatarSpec {
  const b = randomBytes(3);
  return { body: b[0]! % AVATAR_PARTS.body, face: b[1]! % AVATAR_PARTS.face, hair: b[2]! % AVATAR_PARTS.hair };
}

export function registerRoutes(app: FastifyInstance, game: GameService, deps: RoutesDeps): void {
  const joinLimiter = new RateLimiter(30, 60_000);
  const loginLimiter = new RateLimiter(5, 10 * 60_000);

  app.addContentTypeParser(['text/csv', 'text/plain'], { parseAs: 'string' }, (_req, body, done) => done(null, body));

  app.get('/api/health', async () => ({ ok: true, status: game.state.room.status }));

  app.get('/api/room/public', async () => ({
    status: game.state.room.status,
    roomCode: game.state.room.code,
    playerCount: Object.keys(game.state.players).length,
    joinUrl: deps.joinUrl(),
  }));

  app.post('/api/join', async (req, reply) => {
    if (!joinLimiter.hit(req.ip)) return reply.code(429).send({ reason: 'rate_limited', message: '잠시 후 다시 시도해 주세요.' });
    const parsed = joinRequestSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ reason: 'invalid', message: '이름과 휴대폰 번호를 확인해 주세요.' });
    const phone = normalizePhone(parsed.data.phone);
    if (!PHONE_DIGITS_RE.test(phone)) return reply.code(400).send({ reason: 'invalid_phone', message: '휴대폰 번호 형식이 올바르지 않습니다.' });

    const token = randomBytes(32).toString('hex');
    const r = game.dispatch({
      type: 'registerPlayer',
      phone,
      name: parsed.data.name,
      avatar: parsed.data.avatar ?? randomAvatar(),
      tokenHash: hashToken(token),
    });
    if (r.error || !r.registered) {
      const code = r.error === 'locked' || r.error === 'eliminated' || r.error === 'name_mismatch' ? 409 : 400;
      return reply.code(code).send({ reason: r.error ?? 'unknown', message: game.errorMessage(r.error ?? 'invalid_state') });
    }
    const player = game.state.players[r.registered.playerId]!;
    return reply.code(r.registered.kind === 'created' ? 201 : 200).send({
      playerId: player.id,
      sessionToken: token,
      rejoined: r.registered.kind === 'rejoined',
      roomCode: game.state.room.code,
      avatar: player.avatar,
      name: player.name,
    });
  });

  app.post('/api/host/login', async (req, reply) => {
    if (loginLimiter.isBlocked(req.ip)) return reply.code(429).send({ message: '실패가 잦아 10분간 잠겼습니다.' });
    const parsed = hostLoginSchema.safeParse(req.body);
    if (!parsed.success || !safeEqual(parsed.data.pin, deps.hostPin)) {
      loginLimiter.hit(req.ip);
      return reply.code(401).send({ message: 'PIN이 올바르지 않습니다.' });
    }
    loginLimiter.reset(req.ip);
    return { token: deps.hostTokens.issue() };
  });

  const requireHost = async (req: FastifyRequest, reply: FastifyReply) => {
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!deps.hostTokens.verify(token)) {
      reply.code(401).send({ message: '사회자 로그인이 필요합니다.' });
      return reply;
    }
    return undefined;
  };

  app.get('/api/host/state', { preHandler: requireHost }, async () => hostView(game.state, game.now(), deps.joinUrl()));

  app.put('/api/host/questions', { preHandler: requireHost }, async (req, reply) => {
    let questions;
    let errors: string[] = [];
    if (typeof req.body === 'string') {
      const r = questionsFromCsv(req.body);
      questions = r.questions;
      errors = r.errors;
    } else {
      const parsed = questionsReplaceSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ message: '문제 형식이 올바르지 않습니다.', errors: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });
      questions = parsed.data.questions;
    }
    if (questions.length === 0) return reply.code(400).send({ message: '가져올 문제가 없습니다.', errors });
    const r = game.dispatch({ type: 'questionsReplace', questions });
    if (r.error) return reply.code(409).send({ message: game.errorMessage(r.error), errors });
    return { imported: questions.length, errors };
  });

  app.get('/api/host/export.csv', { preHandler: requireHost }, async (_req, reply) => {
    const csv = participantsCsv(game.state);
    reply.header('Content-Type', 'text/csv; charset=utf-8');
    reply.header('Content-Disposition', `attachment; filename="ox-participants-${game.state.room.code}.csv"`);
    return reply.send(csv);
  });

  app.post('/api/host/purge-phones', { preHandler: requireHost }, async (req, reply) => {
    const parsed = purgeSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ message: 'confirm: true 가 필요합니다.' });
    const r = game.dispatch({ type: 'purgePhones' });
    if (r.error) return reply.code(409).send({ message: game.errorMessage(r.error) });
    return { purgedAt: game.state.room.phonesPurgedAt };
  });
}

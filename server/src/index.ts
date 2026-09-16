import { buildApp } from './app';
import { assertConfig, config } from './config';

async function main() {
  assertConfig();
  const app = await buildApp({
    dbPath: config.dbPath,
    hostPin: config.hostPin,
    screenKey: config.screenKey,
    publicUrl: config.publicUrl,
    webDist: config.webDist,
    retentionDays: config.retentionDays,
    hostTokenTtlMs: config.hostTokenTtlMs,
    gcsBucket: config.gcsBucket || undefined,
    logger: true,
  });

  const shutdown = async (signal: string) => {
    app.fastify.log.info(`${signal} 수신, 종료합니다`);
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await app.fastify.listen({ port: config.port, host: '0.0.0.0' });
  app.fastify.log.info(
    `OX 퀴즈 서버 시작: 방 코드 ${app.game.state.room.code}, 상태 ${app.game.state.room.status}, 참가자 ${Object.keys(app.game.state.players).length}명, 공개 URL ${config.publicUrl}`,
  );
  if (!config.isProd) app.fastify.log.info(`개발용 PIN=${config.hostPin}, 스크린 키=${config.screenKey}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

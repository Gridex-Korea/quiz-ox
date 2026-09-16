import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const isProd = process.env.NODE_ENV === 'production';

function env(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

const port = Number(env('PORT', '3000'));

export const config = {
  isProd,
  port,
  hostPin: env('HOST_PIN', isProd ? '' : '1234'),
  screenKey: env('SCREEN_KEY', isProd ? '' : 'screen'),
  dbPath: env('DB_PATH', resolve(process.cwd(), 'data/ox.sqlite')),
  publicUrl: env('PUBLIC_URL', `http://localhost:${port}`).replace(/\/$/, ''),
  retentionDays: Number(env('RETENTION_DAYS', '7')),
  gcsBucket: env('GCS_BUCKET', ''),
  /** 빌드된 웹 정적 파일. server/dist/index.js 와 server/src/index.ts 모두에서 ../../web/dist */
  webDist: env('WEB_DIST', resolve(here, '../../web/dist')),
  hostTokenTtlMs: 12 * 60 * 60 * 1000,
};

export function assertConfig(): void {
  if (!config.hostPin) throw new Error('HOST_PIN 환경변수가 필요합니다.');
  if (!config.screenKey) throw new Error('SCREEN_KEY 환경변수가 필요합니다.');
  if (isProd && config.hostPin.length < 4) throw new Error('HOST_PIN은 4자 이상이어야 합니다.');
}

export function joinUrl(roomCode: string): string {
  return `${config.publicUrl}/join?room=${encodeURIComponent(roomCode)}`;
}

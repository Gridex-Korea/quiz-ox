import { randomBytes, timingSafeEqual } from 'node:crypto';

/** 사회자 로그인 토큰. 프로세스 메모리에만 두며 재시작하면 다시 로그인한다 */
export class HostTokens {
  private tokens = new Map<string, number>();

  constructor(private readonly ttlMs: number) {}

  issue(now = Date.now()): string {
    const token = randomBytes(24).toString('base64url');
    this.tokens.set(token, now + this.ttlMs);
    return token;
  }

  verify(token: unknown, now = Date.now()): boolean {
    if (typeof token !== 'string' || token.length === 0) return false;
    const exp = this.tokens.get(token);
    if (!exp) return false;
    if (exp < now) {
      this.tokens.delete(token);
      return false;
    }
    return true;
  }
}

/** 길이가 달라도 시간 차이가 새지 않게 비교 */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) {
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

/** 단순 IP 기반 카운터: 시도 횟수 제한과 잠금 */
export class RateLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  /** true면 허용 */
  hit(key: string, now = Date.now()): boolean {
    const cur = this.hits.get(key);
    if (!cur || cur.resetAt <= now) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }
    cur.count += 1;
    return cur.count <= this.max;
  }

  isBlocked(key: string, now = Date.now()): boolean {
    const cur = this.hits.get(key);
    return !!cur && cur.resetAt > now && cur.count > this.max;
  }

  reset(key: string): void {
    this.hits.delete(key);
  }
}

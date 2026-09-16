// 개발 전용 진입점. 미리보기 도구나 셸이 PORT를 5173(Vite) 등으로 물려줘도 서버는 항상 3000에서 뜨게 한다.
// 운영(Cloud Run)은 index.ts를 직접 실행하므로 플랫폼이 준 PORT를 그대로 쓴다.
import { networkInterfaces } from 'node:os';

process.env['PORT'] = process.env['DEV_SERVER_PORT'] ?? '3000';

/** 같은 Wi-Fi의 폰이 QR로 들어올 수 있게, 가상 어댑터를 뺀 실제 LAN IPv4를 고른다 */
function lanIp(): string | null {
  const score = (ip: string) => (ip.startsWith('192.168.') ? 3 : ip.startsWith('10.') ? 2 : 1);
  const found: string[] = [];
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    if (/vEthernet|WSL|Hyper-V|VirtualBox|VMware|Docker|Loopback|Bluetooth/i.test(name)) continue;
    for (const a of addrs ?? []) if (a.family === 'IPv4' && !a.internal) found.push(a.address);
  }
  return found.sort((a, b) => score(b) - score(a))[0] ?? null;
}

// 개발 중 참가자는 Vite(5173)로 들어오므로 QR/URL도 그쪽을 가리킨다
process.env['PUBLIC_URL'] ??= `http://${lanIp() ?? 'localhost'}:${process.env['DEV_WEB_PORT'] ?? '5173'}`;

await import('./index');

export {};

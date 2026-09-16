// 개발 전용 진입점. 미리보기 도구나 셸이 PORT를 5173(Vite) 등으로 물려줘도 서버는 항상 3000에서 뜨게 한다.
// 운영(Cloud Run)은 index.ts를 직접 실행하므로 플랫폼이 준 PORT를 그대로 쓴다.
process.env['PORT'] = process.env['DEV_SERVER_PORT'] ?? '3000';
// 개발 중 참가자는 Vite(5173)로 들어오므로 QR/URL도 그쪽을 가리킨다
process.env['PUBLIC_URL'] ??= 'http://localhost:5173';
await import('./index');

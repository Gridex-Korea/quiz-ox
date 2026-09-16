import type { AvatarSpec, QuestionInput } from '@ox/shared';

export class ApiError extends Error {
  constructor(
    public status: number,
    public reason: string,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  const text = await res.text();
  let body: Record<string, unknown>;
  try {
    body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    body = { message: text };
  }
  if (!res.ok) {
    throw new ApiError(res.status, String(body['reason'] ?? res.status), String(body['message'] ?? '요청이 실패했습니다.'));
  }
  return body as T;
}

const json = (body: unknown, token?: string): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify(body),
});

export interface JoinResponse {
  playerId: string;
  sessionToken: string;
  rejoined: boolean;
  roomCode: string;
  avatar: AvatarSpec;
  name: string;
}

export const api = {
  join: (payload: { phone: string; name: string; avatar?: AvatarSpec; consent: true; roomCode?: string }) =>
    request<JoinResponse>('/api/join', json(payload)),
  roomPublic: () => request<{ status: string; roomCode: string; playerCount: number; joinUrl: string }>('/api/room/public', { method: 'GET' }),
  hostLogin: (pin: string) => request<{ token: string }>('/api/host/login', json({ pin })),
  importCsv: (token: string, csv: string) =>
    request<{ imported: number; errors: string[] }>('/api/host/questions', {
      method: 'PUT',
      headers: { 'content-type': 'text/csv', authorization: `Bearer ${token}` },
      body: csv,
    }),
  importJson: (token: string, questions: QuestionInput[]) =>
    request<{ imported: number; errors: string[] }>('/api/host/questions', { ...json({ questions }, token), method: 'PUT' }),
  purgePhones: (token: string) => request<{ purgedAt: number }>('/api/host/purge-phones', json({ confirm: true }, token)),
  async downloadCsv(token: string, filename: string) {
    const res = await fetch('/api/host/export.csv', { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) throw new ApiError(res.status, 'export_failed', 'CSV 내보내기에 실패했습니다.');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  },
};

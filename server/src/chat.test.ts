import { describe, expect, it } from 'vitest';
import type { Player } from '@ox/shared';
import { ChatRoom, sanitizeChat } from './chat';

const player = (id: string): Player => ({
  id,
  phone: '01011112222',
  name: `P${id}`,
  avatar: { body: 0, face: 0, hair: 0 },
  strikes: 0,
  status: 'ACTIVE',
  sessionTokenHash: 'h',
  connected: true,
  joinedAt: 0,
  consentAt: 0,
  eliminatedAtIndex: null,
  revivedAtIndex: null,
});

const NUL = String.fromCharCode(0);
const ZERO_WIDTH = String.fromCharCode(0x200b);

describe('채팅', () => {
  it('보이지 않는 문자와 줄바꿈을 공백으로 바꾸고 60자로 자른다', () => {
    expect(sanitizeChat('  안녕\n\n하세요' + NUL + '!  ')).toBe('안녕 하세요 !');
    expect(sanitizeChat('응' + ZERO_WIDTH + '원')).toBe('응 원');
    expect(sanitizeChat('   ')).toBeNull();
    expect(sanitizeChat(NUL + ZERO_WIDTH)).toBeNull();
    expect(sanitizeChat('가'.repeat(100))!.length).toBe(60);
  });

  it('같은 사람은 1.5초 안에 두 번 보낼 수 없고, 기록은 최근 것만 남는다', () => {
    const chat = new ChatRoom();
    const p = player('a');
    expect(chat.post(p, '첫 메시지', 1000)).not.toBeNull();
    expect(chat.post(p, '너무 빨리', 1500)).toBeNull();
    expect(chat.post(p, '이건 됨', 2600)).not.toBeNull();
    expect(chat.post(player('b'), '다른 사람은 바로', 2601)).not.toBeNull();
    expect(chat.history().map((m) => m.text)).toEqual(['첫 메시지', '이건 됨', '다른 사람은 바로']);
    const id = chat.history()[0]!.id;
    expect(chat.delete(id)).toBe(true);
    expect(chat.delete(id)).toBe(false);
    expect(chat.history()).toHaveLength(2);
    chat.clear();
    expect(chat.history()).toHaveLength(0);
    expect(chat.post(p, '초기화 뒤 바로 가능', 2700)).not.toBeNull();
  });

  it('기록은 200개를 넘지 않는다', () => {
    const chat = new ChatRoom();
    for (let i = 0; i < 250; i++) chat.post(player(`p${i}`), `m${i}`, i * 10);
    expect(chat.history(500)).toHaveLength(200);
    expect(chat.history(500)[0]!.text).toBe('m50');
  });

  it('메시지에는 전화번호가 들어가지 않는다', () => {
    const chat = new ChatRoom();
    const msg = chat.post(player('a'), '안녕하세요', 1000)!;
    expect(JSON.stringify(msg)).not.toContain('01011112222');
    expect(msg).toMatchObject({ playerId: 'a', name: 'Pa', text: '안녕하세요', at: 1000 });
  });
});

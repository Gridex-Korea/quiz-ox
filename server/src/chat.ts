// 참가자 채팅. 저장하지 않고 메모리에 최근 메시지만 둔다. 검증·정리·속도 제한을 여기서 한다.
import { randomUUID } from 'node:crypto';
import { CHAT_HISTORY_LIMIT, CHAT_MAX_LENGTH, CHAT_MIN_INTERVAL_MS, type ChatMessage, type Player } from '@ox/shared';

/** 보이지 않는 문자(제어·zero-width·줄 구분자·BOM)인가. 정규식 이스케이프 대신 코드값으로 판단한다 */
function isInvisible(code: number): boolean {
  if (code < 0x20 || code === 0x7f) return true;
  if (code >= 0x200b && code <= 0x200f) return true;
  if (code === 0x2028 || code === 0x2029) return true;
  return code === 0xfeff;
}

/** 보이지 않는 문자와 연속 공백을 정리하고 길이를 자른다. 비어 있으면 null */
export function sanitizeChat(raw: string): string | null {
  let cleaned = '';
  for (const ch of raw) cleaned += isInvisible(ch.codePointAt(0) ?? 0) ? ' ' : ch;
  const text = cleaned.replace(/\s+/g, ' ').trim().slice(0, CHAT_MAX_LENGTH);
  return text.length > 0 ? text : null;
}

export class ChatRoom {
  private log: ChatMessage[] = [];
  private lastAt = new Map<string, number>();

  /** 성공하면 메시지, 속도 제한·빈 문자열이면 null */
  post(player: Player, raw: string, now = Date.now()): ChatMessage | null {
    const text = sanitizeChat(raw);
    if (!text) return null;
    // 처음 보내는 사람은 제한 없음(기본값 0을 쓰면 서버 시각이 작은 테스트·리허설에서 막힌다)
    const last = this.lastAt.get(player.id);
    if (last !== undefined && now - last < CHAT_MIN_INTERVAL_MS) return null;
    this.lastAt.set(player.id, now);
    const msg: ChatMessage = { id: randomUUID(), playerId: player.id, name: player.name, avatar: player.avatar, text, at: now };
    this.log.push(msg);
    if (this.log.length > CHAT_HISTORY_LIMIT) this.log.splice(0, this.log.length - CHAT_HISTORY_LIMIT);
    return msg;
  }

  history(limit = 40): ChatMessage[] {
    return this.log.slice(-limit);
  }

  delete(id: string): boolean {
    const before = this.log.length;
    this.log = this.log.filter((m) => m.id !== id);
    return this.log.length !== before;
  }

  clear(): void {
    this.log = [];
    this.lastAt.clear();
  }
}

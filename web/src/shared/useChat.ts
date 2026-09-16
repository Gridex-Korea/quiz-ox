// 채팅 메시지 수집 훅. room:state와 별개로 chat:* 이벤트만 모아 둔다.
// 채팅 UI는 첫 room:state 뒤에 마운트되므로 접속 직후 서버가 보낸 chat:history를 놓칠 수 있다 → 마운트할 때 한 번 요청한다.
import { useEffect, useState } from 'react';
import { C2S, CHAT_HISTORY_LIMIT, S2C, type ChatMessage } from '@ox/shared';
import type { RoomConnection } from './socket';

export function useChat<TView>(room: RoomConnection<TView>): ChatMessage[] {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const { on, emit, status } = room;

  useEffect(() => {
    const offs = [
      on(S2C.chatHistory, (p) => setMessages((p as { messages: ChatMessage[] }).messages ?? [])),
      on(S2C.chatMessage, (p) => setMessages((cur) => [...cur, p as ChatMessage].slice(-CHAT_HISTORY_LIMIT))),
      on(S2C.chatDeleted, (p) => setMessages((cur) => cur.filter((m) => m.id !== (p as { id: string }).id))),
      on(S2C.chatCleared, () => setMessages([])),
    ];
    return () => offs.forEach((off) => off());
  }, [on]);

  // 연결될 때마다(재접속 포함) 기록을 다시 받아 온다
  useEffect(() => {
    if (status === 'connected') emit(C2S.chatSync);
  }, [status, emit]);

  return messages;
}

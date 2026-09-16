// 참가자 폰 채팅 서랍: 접으면 마지막 메시지 한 줄, 펼치면 최근 메시지와 입력창.
import { useEffect, useRef, useState } from 'react';
import { C2S, CHAT_MAX_LENGTH, CHAT_MIN_INTERVAL_MS, type ChatMessage, type RoomStateForPlayer } from '@ox/shared';
import { Avatar } from '../shared/Avatar';
import { useChat } from '../shared/useChat';
import type { RoomConnection } from '../shared/socket';

export function ChatDrawer({ room, view }: { room: RoomConnection<RoomStateForPlayer>; view: RoomStateForPlayer }) {
  const messages = useChat(room);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [cooldown, setCooldown] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const last = messages[messages.length - 1];

  useEffect(() => {
    if (open) listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages.length, open]);

  // 한글 입력 중에는 Enter 키 이벤트가 조합 확정으로 소비되므로, 폼 제출로 받는다(확정 후 Enter 한 번 더 = 전송)
  const send = (e?: React.FormEvent) => {
    e?.preventDefault();
    const t = text.trim();
    if (!t || cooldown || !view.chatEnabled) return;
    room.emit(C2S.chatSend, { text: t.slice(0, CHAT_MAX_LENGTH) });
    setText('');
    setCooldown(true);
    setTimeout(() => setCooldown(false), CHAT_MIN_INTERVAL_MS);
  };

  return (
    <section className={`chat-drawer ${open ? 'open' : ''}`}>
      <button type="button" className="chat-toggle" onClick={() => setOpen((o) => !o)}>
        <span>💬 채팅{messages.length ? ` (${messages.length})` : ''}</span>
        {!open && last && (
          <span className="chat-preview">
            <b>{last.name}</b> {last.text}
          </span>
        )}
        <span className="chat-caret">{open ? '▾' : '▴'}</span>
      </button>
      {/* 메시지 목록은 접었다 펼치고, 입력창은 항상 보인다 */}
      {open && (
        <div className="chat-messages" ref={listRef}>
          {messages.length === 0 && <p className="muted">첫 응원 메시지를 보내 보세요!</p>}
          {messages.slice(-40).map((m: ChatMessage) => (
            <div key={m.id} className={`chat-line ${m.playerId === view.me.id ? 'mine' : ''}`}>
              <Avatar spec={m.avatar} size={22} />
              <b>{m.name}</b>
              <span>{m.text}</span>
            </div>
          ))}
        </div>
      )}
      <form className="chat-input" onSubmit={send}>
        <input
          value={text}
          maxLength={CHAT_MAX_LENGTH}
          enterKeyHint="send"
          placeholder={view.chatEnabled ? '응원 메시지를 보내면 스크린에 떠요' : '사회자가 채팅을 잠갔습니다'}
          disabled={!view.chatEnabled}
          onFocus={() => setOpen(true)}
          onChange={(e) => setText(e.target.value)}
        />
        <button type="submit" className="primary small" disabled={!text.trim() || cooldown || !view.chatEnabled}>
          {cooldown ? '…' : '보내기'}
        </button>
      </form>
    </section>
  );
}

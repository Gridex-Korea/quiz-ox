import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './shared/styles.css';
import { JoinApp } from './join/JoinApp';
import { ScreenApp } from './screen/ScreenApp';
import { HostApp } from './host/HostApp';

function Landing() {
  return (
    <div style={{ maxWidth: 480, margin: '80px auto', padding: 24 }} className="stack">
      <h1 style={{ margin: 0 }}>OX 퀴즈 라이브</h1>
      <p className="muted">역할에 맞는 화면으로 이동하세요.</p>
      <a className="card" href="/join">📱 참가자 입장 (/join)</a>
      <a className="card" href="/screen">🖥️ 대형 스크린 (/screen)</a>
      <a className="card" href="/host">🎤 사회자 콘솔 (/host)</a>
    </div>
  );
}

function App() {
  const path = window.location.pathname.replace(/\/+$/, '') || '/';
  if (path.startsWith('/join')) return <JoinApp />;
  if (path.startsWith('/screen')) return <ScreenApp />;
  if (path.startsWith('/host')) return <HostApp />;
  return <Landing />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

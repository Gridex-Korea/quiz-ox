// 효과음은 파일 없이 WebAudio로 합성한다(라이선스 걱정 없음). 브라우저 정책상 사용자가 한 번 클릭한 뒤에만 소리가 난다.
export type SoundName = 'tick' | 'timeup' | 'correct' | 'wrong' | 'eliminated' | 'fanfare' | 'swap' | 'join' | 'revive';

let ctx: AudioContext | null = null;
let enabled = false;

export function isSoundEnabled(): boolean {
  return enabled;
}

/** 사용자 클릭 핸들러 안에서 호출해야 한다 */
export async function unlockSound(): Promise<boolean> {
  try {
    ctx ??= new AudioContext();
    if (ctx.state === 'suspended') await ctx.resume();
    enabled = ctx.state === 'running';
    if (enabled) beep(880, 0.05, 'sine', 0.03);
    return enabled;
  } catch {
    return false;
  }
}

export function disableSound(): void {
  enabled = false;
}

function beep(freq: number, duration: number, type: OscillatorType = 'sine', gain = 0.08, when = 0, slideTo?: number): void {
  if (!ctx || !enabled) return;
  const t0 = ctx.currentTime + when;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t0 + duration);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
  osc.connect(g).connect(ctx.destination);
  osc.start(t0);
  osc.stop(t0 + duration + 0.02);
}

function noise(duration: number, gain = 0.05, when = 0): void {
  if (!ctx || !enabled) return;
  const t0 = ctx.currentTime + when;
  const buffer = ctx.createBuffer(1, Math.floor(ctx.sampleRate * duration), ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  const filter = ctx.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.setValueAtTime(400, t0);
  filter.frequency.exponentialRampToValueAtTime(3000, t0 + duration);
  const g = ctx.createGain();
  g.gain.setValueAtTime(gain, t0);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
  src.connect(filter).connect(g).connect(ctx.destination);
  src.start(t0);
}

export function play(name: SoundName): void {
  if (!enabled) return;
  switch (name) {
    case 'tick':
      beep(1200, 0.06, 'square', 0.04);
      break;
    case 'timeup':
      beep(660, 0.5, 'triangle', 0.1);
      beep(880, 0.6, 'sine', 0.08, 0.05);
      break;
    case 'correct':
      [523, 659, 784, 1047].forEach((f, i) => beep(f, 0.18, 'triangle', 0.08, i * 0.09));
      break;
    case 'wrong':
      beep(220, 0.35, 'sawtooth', 0.07, 0, 160);
      break;
    case 'eliminated':
      beep(330, 0.25, 'sawtooth', 0.07, 0, 110);
      noise(0.5, 0.04, 0.05);
      break;
    case 'fanfare':
      [523, 523, 523, 659, 784, 1047, 784, 1047].forEach((f, i) => beep(f, 0.22, 'square', 0.06, i * 0.13));
      break;
    case 'swap':
      noise(0.6, 0.06);
      beep(300, 0.6, 'sine', 0.05, 0, 900);
      break;
    case 'join':
      beep(880, 0.08, 'sine', 0.04);
      beep(1320, 0.1, 'sine', 0.04, 0.08);
      break;
    case 'revive':
      [392, 523, 659, 784].forEach((f, i) => beep(f, 0.2, 'sine', 0.08, i * 0.08));
      break;
  }
}

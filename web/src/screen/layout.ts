// 무대 좌표계(1920×1080 고정)와 구역·슬롯 배치. 설계: DOCS/design/screens.md "아바타 규칙"
import type { PublicPlayer, RoomStateForScreen } from '@ox/shared';

export const STAGE_W = 1920;
export const STAGE_H = 1080;

export type ZoneKey = 'lobby' | 'O' | 'center' | 'X' | 'strip' | 'hidden';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type ZoneName = Exclude<ZoneKey, 'hidden'>;

export const ZONES: Record<ZoneName, Rect> = {
  // 로비·종료 화면: 상단 QR 카드/우승 자막과 겹치지 않게 아래쪽 띠에서 배회
  lobby: { x: 60, y: 560, w: 1800, h: 300 },
  O: { x: 40, y: 190, w: 640, h: 660 },
  center: { x: 700, y: 190, w: 520, h: 660 },
  X: { x: 1240, y: 190, w: 640, h: 660 },
  strip: { x: 60, y: 900, w: 1800, h: 150 },
};

/** 사진 문제일 때 중앙 구역 윗부분에 사진이 들어가고, 미선택 아바타는 그 아래에서 배회한다 */
export const QUESTION_IMAGE_RECT: Rect = { x: 720, y: 200, w: 480, h: 380 };

export function zoneRects(hasImage: boolean): Record<ZoneName, Rect> {
  if (!hasImage) return ZONES;
  return { ...ZONES, center: { x: 700, y: 600, w: 520, h: 250 } };
}

export type RevealPhase = 'none' | 'hold';

/** 참가자가 서 있어야 할 구역. 상태·모드·공개 단계로 결정한다 */
export function zoneOf(p: PublicPlayer, view: RoomStateForScreen, phase: RevealPhase): ZoneKey {
  const { status, mode } = view;
  if (status === 'LOBBY' || status === 'LOCKED') return p.status === 'ELIMINATED' ? 'hidden' : 'lobby';
  // 종료: 결승 진출자 카드가 뜨는 경우엔 아바타를 숨기고, 그 외에는 생존자만 아래에서 배회
  if (status === 'ENDED') return view.finalists ? 'hidden' : p.status === 'ACTIVE' ? 'lobby' : 'hidden';

  const eligible = mode === 'REVIVAL' ? 'WAITING' : 'ACTIVE';

  if (status === 'REVEALED') {
    const outcome = view.outcomes?.find((o) => o.playerId === p.id);
    if (outcome) {
      // 공개 직후 잠깐(hold): 마감 시점의 자리를 유지하며 정답·오답만 색으로 구분
      if (phase === 'hold') return outcome.choice ?? 'center';
      if (outcome.statusAfter === 'ELIMINATED') return 'hidden';
      if (outcome.statusAfter === 'WAITING') return 'strip';
      // 정답자·부활자는 다음 문제까지 자기 구역에 남는다
      return outcome.choice ?? 'center';
    }
    return p.status === 'ELIMINATED' ? 'hidden' : 'strip';
  }

  if (p.status === 'ELIMINATED') return 'hidden';
  if (p.status !== eligible) return 'strip';
  if (p.choice) return p.choice;
  return 'center';
}

export interface Slot {
  x: number;
  y: number;
  size: number;
}

function gridFor(rect: Rect, n: number, maxCell: number): { cols: number; rows: number; cell: number; gx: number; gy: number } {
  const count = Math.max(1, n);
  const aspect = rect.w / rect.h;
  let cols = Math.max(1, Math.ceil(Math.sqrt(count * aspect)));
  let rows = Math.ceil(count / cols);
  let cell = Math.min(rect.w / cols, rect.h / rows, maxCell);
  // 셀이 너무 작아지면 열을 줄여 다시 계산
  while (cell < 40 && cols > 1) {
    cols -= 1;
    rows = Math.ceil(count / cols);
    cell = Math.min(rect.w / cols, rect.h / rows, maxCell);
  }
  const gx = rect.x + (rect.w - cols * cell) / 2;
  const gy = rect.y + (rect.h - rows * cell) / 2;
  return { cols, rows, cell, gx, gy };
}

/** 구역별 안정적 슬롯 배정: 먼저 온 사람이 앉은 자리는 유지, 새 사람은 첫 빈 자리 */
export class SlotAllocator {
  private seats = new Map<ZoneKey, (string | undefined)[]>();

  assign(zone: ZoneKey, members: string[]): Map<string, number> {
    const seats = this.seats.get(zone) ?? [];
    const memberSet = new Set(members);
    for (let i = 0; i < seats.length; i++) if (seats[i] !== undefined && !memberSet.has(seats[i]!)) seats[i] = undefined;
    const seated = new Set(seats.filter((s): s is string => s !== undefined));
    for (const id of members) {
      if (seated.has(id)) continue;
      let idx = seats.findIndex((s) => s === undefined);
      if (idx < 0) idx = seats.length;
      seats[idx] = id;
      seated.add(id);
    }
    // 뒤쪽 빈 자리 정리
    while (seats.length > 0 && seats[seats.length - 1] === undefined) seats.pop();
    this.seats.set(zone, seats);
    const out = new Map<string, number>();
    seats.forEach((id, i) => {
      if (id !== undefined) out.set(id, i);
    });
    return out;
  }

  reset(): void {
    this.seats.clear();
  }
}

/** 좌표 계산. 결정적 지터로 격자 느낌을 줄인다 */
export function positionsFor(zone: ZoneName, seatIndex: Map<string, number>, isStrip: boolean, rect: Rect = ZONES[zone]): Map<string, Slot> {
  const n = Math.max(seatIndex.size, Math.max(...seatIndex.values(), -1) + 1);
  const maxCell = isStrip ? 90 : zone === 'lobby' ? 140 : 120;
  const g = gridFor(rect, n, maxCell);
  const out = new Map<string, Slot>();
  const size = Math.max(isStrip ? 34 : 40, Math.min(isStrip ? 52 : 72, g.cell * 0.6));
  for (const [id, i] of seatIndex) {
    const col = i % g.cols;
    const row = Math.floor(i / g.cols);
    const jitter = hash(id);
    const jx = ((jitter % 17) - 8) * (g.cell / 60);
    const jy = (((jitter >> 5) % 13) - 6) * (g.cell / 60);
    out.set(id, {
      x: g.gx + (col + 0.5) * g.cell + jx,
      y: g.gy + (row + 0.5) * g.cell + jy,
      size,
    });
  }
  return out;
}

export function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

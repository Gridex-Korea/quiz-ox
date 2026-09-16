// 엔진(순수)과 바깥세상(소켓·타이머·저장)을 잇는 서비스.
// 명령 하나 = reduce 한 번 = effects 적용 한 번. 상태 전이(stateChanged)마다 저장하고 모든 화면에 room:state를 다시 보낸다.
import { S2C, type RoomState } from '@ox/shared';
import { ERROR_MESSAGES, reduce, type Command, type Effect, type Result, type Target } from './engine/reducer';
import type { Store } from './store/db';

/** 게이트웨이가 구현하는 전송 인터페이스. 테스트에서는 가짜로 바꿔 끼운다 */
export interface Emitter {
  toTarget(target: Target, event: string, payload: unknown): void;
  toPlayer(playerId: string, event: string, payload: unknown): void;
  toEachPlayer(event: string, payloadFor: (playerId: string) => unknown): void;
  disconnectPlayer(playerId: string): void;
  pushViews(): void;
}

export class GameService {
  state: RoomState;
  private timer: NodeJS.Timeout | null = null;
  private pendingDisconnects = new Set<NodeJS.Timeout>();
  private emitter: Emitter | null = null;
  /** 재시작 복구 등, 다음 사회자 접속 때 보여줄 알림 */
  readonly bootAlerts: { level: 'info' | 'warning' | 'error'; message: string }[] = [];

  constructor(
    private readonly store: Store | null,
    initialState: RoomState,
    private readonly log: { info: (msg: string) => void; error: (msg: string) => void } = console,
  ) {
    this.state = initialState;
  }

  attach(emitter: Emitter): void {
    this.emitter = emitter;
    // 재시작 직후 ANSWERING이었다면 마감 시각을 믿을 수 없으므로 문제 화면으로 내린다.
    if (this.state.room.status === 'ANSWERING') {
      const r = reduce(this.state, { type: 'cancelRound' }, Date.now());
      if (!r.error) {
        this.state = r.state;
        this.persist();
        this.bootAlerts.push({
          level: 'warning',
          message: '서버가 재시작되어 답변 중이던 문제를 문제 화면으로 되돌렸습니다. 타이머를 다시 시작해 주세요.',
        });
      }
    }
    for (const p of Object.values(this.state.players)) p.connected = false;
  }

  now(): number {
    return Date.now();
  }

  /** 명령을 적용하고 부수효과를 실행한다. 오류면 상태는 그대로이고 error만 채워진다 */
  dispatch(cmd: Command, now = this.now()): Result {
    const result = reduce(this.state, cmd, now);
    if (result.error) {
      if (process.env['OX_DEBUG']) console.log(`[ox] 명령 거절 ${cmd.type}: ${result.error} (status=${this.state.room.status})`);
      return result;
    }
    this.state = result.state;
    this.applyEffects(result.effects, now);
    return result;
  }

  errorMessage(code: string): string {
    return ERROR_MESSAGES[code] ?? `처리할 수 없습니다 (${code})`;
  }

  private applyEffects(effects: Effect[], now: number): void {
    const em = this.emitter;
    let changed = false;
    for (const e of effects) {
      switch (e.type) {
        case 'broadcast':
          em?.toTarget(e.to, e.event, e.payload);
          break;
        case 'toPlayer':
          em?.toPlayer(e.playerId, e.event, e.payload);
          break;
        case 'toEachPlayer':
          em?.toEachPlayer(e.event, e.payloadFor);
          break;
        case 'timer:set':
          this.setTimer(e.deadline, now);
          break;
        case 'timer:clear':
          this.clearTimer();
          break;
        case 'disconnect': {
          const t = setTimeout(() => {
            this.pendingDisconnects.delete(t);
            em?.disconnectPlayer(e.playerId);
          }, e.delayMs);
          this.pendingDisconnects.add(t);
          break;
        }
        case 'alert':
          em?.toTarget('host', S2C.hostAlert, { level: e.level, message: e.message });
          break;
        case 'stateChanged':
          changed = true;
          break;
      }
    }
    if (changed) {
      this.persist();
      em?.pushViews();
    }
  }

  private setTimer(deadline: number, now: number): void {
    this.clearTimer();
    const delay = Math.max(0, deadline - now);
    this.timer = setTimeout(() => {
      this.timer = null;
      const r = this.dispatch({ type: 'timeUp' });
      if (r.error) this.log.error(`timeUp 실패: ${r.error}`);
    }, delay);
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private persist(): void {
    if (!this.store) return;
    try {
      this.store.save(this.state);
    } catch (e) {
      this.log.error(`SQLite 저장 실패: ${(e as Error).message}`);
    }
  }

  /** 종료 시 타이머 정리 */
  dispose(): void {
    this.clearTimer();
    for (const t of this.pendingDisconnects) clearTimeout(t);
    this.pendingDisconnects.clear();
  }
}

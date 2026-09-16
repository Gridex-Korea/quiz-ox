// Socket.IO 이벤트 이름과 페이로드. 원본: DOCS/design/realtime-protocol.md
import type {
  Choice,
  Counts,
  Outcome,
  PublicPlayer,
  QuestionPublic,
  RoomConfig,
  RoundMode,
} from './types';

/** 서버 → 클라이언트 */
export const S2C = {
  roomState: 'room:state',
  timePong: 'time:pong',
  playerJoined: 'lobby:playerJoined',
  playerConnection: 'player:connection',
  roomLocked: 'room:locked',
  roomUnlocked: 'room:unlocked',
  questionShow: 'question:show',
  questionStart: 'question:start',
  questionExtended: 'question:extended',
  answerMoved: 'answer:moved',
  answerLocked: 'answer:locked',
  answerAck: 'answer:ack',
  questionTimeup: 'question:timeup',
  questionReveal: 'question:reveal',
  playerEliminated: 'player:eliminated',
  roundUndone: 'round:undone',
  roundCancelled: 'round:cancelled',
  gameEnded: 'game:ended',
  gameWinner: 'game:winner',
  roomReset: 'room:reset',
  playerRemoved: 'player:removed',
  hostAlert: 'host:alert',
  sessionReplaced: 'session:replaced',
} as const;

/** 클라이언트 → 서버 */
export const C2S = {
  timePing: 'time:ping',
  answerChoose: 'answer:choose',
  hostLock: 'host:lock',
  hostUnlock: 'host:unlock',
  hostShowQuestion: 'host:showQuestion',
  hostStartTimer: 'host:startTimer',
  hostExtendTimer: 'host:extendTimer',
  hostEndTimerNow: 'host:endTimerNow',
  hostReveal: 'host:reveal',
  hostUndoReveal: 'host:undoReveal',
  hostCancelRound: 'host:cancelRound',
  hostNext: 'host:next',
  hostEnd: 'host:end',
  hostStartRevival: 'host:startRevival',
  hostRestore: 'host:restore',
  hostKick: 'host:kick',
  hostRemovePlayer: 'host:removePlayer',
  hostSetWinner: 'host:setWinner',
  hostUpdateConfig: 'host:updateConfig',
  hostQuestionsReplace: 'host:questions:replace',
  hostQuestionUpsert: 'host:question:upsert',
  hostQuestionDelete: 'host:question:delete',
  hostResetRoom: 'host:resetRoom',
} as const;

export interface TimePong {
  clientSent: number;
  serverNow: number;
}

export interface QuestionShowPayload {
  index: number;
  total: number;
  mode: RoundMode;
  eligible: 'ACTIVE' | 'WAITING';
  liveMoves: boolean;
  question: QuestionPublic;
  /** 사회자 룸에만 실림 */
  answer?: Choice;
}

export interface QuestionStartPayload {
  index: number;
  deadline: number;
  serverNow: number;
}

export interface QuestionExtendedPayload {
  deadline: number;
  serverNow: number;
}

export interface AnswerMovedPayload {
  playerId: string;
  choice: Choice;
}

export interface AnswerLockedPayload {
  playerId: string;
}

export interface AnswerAckPayload {
  index: number;
  choice: Choice;
  acceptedAt: number;
}

export interface QuestionTimeupPayload {
  index: number;
  counts: Counts;
  /** 스크린·사회자에게만 실림 */
  choices?: { playerId: string; choice: Choice }[];
}

export interface QuestionRevealPayload {
  index: number;
  mode: RoundMode;
  answer: Choice;
  explanation: string | null;
  outcomes: Outcome[];
  survivors: number;
  waiting: number;
  eliminatedCount: number;
}

export interface QuestionRevealForPlayer {
  index: number;
  mode: RoundMode;
  answer: Choice;
  explanation: string | null;
  me: Outcome | null;
}

export interface PlayerEliminatedPayload {
  atQuestion: number;
  message: string;
}

export interface GameEndedPayload {
  survivors: PublicPlayer[];
  totalQuestions: number;
}

export interface GameWinnerPayload {
  playerId: string;
}

export interface HostAlertPayload {
  level: 'info' | 'warning' | 'error';
  message: string;
}

export interface PlayerConnectionPayload {
  playerId: string;
  connected: boolean;
}

export type UpdateConfigPayload = Partial<RoomConfig>;

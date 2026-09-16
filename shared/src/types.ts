// 서버·웹이 함께 쓰는 도메인 타입. 규칙의 원본은 DOCS/design/game-flow.md, 저장 구조는 DOCS/design/data-model.md.

export type RoomStatus =
  | 'LOBBY'
  | 'LOCKED'
  | 'QUESTION_SHOWN'
  | 'ANSWERING'
  | 'TIME_UP'
  | 'REVEALED'
  | 'ENDED';

export type RoundMode = 'NORMAL' | 'REVIVAL';
export type PlayerStatus = 'ACTIVE' | 'WAITING' | 'ELIMINATED';
export type Choice = 'O' | 'X';
export type QuestionKind = 'NORMAL' | 'REVIVAL';

export interface AvatarSpec {
  body: number;
  face: number;
  hair: number;
}

export const AVATAR_PARTS = { body: 12, face: 8, hair: 10 } as const;

export interface RoomConfig {
  /** 문제 기본 제한시간(초). 문제별 값이 없을 때 사용 */
  defaultTimeLimitSec: number;
  /** 이 횟수에 도달하면 퇴장. 기본 2 */
  maxStrikes: number;
  /** 패자부활전 예정 시점: 이 order_no 문제의 정답 공개 뒤. 0부터 셈 */
  revivalAfterOrderNo: number;
  /** 아바타 이동을 실시간으로 보여주는 마지막 문제의 order_no. 0부터 셈. 그 뒤는 숨김 모드 */
  liveMovesUntilOrderNo: number;
  /** 마감 시각 이후에도 이만큼(ms) 늦게 도착한 답은 인정 */
  answerGraceMs: number;
  /** 참가자당 선택 변경 최소 간격(ms) */
  answerRateLimitMs: number;
  /** 문제 공개 뒤 타이머를 자동으로 시작하는가 */
  autoStart: boolean;
  /** 자동 시작까지 준비 카운트(초). 0이면 공개와 동시에 시작 */
  autoStartDelaySec: number;
  /** 무대 생존자가 이 인원 이하가 되면 결승 진출자 축하 화면으로 넘어간다(0이면 끔). 부활전을 아직 안 열었고 대기실이 있으면 부활전을 먼저 제안 */
  finalistThreshold: number;
}

/** 결승 진출자: 무대에서 호명할 수 있게 뒷번호 4자리를 함께 보낸다(사회자 결정, ENDED에서만) */
export interface Finalist extends PublicPlayer {
  phoneTail: string | null;
}

export const DEFAULT_CONFIG: RoomConfig = {
  defaultTimeLimitSec: 15,
  maxStrikes: 2,
  revivalAfterOrderNo: 4,
  liveMovesUntilOrderNo: 3,
  answerGraceMs: 300,
  answerRateLimitMs: 300,
  autoStart: true,
  autoStartDelaySec: 3,
  finalistThreshold: 3,
};

export interface Question {
  id: string;
  orderNo: number;
  kind: QuestionKind;
  text: string;
  answer: Choice;
  timeLimitSec: number | null;
  imageUrl: string | null;
  explanation: string | null;
  /** 출제된 서버 시각(ms). null이면 미출제 */
  usedAt: number | null;
}

/** 스크린·참가자에게 보내는 문제. 정답은 REVEALED 이후에만 채운다 */
export interface QuestionPublic {
  id: string;
  index: number;
  total: number;
  kind: QuestionKind;
  text: string;
  imageUrl: string | null;
  timeLimitSec: number;
  explanation: string | null;
}

export interface Player {
  id: string;
  /** 정규화된 휴대폰 번호(숫자만). 파기 후 null */
  phone: string | null;
  name: string;
  avatar: AvatarSpec;
  strikes: number;
  status: PlayerStatus;
  sessionTokenHash: string;
  connected: boolean;
  joinedAt: number;
  consentAt: number;
  eliminatedAtIndex: number | null;
  revivedAtIndex: number | null;
}

/** 전화번호·토큰이 없는 공개용 참가자 */
export interface PublicPlayer {
  id: string;
  name: string;
  avatar: AvatarSpec;
  status: PlayerStatus;
  strikes: number;
  connected: boolean;
  eliminatedAtIndex: number | null;
  revivedAtIndex: number | null;
  /** 이번 라운드 선택. 스크린에는 실시간 모드이거나 TIME_UP 이후에만 채운다 */
  choice?: Choice;
  /** 숨김 모드의 ANSWERING 중 스크린에 주는 "선택함" 표시 */
  hasAnswered?: boolean;
}

export interface CurrentAnswer {
  choice: Choice;
  answeredAt: number;
  changeCount: number;
}

export interface AnswerRecord {
  choice: Choice | null;
  answeredAt: number | null;
  changeCount: number;
  isCorrect: boolean | null;
}

export interface Counts {
  O: number;
  X: number;
  none: number;
}

export interface Outcome {
  playerId: string;
  choice: Choice | null;
  correct: boolean;
  strikesAfter: number;
  statusAfter: PlayerStatus;
  revived: boolean;
}

export interface PlayerSnapshot {
  id: string;
  strikes: number;
  status: PlayerStatus;
  eliminatedAtIndex: number | null;
  revivedAtIndex: number | null;
}

export interface RoundResult {
  questionId: string;
  index: number;
  mode: RoundMode;
  counts: Counts;
  outcomes: Outcome[];
  snapshotBefore: PlayerSnapshot[];
  revealedAt: number;
  undone: boolean;
}

export interface Room {
  id: string;
  code: string;
  status: RoomStatus;
  roundMode: RoundMode | null;
  /** 진행 중 문제의 orderNo. 시작 전 -1 */
  currentIndex: number;
  deadlineAt: number | null;
  /** QUESTION_SHOWN에서 타이머가 자동 시작될 서버 시각(ms). 수동 모드면 null */
  autoStartAt: number | null;
  /** 생존자가 결승 인원 이하인데 부활전을 아직 안 열어, 다음 단계가 패자부활전이어야 하는 상태 */
  pendingRevival: boolean;
  /** REVEALED에서 결승 진출자 발표(ENDED)로 자동 전환될 서버 시각(ms) */
  finaleAt: number | null;
  revivalUsedCount: number;
  winnerPlayerId: string | null;
  config: RoomConfig;
  createdAt: number;
  updatedAt: number;
  phonesPurgedAt: number | null;
}

/** 엔진이 다루는 방 전체 상태. 인메모리가 진실이고 SQLite는 사본 */
export interface RoomState {
  room: Room;
  players: Record<string, Player>;
  questions: Question[];
  /** ANSWERING~REVEALED 동안의 이번 라운드 선택 */
  currentAnswers: Record<string, CurrentAnswer>;
  /** questionId → playerId → 답. TIME_UP에 확정, REVEALED에 isCorrect 채움 */
  answers: Record<string, Record<string, AnswerRecord>>;
  roundResults: Record<string, RoundResult>;
}

// ---- 역할별 room:state 투영 ----

export interface RoomStateForPlayer {
  status: RoomStatus;
  mode: RoundMode | null;
  liveMoves: boolean;
  me: PublicPlayer;
  canAnswer: boolean;
  question: QuestionPublic | null;
  deadline: number | null;
  autoStartAt: number | null;
  pendingRevival: boolean;
  finaleAt: number | null;
  /** ENDED에서 내가 결승 진출자인가 */
  isFinalist: boolean;
  playerCount: number;
  counts: Counts | null;
  answer: Choice | null;
  myOutcome: Outcome | null;
  survivors: PublicPlayer[] | null;
  winnerId: string | null;
  serverNow: number;
}

export interface RoomStateForScreen {
  status: RoomStatus;
  mode: RoundMode | null;
  liveMoves: boolean;
  roomCode: string;
  joinUrl: string;
  players: PublicPlayer[];
  question: QuestionPublic | null;
  deadline: number | null;
  autoStartAt: number | null;
  pendingRevival: boolean;
  finaleAt: number | null;
  /** ENDED이고 생존자가 결승 인원 이하일 때만 채움 */
  finalists: Finalist[] | null;
  counts: Counts | null;
  answer: Choice | null;
  outcomes: Outcome[] | null;
  winnerId: string | null;
  serverNow: number;
}

export interface RoomStateForHost extends RoomStateForScreen {
  questions: Question[];
  currentIndex: number;
  config: RoomConfig;
  revivalUsedCount: number;
  /** playerId → 전화번호(파기 후 null) */
  phones: Record<string, string | null>;
  phonesPurgedAt: number | null;
  createdAt: number;
}

export type RoleView = RoomStateForPlayer | RoomStateForScreen | RoomStateForHost;

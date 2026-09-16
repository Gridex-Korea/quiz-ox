---
title: 실시간 이벤트 프로토콜
tags: [설계, protocol, project/ox-quiz]
status: draft
created: 2026-09-16
updated: 2026-09-16
up: "[[architecture]]"
related: ["[[game-flow]]", "[[data-model]]", "[[ADR-0001-realtime-socketio]]"]
---

# 실시간 이벤트 프로토콜

## 책임

서버와 세 클라이언트(참가자·스크린·사회자) 사이의 모든 메시지를 정의한다. 이벤트 이름과 페이로드 타입은 `shared/` 패키지에 TypeScript 타입 + zod 스키마로 한 번만 선언하고 서버·웹이 같이 쓴다. 서버는 들어오는 모든 페이로드를 스키마로 검증하고, 실패하면 무시하고 로그만 남긴다.

## 연결과 인증

| 역할 | 연결 방법 | 인증 | 들어가는 룸 |
|---|---|---|---|
| 참가자 | 먼저 `POST /api/join`으로 등록 → 받은 `sessionToken`을 Socket.IO `auth`에 넣어 연결 | 세션 토큰(랜덤 32바이트, 서버는 해시만 보관) | `players`, `p:<playerId>` |
| 스크린 | `?role=screen` 로 연결 | 스크린 키(환경변수, URL 쿼리가 아닌 `auth`로 전달) | `screen` |
| 사회자 | `POST /api/host/login`으로 PIN 확인 → 토큰(12시간, 서버 메모리) → 소켓 `auth.token`과 HTTP `Authorization: Bearer` | PIN(환경변수), 5회 실패 시 10분 잠금 | `host` |

토큰이 무효하면 서버가 `connect_error`로 거절하고, 참가자 폰은 입장 폼으로 돌아가 전화번호 재입력으로 복귀를 시도한다([[game-flow]] 재접속 흐름).

## HTTP 엔드포인트

| 메서드 · 경로 | 누가 | 요청 | 응답 |
|---|---|---|---|
| `POST /api/join` | 참가자 | `{ roomCode, phone, name, avatar? , consent: true }` | `201 { playerId, sessionToken, avatar }` / `409 { reason: "locked" \| "eliminated" }` / `400` 검증 실패. 같은 번호 재입장은 `200`으로 기존 자리 복귀 |
| `GET /api/room/public` | 누구나 | — | `{ status, playerCount, joinUrl }` (QR 표시용, 개인정보 없음) |
| `POST /api/host/login` | 사회자 | `{ pin }` | 쿠키 설정. 5회 실패 시 10분 잠금 |
| `PUT /api/host/questions` | 사회자 | JSON 배열 또는 CSV(multipart) | 검증 결과와 저장된 문제 수 |
| `GET /api/host/export.csv` | 사회자 | — | 참가자 목록 CSV(이름, 전화번호, 최종 상태, 탈락 문제 번호) |
| `POST /api/host/purge-phones` | 사회자 | `{ confirm: true }` | 전화번호 컬럼 삭제. 되돌릴 수 없음 |

전화번호는 요청 **본문**으로만 다니고, URL·쿼리스트링·소켓 브로드캐스트에는 절대 실리지 않는다([[ADR-0003-phone-identity]]).

## 서버 → 클라이언트 이벤트

| 이벤트 | 받는 룸 | 페이로드 | 언제 |
|---|---|---|---|
| `room:state` | 연결한 소켓 1개 | 아래 `RoomStateForRole` | 연결·재접속 직후, 그리고 복구가 필요한 모든 순간. 역할별로 내용이 다름 |
| `time:pong` | 소켓 1개 | `{ clientSent, serverNow }` | `time:ping` 응답 |
| `lobby:playerJoined` | `screen`, `host` | `{ player: PublicPlayer }` | 새 참가자 등록 |
| `player:connection` | `screen`, `host` | `{ playerId, connected }` | 소켓 연결/끊김 |
| `room:locked` | 전체 | `{ playerCount }` | 입장 마감 |
| `question:show` | 전체 | `{ index, total, mode: "NORMAL" \| "REVIVAL", eligible: "ACTIVE" \| "WAITING", liveMoves: boolean, text, imageUrl?, timeLimitSec }` | 문제 공개. `mode`로 스크린은 무대 교대 여부를, 폰은 자기 답변 자격을 판단. `liveMoves`가 false면 스크린은 숨김 모드 자막을 띄움. **정답은 절대 포함하지 않음** (사회자 룸만 `answer` 필드 추가) |
| `question:start` | 전체 | `{ index, deadline }` | 타이머 시작. `deadline`은 서버 절대 시각(ms) |
| `question:extended` | 전체 | `{ deadline }` | 타이머 연장/조기 마감으로 마감 시각 변경 |
| `answer:moved` | `host` 항상, `screen`은 `liveMoves`일 때만 | `{ playerId, choice: "O" \| "X" }` | 참가자 선택·변경. 스크린이 아바타를 걷게 함 |
| `answer:locked` | `screen` (`liveMoves`가 false일 때) | `{ playerId }` | 선택했다는 사실만. 스크린은 ✓ 배지를 띄우고 어느 쪽인지는 모름. 선택을 바꿔도 다시 보내지 않음 |
| `answer:ack` | `p:<id>` | `{ choice, acceptedAt }` | 참가자 본인에게 접수 확인 |
| `question:timeup` | 전체 | `{ index, counts: { O, X, none } }` — `screen`·`host`에는 `choices: [{ playerId, choice }]` 추가 | 마감. 숨김 모드였다면 스크린은 `choices`로 아바타를 일제히 이동시킨 뒤 인원 공개 연출 |
| `question:reveal` | `screen`, `host` | `{ index, mode, answer, outcomes: Outcome[], survivors, waiting, eliminatedCount }` | 정답 공개. `Outcome = { playerId, choice, correct, strikesAfter, statusAfter, revived: boolean }`. 자격자만 `outcomes`에 포함 |
| `question:reveal` | `players` (개별) | `{ index, mode, answer, me: Outcome \| null }` | 참가자 본인 결과만. 관전자는 `me: null` |
| `player:eliminated` | `p:<id>` | `{ atQuestion, message }` | 2스트라이크. 3초 후 서버가 소켓 종료 |
| `round:undone` | 전체 | `{ index }` | 사회자가 정답 공개 취소. 스크린은 `room:state`를 다시 받아 재배치 |
| `round:cancelled` | 전체 | `{ index }` | 답변 폐기, 문제 화면으로 복귀 |
| `game:ended` | 전체 | `{ survivors: PublicPlayer[], totalQuestions }` | 종료. 최종 결승은 앱 밖에서 진행 |
| `game:winner` | 전체 | `{ playerId }` | 오프라인 결승 뒤 사회자가 우승자 지정. 스크린은 왕관·팡파르, 우승자 폰은 축하 화면 |
| `host:alert` | `host` | `{ level, message }` | 생존자 0명, 대기실 0명에 패자부활전 시도, 스냅샷 복구 등 운영 경고 |

### `room:state` 내용

```ts
// 공통
type PublicPlayer = { id: string; name: string; avatar: AvatarSpec; status: "ACTIVE"|"WAITING"|"ELIMINATED"; strikes: number; connected: boolean; choice?: "O"|"X" };

type RoundMode = "NORMAL" | "REVIVAL";

// 참가자 폰이 받는 것: 남의 선택은 없다. canAnswer는 서버가 계산한 이번 라운드 자격
type RoomStateForPlayer = { status: RoomStatus; mode?: RoundMode; me: PublicPlayer; canAnswer: boolean; question?: QuestionPublic; deadline?: number; playerCount: number };

// 스크린이 받는 것: 전원 위치를 다시 그릴 수 있어야 한다. mode로 무대 교대 상태를 복원.
// players[].choice는 liveMoves이거나 TIME_UP 이후에만 채우고, 숨김 모드의 ANSWERING 중에는 hasAnswered만 준다
type RoomStateForScreen = { status: RoomStatus; mode?: RoundMode; liveMoves?: boolean; players: (PublicPlayer & { hasAnswered?: boolean })[]; question?: QuestionPublic; deadline?: number; counts?: {O:number;X:number;none:number}; answer?: "O"|"X"; winnerId?: string; joinUrl: string };

// 사회자: 스크린 것 + 정답 + 전화번호 + 진행 인덱스
type RoomStateForHost = RoomStateForScreen & { questions: Question[]; currentIndex: number; config: RoomConfig; phones: Record<string,string> };
```

## 클라이언트 → 서버 이벤트

| 이벤트 | 보내는 쪽 | 페이로드 | 서버 동작 |
|---|---|---|---|
| `time:ping` | 전체 | `{ clientSent }` | 즉시 `time:pong` |
| `answer:choose` | 참가자 | `{ index, choice: "O" \| "X" }` | 상태 `ANSWERING`, `now ≤ deadline + grace`, 참가자가 이번 라운드 자격자(`NORMAL`→`ACTIVE`, `REVIVAL`→`WAITING`)인지 확인 → 저장, `answer:moved`·`answer:ack` 발송. 자격 없으면 무시(ack 없음). 300ms 안에 반복 오면 무시 |
| `host:lock` / `host:unlock` | 사회자 | — | `LOBBY ↔ LOCKED`. unlock은 `LOCKED`에서만 |
| `host:showQuestion` | 사회자 | `{ index?, mode? }` | 기본은 다음 미출제 문제를 `NORMAL`로. 특정 문제로 건너뛰기 허용. `mode` 생략 시 문제의 `kind`를 따름 |
| `host:startRevival` | 사회자 | `{ index?, force? }` | `REVEALED`에서만, `WAITING` 1명 이상일 때만. `kind = REVIVAL`인 다음 미출제 문제(없으면 지정 문제)를 `REVIVAL` 모드로 `QUESTION_SHOWN`. 이미 한 번 열었으면(`revival_used_count ≥ 1`) `force: true`가 없으면 거절. 조건 미충족 시 `host:alert` |
| `host:startTimer` | 사회자 | `{ seconds? }` | 문제 기본 제한시간 또는 지정값으로 마감 시각 계산 |
| `host:extendTimer` | 사회자 | `{ seconds }` | 마감 시각 연장 → `question:extended` |
| `host:endTimerNow` | 사회자 | — | 즉시 `TIME_UP` |
| `host:reveal` | 사회자 | — | 판정 실행([[game-flow]] 판정 규칙) |
| `host:undoReveal` | 사회자 | — | 직전 스냅샷 복원 |
| `host:cancelRound` | 사회자 | — | 답변 폐기 |
| `host:next` | 사회자 | — | 다음 문제 또는 종료 |
| `host:end` | 사회자 | — | 강제 종료 |
| `host:setWinner` | 사회자 | `{ playerId }` | `ENDED`에서만, 생존자 중 한 명 → `game:winner`. 다시 보내면 교체 |
| `host:restore` / `host:kick` | 사회자 | `{ playerId }` | 참가자 수동 개입 |
| `host:updateConfig` | 사회자 | `Partial<RoomConfig>` | `LOBBY`/`LOCKED`에서만 허용. 단 `revivalAfterOrderNo`·`liveMovesUntilOrderNo`는 게임 중에도 변경 가능 |
| `host:questions:replace` / `host:question:upsert` / `host:question:delete` | 사회자 | 문제 목록 / 문제 1개 / `{ id }` | 문제 편집. 출제한 문제는 삭제·순서 변경 불가 |
| `host:resetRoom` | 사회자 | `{ confirm: true, keepQuestions }` | 새 방 코드로 초기화. 참가자·기록 삭제, 문제는 선택 유지. 참가자 소켓에 `room:reset` 후 종료 |

모든 사회자 명령은 서버가 현재 상태에서 허용되는지 확인하고, 아니면 `host:alert`로 이유를 돌려준다. 버튼 연타로 같은 명령이 두 번 오면 두 번째는 무시된다(멱등).

## 트래픽 추정

참가자 50명(설계 상한 100명)이 한 문제에서 평균 2번 선택을 바꾸면 스크린은 문제당 100~200개의 `answer:moved`(각 60바이트 미만)를 받는다. 초당 10개 수준이라 노트북이 휴대폰 핫스팟으로 연결되어 있어도 여유가 크다. 참가자 폰은 문제당 이벤트 5~6개만 받으므로 이동통신 데이터 환경에서도 부담이 없다. 스크린이 끊겼다 붙으면 `room:state`(100명 × 약 120바이트 ≈ 12KB) 한 번으로 복구한다.

## 실패 처리

| 실패 상황 | 동작 |
|---|---|
| 페이로드 스키마 불일치 | 무시 + 서버 로그. 응답 없음 |
| 마감 후 도착한 답 | 무시. 참가자 폰은 ack가 안 오므로 "마감되었습니다" 표시 유지 |
| 스크린 키/호스트 PIN 불일치 | `connect_error`. 클라이언트는 재시도하지 않고 안내 |
| 참가자 소켓 중복 연결(같은 토큰으로 탭 2개) | 마지막 연결만 유지, 이전 소켓에 `session:replaced` 후 종료 |

## 의존성

- [[game-flow]] — 각 명령이 허용되는 상태
- [[data-model]] — 페이로드에 담기는 엔티티의 원본 정의

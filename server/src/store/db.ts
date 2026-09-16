// SQLite 영속화. Node 내장 node:sqlite를 사용해 네이티브 모듈 빌드가 필요 없다.
// 스키마는 DOCS/design/data-model.md를 따르되, 방은 하나뿐이므로 저장은 "전체 교체" 한 트랜잭션으로 한다.
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DEFAULT_CONFIG, type AnswerRecord, type Player, type Question, type Room, type RoomState, type RoundResult } from '@ox/shared';

const SCHEMA_VERSION = 2;

const MIGRATIONS: Record<number, string> = {
  1: `
    CREATE TABLE IF NOT EXISTS rooms (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL,
      round_mode TEXT,
      current_index INTEGER NOT NULL,
      deadline_at INTEGER,
      revival_used_count INTEGER NOT NULL DEFAULT 0,
      winner_player_id TEXT,
      config TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      phones_purged_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS players (
      id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL,
      phone TEXT,
      name TEXT NOT NULL,
      avatar TEXT NOT NULL,
      strikes INTEGER NOT NULL,
      status TEXT NOT NULL,
      session_token_hash TEXT NOT NULL,
      connected INTEGER NOT NULL,
      joined_at INTEGER NOT NULL,
      consent_at INTEGER NOT NULL,
      eliminated_at_index INTEGER,
      revived_at_index INTEGER
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_players_phone ON players(room_id, phone);
    CREATE INDEX IF NOT EXISTS idx_players_token ON players(session_token_hash);
    CREATE TABLE IF NOT EXISTS questions (
      id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL,
      order_no INTEGER NOT NULL,
      kind TEXT NOT NULL,
      text TEXT NOT NULL,
      answer TEXT NOT NULL,
      time_limit_sec INTEGER,
      image_url TEXT,
      explanation TEXT,
      used_at INTEGER
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_questions_order ON questions(room_id, order_no);
    CREATE TABLE IF NOT EXISTS answers (
      question_id TEXT NOT NULL,
      player_id TEXT NOT NULL,
      choice TEXT,
      answered_at INTEGER,
      change_count INTEGER NOT NULL,
      is_correct INTEGER,
      PRIMARY KEY (question_id, player_id)
    );
    CREATE TABLE IF NOT EXISTS round_results (
      question_id TEXT PRIMARY KEY,
      idx INTEGER NOT NULL,
      mode TEXT NOT NULL,
      counts TEXT NOT NULL,
      outcomes TEXT NOT NULL,
      snapshot_before TEXT NOT NULL,
      revealed_at INTEGER NOT NULL,
      undone INTEGER NOT NULL
    );
  `,
  // v2: 문제 사진(방 상태와 별도로 보관, 전체 교체 저장에서 지우지 않음) + 결승 규칙 상태
  2: `
    CREATE TABLE IF NOT EXISTS images (
      id TEXT PRIMARY KEY,
      mime TEXT NOT NULL,
      bytes BLOB NOT NULL,
      size INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    ALTER TABLE rooms ADD COLUMN pending_revival INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE rooms ADD COLUMN finale_at INTEGER;
  `,
};

type Row = Record<string, unknown>;
const int = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const bool = (v: unknown) => Number(v) === 1;

export class Store {
  private db: DatabaseSync;
  /** save()가 끝날 때마다 호출(GCS 스냅샷 등) */
  onSaved: (() => void) | null = null;

  constructor(public readonly path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.migrate();
  }

  private migrate(): void {
    const row = this.db.prepare('PRAGMA user_version').get() as Row;
    let version = Number(row['user_version'] ?? 0);
    while (version < SCHEMA_VERSION) {
      const next = version + 1;
      const sql = MIGRATIONS[next];
      if (!sql) break;
      this.db.exec('BEGIN');
      try {
        this.db.exec(sql);
        this.db.exec(`PRAGMA user_version = ${next}`);
        this.db.exec('COMMIT');
      } catch (e) {
        this.db.exec('ROLLBACK');
        throw e;
      }
      version = next;
    }
  }

  /** 상태 전체를 한 트랜잭션으로 저장한다. 참가자 100명·문제 50개 규모에서는 수 ms */
  save(state: RoomState): void {
    const db = this.db;
    db.exec('BEGIN');
    try {
      for (const t of ['rooms', 'players', 'questions', 'answers', 'round_results']) db.exec(`DELETE FROM ${t}`);
      const r = state.room;
      db.prepare(
        `INSERT INTO rooms (id, code, status, round_mode, current_index, deadline_at, revival_used_count, winner_player_id, config, created_at, updated_at, phones_purged_at, pending_revival, finale_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(r.id, r.code, r.status, r.roundMode, r.currentIndex, r.deadlineAt, r.revivalUsedCount, r.winnerPlayerId, JSON.stringify(r.config), r.createdAt, r.updatedAt, r.phonesPurgedAt, r.pendingRevival ? 1 : 0, r.finaleAt);

      const insPlayer = db.prepare(
        `INSERT INTO players (id, room_id, phone, name, avatar, strikes, status, session_token_hash, connected, joined_at, consent_at, eliminated_at_index, revived_at_index)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const p of Object.values(state.players)) {
        insPlayer.run(p.id, r.id, p.phone, p.name, JSON.stringify(p.avatar), p.strikes, p.status, p.sessionTokenHash, p.connected ? 1 : 0, p.joinedAt, p.consentAt, p.eliminatedAtIndex, p.revivedAtIndex);
      }

      const insQ = db.prepare(
        `INSERT INTO questions (id, room_id, order_no, kind, text, answer, time_limit_sec, image_url, explanation, used_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const q of state.questions) insQ.run(q.id, r.id, q.orderNo, q.kind, q.text, q.answer, q.timeLimitSec, q.imageUrl, q.explanation, q.usedAt);

      const insA = db.prepare(
        `INSERT INTO answers (question_id, player_id, choice, answered_at, change_count, is_correct) VALUES (?, ?, ?, ?, ?, ?)`,
      );
      for (const [qid, byPlayer] of Object.entries(state.answers)) {
        for (const [pid, a] of Object.entries(byPlayer)) {
          insA.run(qid, pid, a.choice, a.answeredAt, a.changeCount, a.isCorrect === null ? null : a.isCorrect ? 1 : 0);
        }
      }

      const insR = db.prepare(
        `INSERT INTO round_results (question_id, idx, mode, counts, outcomes, snapshot_before, revealed_at, undone) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const rr of Object.values(state.roundResults)) {
        insR.run(rr.questionId, rr.index, rr.mode, JSON.stringify(rr.counts), JSON.stringify(rr.outcomes), JSON.stringify(rr.snapshotBefore), rr.revealedAt, rr.undone ? 1 : 0);
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    this.onSaved?.();
  }

  // ---- 문제 사진 ----

  putImage(id: string, mime: string, bytes: Uint8Array, now = Date.now()): void {
    this.db.prepare('INSERT OR REPLACE INTO images (id, mime, bytes, size, created_at) VALUES (?, ?, ?, ?, ?)').run(id, mime, bytes, bytes.byteLength, now);
  }

  getImage(id: string): { mime: string; bytes: Uint8Array } | null {
    const row = this.db.prepare('SELECT mime, bytes FROM images WHERE id = ?').get(id) as Row | undefined;
    if (!row) return null;
    return { mime: String(row['mime']), bytes: row['bytes'] as Uint8Array };
  }

  deleteImage(id: string): void {
    this.db.prepare('DELETE FROM images WHERE id = ?').run(id);
  }

  /** WAL 내용까지 포함한 일관된 사본을 만든다 */
  copyTo(path: string): void {
    this.db.exec(`VACUUM INTO '${path.replace(/'/g, "''")}'`);
  }

  /** 저장된 방이 없으면 null */
  load(): RoomState | null {
    const roomRow = this.db.prepare('SELECT * FROM rooms LIMIT 1').get() as Row | undefined;
    if (!roomRow) return null;
    const room: Room = {
      id: String(roomRow['id']),
      code: String(roomRow['code']),
      status: roomRow['status'] as Room['status'],
      roundMode: (roomRow['round_mode'] as Room['roundMode']) ?? null,
      currentIndex: Number(roomRow['current_index']),
      deadlineAt: int(roomRow['deadline_at']),
      autoStartAt: null,
      pendingRevival: bool(roomRow['pending_revival']),
      finaleAt: null,
      revivalUsedCount: Number(roomRow['revival_used_count']),
      winnerPlayerId: (roomRow['winner_player_id'] as string | null) ?? null,
      // 예전 저장분에 새 설정 항목이 없으면 기본값으로 채운다
      config: { ...DEFAULT_CONFIG, ...(JSON.parse(String(roomRow['config'])) as Partial<Room['config']>) },
      createdAt: Number(roomRow['created_at']),
      updatedAt: Number(roomRow['updated_at']),
      phonesPurgedAt: int(roomRow['phones_purged_at']),
    };

    const players: Record<string, Player> = {};
    for (const row of this.db.prepare('SELECT * FROM players').all() as Row[]) {
      const p: Player = {
        id: String(row['id']),
        phone: (row['phone'] as string | null) ?? null,
        name: String(row['name']),
        avatar: JSON.parse(String(row['avatar'])),
        strikes: Number(row['strikes']),
        status: row['status'] as Player['status'],
        sessionTokenHash: String(row['session_token_hash']),
        connected: bool(row['connected']),
        joinedAt: Number(row['joined_at']),
        consentAt: Number(row['consent_at']),
        eliminatedAtIndex: int(row['eliminated_at_index']),
        revivedAtIndex: int(row['revived_at_index']),
      };
      players[p.id] = p;
    }

    const questions: Question[] = (this.db.prepare('SELECT * FROM questions ORDER BY order_no').all() as Row[]).map((row) => ({
      id: String(row['id']),
      orderNo: Number(row['order_no']),
      kind: row['kind'] as Question['kind'],
      text: String(row['text']),
      answer: row['answer'] as Question['answer'],
      timeLimitSec: int(row['time_limit_sec']),
      imageUrl: (row['image_url'] as string | null) ?? null,
      explanation: (row['explanation'] as string | null) ?? null,
      usedAt: int(row['used_at']),
    }));

    const answers: RoomState['answers'] = {};
    for (const row of this.db.prepare('SELECT * FROM answers').all() as Row[]) {
      const qid = String(row['question_id']);
      const rec: AnswerRecord = {
        choice: (row['choice'] as AnswerRecord['choice']) ?? null,
        answeredAt: int(row['answered_at']),
        changeCount: Number(row['change_count']),
        isCorrect: row['is_correct'] === null || row['is_correct'] === undefined ? null : bool(row['is_correct']),
      };
      (answers[qid] ??= {})[String(row['player_id'])] = rec;
    }

    const roundResults: Record<string, RoundResult> = {};
    for (const row of this.db.prepare('SELECT * FROM round_results').all() as Row[]) {
      const rr: RoundResult = {
        questionId: String(row['question_id']),
        index: Number(row['idx']),
        mode: row['mode'] as RoundResult['mode'],
        counts: JSON.parse(String(row['counts'])),
        outcomes: JSON.parse(String(row['outcomes'])),
        snapshotBefore: JSON.parse(String(row['snapshot_before'])),
        revealedAt: Number(row['revealed_at']),
        undone: bool(row['undone']),
      };
      roundResults[rr.questionId] = rr;
    }

    return { room, players, questions, currentAnswers: {}, answers, roundResults };
  }

  close(): void {
    this.db.close();
  }
}

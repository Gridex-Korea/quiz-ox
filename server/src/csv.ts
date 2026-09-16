// 문제 CSV 가져오기와 참가자 CSV 내보내기. 외부 의존성 없이 RFC 4180 최소 구현.
import { formatPhone, questionInputSchema, type QuestionInput, type RoomState } from '@ox/shared';

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') inQuotes = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

const HEADER_ALIASES: Record<string, keyof QuestionInput> = {
  order: 'orderNo',
  orderno: 'orderNo',
  '순서': 'orderNo',
  '번호': 'orderNo',
  kind: 'kind',
  '종류': 'kind',
  '구분': 'kind',
  text: 'text',
  question: 'text',
  '지문': 'text',
  '문제': 'text',
  answer: 'answer',
  '정답': 'answer',
  timelimitsec: 'timeLimitSec',
  time: 'timeLimitSec',
  '제한시간': 'timeLimitSec',
  imageurl: 'imageUrl',
  image: 'imageUrl',
  '이미지': 'imageUrl',
  explanation: 'explanation',
  '해설': 'explanation',
};

const KIND_ALIASES: Record<string, 'NORMAL' | 'REVIVAL'> = {
  normal: 'NORMAL',
  '일반': 'NORMAL',
  revival: 'REVIVAL',
  '부활': 'REVIVAL',
  '패자부활': 'REVIVAL',
  '패자부활전': 'REVIVAL',
};

export interface CsvImportResult {
  questions: QuestionInput[];
  errors: string[];
}

/** 헤더 행이 있으면 헤더로 매핑하고, 없으면 order,kind,text,answer,timeLimitSec,imageUrl,explanation 순서로 본다 */
export function questionsFromCsv(text: string): CsvImportResult {
  const rows = parseCsv(text);
  const errors: string[] = [];
  if (rows.length === 0) return { questions: [], errors: ['비어 있는 파일입니다.'] };

  const first = rows[0]!.map((c) => c.trim().toLowerCase().replace(/\s/g, ''));
  const hasHeader = first.some((c) => c in HEADER_ALIASES);
  const columns: (keyof QuestionInput | null)[] = hasHeader
    ? first.map((c) => HEADER_ALIASES[c] ?? null)
    : ['orderNo', 'kind', 'text', 'answer', 'timeLimitSec', 'imageUrl', 'explanation'];
  const dataRows = hasHeader ? rows.slice(1) : rows;

  const questions: QuestionInput[] = [];
  dataRows.forEach((cells, i) => {
    const lineNo = i + (hasHeader ? 2 : 1);
    const raw: Record<string, unknown> = {};
    columns.forEach((key, ci) => {
      if (!key) return;
      const v = (cells[ci] ?? '').trim();
      if (v === '') return;
      if (key === 'orderNo' || key === 'timeLimitSec') raw[key] = Number(v);
      else if (key === 'kind') raw[key] = KIND_ALIASES[v.toLowerCase()] ?? v.toUpperCase();
      else if (key === 'answer') raw[key] = v.toUpperCase() === 'ㅇ' ? 'O' : v.toUpperCase();
      else raw[key] = v;
    });
    const parsed = questionInputSchema.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      errors.push(`${lineNo}행: ${issue ? `${String(issue.path[0] ?? '')} ${issue.message}` : '형식 오류'}`);
      return;
    }
    questions.push(parsed.data);
  });
  return { questions, errors };
}

function csvCell(v: string | number | null | undefined): string {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const STATUS_KO: Record<string, string> = { ACTIVE: '생존', WAITING: '대기실', ELIMINATED: '탈락' };

/** 참가자 목록 CSV (엑셀용 BOM 포함). 전화번호가 들어가므로 사회자 전용 */
export function participantsCsv(state: RoomState): string {
  const header = ['이름', '전화번호', '상태', '스트라이크', '탈락문제', '부활문제', '입장시각', '우승'];
  const lines = [header.join(',')];
  const players = Object.values(state.players).sort((a, b) => a.joinedAt - b.joinedAt);
  for (const p of players) {
    lines.push(
      [
        csvCell(p.name),
        csvCell(formatPhone(p.phone)),
        csvCell(STATUS_KO[p.status] ?? p.status),
        csvCell(p.strikes),
        csvCell(p.eliminatedAtIndex === null ? '' : p.eliminatedAtIndex + 1),
        csvCell(p.revivedAtIndex === null ? '' : p.revivedAtIndex + 1),
        csvCell(new Date(p.joinedAt).toISOString()),
        csvCell(state.room.winnerPlayerId === p.id ? 'O' : ''),
      ].join(','),
    );
  }
  return String.fromCharCode(0xfeff) + lines.join('\r\n') + '\r\n';
}

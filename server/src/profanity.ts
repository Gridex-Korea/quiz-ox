// 채팅 욕설 필터. 완벽한 차단은 불가능하므로 "흔한 표현을 가려 스크린에 크게 뜨지 않게" 하는 것이 목표다.
// 걸러지지 않은 말은 사회자가 콘솔 채팅 탭에서 지운다.

/** 걸러낼 표현. 한글 욕설과 자음 축약형, 영어 비속어. 우회를 막기 위해 비교 전에 문자를 정규화한다 */
const WORDS = [
  // 한글
  '시발', '씨발', '씨빨', '시바', '씨바', '쉬발', '쒸발', '시펄', '씨펄', '십알',
  '병신', '븅신', '빙신', '등신', '멍청이', '또라이', '돌아이',
  '지랄', '지럴', '개소리', '개새끼', '개색기', '개세끼', '새끼', '색기', '쌔끼',
  '좆', '좇', '존나', '졸라', '조까', '꺼져', '닥쳐', '엿먹',
  '미친놈', '미친년', '미친새', '썅', '쌍놈', '쌍년', '개년', '개놈',
  '보지', '자지', '섹스', '야동', '창녀', '창놈', '걸레년',
  '느금마', '니미', '애미', '애비뒤', '엠창', '패드립',
  '죽어라', '뒤져라', '꺼지라',
  // 자음 축약형
  'ㅅㅂ', 'ㅆㅂ', 'ㅂㅅ', 'ㄲㅈ', 'ㅈㄹ', 'ㅁㅊ', 'ㄱㅅㄲ', 'ㅅㄲ', 'ㅈㄴ', 'ㅆㄹㄱ',
  // 영어
  'fuck', 'fck', 'fuk', 'shit', 'bitch', 'asshole', 'bastard', 'dick', 'pussy', 'cunt', 'retard', 'nigger',
];

/** 우회 표기를 최대한 원형으로 되돌린다: 공백·기호 제거, 알파벳 소문자화, 숫자 치환 */
function normalizeForMatch(text: string): { normalized: string; map: number[] } {
  const normalized: string[] = [];
  const map: number[] = []; // normalized 각 글자가 원문 몇 번째 글자에서 왔는지
  const digitLike: Record<string, string> = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', '$': 's' };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (/[\s.,!?~*_\-+=/\\|()[\]{}'"^<>:;#&%]/.test(ch)) continue; // 사이에 낀 기호·공백 무시
    const lower = ch.toLowerCase();
    const mapped = digitLike[lower] ?? lower;
    normalized.push(mapped);
    map.push(i);
  }
  return { normalized: normalized.join(''), map };
}

export interface FilterResult {
  text: string;
  /** 걸러낸 표현이 있었는가 */
  filtered: boolean;
}

/**
 * 욕설을 ●로 가린다. 원문의 해당 구간만 바꾸므로 나머지 문장은 그대로 남는다.
 * 전부 가려져 남는 글자가 없으면 빈 문자열을 돌려준다(호출 쪽에서 전송을 막는다).
 */
export function filterProfanity(raw: string): FilterResult {
  const { normalized, map } = normalizeForMatch(raw);
  if (!normalized) return { text: raw, filtered: false };

  const hide = new Set<number>(); // 가릴 원문 인덱스
  for (const word of WORDS) {
    let from = 0;
    for (;;) {
      const at = normalized.indexOf(word, from);
      if (at < 0) break;
      for (let k = at; k < at + word.length; k++) {
        const origin = map[k];
        if (origin !== undefined) hide.add(origin);
      }
      from = at + 1;
    }
  }
  if (hide.size === 0) return { text: raw, filtered: false };

  let out = '';
  for (let i = 0; i < raw.length; i++) out += hide.has(i) ? '●' : raw[i];
  return { text: out.replace(/●+/g, (m) => '●'.repeat(Math.min(m.length, 5))), filtered: true };
}

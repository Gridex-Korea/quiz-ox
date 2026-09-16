import { describe, expect, it } from 'vitest';
import { filterProfanity } from './profanity';

describe('욕설 필터', () => {
  it('평범한 응원은 그대로 둔다', () => {
    for (const ok of ['다들 화이팅!', 'O 가 정답이지 ㅋㅋ', '아 아깝다 ㅠㅠ', '사회자님 최고', '5초 남았어!']) {
      expect(filterProfanity(ok)).toEqual({ text: ok, filtered: false });
    }
  });

  it('한글 욕설을 가린다', () => {
    const r = filterProfanity('아 시발 틀렸네');
    expect(r.filtered).toBe(true);
    expect(r.text).not.toContain('시발');
    expect(r.text).toContain('아 ');
    expect(r.text).toContain('틀렸네');
  });

  it('자음 축약형과 영어도 가린다', () => {
    expect(filterProfanity('ㅅㅂ 이게 뭐야').filtered).toBe(true);
    expect(filterProfanity('what the fuck').filtered).toBe(true);
    expect(filterProfanity('개새끼야').filtered).toBe(true);
  });

  it('사이에 공백·기호·숫자를 넣은 우회도 잡는다', () => {
    expect(filterProfanity('시 발').filtered).toBe(true);
    expect(filterProfanity('시*발').filtered).toBe(true);
    expect(filterProfanity('f u c k').filtered).toBe(true);
    expect(filterProfanity('sh1t').filtered).toBe(true);
  });

  it('욕설만 있으면 남는 글자가 없다', () => {
    const r = filterProfanity('시발');
    expect(r.text.replace(/●/g, '').trim()).toBe('');
  });

  it('가린 부분은 최대 5글자로 줄인다', () => {
    const r = filterProfanity('개새끼개새끼개새끼 그만');
    expect(r.text).toMatch(/^●{1,5} 그만$/);
  });
});

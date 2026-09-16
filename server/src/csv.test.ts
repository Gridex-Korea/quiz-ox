import { describe, expect, it } from 'vitest';
import { createInitialState } from './engine/state';
import { parseCsv, participantsCsv, questionsFromCsv } from './csv';

describe('CSV', () => {
  it('BOM을 벗겨 읽고, 내보낼 때는 BOM을 붙인다', () => {
    const rows = parseCsv(String.fromCharCode(0xfeff) + 'a,b\n');
    expect(rows[0]![0]).toBe('a');
    const out = participantsCsv(createInitialState(0));
    expect(out.charCodeAt(0)).toBe(0xfeff);
    expect(out.slice(1)).toMatch(/^이름,전화번호/);
  });

  it('따옴표·쉼표·줄바꿈을 처리한다', () => {
    const rows = parseCsv('a,"b,c","d ""e""",f\r\n1,2,"3\n4",5\n');
    expect(rows).toEqual([
      ['a', 'b,c', 'd "e"', 'f'],
      ['1', '2', '3\n4', '5'],
    ]);
  });

  it('영문 헤더와 한글 헤더를 모두 인식하고 잘못된 행은 오류로 모은다', () => {
    const en = questionsFromCsv('order,kind,text,answer,timeLimitSec\n1,,지구는 둥글다,O,10\n2,revival,달은 별이다,X,\n3,,정답이 이상함,Y,15\n');
    expect(en.questions).toHaveLength(2);
    expect(en.questions[1]!.kind).toBe('REVIVAL');
    expect(en.questions[0]!.timeLimitSec).toBe(10);
    expect(en.errors).toHaveLength(1);
    expect(en.errors[0]).toContain('4행');

    const ko = questionsFromCsv('﻿문제,정답,종류,해설\n"물은 100도에서 끓는다",o,일반,기압 기준\n');
    expect(ko.questions).toHaveLength(1);
    expect(ko.questions[0]).toMatchObject({ text: '물은 100도에서 끓는다', answer: 'O', kind: 'NORMAL', explanation: '기압 기준' });
  });

  it('헤더가 없으면 고정 순서로 본다', () => {
    const r = questionsFromCsv(',,"헤더 없는 문제",X\n');
    expect(r.questions).toHaveLength(1);
    expect(r.questions[0]!.answer).toBe('X');
  });
});

import { describe, expect, it } from 'vitest';
import { collectTexts } from '../providers/findImagePart';
import { parseAnalysis } from './hairAnalyzer';

const valid = {
  length: { value: 'medium', confidence: 'high', reason: '어깨에 닿음' },
  texture: { value: 'wavy', confidence: 'medium', reason: '끝에 웨이브' },
  density: { value: 'high', confidence: 'high', reason: '볼륨이 많음' },
  damage: { value: 2, confidence: 'low', reason: '윤기 있음' },
  currentLevel: { value: 3, confidence: 'medium', reason: '자연 흑갈색' },
  colorDescription: '자연 흑갈색',
  notes: '조명이 따뜻함',
};

describe('parseAnalysis', () => {
  it('정상 JSON', () => {
    const a = parseAnalysis(JSON.stringify(valid), 'm');
    expect(a.texture.value).toBe('wavy');
    expect(a.damage.value).toBe(2);
    expect(a.model).toBe('m');
  });
  it('코드펜스 제거, 범위 밖 숫자는 클램프, 문자열 숫자 허용', () => {
    const a = parseAnalysis('```json\n' + JSON.stringify({ ...valid, damage: { ...valid.damage, value: 9 }, currentLevel: { ...valid.currentLevel, value: '4' } }) + '\n```', 'm');
    expect(a.damage.value).toBe(5);
    expect(a.currentLevel.value).toBe(4);
  });
  it('enum 밖 값은 오류', () => {
    expect(() => parseAnalysis(JSON.stringify({ ...valid, texture: { ...valid.texture, value: 'kinky' } }), 'm')).toThrow(/texture/);
  });
  it('잘못된 확신도는 low로', () => {
    expect(parseAnalysis(JSON.stringify({ ...valid, length: { ...valid.length, confidence: 'sure' } }), 'm').length.confidence).toBe('low');
  });
});

describe('collectTexts', () => {
  it('입력 프롬프트와 출력이 섞여도 모두 모으고 사고 블록은 제외', () => {
    const texts = collectTexts({
      steps: [
        { role: 'user', content: [{ type: 'text', text: 'PROMPT' }] },
        { content: [{ type: 'thought', text: 'thinking…' }, { type: 'text', text: '{"a":1}' }] },
      ],
      usage: { text: 'x' },
    });
    expect(texts).toEqual(['PROMPT', '{"a":1}']);
  });
});

describe('parseStyleAnalysis', () => {
  it('중복·빈 태그 제거, 최대 3개, 잘못된 확신도는 low', async () => {
    const { parseStyleAnalysis } = await import('./styleAnalyzer');
    const a = parseStyleAnalysis(
      JSON.stringify({
        suggestions: [
          { tag: ' 허쉬컷 ', description: 'a', confidence: 'high' },
          { tag: '허쉬컷', description: 'dup', confidence: 'high' },
          { tag: '', description: 'empty', confidence: 'high' },
          { tag: '레이어드컷', description: 'b', confidence: 'sure' },
          { tag: '태슬컷', description: 'c', confidence: 'low' },
          { tag: '보브컷', description: 'd', confidence: 'low' },
        ],
      }),
      'm',
    );
    expect(a.suggestions.map((s) => s.tag)).toEqual(['허쉬컷', '레이어드컷', '태슬컷']);
    expect(a.suggestions[1]!.confidence).toBe('low');
  });
  it('추천이 하나도 없으면 오류', async () => {
    const { parseStyleAnalysis } = await import('./styleAnalyzer');
    expect(() => parseStyleAnalysis('{"suggestions":[]}', 'm')).toThrow();
  });
});

describe('parseStyleAnalysis · 비슷한 스타일 (v2)', () => {
  const suggestions = [
    { tag: '허쉬컷', description: 'a', confidence: 'high' },
    { tag: '레이어드컷', description: 'b', confidence: 'medium' },
    { tag: '태슬컷', description: 'c', confidence: 'low' },
  ];
  it('추천과 같은 태그·중복·빈 항목을 빼고 최대 4개', async () => {
    const { parseStyleAnalysis } = await import('./styleAnalyzer');
    const s = (tag: string) => ({ tag, description: `${tag} 설명`, diffFromReference: '다른 점' });
    const a = parseStyleAnalysis(
      JSON.stringify({ suggestions, similarStyles: [s('허쉬컷'), s('리프컷'), s('리프컷'), { tag: '', description: 'x' }, s('보브컷'), s('C컬펌 단발'), s('히피펌'), s('빌드펌')] }),
      'm',
    );
    expect(a.similarStyles.map((x) => x.tag)).toEqual(['리프컷', '보브컷', 'C컬펌 단발', '히피펌']);
    expect(a.similarStyles[0]).toEqual({ tag: '리프컷', description: '리프컷 설명', diffFromReference: '다른 점' });
  });
  it('없거나 형식이 틀리면 [] (추천은 그대로)', async () => {
    const { parseStyleAnalysis } = await import('./styleAnalyzer');
    expect(parseStyleAnalysis(JSON.stringify({ suggestions }), 'm').similarStyles).toEqual([]);
    const a = parseStyleAnalysis(JSON.stringify({ suggestions, similarStyles: 'x' }), 'm');
    expect(a.similarStyles).toEqual([]);
    expect(a.suggestions).toHaveLength(3);
  });
});

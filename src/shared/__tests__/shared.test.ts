import { describe, expect, it } from 'vitest';
import { PRESERVE_INSTRUCTION, buildPrompt, getSafeToneRange, splitToneSteps, type HairProfile } from '../index';

/** 테스트 고정 프로필 (원본은 실험용 BASE_PROFILE을 썼다) */
const BASE_PROFILE: HairProfile = {
  length: 'medium',
  texture: 'wavy',
  density: 'medium',
  damage: 3,
  history: [
    { type: 'cut', date: '2026-08-20' },
    { type: 'color', date: '2026-08-10' },
    { type: 'perm', date: '2026-06-01' },
  ],
  currentLevel: 6,
};

describe('getSafeToneRange (임시 규칙)', () => {
  const now = new Date('2026-09-28');
  it('기본 4~8', () => {
    expect(getSafeToneRange({ ...BASE_PROFILE, damage: 2, history: [] }, now)).toMatchObject({ min: 4, max: 8 });
  });
  it('손상도 4 이상이면 상한 7', () => {
    expect(getSafeToneRange({ ...BASE_PROFILE, damage: 4, history: [] }, now).max).toBe(7);
  });
  it('4주 내 탈색이면 상한을 현재 레벨로', () => {
    const p: HairProfile = { ...BASE_PROFILE, damage: 2, currentLevel: 6, history: [{ type: 'bleach', date: '2026-09-10' }] };
    expect(getSafeToneRange(p, now).max).toBe(6);
  });
  it('오래된 탈색은 무시', () => {
    const p: HairProfile = { ...BASE_PROFILE, damage: 2, currentLevel: 6, history: [{ type: 'bleach', date: '2026-05-01' }] };
    expect(getSafeToneRange(p, now).max).toBe(8);
  });
  it('5단계 균등 분할', () => {
    expect(splitToneSteps({ min: 4, max: 8 }, 5)).toEqual([4, 5, 6, 7, 8]);
    expect(splitToneSteps({ min: 4, max: 6 }, 5)).toEqual([4, 4.5, 5, 5.5, 6]);
  });
});

describe('buildPrompt', () => {
  it('모든 버전·작업에 보존 지시 포함', () => {
    for (const v of ['v1', 'v2'] as const) {
      expect(buildPrompt(BASE_PROFILE, 'C컬 레이어드', { task: 'style', hasReference: true }, v).text).toContain(PRESERVE_INSTRUCTION);
      expect(buildPrompt(BASE_PROFILE, '', { task: 'tone', toneLevel: 6 }, v).text).toContain(PRESERVE_INSTRUCTION);
    }
  });
  it('조건이 프롬프트에 반영되고 버전이 기록된다', () => {
    const curly = buildPrompt({ ...BASE_PROFILE, texture: 'curly' }, 'x', { task: 'style', hasReference: true }, 'v2');
    expect(curly.promptVersion).toBe('v2');
    expect(curly.text).toContain('curly');
    expect(curly.text).toContain('spiral');
  });
  it('기장: 레퍼런스를 따르되 현재 기장보다 길게는 금지', () => {
    const t = buildPrompt({ ...BASE_PROFILE, length: 'medium' }, '숏컷', { task: 'style', hasReference: true }).text;
    expect(t).toContain('follow the cut length of the second image');
    expect(t).toContain('never make the hair longer than');
    expect(t).toContain('shoulder length');
  });
  it('현재 머리색 유지 지시에 프로필 명도 레벨 포함', () => {
    const t = buildPrompt({ ...BASE_PROFILE, currentLevel: 3 }, 'x', { task: 'style', hasReference: true }).text;
    expect(t).toContain("keep this person's current hair color (about level 3");
  });
  it('톤 프롬프트는 레벨마다 달라지고 hue는 고정', () => {
    const a = buildPrompt(BASE_PROFILE, '', { task: 'tone', toneLevel: 4 }).text;
    const b = buildPrompt(BASE_PROFILE, '', { task: 'tone', toneLevel: 8 }).text;
    expect(a).not.toEqual(b);
    expect(a).toContain('ash brown');
    expect(b).toContain('ash brown');
  });
});

describe('buildPrompt · 비슷한 스타일 (v2)', () => {
  it('레퍼런스 없이 특징 한 줄을 넣는다', () => {
    for (const v of ['v1', 'v2'] as const) {
      const t = buildPrompt(BASE_PROFILE, '리프컷', { task: 'style', hasReference: false, styleDescription: '얼굴선을 따라 층을 낸 컷' }, v).text;
      expect(t).toContain('Apply the hairstyle "리프컷".');
      expect(t).toContain('Style features: 얼굴선을 따라 층을 낸 컷');
      expect(t).not.toContain('second image');
      expect(t).toContain(PRESERVE_INSTRUCTION);
    }
  });
  it('특징이 없거나 레퍼런스가 있으면 기존 프롬프트와 같다', () => {
    const plain = buildPrompt(BASE_PROFILE, 'x', { task: 'style', hasReference: false }).text;
    expect(plain).not.toContain('Style features');
    const withRef = buildPrompt(BASE_PROFILE, 'x', { task: 'style', hasReference: true, styleDescription: 'y' }).text;
    expect(withRef).toBe(buildPrompt(BASE_PROFILE, 'x', { task: 'style', hasReference: true }).text);
  });
});

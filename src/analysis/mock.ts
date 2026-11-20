// AI_MODE=mock 전용 고정 분석 결과. 확신도를 섞어 두어 "한 번 확인해 주세요" 표시를 확인할 수 있게 한다.
import type { HairAnalysis, StyleAnalysis } from '../shared/index.js';
import { mockDelay } from '../providers/mock.js';

export async function mockAnalyzeHair(): Promise<HairAnalysis> {
  const started = performance.now();
  await mockDelay();
  return {
    model: 'mock-analyzer',
    analyzedAt: new Date().toISOString(),
    length: { value: 'medium', confidence: 'high', reason: '머리끝이 어깨선에 닿아요.' },
    texture: { value: 'wavy', confidence: 'medium', reason: '끝부분에 약한 S자 웨이브가 보여요.' },
    density: { value: 'medium', confidence: 'low', reason: '조명이 어두워 두피 비침을 판단하기 어려워요.' },
    damage: { value: 3, confidence: 'medium', reason: '끝이 조금 건조하고 윤기가 약해요.' },
    currentLevel: { value: 5, confidence: 'high', reason: '자연 흑갈색보다 한 톤 밝은 갈색이에요.' },
    colorDescription: '어두운 갈색',
    notes: '예시 분석 결과입니다 (AI_MODE=mock).',
    latencyMs: Math.round(performance.now() - started),
  };
}

export async function mockAnalyzeStyle(): Promise<StyleAnalysis> {
  const started = performance.now();
  await mockDelay();
  return {
    model: 'mock-analyzer',
    analyzedAt: new Date().toISOString(),
    suggestions: [
      { tag: '레이어드컷', description: '어깨 기장에 층을 많이 내어 가볍게 떨어지는 스타일이에요.', confidence: 'high' },
      { tag: '허쉬컷', description: '정수리 볼륨과 얼굴선 레이어가 강조된 스타일이에요.', confidence: 'medium' },
      { tag: '시스루뱅 레이어드컷', description: '얇은 앞머리를 더한 레이어드컷이에요.', confidence: 'low' },
    ],
    similarStyles: [
      { tag: '태슬컷', description: '층 없이 끝을 일자로 떨어뜨린 어깨 기장 컷이에요.', diffFromReference: '레이어가 없어 손질이 쉽고 숱이 많아 보여요.' },
      { tag: '레이어드 C컬펌', description: '레이어드컷에 끝을 C자로 말아 넣은 펌이에요.', diffFromReference: '끝에 컬이 들어가 볼륨이 더 살아요.' },
      { tag: '리프컷', description: '얼굴선을 따라 잎 모양으로 층을 낸 컷이에요.', diffFromReference: '층이 얼굴 주변에만 있어 더 차분해요.' },
      { tag: '보브컷', description: '턱선 기장의 둥근 단발이에요.', diffFromReference: '기장이 더 짧아 지금 기장에서도 만들 수 있어요.' },
    ],
    latencyMs: Math.round(performance.now() - started),
  };
}

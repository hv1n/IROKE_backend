// 시술 종류·난이도 산정. 손님이 고르지 않고 요청 등록 때 서버가 정한다.
// AI_MODE=gemini: Gemini가 스타일·손상도·최근 약제 시술·밝기를 종합 (실패하면 아래 규칙으로 대체)
// AI_MODE=mock: 아래 고정 규칙
import { TREATMENT_LABELS, type Difficulty, type RequestCard, type TreatmentType } from '../shared';
import { recentChemicals } from './hairTags';

export interface TreatmentEstimate {
  treatmentType: TreatmentType;
  difficulty: Difficulty;
  /** 근거 한 줄 */
  difficultyReason: string;
}

export interface TreatmentEstimator {
  readonly model: string;
  estimate(card: RequestCard, now: Date): Promise<TreatmentEstimate>;
}

/** 스타일명 키워드 → 시술 종류 (앞에서부터 먼저 맞는 것) */
const KEYWORDS: [TreatmentType, RegExp][] = [
  ['bleach', /탈색|블리치|하이라이트|발레아쥬|옴브레/],
  ['color', /염색|컬러|톤다운|톤업|브릿지/],
  ['perm', /펌|웨이브|컬/],
];
const BASE: Record<TreatmentType, Difficulty> = { cut: 'low', perm: 'medium', color: 'medium', bleach: 'high' };
const UP: Record<Difficulty, Difficulty> = { low: 'medium', medium: 'high', high: 'high' };
const HIGH_DAMAGE = 4;

export function inferTreatmentType(styleTag: string): TreatmentType {
  return KEYWORDS.find(([, re]) => re.test(styleTag))?.[0] ?? 'cut';
}

/** 고정 규칙: 종류별 기본 난이도, 손상도 4 이상이거나 90일 안 약제 시술이 있으면 한 단계 올림 */
export function ruleEstimate(card: RequestCard, now: Date): TreatmentEstimate {
  const treatmentType = inferTreatmentType(card.styleTag);
  const reasons = [`${TREATMENT_LABELS[treatmentType]} 기본 ${label(BASE[treatmentType])}`];
  const recent = recentChemicals(card.profile, now);
  let difficulty = BASE[treatmentType];
  if (card.profile.damage >= HIGH_DAMAGE || recent.length) {
    difficulty = UP[difficulty];
    const why = [
      ...(card.profile.damage >= HIGH_DAMAGE ? [`손상도 ${card.profile.damage}`] : []),
      ...(recent.length ? [`최근 3개월 ${recent.map((t) => TREATMENT_LABELS[t]).join('·')}`] : []),
    ];
    reasons.push(`${why.join(', ')} → 한 단계 올림`);
  }
  return { treatmentType, difficulty, difficultyReason: reasons.join(' · ') };
}

function label(d: Difficulty) {
  return d === 'low' ? '쉬움' : d === 'medium' ? '보통' : '어려움';
}

export const ruleEstimator: TreatmentEstimator = {
  model: 'rule-v1',
  async estimate(card, now) {
    return ruleEstimate(card, now);
  },
};

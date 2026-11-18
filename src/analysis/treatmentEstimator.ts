// AI_MODE=gemini: 요청 카드(스타일·모발 정보)로 시술 종류·난이도를 산정한다. 사진은 보내지 않는다.
// 실패하면 요청 등록을 막지 않고 고정 규칙으로 대체한다.
import { DAMAGE_LABELS, DENSITY_LABELS, LENGTH_LABELS, TEXTURE_LABELS, TREATMENT_LABELS, type RequestCard } from '../shared';
import { env } from '../env';
import { logEvent } from '../lib/log';
import { ruleEstimate, type TreatmentEstimate, type TreatmentEstimator } from '../services/treatment';
import { ProviderError } from '../providers/types';
import { analyzeImageJson, parseJsonText } from './geminiJson';

const TYPES = ['cut', 'perm', 'color', 'bleach'] as const;
const LEVELS = ['low', 'medium', 'high'] as const;

const SCHEMA = {
  type: 'object',
  properties: {
    treatmentType: { type: 'string', enum: TYPES },
    difficulty: { type: 'string', enum: LEVELS },
    difficultyReason: { type: 'string' },
  },
  required: ['treatmentType', 'difficulty', 'difficultyReason'],
};

export function buildTreatmentPrompt(card: RequestCard, now: Date): string {
  const p = card.profile;
  const history = p.history.length
    ? p.history.map((t) => `${TREATMENT_LABELS[t.type]} ${t.date}`).join(', ')
    : '없음';
  return `You are a senior hair designer at a Korean salon. A customer wants the hairstyle below. Decide:
- treatmentType: the main salon service needed — cut | perm | color | bleach (choose the most chemically demanding one that is required).
- difficulty: low | medium | high for a designer, considering the target style, current damage, recent chemical treatments (perm/color/bleach within ~3 months make further chemical work riskier) and how far the current lightness is from what the style needs (lightening by several levels usually needs bleach).
- difficultyReason: one short Korean sentence (max 60 characters) explaining the difficulty.
Today: ${now.toISOString().slice(0, 10)}
Target style: ${card.styleTag}
Current hair: length ${LENGTH_LABELS[p.length]}, texture ${TEXTURE_LABELS[p.texture]}, density ${DENSITY_LABELS[p.density]}, damage ${DAMAGE_LABELS[p.damage]}, lightness level ${p.currentLevel ?? 'unknown'} (1 black – 10 lightest)
Treatment history: ${history}`;
}

export function parseTreatment(text: string): TreatmentEstimate {
  const json = parseJsonText(text);
  if (!TYPES.includes(json.treatmentType as never) || !LEVELS.includes(json.difficulty as never)) {
    throw new ProviderError(`난이도 산정 결과가 올바르지 않음: ${text.slice(0, 200)}`);
  }
  const reason = typeof json.difficultyReason === 'string' ? json.difficultyReason.trim().slice(0, 100) : '';
  return {
    treatmentType: json.treatmentType as TreatmentEstimate['treatmentType'],
    difficulty: json.difficulty as TreatmentEstimate['difficulty'],
    difficultyReason: reason,
  };
}

export const geminiTreatmentEstimator: TreatmentEstimator = {
  model: env.gemini.analyzeModel,
  async estimate(card, now) {
    try {
      const { result } = await analyzeImageJson({
        label: 'treatment',
        prompt: buildTreatmentPrompt(card, now),
        schema: SCHEMA,
        parse: (text) => parseTreatment(text),
      });
      if (!result.difficultyReason) return { ...result, difficultyReason: ruleEstimate(card, now).difficultyReason };
      return result;
    } catch (err) {
      void logEvent('treatment_estimate_failed', { error: (err as Error).message });
      return ruleEstimate(card, now);
    }
  },
};

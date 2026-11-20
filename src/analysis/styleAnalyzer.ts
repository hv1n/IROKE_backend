import { SIMILAR_STYLE_MAX, type Confidence, type SimilarStyle, type StyleAnalysis, type StyleSuggestion } from '../shared/index.js';
import { ProviderError, type ImageBlob } from '../providers/types.js';
import { analyzeImageJson, parseJsonText } from './geminiJson.js';

export const STYLE_SUGGESTION_COUNT = 3;
const CONFIDENCES: Confidence[] = ['high', 'medium', 'low'];

const STYLE_PROMPT = `You are an experienced hair designer at a Korean salon. Look ONLY at the hairstyle in this reference photo (ignore the face and do not identify the person).
Suggest exactly ${STYLE_SUGGESTION_COUNT} Korean salon style names that best describe this hairstyle, ordered from best fit to worst.
- tag: the name a customer would say at a Korean salon, written in Korean, at most 15 characters. Each tag must name the whole hairstyle (cut, optionally with perm), never bangs alone; include bangs only as a modifier (e.g. 허쉬컷, 레이어드컷, 태슬컷, 보브컷, 픽시컷, 리프컷, C컬펌 단발, 히피펌, 빌드펌, 레이어드 C컬펌, 시스루뱅 리프컷). The 3 tags must be different from each other.
- description: one Korean sentence describing the visible features (length, layers, bangs, curl, volume).
- confidence: high | medium | low.
Also suggest up to ${SIMILAR_STYLE_MAX} similarStyles: other Korean salon styles that look similar to this reference but are NOT the same as any of the suggestions above (for example a softer, shorter or lower-maintenance variation). Return an empty array if there is no good candidate.
- tag: Korean style name, at most 15 characters, following the same naming rules as above.
- description: one Korean sentence describing its visible features.
- diffFromReference: one Korean sentence on how it differs from the reference hairstyle.`;

const SCHEMA = {
  type: 'object',
  properties: {
    suggestions: {
      type: 'array',
      minItems: STYLE_SUGGESTION_COUNT,
      maxItems: STYLE_SUGGESTION_COUNT,
      items: {
        type: 'object',
        properties: {
          tag: { type: 'string' },
          description: { type: 'string' },
          confidence: { type: 'string', enum: CONFIDENCES },
        },
        required: ['tag', 'description', 'confidence'],
      },
    },
    similarStyles: {
      type: 'array',
      maxItems: SIMILAR_STYLE_MAX,
      items: {
        type: 'object',
        properties: {
          tag: { type: 'string' },
          description: { type: 'string' },
          diffFromReference: { type: 'string' },
        },
        required: ['tag', 'description', 'diffFromReference'],
      },
    },
  },
  required: ['suggestions', 'similarStyles'],
};

/** 비슷한 스타일 검증: 빈 태그·중복·추천과 같은 태그 제거, 최대 4개. 형식이 틀려도 실패시키지 않고 []로 둔다. */
export function parseSimilarStyles(raw: unknown, exclude: Set<string>): SimilarStyle[] {
  const list = Array.isArray(raw) ? (raw as Record<string, unknown>[]) : [];
  const seen = new Set(exclude);
  const out: SimilarStyle[] = [];
  for (const r of list) {
    if (!r || typeof r !== 'object') continue;
    const tag = typeof r.tag === 'string' ? r.tag.trim().slice(0, 30) : '';
    const description = typeof r.description === 'string' ? r.description.trim() : '';
    if (!tag || !description || seen.has(tag)) continue;
    seen.add(tag);
    out.push({ tag, description, diffFromReference: typeof r.diffFromReference === 'string' ? r.diffFromReference.trim() : '' });
    if (out.length === SIMILAR_STYLE_MAX) break;
  }
  return out;
}

/** 모델 출력 검증: 빈 태그·중복 제거, 최대 3개 + 비슷한 스타일 최대 4개 */
export function parseStyleAnalysis(text: string, model: string): StyleAnalysis {
  const json = parseJsonText(text);
  const raw = Array.isArray(json.suggestions) ? (json.suggestions as Record<string, unknown>[]) : [];
  const seen = new Set<string>();
  const suggestions: StyleSuggestion[] = [];
  for (const r of raw) {
    const tag = typeof r.tag === 'string' ? r.tag.trim().slice(0, 30) : '';
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    suggestions.push({
      tag,
      description: typeof r.description === 'string' ? r.description : '',
      confidence: CONFIDENCES.includes(r.confidence as Confidence) ? (r.confidence as Confidence) : 'low',
    });
    if (suggestions.length === STYLE_SUGGESTION_COUNT) break;
  }
  if (!suggestions.length) throw new ProviderError(`스타일 추천이 비어 있음: ${text.slice(0, 200)}`);
  const similarStyles = parseSimilarStyles(json.similarStyles, seen);
  return { model, analyzedAt: new Date().toISOString(), suggestions, similarStyles };
}

/** 레퍼런스 사진에서 스타일명 3개와 비슷한 스타일 최대 4개를 추천한다 */
export async function analyzeStyle(image: ImageBlob): Promise<StyleAnalysis> {
  const { result, latencyMs } = await analyzeImageJson({ label: 'style', prompt: STYLE_PROMPT, image, schema: SCHEMA, parse: parseStyleAnalysis });
  return { ...result, latencyMs };
}

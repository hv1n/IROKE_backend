import type { HairProfile, PromptVersion } from '../types.js';
import { buildV1 } from './v1.js';
import { buildV2 } from './v2.js';

/** 모든 버전에 반드시 들어가는 보존 지시 */
export const PRESERVE_INSTRUCTION =
  "Change ONLY the hair. Keep the person's face, facial features, identity, expression, skin, " +
  'body, clothing, background, lighting, camera angle and framing exactly the same as the first image.';

export type PromptOptions =
  /** styleDescription: 레퍼런스 없이 만들 때 스타일 특징 한 줄 (v2 비슷한 스타일). 없으면 기존 프롬프트와 같다. */
  | { task: 'style'; hasReference: boolean; styleDescription?: string }
  | { task: 'tone'; toneLevel: number };

export interface BuiltPrompt {
  text: string;
  promptVersion: PromptVersion;
}

export const PROMPT_VERSIONS: { id: PromptVersion; note: string }[] = [
  { id: 'v1', note: '기본: 프로필 속성을 서술형으로 전달' },
  { id: 'v2', note: '조건별 시각 단서 보강 (곱슬 패턴·두피 비침 등)' },
];

export const DEFAULT_PROMPT_VERSION: PromptVersion = 'v1';

/**
 * 헤어 프로필을 이미지 편집 모델용 프롬프트로 변환한다.
 * 첫 번째 이미지는 항상 사용자 사진(셀카 또는 기준 시안), 두 번째는 레퍼런스(있을 때).
 */
export function buildPrompt(
  profile: HairProfile,
  styleTag: string,
  options: PromptOptions,
  version: PromptVersion = DEFAULT_PROMPT_VERSION,
): BuiltPrompt {
  const body = version === 'v2' ? buildV2(profile, styleTag, options) : buildV1(profile, styleTag, options);
  return { text: [PRESERVE_INSTRUCTION, ...body].join('\n'), promptVersion: version };
}

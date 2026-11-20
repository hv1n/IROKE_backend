import type { HairAnalysis, StyleAnalysis } from '../shared/index.js';
import { env } from '../env.js';
import type { ImageBlob } from '../providers/types.js';
import { analyzeHair } from './hairAnalyzer.js';
import { mockAnalyzeHair, mockAnalyzeStyle } from './mock.js';
import { analyzeStyle } from './styleAnalyzer.js';

/** AI_MODE에 맞는 분석기 */
export const analyzers: {
  hair: (image: ImageBlob) => Promise<HairAnalysis>;
  style: (image: ImageBlob) => Promise<StyleAnalysis>;
} = env.aiMode === 'gemini' ? { hair: analyzeHair, style: analyzeStyle } : { hair: mockAnalyzeHair, style: mockAnalyzeStyle };

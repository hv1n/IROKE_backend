import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PROMPT_VERSION, type AiMode, type PromptVersion } from './shared';

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const list = (v: string | undefined, fallback: string[]) =>
  v ? v.split(',').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean) : fallback;

try {
  process.loadEnvFile(path.join(serverRoot, '.env'));
} catch {
  // .env가 없으면 기본값(mock)으로 동작한다
}

const num = (v: string | undefined, fallback: number) => (v && !Number.isNaN(Number(v)) ? Number(v) : fallback);

const port = num(process.env.PORT, 8787);
const dataMode: 'memory' | 'supabase' = process.env.DATA_MODE === 'supabase' ? 'supabase' : 'memory';
/** Vercel 배포(프리뷰 포함)는 NODE_ENV=production */
const isProduction = process.env.NODE_ENV === 'production' || Boolean(process.env.VERCEL_ENV);
const aiMode: AiMode = process.env.AI_MODE === 'gemini' ? 'gemini' : 'mock';
const promptVersion: PromptVersion = process.env.PROMPT_VERSION === 'v2' ? 'v2' : DEFAULT_PROMPT_VERSION;

export const env = {
  port,
  isProduction,
  /** memory = 로컬·테스트 (재시작하면 초기화, 시드 3명 자동), supabase = Postgres + Storage */
  dataMode,
  /** memory 모드 서명 URL의 주소 (dev 업로드·보기 경로) */
  publicBaseUrl: (process.env.PUBLIC_BASE_URL || `http://localhost:${port}`).replace(/\/$/, ''),
  /** 자체 JWT 서명 키. memory 모드 로컬 실행에서만 기본값을 쓴다 */
  jwtSecret: process.env.JWT_SECRET || (dataMode === 'memory' && !isProduction ? 'iroke-dev-only-secret' : ''),
  /** 로그인 토큰 유효 시간 (초, 기본 7일) */
  jwtTtlSec: num(process.env.JWT_TTL_SEC, 7 * 24 * 60 * 60),
  /** POST·GET /api/internal/jobs/sweep 보호 (Vercel Cron이 Authorization: Bearer로 보냄). 비우면 배치 호출 불가 */
  cronSecret: process.env.CRON_SECRET ?? '',
  /** 개발용 로그인(POST /api/auth/dev)과 dev 업로드 경로: memory 모드 + production 아님 */
  devRoutes: dataMode === 'memory' && !isProduction,
  databaseUrl: process.env.DATABASE_URL ?? '',
  supabase: {
    url: process.env.SUPABASE_URL ?? '',
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY ?? '',
    bucket: process.env.SUPABASE_BUCKET || 'iroke-private',
  },
  kakao: {
    restApiKey: process.env.KAKAO_REST_API_KEY ?? '',
    clientSecret: process.env.KAKAO_CLIENT_SECRET ?? '',
  },
  /** 브라우저 호출을 허용할 출처 (쉼표 구분) */
  corsOrigins: list(process.env.CORS_ORIGINS, ['https://iroke.vercel.app', 'http://localhost:5173']),
  /** mock = API 비용 없이 전체 플로우 확인, gemini = 실제 분석·생성 */
  aiMode,
  promptVersion,
  /** 사용자(브라우저 ID)별 하루 시안 생성 횟수. 비우면 제한 없음 (정책 미정) */
  generationDailyLimit: process.env.GENERATION_DAILY_LIMIT ? num(process.env.GENERATION_DAILY_LIMIT, 0) : null,
  generationTimeoutMs: num(process.env.GENERATION_TIMEOUT_MS, 60_000),
  analysisTimeoutMs: num(process.env.ANALYSIS_TIMEOUT_MS, 30_000),
  /** 이벤트 로그(JSONL) 위치. 사진은 기록하지 않는다. */
  logDir: path.resolve(serverRoot, process.env.LOG_DIR ?? 'logs'),
  gemini: {
    apiKey: process.env.GEMINI_API_KEY ?? '',
    model: process.env.GEMINI_MODEL || 'gemini-nano-banana-2.1',
    imageSize: process.env.GEMINI_IMAGE_SIZE || '1K',
    /** 셀카 모발 분석·스타일 추천용 텍스트 모델 */
    analyzeModel: process.env.GEMINI_ANALYZE_MODEL || 'gemini-3.5-flash-lite',
    /** 분석 모델이 과부하일 때 대체 모델 (비우면 사용 안 함) */
    analyzeFallbackModel: process.env.GEMINI_ANALYZE_FALLBACK_MODEL ?? 'gemini-3.8-flash',
    /** 1이면 응답 구조를 콘솔에 출력 (base64는 잘라서) */
    debug: process.env.GEMINI_DEBUG === '1' || process.env.GEMINI_DEBUG === 'full',
  },
  mock: {
    delayMinMs: num(process.env.MOCK_DELAY_MIN_MS, 800),
    delayMaxMs: num(process.env.MOCK_DELAY_MAX_MS, 2500),
  },
};

if (env.aiMode === 'gemini' && !env.gemini.apiKey) {
  throw new Error('AI_MODE=gemini인데 GEMINI_API_KEY가 없습니다. .env를 확인하세요.');
}
if (!env.jwtSecret) throw new Error('JWT_SECRET이 없습니다. .env를 확인하세요.');
if (env.dataMode === 'supabase') {
  const missing = [
    ['DATABASE_URL', env.databaseUrl],
    ['SUPABASE_URL', env.supabase.url],
    ['SUPABASE_SERVICE_ROLE_KEY', env.supabase.serviceRoleKey],
  ].filter(([, v]) => !v);
  if (missing.length) throw new Error(`DATA_MODE=supabase인데 ${missing.map(([k]) => k).join(', ')}가 없습니다.`);
}

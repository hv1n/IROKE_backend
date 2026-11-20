// 앱이 쓰는 외부 의존성 묶음. 테스트는 createApp(overrides)로 시계·저장소·카카오를 바꿔 끼운다.
import { geminiTreatmentEstimator } from './analysis/treatmentEstimator.js';
import { createKakaoClient, type KakaoClient } from './auth/kakao.js';
import { env } from './env.js';
import { createMemoryRepo } from './repo/memory.js';
import { createPostgresRepo, createSql } from './repo/postgres.js';
import { SEED } from './repo/seed.js';
import type { Repo } from './repo/types.js';
import { ruleEstimator, type TreatmentEstimator } from './services/treatment.js';
import { createMemoryStorage } from './storage/memory.js';
import { createSupabaseStorage } from './storage/supabase.js';
import type { ImageStorage } from './storage/types.js';

export interface AppConfig {
  jwtSecret: string;
  jwtTtlSec: number;
  /** 비면 배치 호출 불가 */
  cronSecret: string;
  /** 개발용 로그인·dev 업로드 경로 */
  devRoutes: boolean;
}

export interface AppDeps {
  repo: Repo;
  storage: ImageStorage;
  now: () => Date;
  kakao: KakaoClient;
  estimator: TreatmentEstimator;
  config: AppConfig;
}

export function createDeps(overrides: Partial<AppDeps> = {}): AppDeps {
  const now = overrides.now ?? (() => new Date());
  const config: AppConfig = {
    jwtSecret: env.jwtSecret,
    jwtTtlSec: env.jwtTtlSec,
    cronSecret: env.cronSecret,
    devRoutes: env.devRoutes,
    ...overrides.config,
  };
  let repo = overrides.repo;
  let storage = overrides.storage;
  if (!repo || !storage) {
    if (env.dataMode === 'supabase') {
      const sql = createSql(env.databaseUrl);
      repo ??= createPostgresRepo(sql);
      storage ??= createSupabaseStorage({ ...env.supabase, sql });
    } else {
      repo ??= createMemoryRepo(SEED);
      storage ??= createMemoryStorage({ baseUrl: env.publicBaseUrl, secret: config.jwtSecret, now });
    }
  }
  return {
    repo,
    storage,
    now,
    kakao: overrides.kakao ?? createKakaoClient(env.kakao),
    estimator: overrides.estimator ?? (env.aiMode === 'gemini' ? geminiTreatmentEstimator : ruleEstimator),
    config,
  };
}

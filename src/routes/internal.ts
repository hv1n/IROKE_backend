// 내부 배치. Vercel Cron은 GET으로만 부르고 Authorization: Bearer <CRON_SECRET>을 붙인다.
// 명세는 POST라서 같은 경로에서 GET(크론)·POST(수동 실행)를 모두 받는다.
import type { Hono } from 'hono';
import type { SweepResult } from '../shared/index.js';
import type { AppDeps } from '../deps.js';
import type { AppEnv } from '../http/context.js';
import { requireCronSecret } from '../http/middleware.js';
import { sweep } from '../services/sweep.js';

export function internalRoutes(app: Hono<AppEnv>, d: AppDeps) {
  const cron = requireCronSecret(d);
  app.on(['GET', 'POST'], '/internal/jobs/sweep', cron, async (c) => c.json<SweepResult>(await sweep(d)));
}

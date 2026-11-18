// Hono 앱 조립: 공통 미들웨어 + 라우트 모듈. 경로는 모두 /api 아래.
// 테스트는 createApp({ now, repo, storage, kakao, ... })로 의존성을 바꿔 끼운다.
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import { MAX_REQUEST_BODY_BYTES } from './shared';
import { createDeps, type AppDeps } from './deps';
import { env } from './env';
import type { AppEnv } from './http/context';
import { ApiFail, fail } from './http/errors';
import { accountRoutes } from './routes/account';
import { creationRoutes } from './routes/creation';
import { designerRoutes } from './routes/designer';
import { devRoutes } from './routes/dev';
import { internalRoutes } from './routes/internal';
import { matchRoutes } from './routes/matches';
import { requestRoutes } from './routes/requests';

const CLIENT_ID = /^[0-9a-f-]{36}$/i;
/** 메모리 저장소의 서명 업로드 경로 (사진 최대 5MB라 본문 한도에서 뺀다. dev 전용) */
const DEV_UPLOAD_PATH = '/api/dev/uploads';

export function createApp(overrides: Partial<AppDeps> = {}) {
  const deps = createDeps(overrides);
  const app = new Hono<AppEnv>().basePath('/api');

  // 프론트(iroke.vercel.app)와 백엔드가 다른 출처라 CORS가 필요하다. 쿠키 없이 Bearer 토큰만 쓴다.
  app.use(
    cors({
      origin: (origin) => (env.corsOrigins.includes(origin) ? origin : null),
      allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowHeaders: ['Content-Type', 'Authorization', 'x-iroke-client-id'],
      maxAge: 600,
    }),
  );
  const limit = bodyLimit({ maxSize: MAX_REQUEST_BODY_BYTES, onError: (c) => fail(c, 413, 'payload_too_large', '요청이 너무 큼') });
  app.use((c, next) => (deps.config.devRoutes && c.req.path === DEV_UPLOAD_PATH ? next() : limit(c, next)));
  // 시안 만들기 흐름은 로그인 없이 브라우저별 임의 ID로 사용자를 구분한다
  app.use(async (c, next) => {
    const id = c.req.header('x-iroke-client-id') ?? '';
    c.set('clientId', CLIENT_ID.test(id) ? id.toLowerCase() : 'anonymous');
    await next();
  });
  app.onError((err, c) => {
    if (err instanceof ApiFail) return fail(c, err.status, err.code, err.message, err.fields);
    console.error(err);
    return fail(c, 500, 'server_error', env.isProduction ? '서버 오류' : err.message);
  });
  app.notFound((c) => fail(c, 404, 'not_found', '없는 경로'));

  creationRoutes(app);
  accountRoutes(app, deps);
  requestRoutes(app, deps);
  designerRoutes(app, deps);
  matchRoutes(app, deps);
  internalRoutes(app, deps);
  if (deps.config.devRoutes) devRoutes(app, deps);

  return app;
}

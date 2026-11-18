// 인증 · 계정 · 업로드 (A-01, 공통)
import type { Hono } from 'hono';
import type { LoginResponse, Me, UploadResponse } from '../shared';
import type { AppDeps } from '../deps';
import { KakaoAuthError } from '../auth/kakao';
import { type AppEnv, readJson } from '../http/context';
import { ApiFail, badRequest, unauthorized } from '../http/errors';
import { requireUser } from '../http/middleware';
import { FieldErrors, isObj, text } from '../http/validate';
import { logEvent } from '../lib/log';
import { getMe, loginWithKakaoUser } from '../services/account';
import { createUpload } from '../services/uploads';

export function accountRoutes(app: Hono<AppEnv>, d: AppDeps) {
  const user = requireUser(d);

  /** 카카오 인가 코드 → 토큰 교환 → users upsert → 자체 JWT. 카카오 토큰은 저장하지 않는다 */
  app.post('/auth/kakao', async (c) => {
    const body = await readJson(c);
    if (!isObj(body)) throw badRequest();
    const e = new FieldErrors();
    const code = text(body.code, 'code', 2000, e);
    const redirectUri = text(body.redirectUri, 'redirectUri', 2000, e);
    e.throwIfAny();
    let kakao;
    try {
      kakao = await d.kakao.exchange(code!, redirectUri!);
    } catch (err) {
      void logEvent('kakao_login_failed', { error: (err as Error).message });
      if (err instanceof KakaoAuthError) throw unauthorized('카카오 로그인에 실패함 (인가 코드가 잘못됐거나 만료됨)');
      throw new ApiFail(502, 'server_error', '카카오 서버에 연결하지 못함');
    }
    return c.json<LoginResponse>(await loginWithKakaoUser(d, kakao));
  });

  /** JWT는 무상태라 클라이언트가 토큰을 버리는 것이 본체 */
  app.post('/auth/logout', user, (c) => c.body(null, 204));

  app.get('/me', user, async (c) => c.json<Me>(await getMe(d, c.get('userId'))));

  /** 서명 업로드 URL 발급 */
  app.post('/uploads', user, async (c) => c.json<UploadResponse>(await createUpload(d, c.get('userId'), await readJson(c)), 201));
}

// 개발 전용 경로 (DATA_MODE=memory이고 production이 아닐 때만 등록된다).
// - POST /api/auth/dev: 카카오 호출 없이 로그인 (시드 계정 kakaoId: seed-designer-1, seed-designer-2, seed-customer-1)
// - PUT /api/dev/uploads, GET /api/dev/files: 메모리 저장소의 서명 업로드·보기 URL
import type { Hono } from 'hono';
import type { LoginResponse } from '../shared';
import type { AppDeps } from '../deps';
import { type AppEnv, readJson } from '../http/context';
import { ApiFail, badRequest, notFound } from '../http/errors';
import { FieldErrors, isObj, text } from '../http/validate';
import { loginWithKakaoUser } from '../services/account';
import type { MemoryStorage } from '../storage/memory';

export function devRoutes(app: Hono<AppEnv>, d: AppDeps) {
  app.post('/auth/dev', async (c) => {
    const body = await readJson(c);
    if (!isObj(body)) throw badRequest();
    const e = new FieldErrors();
    const kakaoId = text(body.kakaoId, 'kakaoId', 64, e);
    const nickname = body.nickname == null ? undefined : text(body.nickname, 'nickname', 30, e);
    e.throwIfAny();
    return c.json<LoginResponse>(await loginWithKakaoUser(d, { kakaoId: kakaoId!, nickname: nickname ?? `개발용 ${kakaoId}` }));
  });

  if (d.storage.kind !== 'memory') return;
  const storage = d.storage as MemoryStorage;
  const q = (c: { req: { query: (k: string) => string | undefined } }, k: string) => c.req.query(k) ?? '';

  // bodyLimit(4.4MB)보다 큰 사진도 받을 수 있게, 이 경로는 bodyLimit 앞에서 처리된다 (createApp 참고)
  app.put('/dev/uploads', async (c) => {
    const data = Buffer.from(await c.req.arrayBuffer());
    const result = storage.acceptUpload(
      { key: q(c, 'key'), exp: q(c, 'exp'), ct: q(c, 'ct'), max: q(c, 'max'), sig: q(c, 'sig') },
      c.req.header('content-type') ?? '',
      data,
    );
    if (result === 'ok') return c.body(null, 200);
    if (result === 'too_large') throw new ApiFail(413, 'payload_too_large', '업로드 크기 한도를 넘음');
    if (result === 'bad_type') throw new ApiFail(400, 'bad_request', 'Content-Type이 발급 때와 다름');
    throw new ApiFail(403, 'forbidden', result === 'expired' ? '업로드 URL이 만료됨' : '서명이 올바르지 않음');
  });

  app.get('/dev/files', (c) => {
    const result = storage.read({ key: q(c, 'key'), exp: q(c, 'exp'), sig: q(c, 'sig') });
    if (result === 'not_found') throw notFound();
    if (typeof result === 'string') throw new ApiFail(403, 'forbidden', result === 'expired' ? '보기 URL이 만료됨' : '서명이 올바르지 않음');
    return c.body(new Uint8Array(result.data), 200, { 'content-type': result.contentType, 'cache-control': 'private, max-age=600' });
  });
}

import { describe, expect, it } from 'vitest';
import { issueToken } from '../src/auth/jwt';
import { DAY, PNG_BYTES, SEED_IDS, SEED_KAKAO_IDS, setup } from './helpers';

describe('POST /auth/kakao', () => {
  it('처음이면 users를 만들고 isNewUser, 두 번째는 같은 사용자', async () => {
    const t = setup();
    const first = await t.call('POST', '/auth/kakao', { body: { code: 'abc', redirectUri: 'http://localhost:5173/auth' } });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ isNewUser: true, expiresIn: 7 * 24 * 60 * 60, user: { nickname: '닉네임 abc', temperature: 36.5, hasHairProfile: false, designer: null } });
    expect(first.body.accessToken).toEqual(expect.any(String));
    const second = await t.call('POST', '/auth/kakao', { body: { code: 'abc', redirectUri: 'http://localhost:5173/auth' } });
    expect(second.body.isNewUser).toBe(false);
    expect(second.body.user.id).toBe(first.body.user.id);
    // 카카오 회원번호·토큰은 응답에 없다
    expect(first.text).not.toContain('kakao-abc');
  });
  it('인가 코드가 잘못되면 401 unauthorized', async () => {
    const res = await setup().call('POST', '/auth/kakao', { body: { code: 'bad', redirectUri: 'http://localhost:5173/auth' } });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('unauthorized');
  });
  it('code·redirectUri가 없으면 422 validation_failed', async () => {
    const res = await setup().call('POST', '/auth/kakao', { body: {} });
    expect(res.status).toBe(422);
    expect(Object.keys(res.body.fields)).toEqual(['code', 'redirectUri']);
  });
});

describe('GET /me · 토큰', () => {
  it('토큰이 없거나 잘못되면 401', async () => {
    const t = setup();
    expect((await t.call('GET', '/me')).status).toBe(401);
    const bad = await t.call('GET', '/me', { token: 'not-a-jwt' });
    expect(bad.status).toBe(401);
    expect(bad.body.code).toBe('unauthorized');
    // 다른 키로 서명한 토큰
    const forged = await issueToken(SEED_IDS.customer1, 'other-secret', 3600, t.now());
    expect((await t.call('GET', '/me', { token: forged })).status).toBe(401);
  });
  it('만료(7일)되면 401', async () => {
    const t = setup();
    const token = await t.login(SEED_KAKAO_IDS.customer1);
    expect((await t.call('GET', '/me', { token })).status).toBe(200);
    t.advance(7 * DAY + 1000);
    expect((await t.call('GET', '/me', { token })).status).toBe(401);
  });
  it('시드 디자이너는 Me.designer가 있고, 손님은 null + 모발 프로필 있음', async () => {
    const t = setup();
    const designer = await t.call('GET', '/me', { token: await t.login(SEED_KAKAO_IDS.designer1) });
    expect(designer.body.designer).toMatchObject({ verifyStatus: 'verified', regions: ['서울 동작구', '서울 관악구'] });
    const customer = await t.call('GET', '/me', { token: await t.login(SEED_KAKAO_IDS.customer1) });
    expect(customer.body).toMatchObject({ id: SEED_IDS.customer1, nickname: '하린', designer: null, hasHairProfile: true });
    expect(customer.text).not.toContain(SEED_KAKAO_IDS.customer1);
  });
  it('POST /auth/logout은 204 (로그인 필요)', async () => {
    const t = setup();
    expect((await t.call('POST', '/auth/logout')).status).toBe(401);
    expect((await t.call('POST', '/auth/logout', { token: await t.login('x') })).status).toBe(204);
  });
});

describe('개발용 로그인', () => {
  it('devRoutes가 꺼져 있으면 /auth/dev와 dev 업로드 경로가 없다 (production)', async () => {
    const t = setup({ config: { jwtSecret: 's', jwtTtlSec: 60, cronSecret: '', devRoutes: false } });
    expect((await t.call('POST', '/auth/dev', { body: { kakaoId: 'x' } })).status).toBe(404);
    expect((await t.call('PUT', '/dev/uploads?key=x')).status).toBe(404);
  });
});

describe('POST /uploads', () => {
  it('key = {purpose}/{userId}/{uuid}, 서명 URL로 PUT하면 올라간다', async () => {
    const t = setup();
    const token = await t.login('u1');
    const uid = await t.userId(token);
    const res = await t.call('POST', '/uploads', { token, body: { purpose: 'request_design', contentType: 'image/png', size: 100 } });
    expect(res.status).toBe(201);
    expect(res.body.key).toMatch(new RegExp(`^request_design/${uid}/[0-9a-f-]{36}$`));
    expect(new Date(res.body.expiresAt).getTime()).toBeGreaterThan(t.now().getTime());
    expect(await t.storage.exists(res.body.key)).toBe(false);
    const put = await t.app.request(res.body.uploadUrl, { method: 'PUT', headers: { 'content-type': 'image/png' }, body: PNG_BYTES });
    expect(put.status).toBe(200);
    expect(await t.storage.exists(res.body.key)).toBe(true);
  });
  it('서명 URL: Content-Type이 다르거나 서명을 바꾸면 거절', async () => {
    const t = setup();
    const token = await t.login('u1');
    const { body } = await t.call('POST', '/uploads', { token, body: { purpose: 'license', contentType: 'image/jpeg', size: 100 } });
    expect((await t.app.request(body.uploadUrl, { method: 'PUT', headers: { 'content-type': 'image/png' }, body: PNG_BYTES })).status).toBe(400);
    const tampered = body.uploadUrl.replace(/key=[^&]+/, `key=${encodeURIComponent('license/other/x')}`);
    expect((await t.app.request(tampered, { method: 'PUT', headers: { 'content-type': 'image/jpeg' }, body: PNG_BYTES })).status).toBe(403);
  });
  it('5MB 초과·허용 안 된 형식·모르는 용도는 422', async () => {
    const t = setup();
    const token = await t.login('u1');
    const res = await t.call('POST', '/uploads', { token, body: { purpose: 'selfie', contentType: 'image/gif', size: 5 * 1024 * 1024 + 1 } });
    expect(res.status).toBe(422);
    expect(Object.keys(res.body.fields).sort()).toEqual(['contentType', 'purpose', 'size']);
  });
  it('result는 진행 중 매칭 당사자만, portfolio는 인증 디자이너만 (403)', async () => {
    const t = setup();
    const token = await t.login('u1');
    const result = await t.call('POST', '/uploads', { token, body: { purpose: 'result', contentType: 'image/png', size: 10 } });
    expect(result.status).toBe(403);
    expect(result.body.code).toBe('forbidden');
    expect((await t.call('POST', '/uploads', { token, body: { purpose: 'portfolio', contentType: 'image/png', size: 10 } })).body.code).toBe('forbidden');
    await t.makeDesigner(token, { verifyStatus: 'pending' });
    expect((await t.call('POST', '/uploads', { token, body: { purpose: 'portfolio', contentType: 'image/png', size: 10 } })).body.code).toBe('not_verified');
  });
  it('로그인 없이는 401', async () => {
    expect((await setup().call('POST', '/uploads', { body: { purpose: 'license', contentType: 'image/png', size: 1 } })).status).toBe(401);
  });
});

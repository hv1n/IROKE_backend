import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { env } from '../src/env.js';
import { CRON_SECRET, DAY, SEED_IDS, SEED_KAKAO_IDS, setup } from './helpers.js';

const cron = { authorization: `Bearer ${CRON_SECRET}` };

async function matchedFlow() {
  const t = setup();
  const customer = await t.login(SEED_KAKAO_IDS.customer1);
  const designer = await t.login(SEED_KAKAO_IDS.designer1);
  const requestId = (await t.createRequest(customer)).body.id as string;
  const responseId = (await t.call('POST', `/requests/${requestId}/responses`, { token: designer, body: t.responseBody() })).body.id as string;
  const matchId = (await t.call('POST', `/responses/${responseId}/accept`, { token: customer })).body.matchId as string;
  return { t, customer, designer, requestId, responseId, matchId };
}

describe('면허 인증 · /designers/verification', () => {
  const body = (key: string, over: Record<string, unknown> = {}) => ({
    licenseImageKey: key,
    name: '홍길동',
    licenseNumber: '2024-123456',
    regions: ['서울 동작구'],
    shopName: '길동 헤어',
    bookingUrl: 'https://example.com/booking/gildong',
    instagram: '@gildong.hair',
    ...over,
  });

  it('202 pending. 이름·면허 번호는 DB·로그 어디에도 남지 않는다', async () => {
    const t = setup();
    const token = await t.login('new-designer');
    expect((await t.call('GET', '/designers/verification', { token })).status).toBe(404);
    const key = await t.upload(token, 'license');
    const res = await t.call('POST', '/designers/verification', { token, body: body(key) });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ verifyStatus: 'pending' });
    const id = await t.userId(token);
    const row = t.repo.state().designerProfiles.get(id)!;
    expect(row).toMatchObject({ verifyStatus: 'pending', licenseImageKey: key, shopName: '길동 헤어', instagram: 'gildong.hair', regions: ['서울 동작구'] });
    const dump = JSON.stringify([...Object.values(t.repo.state())].map((m) => [...m.values()]));
    expect(dump).not.toContain('홍길동');
    expect(dump).not.toContain('2024-123456');
    await new Promise((r) => setTimeout(r, 20));
    if (existsSync(env.logDir)) {
      const logs = readdirSync(env.logDir).map((f) => readFileSync(path.join(env.logDir, f), 'utf8')).join('');
      expect(logs).not.toContain('2024-123456');
      expect(logs).not.toContain('홍길동');
    }
    expect(t.responses.join('')).not.toContain('2024-123456');
    expect((await t.call('GET', '/designers/verification', { token })).body).toEqual({
      verifyStatus: 'pending', rejectReason: null, submittedAt: t.now().toISOString(), decidedAt: null,
    });
    // 신청 직후부터 디자이너(게시판 열람 가능), 응답은 미인증이라 불가
    expect((await t.call('GET', '/me', { token })).body.designer.verifyStatus).toBe('pending');
    expect((await t.call('GET', '/board', { token })).status).toBe(200);
  });

  it('형식 오류는 422, 이미 신청·인증된 계정은 409, 반려되면 다시 제출 가능', async () => {
    const t = setup();
    const token = await t.login('d');
    const key = await t.upload(token, 'license');
    const bad = await t.call('POST', '/designers/verification', {
      token,
      body: body(key, { name: '홍', licenseNumber: '번호', regions: [], bookingUrl: 'http://example.com', instagram: 'no spaces!' }),
    });
    expect(bad.status).toBe(422);
    expect(Object.keys(bad.body.fields).sort()).toEqual(['bookingUrl', 'instagram', 'licenseNumber', 'name', 'regions']);
    expect((await t.call('POST', '/designers/verification', { token, body: body(await t.upload(token, 'request_design')) })).body.fields.licenseImageKey).toBeDefined();
    expect((await t.call('POST', '/designers/verification', { token, body: body(key) })).status).toBe(202);
    expect((await t.call('POST', '/designers/verification', { token, body: body(key) })).body.code).toBe('invalid_state');
    // 관리자가 DB에서 반려 → 배치가 면허 사진 삭제 + 결과 알림
    const id = await t.userId(token);
    await t.repo.updateDesignerProfile(id, { verifyStatus: 'rejected', rejectReason: '면허 사진이 흐려요' });
    t.advance(1000);
    expect((await t.call('POST', '/internal/jobs/sweep', { headers: cron })).body.verificationResults).toBe(1);
    expect(await t.storage.exists(key)).toBe(false);
    expect(t.repo.state().designerProfiles.get(id)).toMatchObject({ licenseImageKey: null, verifiedAt: t.now() });
    expect(t.notificationsOf(id).find((n) => n.type === 'verification_result')?.payload).toEqual({ verifyStatus: 'rejected', rejectReason: '면허 사진이 흐려요' });
    expect((await t.call('GET', '/designers/verification', { token })).body).toMatchObject({ verifyStatus: 'rejected', rejectReason: '면허 사진이 흐려요', decidedAt: t.now().toISOString() });
    expect((await t.call('POST', '/internal/jobs/sweep', { headers: cron })).body.verificationResults).toBe(0);
    // 다시 제출
    const key2 = await t.upload(token, 'license');
    expect((await t.call('POST', '/designers/verification', { token, body: body(key2) })).status).toBe(202);
    expect(t.repo.state().designerProfiles.get(id)).toMatchObject({ verifyStatus: 'pending', rejectReason: null, licenseImageKey: key2 });
  });
});

describe('PATCH /designers/me', () => {
  it('지역·샵·예약 링크(https만)·인스타 수정, 알림 조건 지역은 활동 지역 안으로 줄인다', async () => {
    const t = setup();
    const d1 = await t.login(SEED_KAKAO_IDS.designer1);
    await t.call('PUT', '/designers/me/alert-settings', { token: d1, body: { enabled: true, regions: ['서울 관악구'], treatmentTypes: [], difficulties: [], budgets: [] } });
    const res = await t.call('PATCH', '/designers/me', { token: d1, body: { regions: ['서울 동작구'], instagram: null, shopName: '새 이름' } });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ regions: ['서울 동작구'], shopName: '새 이름', instagram: null, verifyStatus: 'verified' });
    expect((await t.call('GET', '/designers/me/alert-settings', { token: d1 })).body.regions).toEqual([]);
    const bad = await t.call('PATCH', '/designers/me', { token: d1, body: { bookingUrl: 'javascript:alert(1)', regions: ['a b', 'c d', 'e f'] } });
    expect(Object.keys(bad.body.fields).sort()).toEqual(['bookingUrl', 'regions']);
    expect((await t.call('PATCH', '/designers/me', { token: d1, body: { bookingUrl: null } })).status).toBe(422);
    expect((await t.call('PATCH', '/designers/me', { token: d1, body: {} })).status).toBe(422);
    expect((await t.call('PATCH', '/designers/me', { token: await t.login('x'), body: { shopName: 'x' } })).status).toBe(403);
  });
});

describe('디자이너 프로필 · 포트폴리오 (C-04)', () => {
  it('GET /designers/:id: 작업물 수 = 완료 매칭 수, 후기 수, 연락처·예약 링크 없음', async () => {
    const { t, customer, designer, matchId } = await matchedFlow();
    await t.call('POST', `/matches/${matchId}/complete`, { token: designer });
    await t.call('POST', `/matches/${matchId}/confirm`, { token: customer, body: { portfolioConsent: false } });
    await t.call('POST', `/matches/${matchId}/reviews`, { token: customer, body: { satisfaction: 'ok' } });
    const res = await t.call('GET', `/designers/${SEED_IDS.designer1}`, { token: customer });
    expect(res.body).toEqual({
      id: SEED_IDS.designer1,
      nickname: '서윤 디자이너',
      verified: true,
      shopName: '이로케 시연 살롱 상도점',
      area: '서울 동작구 · 서울 관악구',
      instagram: null,
      temperature: 37.2,
      reviewCount: 1,
      verifiedWorkCount: 1,
      manualWorkCount: 0,
      recentDisputes90d: 0,
    });
    expect((await t.call('GET', `/designers/${SEED_IDS.customer1}`, { token: customer })).status).toBe(404);
    expect((await t.call('GET', `/designers/${SEED_IDS.designer1}`)).status).toBe(401);
  });

  it('포트폴리오: 인증 작업물(시술 전 카드 + 서명 URL), source 필터, similarToMe', async () => {
    const { t, customer, designer, matchId } = await matchedFlow();
    await t.call('POST', `/matches/${matchId}/complete`, { token: designer });
    const front = await t.upload(customer, 'result');
    await t.call('POST', `/matches/${matchId}/confirm`, { token: customer, body: { resultImageKeys: [front], portfolioConsent: true } });
    const res = await t.call('GET', `/designers/${SEED_IDS.designer1}/portfolio`, { token: customer });
    expect(res.body.items).toHaveLength(1);
    const item = res.body.items[0];
    expect(item).toMatchObject({ source: 'verified', styleTag: '레이어드 C컬펌', treatmentType: 'perm', hairTags: ['중단발', '반곱슬', '손상도 3', '최근 3개월 염색'], completedAt: t.now().toISOString() });
    expect(item.beforeCard).toMatchObject({ length: 'medium', texture: 'wavy' });
    expect(item.designImageUrl).toMatch(/dev\/files/);
    expect(item.resultImageUrl).toMatch(/dev\/files/);
    expect((await t.call('GET', `/designers/${SEED_IDS.designer1}/portfolio?source=manual`, { token: customer })).body.items).toEqual([]);
    // similarToMe: 내 기장·모질(중단발·반곱슬)이 같은 작업물만
    expect((await t.call('GET', `/designers/${SEED_IDS.designer1}/portfolio?similarToMe=true`, { token: customer })).body.items).toHaveLength(1);
    await t.call('PUT', '/me/hair-profile', {
      token: customer,
      body: { profile: { length: 'short', texture: 'wavy', density: 'low', damage: 2, history: [] }, profileSource: { editedFields: [], confirmedAt: t.now().toISOString() } },
    });
    expect((await t.call('GET', `/designers/${SEED_IDS.designer1}/portfolio?similarToMe=true`, { token: customer })).body.items).toEqual([]);
    // 서버 모발 프로필이 없으면 필터 없이 전체
    expect((await t.call('GET', `/designers/${SEED_IDS.designer1}/portfolio?similarToMe=true`, { token: await t.login('no-profile') })).body.items).toHaveLength(1);
    expect((await t.call('GET', `/designers/${SEED_IDS.designer1}/portfolio?source=all`, { token: customer })).status).toBe(422);
  });
});

describe('내 응답 · 진행 관리 (D-04)', () => {
  it('탭: pending / in_progress / done, canRequestComplete·canReview', async () => {
    const t = setup();
    const c = await t.login(SEED_KAKAO_IDS.customer1);
    const d1 = await t.login(SEED_KAKAO_IDS.designer1);
    const d2 = await t.login(SEED_KAKAO_IDS.designer2);
    const reqA = (await t.createRequest(c)).body.id; // d1, d2 응답 → d1 수락
    t.advance(1000);
    const reqB = (await t.createRequest(c)).body.id; // d1 응답만 (대기)
    const a1 = (await t.call('POST', `/requests/${reqA}/responses`, { token: d1, body: t.responseBody() })).body.id;
    await t.call('POST', `/requests/${reqA}/responses`, { token: d2, body: t.responseBody() });
    await t.call('POST', `/requests/${reqB}/responses`, { token: d1, body: t.responseBody() });
    const matchId = (await t.call('POST', `/responses/${a1}/accept`, { token: c })).body.matchId;

    const tab = async (token: string, name: string) => (await t.call('GET', `/designers/me/responses?tab=${name}`, { token })).body.items;
    expect((await tab(d1, 'pending')).map((x: any) => x.request.id)).toEqual([reqB]);
    const inProgress = await tab(d1, 'in_progress');
    expect(inProgress).toEqual([expect.objectContaining({ request: expect.objectContaining({ id: reqA }), match: expect.objectContaining({ id: matchId, status: 'accepted' }), canRequestComplete: true, canReview: false })]);
    expect((await tab(d2, 'done')).map((x: any) => x.response.status)).toEqual(['not_selected']);

    await t.call('POST', `/matches/${matchId}/complete`, { token: d1 });
    await t.call('POST', `/matches/${matchId}/confirm`, { token: c, body: { portfolioConsent: false } });
    const done = await tab(d1, 'done');
    expect(done).toEqual([expect.objectContaining({ canReview: true, canRequestComplete: false })]);
    await t.call('POST', `/matches/${matchId}/reviews`, { token: d1, body: { promiseKept: 'yes' } });
    expect((await tab(d1, 'done'))[0].canReview).toBe(false);

    // 마감되면 대기 응답은 done으로 (배치 없이)
    t.advance(7 * DAY);
    const d1b = await t.login(SEED_KAKAO_IDS.designer1);
    expect(await tab(d1b, 'pending')).toEqual([]);
    expect((await tab(d1b, 'done')).map((x: any) => x.request.id).sort()).toEqual([reqA, reqB].sort());
    expect((await t.call('GET', '/designers/me/responses?tab=all', { token: d1b })).status).toBe(422);
  });
});

describe('모발 프로필 · /me/hair-profile', () => {
  it('없으면 404, PUT으로 저장(updatedBy user), 형식 오류 422', async () => {
    const t = setup();
    const token = await t.login('new');
    expect((await t.call('GET', '/me/hair-profile', { token })).status).toBe(404);
    const profile = { length: 'bob', texture: 'straight', density: 'high', damage: 2, currentLevel: 4, history: [{ type: 'cut', date: '2026-11-01' }] };
    const put = await t.call('PUT', '/me/hair-profile', { token, body: { profile, profileSource: { editedFields: ['length'], confirmedAt: '2026-11-18T01:00:00.000Z' } } });
    expect(put.status).toBe(200);
    expect(put.body).toEqual({ profile, confirmedAt: '2026-11-18T01:00:00.000Z', updatedAt: t.now().toISOString(), updatedBy: 'user' });
    expect((await t.call('GET', '/me/hair-profile', { token })).body.profile).toEqual(profile);
    expect((await t.call('GET', '/me', { token })).body.hasHairProfile).toBe(true);
    const bad = await t.call('PUT', '/me/hair-profile', { token, body: { profile: { ...profile, damage: 7 }, profileSource: {} } });
    expect(bad.status).toBe(422);
    expect(Object.keys(bad.body.fields).sort()).toEqual(['profile', 'profileSource']);
  });
});

describe('알림 · /notifications', () => {
  it('목록·안 읽은 수, 일부/전체 읽음, 남의 알림은 못 바꾼다', async () => {
    const t = setup();
    const c = await t.login(SEED_KAKAO_IDS.customer1);
    const d1 = await t.login(SEED_KAKAO_IDS.designer1);
    const d2 = await t.login(SEED_KAKAO_IDS.designer2);
    const id = (await t.createRequest(c)).body.id;
    await t.call('POST', `/requests/${id}/responses`, { token: d1, body: t.responseBody() });
    t.advance(1000);
    await t.call('POST', `/requests/${id}/responses`, { token: d2, body: t.responseBody() });
    const list = await t.call('GET', '/notifications', { token: c });
    expect(list.body.unreadCount).toBe(2);
    expect(list.body.items.map((n: any) => n.type)).toEqual(['new_response', 'new_response']);
    expect(list.body.items[0]).toMatchObject({ readAt: null, payload: { requestId: id } });

    // 남의 알림 id로 읽음 처리해도 바뀌지 않는다
    const d1First = (await t.call('GET', '/notifications', { token: d1 })).body.items[0].id;
    expect((await t.call('POST', '/notifications/read', { token: c, body: { ids: [d1First] } })).status).toBe(204);
    expect((await t.call('GET', '/notifications?unreadOnly=true', { token: d1 })).body.unreadCount).toBe(1);

    expect((await t.call('POST', '/notifications/read', { token: c, body: { ids: [list.body.items[0].id] } })).status).toBe(204);
    const unread = await t.call('GET', '/notifications?unreadOnly=true', { token: c });
    expect(unread.body).toMatchObject({ unreadCount: 1 });
    expect(unread.body.items).toHaveLength(1);
    await t.call('POST', '/notifications/read', { token: c });
    expect((await t.call('GET', '/notifications', { token: c })).body.unreadCount).toBe(0);
    expect((await t.call('POST', '/notifications/read', { token: c, body: { ids: ['x'] } })).status).toBe(422);
    expect((await t.call('GET', '/notifications')).status).toBe(401);
  });
});

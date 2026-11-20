import { describe, expect, it } from 'vitest';
import { CARD, DAY, SEED_IDS, SEED_KAKAO_IDS, setup } from './helpers.js';

describe('POST /requests', () => {
  it('201: open, 마감 +7일, 시술 종류·난이도 산정 (mock 규칙), hairTags 저장', async () => {
    const t = setup();
    const token = await t.login(SEED_KAKAO_IDS.customer1);
    const res = await t.createRequest(token);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      status: 'open',
      expiresAt: new Date(t.now().getTime() + 7 * DAY).toISOString(),
      treatmentType: 'perm',
      // 펌 기본 medium + 최근 3개월 염색 → high
      difficulty: 'high',
    });
    expect(res.body.difficultyReason).toContain('최근 3개월 염색');
    const row = t.repo.state().requests.get(res.body.id)!;
    expect(row.hairTags).toEqual(['중단발', '반곱슬', '손상도 3', '최근 3개월 염색']);
    expect(row.cardSnapshot).toEqual(CARD);
    expect(row.designConsentAt).toEqual(t.now());
  });

  it('시안 공개 동의가 없으면 422 consent_required', async () => {
    const t = setup();
    const token = await t.login('c');
    for (const consent of [undefined, {}, { shareDesignWithVerifiedDesigners: false }]) {
      const res = await t.createRequest(token, { consent });
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('consent_required');
    }
  });

  it('필드 규칙 위반은 422 validation_failed + fields', async () => {
    const t = setup();
    const token = await t.login('c');
    const res = await t.createRequest(token, {
      regions: ['서울 동작구', '서울 관악구', '서울 마포구'],
      timing: 'tomorrow',
      budget: 'free',
      card: { ...CARD, profile: { ...CARD.profile, damage: 9 }, requestText: '가'.repeat(501) },
    });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('validation_failed');
    expect(Object.keys(res.body.fields)).toEqual(expect.arrayContaining(['regions', 'timing', 'budget', 'card.profile', 'card.requestText']));
    expect((await t.createRequest(token, { regions: ['동작구'] })).body.fields.regions).toContain('서울 동작구');
  });

  it('시안 key는 본인이 request_design으로 올린 것만', async () => {
    const t = setup();
    const me = await t.login('c');
    const other = await t.login('d');
    const othersKey = await t.upload(other);
    expect((await t.createRequest(me, { designImageKey: othersKey })).body.fields.designImageKey).toBeDefined();
    const license = await t.upload(me, 'license');
    expect((await t.createRequest(me, { designImageKey: license })).status).toBe(422);
    // URL만 받고 올리지 않은 key
    const notUploaded = (await t.call('POST', '/uploads', { token: me, body: { purpose: 'request_design', contentType: 'image/png', size: 10 } })).body.key;
    expect((await t.createRequest(me, { designImageKey: notUploaded })).body.fields.designImageKey).toContain('업로드');
  });

  it('알림 조건이 맞는 디자이너에게만 new_matching_request (본인 제외)', async () => {
    const t = setup();
    // 시드: designer1 = 동작구·관악구, designer2 = 마포구·동작구
    await t.repo.updateDesignerProfile(SEED_IDS.designer2, { alertSettings: { enabled: true, regions: ['서울 마포구'], treatmentTypes: [], difficulties: [], budgets: [] } });
    const customer = await t.login(SEED_KAKAO_IDS.designer1); // 디자이너가 손님으로도 요청 (겸업)
    const res = await t.createRequest(customer);
    expect(t.notificationsOf(SEED_IDS.designer1)).toHaveLength(0); // 본인
    expect(t.notificationsOf(SEED_IDS.designer2)).toHaveLength(0); // 알림 지역이 마포구만
    const other = await t.login(SEED_KAKAO_IDS.customer1);
    const res2 = await t.createRequest(other);
    expect(t.notificationsOf(SEED_IDS.designer1).map((n) => n.payload.requestId)).toEqual([res2.body.id]);
    expect(t.notificationsOf(SEED_IDS.designer1)[0]).toMatchObject({ type: 'new_matching_request' });
    expect(res.status).toBe(201);
  });

  it('인증 대기·반려 디자이너는 조건이 맞아도 new_matching_request를 받지 않는다', async () => {
    const t = setup();
    const pending = await t.login('pending-designer');
    await t.makeDesigner(pending, { verifyStatus: 'pending' });
    const rejected = await t.login('rejected-designer');
    await t.makeDesigner(rejected, { verifyStatus: 'rejected' });
    const customer = await t.login(SEED_KAKAO_IDS.customer1);
    expect((await t.createRequest(customer)).status).toBe(201);
    const idOf = async (token: string) => (await t.call('GET', '/me', { token })).body.id;
    expect(t.notificationsOf(await idOf(pending))).toHaveLength(0);
    expect(t.notificationsOf(await idOf(rejected))).toHaveLength(0);
    expect(t.notificationsOf(SEED_IDS.designer1)).toHaveLength(1); // 인증 디자이너는 받음
  });

  it('로그인 없이는 401', async () => {
    expect((await setup().call('POST', '/requests', { body: {} })).status).toBe(401);
  });
});

describe('내 요청 관리', () => {
  it('GET /requests/mine: 상태 필터, 본인 시안 URL, 응답 수', async () => {
    const t = setup();
    const token = await t.login('c');
    const a = (await t.createRequest(token)).body.id;
    t.advance(1000);
    const b = (await t.createRequest(token)).body.id;
    await t.call('POST', `/requests/${b}/close`, { token });
    const all = await t.call('GET', '/requests/mine', { token });
    expect(all.body.items.map((x: any) => x.id)).toEqual([b, a]);
    expect(all.body.nextCursor).toBeNull();
    const open = await t.call('GET', '/requests/mine?status=open', { token });
    expect(open.body.items).toHaveLength(1);
    expect(open.body.items[0]).toMatchObject({ id: a, status: 'open', responseCount: 0, regions: ['서울 동작구'], timing: 'within_2_weeks', budget: '5_10' });
    expect(open.body.items[0].designImageUrl).toMatch(/^http:\/\/localhost\/api\/dev\/files\?/);
    // 비공개 처리(취소)된 요청도 본인에게는 시안을 보여 준다
    const closed = await t.call('GET', '/requests/mine?status=closed', { token });
    expect(closed.body.items[0]).toMatchObject({ id: b, status: 'cancelled' });
    expect(closed.body.items[0].designImageUrl).toEqual(expect.any(String));
    expect((await t.call('GET', '/requests/mine?status=done', { token })).status).toBe(422);
    // 남의 요청은 안 보인다
    expect((await t.call('GET', '/requests/mine', { token: await t.login('x') })).body.items).toEqual([]);
  });

  it('목록 페이지: limit·cursor', async () => {
    const t = setup();
    const token = await t.login('c');
    for (let i = 0; i < 3; i++) {
      await t.createRequest(token);
      t.advance(1000);
    }
    const p1 = await t.call('GET', '/requests/mine?limit=2', { token });
    expect(p1.body.items).toHaveLength(2);
    const p2 = await t.call('GET', `/requests/mine?limit=2&cursor=${p1.body.nextCursor}`, { token });
    expect(p2.body.items).toHaveLength(1);
    expect(p2.body.nextCursor).toBeNull();
    expect((await t.call('GET', '/requests/mine?limit=51', { token })).status).toBe(422);
  });

  it('GET /requests/:id: 본인은 card·version, 남은 403, 없으면 404', async () => {
    const t = setup();
    const token = await t.login('c');
    const id = (await t.createRequest(token)).body.id;
    const res = await t.call('GET', `/requests/${id}`, { token });
    expect(res.body).toMatchObject({ id, card: CARD, version: 1, matchId: null, treatmentType: 'perm' });
    expect((await t.call('GET', `/requests/${id}`, { token: await t.login('x') })).body.code).toBe('forbidden');
    expect((await t.call('GET', '/requests/00000000-0000-4000-8000-000000000000', { token })).status).toBe(404);
    expect((await t.call('GET', '/requests/not-a-uuid', { token })).status).toBe(404);
  });

  it('PATCH: open일 때만, version +1 → 기존 응답은 isOutdated', async () => {
    const t = setup();
    const token = await t.login('c');
    const designer = await t.login(SEED_KAKAO_IDS.designer1);
    const id = (await t.createRequest(token)).body.id;
    await t.call('POST', `/requests/${id}/responses`, { token: designer, body: t.responseBody() });
    const res = await t.call('PATCH', `/requests/${id}`, { token, body: { budget: null, regions: ['서울 동작구', '서울 관악구'] } });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ version: 2, budget: null, regions: ['서울 동작구', '서울 관악구'] });
    const cards = await t.call('GET', `/requests/${id}/responses`, { token });
    expect(cards.body.items[0].isOutdated).toBe(true);
    const mine = await t.call('GET', `/board/${id}`, { token: designer });
    expect(mine.body.myResponse.isOutdated).toBe(true);

    expect((await t.call('PATCH', `/requests/${id}`, { token, body: {} })).status).toBe(422);
    expect((await t.call('PATCH', `/requests/${id}`, { token, body: { regions: ['a b', 'c d', 'e f'] } })).status).toBe(422);
    await t.call('POST', `/requests/${id}/close`, { token });
    const closed = await t.call('PATCH', `/requests/${id}`, { token, body: { timing: 'any' } });
    expect(closed.status).toBe(409);
    expect(closed.body.code).toBe('invalid_state');
  });

  it('close: open → cancelled, 시안 비공개, 대기 응답 not_selected + 마감 알림. 두 번째는 409', async () => {
    const t = setup();
    const token = await t.login('c');
    const designer = await t.login(SEED_KAKAO_IDS.designer1);
    const id = (await t.createRequest(token)).body.id;
    await t.call('POST', `/requests/${id}/responses`, { token: designer, body: t.responseBody() });
    const res = await t.call('POST', `/requests/${id}/close`, { token });
    expect(res.body).toEqual({ id, status: 'cancelled' });
    const row = t.repo.state().requests.get(id)!;
    expect(row.designHiddenAt).toEqual(t.now());
    expect([...t.repo.state().responses.values()][0]!.status).toBe('not_selected');
    expect(t.notificationsOf(SEED_IDS.designer1).find((n) => n.type === 'request_closed')?.payload).toMatchObject({ requestId: id, reason: 'cancelled' });
    expect((await t.call('POST', `/requests/${id}/close`, { token })).body.code).toBe('invalid_state');
    expect((await t.call('POST', `/requests/${id}/close`, { token: designer })).body.code).toBe('forbidden');
  });

  it('만료는 배치 없이도 조회 때 반영: expired + 시안 비공개 + 대기 응답 not_selected', async () => {
    const t = setup();
    const token = await t.login('c');
    const designer = await t.login(SEED_KAKAO_IDS.designer1);
    const id = (await t.createRequest(token)).body.id;
    await t.call('POST', `/requests/${id}/responses`, { token: designer, body: t.responseBody() });
    t.advance(7 * DAY);
    const res = await t.call('GET', `/requests/${id}`, { token: await t.login('c') }); // 토큰도 7일이라 다시 로그인
    expect(res.body.status).toBe('expired');
    expect(t.repo.state().requests.get(id)!.designHiddenAt).toEqual(t.now());
    expect([...t.repo.state().responses.values()][0]!.status).toBe('not_selected');
    expect(t.notificationsOf(SEED_IDS.designer1).some((n) => n.type === 'request_closed' && n.payload.reason === 'expired')).toBe(true);
    // 목록도 같은 결과
    const t2 = setup();
    const c2 = await t2.login('c');
    await t2.createRequest(c2);
    t2.advance(7 * DAY - 1000);
    expect((await t2.call('GET', '/requests/mine?status=open', { token: c2 })).body.items).toHaveLength(1);
    t2.advance(1000);
    expect((await t2.call('GET', '/requests/mine?status=closed', { token: await t2.login('c') })).body.items[0].status).toBe('expired');
  });

  it('reopen: expired이고 응답 0개일 때만 → open, 마감 다시 +7일, 조건 변경 가능', async () => {
    const t = setup();
    let token = await t.login('c');
    const id = (await t.createRequest(token)).body.id;
    expect((await t.call('POST', `/requests/${id}/reopen`, { token })).body.code).toBe('invalid_state'); // 아직 open
    t.advance(8 * DAY);
    token = await t.login('c');
    const res = await t.call('POST', `/requests/${id}/reopen`, { token, body: { regions: ['서울 동작구', '서울 마포구'] } });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id, status: 'open', expiresAt: new Date(t.now().getTime() + 7 * DAY).toISOString(), version: 2 });
    const row = t.repo.state().requests.get(id)!;
    expect(row.designHiddenAt).toBeNull();
    expect(row.regions).toEqual(['서울 동작구', '서울 마포구']);

    // 응답이 있었던 요청은 다시 올릴 수 없다
    const id2 = (await t.createRequest(token)).body.id;
    await t.call('POST', `/requests/${id2}/responses`, { token: await t.login(SEED_KAKAO_IDS.designer1), body: t.responseBody() });
    t.advance(8 * DAY);
    token = await t.login('c');
    expect((await t.call('POST', `/requests/${id2}/reopen`, { token })).body.code).toBe('invalid_state');
    // 취소한 요청도 불가
    const id3 = (await t.createRequest(token)).body.id;
    await t.call('POST', `/requests/${id3}/close`, { token });
    expect((await t.call('POST', `/requests/${id3}/reopen`, { token })).status).toBe(409);
  });
});

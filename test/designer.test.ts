import { describe, expect, it } from 'vitest';
import { DAY, SEED_IDS, SEED_KAKAO_IDS, hasKeyDeep, setup } from './helpers.js';

/** 손님 1명이 요청 1개를 올린 상태 */
async function withRequest(over: Record<string, unknown> = {}) {
  const t = setup();
  const customer = await t.login(SEED_KAKAO_IDS.customer1);
  const designer = await t.login(SEED_KAKAO_IDS.designer1);
  const requestId = (await t.createRequest(customer, over)).body.id as string;
  return { t, customer, designer, requestId };
}

describe('GET /board', () => {
  it('내 활동 지역의 open 요청, 공개 필드만 — 이미지 URL 없음', async () => {
    const { t, designer, requestId } = await withRequest();
    const res = await t.call('GET', '/board', { token: designer });
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    const item = res.body.items[0];
    expect(Object.keys(item).sort()).toEqual(
      ['budget', 'difficulty', 'expiresAt', 'hairTags', 'id', 'myResponded', 'regions', 'responseCount', 'styleTag', 'timing', 'treatmentType'].sort(),
    );
    expect(item).toMatchObject({ id: requestId, hairTags: ['중단발', '반곱슬', '손상도 3', '최근 3개월 염색'], myResponded: false, responseCount: 0 });
    expect(hasKeyDeep(res.body, (k) => /url|image|key/i.test(k))).toBe(false);
    expect(res.text).not.toMatch(/https?:\/\//);
  });

  it('미인증 디자이너도 목록은 본다. 디자이너가 아니면 403', async () => {
    const { t } = await withRequest();
    const pending = await t.login('pending-designer');
    await t.makeDesigner(pending, { verifyStatus: 'pending' });
    expect((await t.call('GET', '/board', { token: pending })).body.items).toHaveLength(1);
    const plain = await t.call('GET', '/board', { token: await t.login('plain') });
    expect(plain.status).toBe(403);
    expect(plain.body.code).toBe('forbidden');
  });

  it('활동 지역 밖·마감·내 요청은 안 나온다. region은 활동 지역 안에서만', async () => {
    const { t, requestId } = await withRequest({ regions: ['서울 마포구'] });
    const d1 = await t.login(SEED_KAKAO_IDS.designer1); // 동작구·관악구
    expect((await t.call('GET', '/board', { token: d1 })).body.items).toEqual([]);
    const d2 = await t.login(SEED_KAKAO_IDS.designer2); // 마포구·동작구
    expect((await t.call('GET', '/board?region=서울 마포구', { token: d2 })).body.items.map((x: any) => x.id)).toEqual([requestId]);
    expect((await t.call('GET', '/board?region=서울 동작구', { token: d2 })).body.items).toEqual([]);
    const outside = await t.call('GET', '/board?region=부산 해운대구', { token: d2 });
    expect(outside.status).toBe(422);
    expect(outside.body.fields.region).toBeDefined();
    // 자기 요청은 게시판에서 뺀다 (겸업)
    await t.createRequest(d2, { regions: ['서울 마포구'] });
    expect((await t.call('GET', '/board', { token: d2 })).body.items).toHaveLength(1);
    // 마감 시각이 지나면 배치 전이라도 빠진다
    t.advance(7 * DAY);
    expect((await t.call('GET', '/board', { token: await t.login(SEED_KAKAO_IDS.designer2) })).body.items).toEqual([]);
  });

  it('필터·정렬: treatment·difficulty·budget(예산 없는 요청은 어느 예산에도 포함), fewest_responses', async () => {
    const t = setup();
    const c = await t.login('c');
    const perm = (await t.createRequest(c)).body.id; // perm·high·5_10
    t.advance(1000);
    const cut = (await t.createRequest(c, { card: { ...(await import('./helpers.js')).CARD, styleTag: '허쉬컷', profile: { ...(await import('./helpers.js')).PROFILE, history: [] } }, budget: null })).body.id; // cut·low·null
    const d1 = await t.login(SEED_KAKAO_IDS.designer1);
    const ids = async (q: string) => (await t.call('GET', `/board${q}`, { token: d1 })).body.items.map((x: any) => x.id);
    expect(await ids('')).toEqual([cut, perm]);
    expect(await ids('?treatment=perm')).toEqual([perm]);
    expect(await ids('?difficulty=low')).toEqual([cut]);
    expect(await ids('?budget=over_15')).toEqual([cut]);
    await t.call('POST', `/requests/${cut}/responses`, { token: await t.login(SEED_KAKAO_IDS.designer2), body: t.responseBody() });
    expect(await ids('?sort=fewest_responses')).toEqual([perm, cut]);
    expect((await t.call('GET', '/board?treatment=nail', { token: d1 })).status).toBe(422);
  });
});

describe('GET /board/:requestId', () => {
  it('인증 디자이너: card + 10분 서명 URL. 미인증: designImageUrl null', async () => {
    const { t, designer, requestId } = await withRequest();
    const res = await t.call('GET', `/board/${requestId}`, { token: designer });
    expect(res.body).toMatchObject({ id: requestId, status: 'open', myResponse: null, card: { requestText: '끝만 가볍게 말아 주세요', riskWarnings: ['최근 3개월 염색'] } });
    const url = new URL(res.body.designImageUrl);
    expect(Number(url.searchParams.get('exp')) * 1000 - t.now().getTime()).toBe(600_000);
    expect((await t.app.request(res.body.designImageUrl)).status).toBe(200);
    // 서명 URL은 10분 뒤 만료
    t.advance(600_001);
    expect((await t.app.request(res.body.designImageUrl)).status).toBe(403);

    const pending = await t.login('pending-designer');
    await t.makeDesigner(pending, { verifyStatus: 'pending' });
    const p = await t.call('GET', `/board/${requestId}`, { token: pending });
    expect(p.status).toBe(200);
    expect(p.body.designImageUrl).toBeNull();
    expect(p.body.card.profile).toBeDefined();
  });

  it('비공개 처리(design_hidden_at) 뒤에는 인증 디자이너에게도 null', async () => {
    const { t, customer, designer, requestId } = await withRequest();
    await t.call('POST', `/requests/${requestId}/responses`, { token: designer, body: t.responseBody() });
    await t.call('POST', `/requests/${requestId}/close`, { token: customer });
    const res = await t.call('GET', `/board/${requestId}`, { token: designer });
    expect(res.body.status).toBe('cancelled');
    expect(res.body.designImageUrl).toBeNull();
    expect(res.body.myResponse.status).toBe('not_selected');
    // 응답하지 않은 디자이너에게는 닫힌 요청이 보이지 않는다
    expect((await t.call('GET', `/board/${requestId}`, { token: await t.login(SEED_KAKAO_IDS.designer2) })).status).toBe(404);
  });

  it('자기 요청은 403, 없는 요청은 404', async () => {
    const { t, customer, requestId } = await withRequest();
    await t.makeDesigner(customer);
    expect((await t.call('GET', `/board/${requestId}`, { token: customer })).body.code).toBe('forbidden');
    expect((await t.call('GET', '/board/00000000-0000-4000-8000-000000000000', { token: customer })).status).toBe(404);
  });
});

describe('POST /requests/:id/responses', () => {
  it('201, 손님에게 new_response 알림, 게시판에 myResponded·responseCount 반영', async () => {
    const { t, designer, requestId } = await withRequest();
    const res = await t.call('POST', `/requests/${requestId}/responses`, {
      token: designer,
      body: { availability: 'conditional', condition: '클리닉 병행', priceMin: 90000, priceMax: 120000, comment: '손상 케어 같이 해요' },
    });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ id: expect.any(String) });
    expect(t.notificationsOf(SEED_IDS.customer1)).toEqual([expect.objectContaining({ type: 'new_response', payload: expect.objectContaining({ requestId, responseId: res.body.id }) })]);
    const board = await t.call('GET', '/board', { token: designer });
    expect(board.body.items[0]).toMatchObject({ myResponded: true, responseCount: 1 });
    const row = t.repo.state().responses.get(res.body.id)!;
    expect(row).toMatchObject({ requestVersion: 1, status: 'pending', condition: '클리닉 병행' });
  });

  it('같은 요청에 두 번째 응답은 409 already_responded', async () => {
    const { t, designer, requestId } = await withRequest();
    expect((await t.call('POST', `/requests/${requestId}/responses`, { token: designer, body: t.responseBody() })).status).toBe(201);
    const again = await t.call('POST', `/requests/${requestId}/responses`, { token: designer, body: t.responseBody() });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('already_responded');
  });

  it('미인증 디자이너는 403 not_verified, 디자이너가 아니면 403 forbidden', async () => {
    const { t, requestId } = await withRequest();
    const pending = await t.login('p');
    await t.makeDesigner(pending, { verifyStatus: 'pending' });
    const res = await t.call('POST', `/requests/${requestId}/responses`, { token: pending, body: t.responseBody() });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('not_verified');
    const rejected = await t.login('r');
    await t.makeDesigner(rejected, { verifyStatus: 'rejected' });
    expect((await t.call('POST', `/requests/${requestId}/responses`, { token: rejected, body: t.responseBody() })).body.code).toBe('not_verified');
    expect((await t.call('POST', `/requests/${requestId}/responses`, { token: await t.login('n'), body: t.responseBody() })).body.code).toBe('forbidden');
  });

  it('자기 요청에는 응답할 수 없다 (겸업 계정, 403 forbidden)', async () => {
    const t = setup();
    const both = await t.login(SEED_KAKAO_IDS.designer1);
    const id = (await t.createRequest(both)).body.id;
    const res = await t.call('POST', `/requests/${id}/responses`, { token: both, body: t.responseBody() });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('forbidden');
  });

  it('마감·취소·매칭된 요청에는 410 request_closed', async () => {
    // 취소
    let s = await withRequest();
    await s.t.call('POST', `/requests/${s.requestId}/close`, { token: s.customer });
    expect((await s.t.call('POST', `/requests/${s.requestId}/responses`, { token: s.designer, body: s.t.responseBody() })).body.code).toBe('request_closed');
    // 마감 시각 경과 (배치 전)
    s = await withRequest();
    s.t.advance(7 * DAY);
    const late = await s.t.call('POST', `/requests/${s.requestId}/responses`, { token: await s.t.login(SEED_KAKAO_IDS.designer1), body: s.t.responseBody() });
    expect(late.status).toBe(410);
    // 매칭됨
    s = await withRequest();
    const first = await s.t.call('POST', `/requests/${s.requestId}/responses`, { token: await s.t.login(SEED_KAKAO_IDS.designer2), body: s.t.responseBody() });
    await s.t.call('POST', `/responses/${first.body.id}/accept`, { token: s.customer });
    expect((await s.t.call('POST', `/requests/${s.requestId}/responses`, { token: s.designer, body: s.t.responseBody() })).status).toBe(410);
  });

  it('필드 규칙: 코멘트 50자, conditional이면 condition 필수, priceMin ≤ priceMax, 예약 링크 필요', async () => {
    const { t, designer, requestId } = await withRequest();
    const res = await t.call('POST', `/requests/${requestId}/responses`, {
      token: designer,
      body: { availability: 'conditional', priceMin: 200000, priceMax: 100000, comment: '가'.repeat(51) },
    });
    expect(res.status).toBe(422);
    expect(Object.keys(res.body.fields).sort()).toEqual(['comment', 'condition', 'priceMax']);
    expect((await t.call('POST', `/requests/${requestId}/responses`, { token: designer, body: t.responseBody({ comment: '가'.repeat(50) }) })).status).toBe(201);

    const noLink = await t.login('nolink');
    await t.makeDesigner(noLink, { bookingUrl: null });
    const r2 = await t.call('POST', `/requests/${requestId}/responses`, { token: noLink, body: t.responseBody() });
    expect(r2.status).toBe(422);
    expect(r2.body.fields.bookingUrl).toBeDefined();
  });
});

describe('손님: 응답 비교 · 수락', () => {
  async function withResponses() {
    const s = await withRequest();
    const d2 = await s.t.login(SEED_KAKAO_IDS.designer2);
    await s.t.repo.updateUser(SEED_IDS.designer2, { temperature: 40 });
    const r1 = (await s.t.call('POST', `/requests/${s.requestId}/responses`, { token: s.designer, body: s.t.responseBody({ priceMin: 70000 }) })).body.id;
    s.t.advance(1000);
    const r2 = (await s.t.call('POST', `/requests/${s.requestId}/responses`, { token: d2, body: s.t.responseBody({ priceMin: 90000, priceMax: 90000 }) })).body.id;
    return { ...s, d2, r1, r2 };
  }

  it('응답 카드: 디자이너 정보는 닉네임·샵·지역·온도·작업 수만 — 예약 링크·연락처 없음', async () => {
    const { t, customer, requestId, r1 } = await withResponses();
    const res = await t.call('GET', `/requests/${requestId}/responses`, { token: customer });
    expect(res.body.items).toHaveLength(2);
    expect(res.body.items[0]).toMatchObject({
      id: r1,
      availability: 'possible',
      priceMin: 70000,
      isOutdated: false,
      status: 'pending',
      designer: { id: SEED_IDS.designer1, nickname: '서윤 디자이너', shopName: '이로케 시연 살롱 상도점', area: '서울 동작구 · 서울 관악구', temperature: 37.2, verifiedWorkCount: 0 },
    });
    expect(res.text).not.toContain('booking');
    expect(res.text).not.toContain('example.com');
    expect(hasKeyDeep(res.body, (k) => /booking|phone|email|kakao|instagram/i.test(k))).toBe(false);
  });

  it('정렬: price_asc · temperature_desc', async () => {
    const { t, customer, requestId, r1, r2 } = await withResponses();
    const ids = async (sort: string) => (await t.call('GET', `/requests/${requestId}/responses?sort=${sort}`, { token: customer })).body.items.map((x: any) => x.id);
    expect(await ids('price_asc')).toEqual([r1, r2]);
    expect(await ids('temperature_desc')).toEqual([r2, r1]);
    expect((await t.call('GET', `/requests/${requestId}/responses?sort=cheap`, { token: customer })).status).toBe(422);
    expect((await t.call('GET', `/requests/${requestId}/responses`, { token: await t.login('x') })).status).toBe(403);
  });

  it('수락: 201 { matchId, bookingUrl }, 요청 matched, 나머지 not_selected + 알림', async () => {
    const { t, customer, requestId, r1, r2 } = await withResponses();
    const res = await t.call('POST', `/responses/${r1}/accept`, { token: customer });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ matchId: expect.any(String), bookingUrl: 'https://example.com/booking/iroke-demo-1' });
    const st = t.repo.state();
    expect(st.requests.get(requestId)!.status).toBe('matched');
    expect(st.responses.get(r1)!.status).toBe('accepted');
    expect(st.responses.get(r2)!.status).toBe('not_selected');
    expect(st.matches.get(res.body.matchId)).toMatchObject({ status: 'accepted', customerId: SEED_IDS.customer1, designerId: SEED_IDS.designer1, acceptedAt: t.now() });
    expect(t.notificationsOf(SEED_IDS.designer1).find((n) => n.type === 'accepted')?.payload).toMatchObject({ matchId: res.body.matchId });
    expect(t.notificationsOf(SEED_IDS.designer2).find((n) => n.type === 'request_closed')?.payload).toMatchObject({ reason: 'other_accepted' });
    expect((await t.call('GET', `/requests/${requestId}`, { token: customer })).body.matchId).toBe(res.body.matchId);
  });

  it('수락: 남의 요청 403, 이미 매칭·마감이면 409 invalid_state', async () => {
    const { t, customer, d2, requestId, r1, r2 } = await withResponses();
    expect((await t.call('POST', `/responses/${r1}/accept`, { token: d2 })).body.code).toBe('forbidden');
    await t.call('POST', `/responses/${r1}/accept`, { token: customer });
    const again = await t.call('POST', `/responses/${r2}/accept`, { token: customer });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('invalid_state');
    expect((await t.call('POST', `/requests/${requestId}/close`, { token: customer })).body.code).toBe('invalid_state');

    const s = await withResponses();
    s.t.advance(7 * DAY);
    const customerAgain = await s.t.login(SEED_KAKAO_IDS.customer1);
    const expired = await s.t.call('POST', `/responses/${s.r1}/accept`, { token: customerAgain });
    expect(expired.body.code).toBe('invalid_state');
    expect((await s.t.call('POST', '/responses/00000000-0000-4000-8000-000000000000/accept', { token: customerAgain })).status).toBe(404);
  });
});

describe('알림 조건 · /designers/me/alert-settings', () => {
  it('기본값(전부 받음), PUT으로 바꾸면 알림 대상이 바뀐다', async () => {
    const t = setup();
    const d1 = await t.login(SEED_KAKAO_IDS.designer1);
    const fresh = await t.login('fresh');
    await t.makeDesigner(fresh);
    expect((await t.call('GET', '/designers/me/alert-settings', { token: fresh })).body).toEqual({
      enabled: true, regions: [], treatmentTypes: [], difficulties: [], budgets: [],
    });
    const put = await t.call('PUT', '/designers/me/alert-settings', {
      token: d1,
      body: { enabled: true, regions: ['서울 관악구'], treatmentTypes: ['perm'], difficulties: [], budgets: ['5_10'] },
    });
    expect(put.status).toBe(200);
    expect((await t.call('GET', '/designers/me/alert-settings', { token: d1 })).body.regions).toEqual(['서울 관악구']);
    const c = await t.login('c');
    await t.createRequest(c, { regions: ['서울 동작구'] });
    expect(t.notificationsOf(SEED_IDS.designer1)).toHaveLength(0);
    await t.createRequest(c, { regions: ['서울 관악구'] });
    expect(t.notificationsOf(SEED_IDS.designer1)).toHaveLength(1);
    await t.call('PUT', '/designers/me/alert-settings', { token: d1, body: { enabled: false, regions: [], treatmentTypes: [], difficulties: [], budgets: [] } });
    await t.createRequest(c, { regions: ['서울 관악구'] });
    expect(t.notificationsOf(SEED_IDS.designer1)).toHaveLength(1);
  });

  it('지역은 활동 지역 안에서만, 모르는 값은 422. 디자이너가 아니면 403', async () => {
    const t = setup();
    const d1 = await t.login(SEED_KAKAO_IDS.designer1);
    const res = await t.call('PUT', '/designers/me/alert-settings', {
      token: d1,
      body: { enabled: 'yes', regions: ['서울 마포구'], treatmentTypes: ['nail'], difficulties: ['low', 'low'], budgets: [] },
    });
    expect(res.status).toBe(422);
    expect(Object.keys(res.body.fields).sort()).toEqual(['difficulties', 'enabled', 'regions', 'treatmentTypes']);
    expect((await t.call('GET', '/designers/me/alert-settings', { token: await t.login('x') })).status).toBe(403);
  });
});

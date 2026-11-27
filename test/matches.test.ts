import { describe, expect, it } from 'vitest';
import { CRON_SECRET, DAY, SEED_IDS, SEED_KAKAO_IDS, setup } from './helpers.js';

const cron = { authorization: `Bearer ${CRON_SECRET}` };

/** 요청 → 디자이너1 응답 → 수락까지 */
export async function matched() {
  const t = setup();
  const customer = await t.login(SEED_KAKAO_IDS.customer1);
  const designer = await t.login(SEED_KAKAO_IDS.designer1);
  const requestId = (await t.createRequest(customer)).body.id as string;
  const responseId = (await t.call('POST', `/requests/${requestId}/responses`, { token: designer, body: t.responseBody() })).body.id as string;
  const matchId = (await t.call('POST', `/responses/${responseId}/accept`, { token: customer })).body.matchId as string;
  return {
    t,
    requestId,
    responseId,
    matchId,
    tokens: { customer, designer },
    /** 시계를 돌린 뒤 토큰 다시 받기 */
    async relogin() {
      this.tokens.customer = await t.login(SEED_KAKAO_IDS.customer1);
      this.tokens.designer = await t.login(SEED_KAKAO_IDS.designer1);
    },
  };
}

describe('GET /matches/:id', () => {
  it('당사자만. 손님은 모발 프로필 미리보기, 디자이너는 null. 예약 링크·연락처 없음', async () => {
    const { t, matchId, requestId, tokens } = await matched();
    const c = await t.call('GET', `/matches/${matchId}`, { token: tokens.customer });
    expect(c.status).toBe(200);
    expect(c.body).toMatchObject({
      id: matchId,
      status: 'accepted',
      myRole: 'customer',
      request: { id: requestId, treatmentType: 'perm' },
      designer: { id: SEED_IDS.designer1, nickname: '서윤 디자이너' },
      customer: { id: SEED_IDS.customer1, temperature: 36.5 },
      myReviewWritten: false,
      reviewDeadline: null,
    });
    expect(c.body.request.designImageUrl).toEqual(expect.any(String));
    expect(c.body.profilePreview.changes).toEqual(['시술 이력에 펌(2026-11-18) 추가']);
    expect(c.body.profilePreview.after.history.at(-1)).toEqual({ type: 'perm', date: '2026-11-18' });
    expect(c.text).not.toMatch(/booking|kakao/i);
    const d = await t.call('GET', `/matches/${matchId}`, { token: tokens.designer });
    expect(d.body).toMatchObject({ myRole: 'designer', profilePreview: null });
    expect((await t.call('GET', `/matches/${matchId}`, { token: await t.login(SEED_KAKAO_IDS.designer2) })).body.code).toBe('forbidden');
    expect((await t.call('GET', '/matches/00000000-0000-4000-8000-000000000000', { token: tokens.customer })).status).toBe(404);
  });
});

describe('완료 요청 → 확인', () => {
  it('complete: 디자이너만, accepted일 때만 → complete_requested, 기한 +7일, 손님 알림', async () => {
    const { t, matchId, tokens } = await matched();
    expect((await t.call('POST', `/matches/${matchId}/complete`, { token: tokens.customer })).body.code).toBe('forbidden');
    const key = await t.upload(tokens.designer, 'result');
    const res = await t.call('POST', `/matches/${matchId}/complete`, { token: tokens.designer, body: { resultImageKeys: [key] } });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'complete_requested', confirmDeadline: new Date(t.now().getTime() + 7 * DAY).toISOString() });
    expect(t.notificationsOf(SEED_IDS.customer1).some((n) => n.type === 'complete_requested' && n.payload.matchId === matchId)).toBe(true);
    const again = await t.call('POST', `/matches/${matchId}/complete`, { token: tokens.designer });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('invalid_state');
    expect((await t.call('GET', `/matches/${matchId}`, { token: tokens.customer })).body.designerResultImageUrls).toHaveLength(1);
  });

  it('complete: 결과 사진은 본인이 result로 올린 것, 최대 2장', async () => {
    const { t, matchId, tokens } = await matched();
    const others = await t.upload(tokens.customer, 'result');
    const bad = await t.call('POST', `/matches/${matchId}/complete`, { token: tokens.designer, body: { resultImageKeys: [others] } });
    expect(bad.status).toBe(422);
    const keys = [await t.upload(tokens.designer, 'result'), await t.upload(tokens.designer, 'result'), await t.upload(tokens.designer, 'result')];
    expect((await t.call('POST', `/matches/${matchId}/complete`, { token: tokens.designer, body: { resultImageKeys: keys } })).body.fields.resultImageKeys).toBeDefined();
  });

  it('confirm 전에는 409, 확인하면 completed + 모발 프로필 갱신(updatedBy match) + 요청 completed·시안 비공개 + 동의 시 인증 작업물', async () => {
    const { t, matchId, requestId, tokens } = await matched();
    expect((await t.call('POST', `/matches/${matchId}/confirm`, { token: tokens.customer, body: { portfolioConsent: true } })).body.code).toBe('invalid_state');
    await t.call('POST', `/matches/${matchId}/complete`, { token: tokens.designer });
    expect((await t.call('POST', `/matches/${matchId}/confirm`, { token: tokens.designer, body: { portfolioConsent: true } })).body.code).toBe('forbidden');
    expect((await t.call('POST', `/matches/${matchId}/confirm`, { token: tokens.customer, body: {} })).body.fields.portfolioConsent).toBeDefined();

    const front = await t.upload(tokens.customer, 'result');
    const res = await t.call('POST', `/matches/${matchId}/confirm`, { token: tokens.customer, body: { resultImageKeys: [front], portfolioConsent: true } });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('completed');
    expect(res.body.hairProfile.history).toEqual([{ type: 'color', date: '2026-09-20' }, { type: 'perm', date: '2026-11-18' }]);

    const st = t.repo.state();
    expect(st.matches.get(matchId)).toMatchObject({ status: 'completed', confirmedAt: t.now(), portfolioConsent: true, autoCompleted: false, customerResultKeys: [front] });
    expect(st.requests.get(requestId)).toMatchObject({ status: 'completed', designHiddenAt: t.now() });
    expect(st.hairProfiles.get(SEED_IDS.customer1)).toMatchObject({ updatedBy: 'match' });
    const items = [...st.portfolioItems.values()];
    expect(items).toEqual([expect.objectContaining({ designerId: SEED_IDS.designer1, matchId, source: 'verified', resultKey: front, styleTag: '레이어드 C컬펌' })]);
    expect((await t.call('GET', `/me/hair-profile`, { token: tokens.customer })).body.updatedBy).toBe('match');
    // 완료 후 디자이너는 시안 URL을 받지 못한다
    expect((await t.call('GET', `/matches/${matchId}`, { token: tokens.designer })).body.request.designImageUrl).toBeNull();
  });

  it('동의하지 않거나 사진이 없으면 작업물은 만들지 않지만 작업물 수에는 센다', async () => {
    const { t, matchId, tokens } = await matched();
    await t.call('POST', `/matches/${matchId}/complete`, { token: tokens.designer });
    await t.call('POST', `/matches/${matchId}/confirm`, { token: tokens.customer, body: { portfolioConsent: true } });
    expect(t.repo.state().portfolioItems.size).toBe(0);
    expect((await t.call('GET', `/designers/${SEED_IDS.designer1}`, { token: tokens.customer })).body.verifiedWorkCount).toBe(1);
  });

  it('dispute: [아니에요] → 매칭 disputed + 요청 cancelled, 후기 불가', async () => {
    const { t, matchId, requestId, tokens } = await matched();
    expect((await t.call('POST', `/matches/${matchId}/dispute`, { token: tokens.customer, body: { reason: 'not_done' } })).body.code).toBe('invalid_state');
    await t.call('POST', `/matches/${matchId}/complete`, { token: tokens.designer });
    expect((await t.call('POST', `/matches/${matchId}/dispute`, { token: tokens.customer, body: { reason: 'bad' } })).status).toBe(422);
    const res = await t.call('POST', `/matches/${matchId}/dispute`, { token: tokens.customer, body: { reason: 'different', note: '컬이 거의 없어요' } });
    expect(res.body).toEqual({ status: 'disputed' });
    const st = t.repo.state();
    expect(st.matches.get(matchId)).toMatchObject({ status: 'disputed', disputeReason: 'different: 컬이 거의 없어요' });
    expect(st.requests.get(requestId)).toMatchObject({ status: 'cancelled' });
    // 이의 제기는 디자이너 온도 −0.5, 최근 90일 이의 제기 수에 잡힌다
    expect((await t.repo.getUser(SEED_IDS.designer1))!.temperature).toBe(36.7);
    expect((await t.call('GET', `/designers/${SEED_IDS.designer1}`, { token: tokens.customer })).body.recentDisputes90d).toBe(1);
    expect((await t.call('POST', `/matches/${matchId}/reviews`, { token: tokens.customer, body: { satisfaction: 'bad' } })).body.code).toBe('invalid_state');
    expect((await t.call('POST', `/matches/${matchId}/confirm`, { token: tokens.customer, body: { portfolioConsent: false } })).body.code).toBe('invalid_state');
  });

  it('최근 90일 이의 제기 수: 완료 요청 시각 기준으로 90일이 지나면 빠진다', async () => {
    const s = await matched();
    await s.t.call('POST', `/matches/${s.matchId}/complete`, { token: s.tokens.designer });
    await s.t.call('POST', `/matches/${s.matchId}/dispute`, { token: s.tokens.customer, body: { reason: 'not_done' } });
    s.t.advance(89 * DAY);
    await s.relogin();
    expect((await s.t.call('GET', `/designers/${SEED_IDS.designer1}`, { token: s.tokens.customer })).body.recentDisputes90d).toBe(1);
    s.t.advance(2 * DAY);
    await s.relogin();
    expect((await s.t.call('GET', `/designers/${SEED_IDS.designer1}`, { token: s.tokens.customer })).body.recentDisputes90d).toBe(0);
  });

  it('7일 미확인 → 자동 완료(auto_completed). 모발 프로필 갱신·포트폴리오 공개 없음. 조회 시에도 반영', async () => {
    const s = await matched();
    const key = await s.t.upload(s.tokens.designer, 'result');
    await s.t.call('POST', `/matches/${s.matchId}/complete`, { token: s.tokens.designer, body: { resultImageKeys: [key] } });
    const before = s.t.repo.state().hairProfiles.get(SEED_IDS.customer1);
    s.t.advance(7 * DAY);
    await s.relogin();
    const view = await s.t.call('GET', `/matches/${s.matchId}`, { token: s.tokens.customer });
    expect(view.body).toMatchObject({ status: 'completed', autoCompleted: true });
    const st = s.t.repo.state();
    expect(st.hairProfiles.get(SEED_IDS.customer1)).toEqual(before);
    expect(st.portfolioItems.size).toBe(0);
    expect(st.requests.get(s.requestId)!.status).toBe('completed');
    // 확인은 더 이상 안 되고, 후기는 쓸 수 있다
    expect((await s.t.call('POST', `/matches/${s.matchId}/confirm`, { token: s.tokens.customer, body: { portfolioConsent: true } })).body.code).toBe('invalid_state');
    expect((await s.t.call('POST', `/matches/${s.matchId}/reviews`, { token: s.tokens.customer, body: { satisfaction: 'good' } })).status).toBe(201);

    // 배치로도 자동 완료
    const b = await matched();
    await b.t.call('POST', `/matches/${b.matchId}/complete`, { token: b.tokens.designer });
    b.t.advance(7 * DAY);
    expect((await b.t.call('POST', '/internal/jobs/sweep', { headers: cron })).body.autoCompletedMatches).toBe(1);
    expect(b.t.repo.state().matches.get(b.matchId)).toMatchObject({ status: 'completed', autoCompleted: true });
  });
});

describe('후기 · 온도', () => {
  async function completed() {
    const s = await matched();
    await s.t.call('POST', `/matches/${s.matchId}/complete`, { token: s.tokens.designer });
    await s.t.call('POST', `/matches/${s.matchId}/confirm`, { token: s.tokens.customer, body: { portfolioConsent: false } });
    return s;
  }

  it('손님 → 디자이너: satisfaction이 디자이너 온도에 반영, 역할당 1회', async () => {
    const { t, matchId, tokens } = await completed();
    const res = await t.call('POST', `/matches/${matchId}/reviews`, {
      token: tokens.customer,
      body: { satisfaction: 'good', manner: 'good', promiseKept: 'yes', text: '설명이 친절했어요' },
    });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ reviewId: expect.any(String), targetTemperature: 37.4 });
    expect((await t.repo.getUser(SEED_IDS.designer1))!.temperature).toBe(37.4);
    const again = await t.call('POST', `/matches/${matchId}/reviews`, { token: tokens.customer, body: { satisfaction: 'bad' } });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('already_responded');
    expect((await t.call('GET', `/matches/${matchId}`, { token: tokens.customer })).body.myReviewWritten).toBe(true);
    // 공개 후기
    const reviews = await t.call('GET', `/designers/${SEED_IDS.designer1}/reviews`, { token: tokens.customer });
    expect(reviews.body.items).toEqual([{ manner: 'good', promiseKept: 'yes', satisfaction: 'good', text: '설명이 친절했어요', createdAt: t.now().toISOString() }]);
  });

  it('디자이너 → 손님: promiseKept no(노쇼)는 손님 온도 −1.0, yes는 +0.2', async () => {
    const { t, matchId, tokens } = await completed();
    const res = await t.call('POST', `/matches/${matchId}/reviews`, { token: tokens.designer, body: { promiseKept: 'no' } });
    expect(res.body.targetTemperature).toBe(35.5);
    expect((await t.repo.getUser(SEED_IDS.customer1))!.temperature).toBe(35.5);
    // 디자이너가 쓴 후기는 디자이너 공개 후기에 나오지 않는다
    expect((await t.call('GET', `/designers/${SEED_IDS.designer1}/reviews`, { token: tokens.customer })).body.items).toEqual([]);
  });

  it('필드 규칙: 손님은 satisfaction 필수·text 100자, 디자이너는 promiseKept 필수', async () => {
    const { t, matchId, tokens } = await completed();
    const c = await t.call('POST', `/matches/${matchId}/reviews`, { token: tokens.customer, body: { manner: 'great', text: '가'.repeat(101) } });
    expect(c.status).toBe(422);
    expect(Object.keys(c.body.fields).sort()).toEqual(['manner', 'satisfaction', 'text']);
    expect((await t.call('POST', `/matches/${matchId}/reviews`, { token: tokens.designer, body: { satisfaction: 'good' } })).body.fields.promiseKept).toBeDefined();
  });

  it('완료 전에는 409, 완료 후 7일이 지나면 409', async () => {
    const s = await matched();
    expect((await s.t.call('POST', `/matches/${s.matchId}/reviews`, { token: s.tokens.customer, body: { satisfaction: 'good' } })).body.code).toBe('invalid_state');
    const c = await completed();
    c.t.advance(7 * DAY + 1000);
    await c.relogin();
    expect((await c.t.call('POST', `/matches/${c.matchId}/reviews`, { token: c.tokens.customer, body: { satisfaction: 'good' } })).body.code).toBe('invalid_state');
  });

  it('온도는 0~99.9 안에서만', async () => {
    const { t, matchId, tokens } = await completed();
    await t.repo.updateUser(SEED_IDS.designer1, { temperature: 99.8 });
    expect((await t.call('POST', `/matches/${matchId}/reviews`, { token: tokens.customer, body: { satisfaction: 'good' } })).body.targetTemperature).toBe(99.9);
  });

  it('후기 리마인드: 완료 후 3일 지나도 안 쓴 당사자에게 1회', async () => {
    const { t, matchId, tokens } = await completed();
    await t.call('POST', `/matches/${matchId}/reviews`, { token: tokens.customer, body: { satisfaction: 'ok' } });
    t.advance(3 * DAY - 1000);
    expect((await t.call('POST', '/internal/jobs/sweep', { headers: cron })).body.reviewReminders).toBe(0);
    t.advance(2000);
    expect((await t.call('POST', '/internal/jobs/sweep', { headers: cron })).body.reviewReminders).toBe(1);
    expect((await t.call('POST', '/internal/jobs/sweep', { headers: cron })).body.reviewReminders).toBe(0);
    expect(t.notificationsOf(SEED_IDS.designer1).filter((n) => n.type === 'review_reminder')).toHaveLength(1);
    expect(t.notificationsOf(SEED_IDS.customer1).filter((n) => n.type === 'review_reminder')).toHaveLength(0);
  });
});

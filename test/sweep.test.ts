import { describe, expect, it } from 'vitest';
import { CRON_SECRET, DAY, PNG_BYTES, SEED_IDS, SEED_KAKAO_IDS, setup } from './helpers';

const auth = { authorization: `Bearer ${CRON_SECRET}` };

describe('/internal/jobs/sweep', () => {
  it('CRON_SECRET이 없거나 틀리면 401. 시크릿 설정이 비어 있으면 항상 401', async () => {
    const t = setup();
    expect((await t.call('POST', '/internal/jobs/sweep')).status).toBe(401);
    expect((await t.call('GET', '/internal/jobs/sweep', { headers: { authorization: 'Bearer wrong' } })).status).toBe(401);
    const empty = setup({ config: { jwtSecret: 's', jwtTtlSec: 60, cronSecret: '', devRoutes: true } });
    expect((await empty.call('GET', '/internal/jobs/sweep', { headers: { authorization: 'Bearer ' } })).status).toBe(401);
  });

  it('Vercel Cron(GET)과 수동 실행(POST) 모두 받는다', async () => {
    const t = setup();
    for (const method of ['GET', 'POST']) {
      const res = await t.call(method, '/internal/jobs/sweep', { headers: auth });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ expiredRequests: 0, deadlineSoonNotified: 0, autoCompletedMatches: 0, reviewReminders: 0, orphanUploadsDeleted: 0 });
    }
  });

  it('마감 지난 요청 expired + 시안 비공개, 두 번 돌려도 같은 결과', async () => {
    const t = setup();
    const c = await t.login(SEED_KAKAO_IDS.customer1);
    const id = (await t.createRequest(c)).body.id;
    await t.call('POST', `/requests/${id}/responses`, { token: await t.login(SEED_KAKAO_IDS.designer1), body: t.responseBody() });
    t.advance(7 * DAY + 1);
    expect((await t.call('POST', '/internal/jobs/sweep', { headers: auth })).body.expiredRequests).toBe(1);
    const row = t.repo.state().requests.get(id)!;
    expect(row.status).toBe('expired');
    expect(row.designHiddenAt).not.toBeNull();
    expect((await t.call('POST', '/internal/jobs/sweep', { headers: auth })).body.expiredRequests).toBe(0);
    expect(t.notificationsOf(SEED_IDS.designer1).filter((n) => n.type === 'request_closed')).toHaveLength(1);
  });

  it('마감 D-1 알림은 요청당 한 번', async () => {
    const t = setup();
    const c = await t.login(SEED_KAKAO_IDS.customer1);
    await t.createRequest(c);
    t.advance(5 * DAY);
    expect((await t.call('POST', '/internal/jobs/sweep', { headers: auth })).body.deadlineSoonNotified).toBe(0);
    t.advance(1 * DAY + 1);
    expect((await t.call('POST', '/internal/jobs/sweep', { headers: auth })).body.deadlineSoonNotified).toBe(1);
    expect((await t.call('POST', '/internal/jobs/sweep', { headers: auth })).body.deadlineSoonNotified).toBe(0);
    expect(t.notificationsOf(SEED_IDS.customer1).filter((n) => n.type === 'deadline_soon')).toHaveLength(1);
  });

  it('24시간 동안 어느 테이블에도 연결되지 않은 업로드만 삭제', async () => {
    const t = setup();
    const c = await t.login('c');
    const used = await t.upload(c);
    await t.createRequest(c, { designImageKey: used });
    const orphan = await t.upload(c);
    t.advance(DAY - 1000);
    const fresh = await t.upload(c);
    expect((await t.call('POST', '/internal/jobs/sweep', { headers: auth })).body.orphanUploadsDeleted).toBe(0);
    t.advance(2000);
    expect((await t.call('POST', '/internal/jobs/sweep', { headers: auth })).body.orphanUploadsDeleted).toBe(1);
    expect(await t.storage.exists(orphan)).toBe(false);
    expect(await t.storage.exists(used)).toBe(true);
    expect(await t.storage.exists(fresh)).toBe(true);
    expect(PNG_BYTES.length).toBeGreaterThan(0);
  });
});

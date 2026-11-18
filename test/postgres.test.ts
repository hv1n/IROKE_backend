// Postgres 구현체 검증: PGlite(프로세스 안 Postgres)에 db/migrations/001_v2.sql + db/seed.sql을 적용하고
// postgres.js로 실제 프로토콜로 붙어서 API 흐름을 돌린다. (Supabase Storage는 memory 저장소로 대신)
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import type { Sql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPostgresRepo, createSql } from '../src/repo/postgres';
import { UniqueViolation, type Repo } from '../src/repo/types';
import { CARD, CRON_SECRET, DAY, SEED_IDS, SEED_KAKAO_IDS, T0, setup } from './helpers';

const migration = readFileSync(new URL('../db/migrations/001_v2.sql', import.meta.url), 'utf8');
const seed = readFileSync(new URL('../db/seed.sql', import.meta.url), 'utf8');
const TABLES = 'reports, notifications, portfolio_items, reviews, matches, responses, requests, hair_profiles, designer_profiles, users';

let db: PGlite;
let server: PGLiteSocketServer;
let sql: Sql;
let repo: Repo;

beforeAll(async () => {
  db = await PGlite.create();
  await db.exec(migration);
  const port = 20000 + Math.floor(Math.random() * 20000);
  server = new PGLiteSocketServer({ db, port, maxConnections: 4 });
  await server.start();
  sql = createSql(`postgres://postgres:postgres@127.0.0.1:${port}/postgres`, { max: 1 });
  repo = createPostgresRepo(sql);
}, 30_000);

afterAll(async () => {
  await sql?.end({ timeout: 1 });
  await server?.stop();
  await db?.close();
});

beforeEach(async () => {
  await sql.unsafe(`truncate ${TABLES} cascade`);
  await sql.unsafe(seed);
});

const pg = () => setup({ repo });
const count = async (table: string, where = 'true') => Number((await sql.unsafe(`select count(*)::int as n from ${table} where ${where}`))[0]!.n);

describe('Postgres 구현체 (PGlite)', { timeout: 20_000 }, () => {
  it('시드가 들어가고 매핑이 맞다 (numeric 온도, jsonb, text[])', async () => {
    const u = await repo.getUser(SEED_IDS.designer1);
    expect(u).toMatchObject({ nickname: '서윤 디자이너', temperature: 37.2, kakaoId: SEED_KAKAO_IDS.designer1 });
    const p = await repo.getDesignerProfile(SEED_IDS.designer1);
    expect(p).toMatchObject({ verifyStatus: 'verified', regions: ['서울 동작구', '서울 관악구'], alertSettings: { enabled: true, regions: [] } });
    const h = await repo.getHairProfile(SEED_IDS.customer1);
    expect(h).toMatchObject({ damage: 3, level: 5, history: [{ type: 'color', date: '2026-09-20' }], updatedBy: 'user' });
  });

  it('트랜잭션: 실패하면 되돌리고, UNIQUE 위반은 UniqueViolation', async () => {
    await expect(
      repo.tx(async (r) => {
        await r.updateUser(SEED_IDS.customer1, { nickname: '바뀜' });
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    expect((await repo.getUser(SEED_IDS.customer1))!.nickname).toBe('하린');
    await expect(
      repo.insertUser({ id: '00000000-0000-4000-8000-0000000000aa', kakaoId: SEED_KAKAO_IDS.customer1, nickname: 'x', temperature: 36.5, createdAt: T0 }),
    ).rejects.toBeInstanceOf(UniqueViolation);
  });

  it('손님·디자이너 전체 흐름: 등록 → 게시판 → 응답 → 수정(isOutdated) → 비교 → 수락', async () => {
    const t = pg();
    const customer = await t.login(SEED_KAKAO_IDS.customer1);
    const d1 = await t.login(SEED_KAKAO_IDS.designer1);
    const d2 = await t.login(SEED_KAKAO_IDS.designer2);
    const created = await t.createRequest(customer);
    expect(created.status).toBe(201);
    const id = created.body.id;
    expect(await count('notifications', `type = 'new_matching_request'`)).toBe(2);

    const board = await t.call('GET', '/board?sort=fewest_responses&treatment=perm&budget=5_10', { token: d1 });
    expect(board.body.items.map((x: any) => x.id)).toEqual([id]);
    expect(board.body.items[0].hairTags).toEqual(['중단발', '반곱슬', '손상도 3', '최근 3개월 염색']);
    const detail = await t.call('GET', `/board/${id}`, { token: d1 });
    expect(detail.body.card).toEqual({ profile: CARD.profile, requestText: CARD.requestText, riskWarnings: CARD.riskWarnings });
    expect(detail.body.designImageUrl).toEqual(expect.any(String));

    const r1 = (await t.call('POST', `/requests/${id}/responses`, { token: d1, body: t.responseBody({ priceMin: 70000 }) })).body.id;
    expect((await t.call('POST', `/requests/${id}/responses`, { token: d1, body: t.responseBody() })).body.code).toBe('already_responded');
    expect((await t.call('PATCH', `/requests/${id}`, { token: customer, body: { timing: 'any' } })).body.version).toBe(2);
    t.advance(1000);
    const r2 = (await t.call('POST', `/requests/${id}/responses`, { token: d2, body: t.responseBody({ priceMin: 60000 }) })).body.id;

    const cards = await t.call('GET', `/requests/${id}/responses?sort=price_asc`, { token: customer });
    expect(cards.body.items.map((x: any) => [x.id, x.isOutdated])).toEqual([[r2, false], [r1, true]]);
    expect(cards.body.items[1].designer).toMatchObject({ temperature: 37.2, verifiedWorkCount: 0 });
    expect((await t.call('GET', '/board', { token: d1 })).body.items[0]).toMatchObject({ myResponded: true, responseCount: 2 });

    const accept = await t.call('POST', `/responses/${r1}/accept`, { token: customer });
    expect(accept.status).toBe(201);
    expect(accept.body.bookingUrl).toBe('https://example.com/booking/iroke-demo-1');
    expect((await sql`select status from requests where id = ${id}`)[0]!.status).toBe('matched');
    expect((await sql`select status from responses where id = ${r2}`)[0]!.status).toBe('not_selected');
    expect(await count('matches')).toBe(1);
    expect((await t.call('POST', `/responses/${r2}/accept`, { token: customer })).body.code).toBe('invalid_state');
    expect(await repo.hasActiveMatch(SEED_IDS.designer1)).toBe(true);
    expect((await t.call('GET', `/requests/${id}`, { token: customer })).body.matchId).toBe(accept.body.matchId);
    expect((await t.call('GET', '/requests/mine?status=matched', { token: customer })).body.items[0]).toMatchObject({ id, responseCount: 2 });
  });

  it('만료(조회 시·배치), 마감 알림, 다시 올리기, 내림', async () => {
    const t = pg();
    let customer = await t.login(SEED_KAKAO_IDS.customer1);
    const a = (await t.createRequest(customer)).body.id;
    t.advance(1000);
    const b = (await t.createRequest(customer)).body.id;
    await t.call('POST', `/requests/${b}/responses`, { token: await t.login(SEED_KAKAO_IDS.designer1), body: t.responseBody() });
    t.advance(6 * DAY + 1000);
    const auth = { authorization: `Bearer ${CRON_SECRET}` };
    expect((await t.call('POST', '/internal/jobs/sweep', { headers: auth })).body).toMatchObject({ expiredRequests: 0, deadlineSoonNotified: 2 });
    expect((await t.call('GET', '/internal/jobs/sweep', { headers: auth })).body.deadlineSoonNotified).toBe(0);
    t.advance(DAY);
    customer = await t.login(SEED_KAKAO_IDS.customer1);
    // a는 조회로 만료, b는 배치로 만료
    expect((await t.call('GET', `/requests/${a}`, { token: customer })).body.status).toBe('expired');
    expect((await t.call('POST', '/internal/jobs/sweep', { headers: auth })).body.expiredRequests).toBe(1);
    expect((await sql`select status, design_hidden_at from requests where id = ${b}`)[0]).toMatchObject({ status: 'expired', designHiddenAt: expect.any(Date) });
    expect((await sql`select status from responses where request_id = ${b}`)[0]!.status).toBe('not_selected');

    const reopened = await t.call('POST', `/requests/${a}/reopen`, { token: customer, body: { budget: null } });
    expect(reopened.body).toMatchObject({ status: 'open', version: 2 });
    expect((await sql`select budget, design_hidden_at from requests where id = ${a}`)[0]).toEqual({ budget: null, designHiddenAt: null });
    expect((await t.call('POST', `/requests/${b}/reopen`, { token: customer })).body.code).toBe('invalid_state');
    expect((await t.call('POST', `/requests/${a}/close`, { token: customer })).body.status).toBe('cancelled');
    expect((await t.call('GET', '/requests/mine?status=closed&limit=1', { token: customer })).body.nextCursor).toEqual(expect.any(String));
  });

  it('알림 조건 저장(jsonb)과 고아 업로드 판단', async () => {
    const t = pg();
    const d1 = await t.login(SEED_KAKAO_IDS.designer1);
    const settings = { enabled: false, regions: ['서울 관악구'], treatmentTypes: ['cut'], difficulties: ['low'], budgets: ['under_5'] };
    await t.call('PUT', '/designers/me/alert-settings', { token: d1, body: settings });
    expect((await t.call('GET', '/designers/me/alert-settings', { token: d1 })).body).toEqual(settings);

    const c = await t.login('new-customer');
    expect(await count('users', `kakao_id = 'new-customer'`)).toBe(1);
    const used = await t.upload(c);
    await t.createRequest(c, { designImageKey: used });
    expect(await repo.isImageKeyReferenced(used)).toBe(true);
    expect(await repo.isImageKeyReferenced('request_design/x/y')).toBe(false);
  });

  it('P2: 완료 요청 → 확인(포트폴리오·모발 프로필) → 후기·온도 → 알림 · D-04 · 면허 결과 · 자동 완료 · 리마인드', async () => {
    const t = pg();
    const cron = { authorization: `Bearer ${CRON_SECRET}` };
    const customer = await t.login(SEED_KAKAO_IDS.customer1);
    const d1 = await t.login(SEED_KAKAO_IDS.designer1);
    const id = (await t.createRequest(customer)).body.id;
    const r1 = (await t.call('POST', `/requests/${id}/responses`, { token: d1, body: t.responseBody() })).body.id;
    const matchId = (await t.call('POST', `/responses/${r1}/accept`, { token: customer })).body.matchId;
    expect((await t.call('GET', '/designers/me/responses?tab=in_progress', { token: d1 })).body.items[0].canRequestComplete).toBe(true);

    const dKey = await t.upload(d1, 'result');
    expect((await t.call('POST', `/matches/${matchId}/complete`, { token: d1, body: { resultImageKeys: [dKey] } })).status).toBe(200);
    const front = await t.upload(customer, 'result');
    const confirm = await t.call('POST', `/matches/${matchId}/confirm`, { token: customer, body: { resultImageKeys: [front], portfolioConsent: true } });
    expect(confirm.body.hairProfile.history.at(-1)).toEqual({ type: 'perm', date: '2026-11-18' });
    expect((await sql`select updated_by, level from hair_profiles where user_id = ${SEED_IDS.customer1}`)[0]).toEqual({ updatedBy: 'match', level: 5 });
    const detail = await t.call('GET', `/matches/${matchId}`, { token: customer });
    expect(detail.body).toMatchObject({ status: 'completed', profilePreview: { changes: ['시술 이력에 펌(2026-11-18) 추가'] } });
    expect(detail.body.customerResultImageUrls).toHaveLength(1);

    const portfolio = await t.call('GET', `/designers/${SEED_IDS.designer1}/portfolio?similarToMe=true&source=verified`, { token: customer });
    expect(portfolio.body.items).toHaveLength(1);
    expect(portfolio.body.items[0].beforeCard).toMatchObject({ length: 'medium' });
    expect(await repo.isImageKeyReferenced(front)).toBe(true);

    expect((await t.call('POST', `/matches/${matchId}/reviews`, { token: customer, body: { satisfaction: 'good', text: '좋아요' } })).body.targetTemperature).toBe(37.7);
    expect((await t.call('POST', `/matches/${matchId}/reviews`, { token: customer, body: { satisfaction: 'good' } })).body.code).toBe('already_responded');
    expect((await t.call('POST', `/matches/${matchId}/reviews`, { token: d1, body: { promiseKept: 'no' } })).body.targetTemperature).toBe(35.5);
    expect((await t.call('GET', `/designers/${SEED_IDS.designer1}`, { token: customer })).body).toMatchObject({ reviewCount: 1, verifiedWorkCount: 1, temperature: 37.7 });
    expect((await t.call('GET', `/designers/${SEED_IDS.designer1}/reviews`, { token: customer })).body.items[0]).toMatchObject({ satisfaction: 'good', text: '좋아요' });
    expect((await t.call('GET', '/designers/me/responses?tab=done', { token: d1 })).body.items[0]).toMatchObject({ canReview: false });

    const notes = await t.call('GET', '/notifications?unreadOnly=true', { token: customer });
    expect(notes.body.unreadCount).toBeGreaterThanOrEqual(2);
    await t.call('POST', '/notifications/read', { token: customer, body: { ids: [notes.body.items[0].id] } });
    expect((await t.call('GET', '/notifications', { token: customer })).body.unreadCount).toBe(notes.body.unreadCount - 1);
    await t.call('POST', '/notifications/read', { token: customer });
    expect((await t.call('GET', '/notifications', { token: customer })).body.unreadCount).toBe(0);

    // 면허 신청 → DB에서 승인 → 배치가 사진 삭제·알림
    const nd = await t.login('pg-new-designer');
    const lic = await t.upload(nd, 'license');
    const body = { licenseImageKey: lic, name: '홍길동', licenseNumber: '2024-1', regions: ['서울 동작구'], shopName: '샵', bookingUrl: 'https://example.com/b' };
    expect((await t.call('POST', '/designers/verification', { token: nd, body })).status).toBe(202);
    expect(JSON.stringify(await sql`select * from designer_profiles`)).not.toContain('2024-1');
    await sql`update designer_profiles set verify_status = 'verified' where license_image_key = ${lic}`;
    expect((await t.call('POST', '/internal/jobs/sweep', { headers: cron })).body.verificationResults).toBe(1);
    expect((await t.call('GET', '/designers/verification', { token: nd })).body).toMatchObject({ verifyStatus: 'verified', decidedAt: expect.any(String) });

    // 다른 매칭: 자동 완료 + 리마인드
    const id2 = (await t.createRequest(customer)).body.id;
    const r2 = (await t.call('POST', `/requests/${id2}/responses`, { token: d1, body: t.responseBody() })).body.id;
    const m2 = (await t.call('POST', `/responses/${r2}/accept`, { token: customer })).body.matchId;
    await t.call('POST', `/matches/${m2}/complete`, { token: d1 });
    t.advance(7 * DAY);
    expect((await t.call('POST', '/internal/jobs/sweep', { headers: cron })).body.autoCompletedMatches).toBe(1);
    expect((await sql`select status, auto_completed from matches where id = ${m2}`)[0]).toEqual({ status: 'completed', autoCompleted: true });
    t.advance(3 * DAY + 1000); // 완료(자동) 후 3일이 지난 뒤
    expect((await t.call('POST', '/internal/jobs/sweep', { headers: cron })).body.reviewReminders).toBe(2);
    expect((await t.call('POST', '/internal/jobs/sweep', { headers: cron })).body.reviewReminders).toBe(0);
  });
});

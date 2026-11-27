// Postgres 구현체 (DATA_MODE=supabase). Supabase의 transaction pooler(DATABASE_URL)에 직접 붙는다.
// supabase-js(REST)는 트랜잭션이 없어 수락·확인처럼 여러 행을 함께 바꾸는 작업을 원자적으로 못 하기 때문.
import postgres, { type Sql, type TransactionSql } from 'postgres';
import type {
  BoardQuery,
  BoardRow,
  DesignerProfileRow,
  HairProfileRow,
  MatchRow,
  NotificationRow,
  PortfolioItemRow,
  Repo,
  RequestRow,
  ResponseRow,
  ReviewRow,
  UserRow,
} from './types.js';
import { UniqueViolation } from './types.js';

type AnySql = Sql | TransactionSql;
type Row = Record<string, unknown>;

/** jsonb 컬럼 (camelCase 키 → snake_case 컬럼) */
const JSON_COLUMNS = new Set(['cardSnapshot', 'alertSettings', 'history', 'source', 'profileUpdate', 'payload', 'beforeCard']);

export function createSql(databaseUrl: string, opts: { max?: number } = {}): Sql {
  return postgres(databaseUrl, {
    // Supabase transaction pooler(6543)는 prepared statement를 지원하지 않는다
    prepare: false,
    max: opts.max ?? 5,
    idle_timeout: 20,
    connect_timeout: 10,
    transform: { column: { from: postgres.toCamel, to: postgres.fromCamel }, json: false, undefined: null },
  });
}

export function createPostgresRepo(sql: Sql): Repo {
  return ops(sql, false);
}

/** insert/update용 값 정리: jsonb 컬럼은 sql.json으로 감싼다 */
function values(sql: AnySql, obj: Row): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    // 이름이 같아도 테이블마다 타입이 다를 수 있다 (hair_profiles.source = jsonb, portfolio_items.source = text)
    out[k] = JSON_COLUMNS.has(k) && v !== null && typeof v === 'object' && !(v instanceof Date) ? sql.json(v as never) : v;
  }
  return out;
}

const num = (v: unknown) => (v == null ? v : Number(v));
const toUser = (r: Row): UserRow => ({ ...(r as unknown as UserRow), temperature: Number(r.temperature) });
const toRequest = (r: Row) => r as unknown as RequestRow;
const toResponse = (r: Row) => r as unknown as ResponseRow;
const toMatch = (r: Row) => r as unknown as MatchRow;
const toDesigner = (r: Row) => r as unknown as DesignerProfileRow;
const toReview = (r: Row) => r as unknown as ReviewRow;
const toPortfolio = (r: Row) => r as unknown as PortfolioItemRow;
const toNotification = (r: Row) => r as unknown as NotificationRow;
const toHair = (r: Row): HairProfileRow => ({ ...(r as unknown as HairProfileRow), damage: Number(r.damage), level: num(r.level) as number | null });

async function unique<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const e = err as { code?: string; constraint_name?: string };
    if (e.code === '23505') throw new UniqueViolation(e.constraint_name ?? 'unique');
    throw err;
  }
}

function ops(sql: AnySql, inTx: boolean): Repo {
  const lock = (opts?: { lock?: boolean }) => (inTx && opts?.lock ? sql`for update` : sql``);
  const repo: Repo = {
    async tx(fn) {
      if (inTx) return fn(repo);
      return (sql as Sql).begin((tx) => fn(ops(tx, true))) as Promise<Awaited<ReturnType<typeof fn>>>;
    },

    // users
    async getUser(id) {
      const [r] = await sql`select * from users where id = ${id}`;
      return r ? toUser(r) : null;
    },
    async getUsers(ids) {
      if (!ids.length) return [];
      return (await sql`select * from users where id = any(${ids}::uuid[])`).map(toUser);
    },
    async getUserByKakaoId(kakaoId) {
      const [r] = await sql`select * from users where kakao_id = ${kakaoId}`;
      return r ? toUser(r) : null;
    },
    async insertUser(user) {
      await unique(() => sql`insert into users ${sql(values(sql, { ...user }))}`);
    },
    async updateUser(id, patch) {
      const v = values(sql, patch);
      if (Object.keys(v).length) await sql`update users set ${sql(v)} where id = ${id}`;
    },

    async adjustTemperature(id, delta, min, max) {
      const [r] = await sql`
        update users set temperature = round(least(${max}::numeric, greatest(${min}::numeric, temperature + ${delta}::numeric)), 1)
        where id = ${id} returning temperature`;
      return Number(r?.temperature ?? 36.5);
    },

    // designer_profiles
    async getDesignerProfile(userId) {
      const [r] = await sql`select * from designer_profiles where user_id = ${userId}`;
      return r ? toDesigner(r) : null;
    },
    async getDesignerProfiles(userIds) {
      if (!userIds.length) return [];
      return (await sql`select * from designer_profiles where user_id = any(${userIds}::uuid[])`).map(toDesigner);
    },
    async upsertDesignerProfile(profile) {
      const v = values(sql, { ...profile });
      const { userId: _id, ...rest } = v;
      await sql`insert into designer_profiles ${sql(v)} on conflict (user_id) do update set ${sql(rest)}`;
    },
    async updateDesignerProfile(userId, patch) {
      const v = values(sql, patch);
      if (Object.keys(v).length) await sql`update designer_profiles set ${sql(v)} where user_id = ${userId}`;
    },
    async listDesignersInRegions(regions) {
      return (await sql`select * from designer_profiles where regions && ${regions}::text[]`).map(toDesigner);
    },
    async listDecidedWithLicenseImage(limit) {
      return (
        await sql`select * from designer_profiles where verify_status <> 'pending' and license_image_key is not null limit ${limit}`
      ).map(toDesigner);
    },

    // hair_profiles
    async getHairProfile(userId) {
      const [r] = await sql`select * from hair_profiles where user_id = ${userId}`;
      return r ? toHair(r) : null;
    },
    async upsertHairProfile(profile) {
      const v = values(sql, { ...profile });
      const { userId: _id, ...rest } = v;
      await sql`insert into hair_profiles ${sql(v)} on conflict (user_id) do update set ${sql(rest)}`;
    },

    // requests
    async insertRequest(request) {
      await sql`insert into requests ${sql(values(sql, { ...request }))}`;
    },
    async getRequest(id, opts) {
      const [r] = await sql`select * from requests where id = ${id} ${lock(opts)}`;
      return r ? toRequest(r) : null;
    },
    async getRequests(ids) {
      if (!ids.length) return [];
      return (await sql`select * from requests where id = any(${ids}::uuid[])`).map(toRequest);
    },
    async updateRequest(id, patch) {
      const v = values(sql, patch);
      if (Object.keys(v).length) await sql`update requests set ${sql(v)} where id = ${id}`;
    },
    async listRequestsByCustomer(customerId, statuses, page) {
      return (
        await sql`
          select * from requests
          where customer_id = ${customerId} ${statuses ? sql`and status = any(${statuses}::text[])` : sql``}
          order by created_at desc, id desc
          limit ${page.limit} offset ${page.offset}`
      ).map(toRequest);
    },
    async listBoard(q: BoardQuery): Promise<BoardRow[]> {
      const rows = await sql`
        select r.*, (select count(*) from responses s where s.request_id = r.id)::int as response_count
        from requests r
        where r.status = 'open'
          and r.expires_at > ${q.now}
          and r.customer_id <> ${q.excludeCustomerId}
          and r.regions && ${q.regions}::text[]
          ${q.treatmentType ? sql`and r.treatment_type = ${q.treatmentType}` : sql``}
          ${q.difficulty ? sql`and r.difficulty = ${q.difficulty}` : sql``}
          ${q.budget ? sql`and (r.budget is null or r.budget = ${q.budget})` : sql``}
        order by ${q.sort === 'fewest_responses' ? sql`response_count asc, r.created_at desc` : sql`r.created_at desc`}, r.id desc
        limit ${q.page.limit} offset ${q.page.offset}`;
      return rows.map(({ responseCount, ...r }) => ({ request: toRequest(r), responseCount: Number(responseCount) }));
    },
    async listOverdueOpenRequests(now, opts = {}) {
      return (
        await sql`
          select * from requests
          where status = 'open' and expires_at <= ${now}
          ${opts.customerId ? sql`and customer_id = ${opts.customerId}` : sql``}
          order by expires_at
          ${opts.limit ? sql`limit ${opts.limit}` : sql``}`
      ).map(toRequest);
    },
    async listOpenRequestsExpiringBetween(now, before) {
      return (await sql`select * from requests where status = 'open' and expires_at > ${now} and expires_at <= ${before}`).map(toRequest);
    },
    async isImageKeyReferenced(key) {
      const [r] = await sql`
        select (
          exists (select 1 from requests where design_image_key = ${key})
          or exists (select 1 from matches where ${key} = any(designer_result_keys) or ${key} = any(customer_result_keys))
          or exists (select 1 from designer_profiles where license_image_key = ${key})
          or exists (select 1 from portfolio_items where design_key = ${key} or result_key = ${key})
        ) as referenced`;
      return Boolean(r?.referenced);
    },

    // responses
    async insertResponse(response) {
      await unique(() => sql`insert into responses ${sql(values(sql, { ...response }))}`);
    },
    async getResponse(id) {
      const [r] = await sql`select * from responses where id = ${id}`;
      return r ? toResponse(r) : null;
    },
    async listResponsesByRequest(requestId) {
      return (await sql`select * from responses where request_id = ${requestId} order by created_at, id`).map(toResponse);
    },
    async listResponsesByDesigner(designerId, requestIds) {
      if (!requestIds.length) return [];
      return (await sql`select * from responses where designer_id = ${designerId} and request_id = any(${requestIds}::uuid[])`).map(toResponse);
    },
    async listAllResponsesByDesigner(designerId) {
      return (await sql`select * from responses where designer_id = ${designerId} order by created_at desc, id desc`).map(toResponse);
    },
    async countResponses(requestIds) {
      const m = new Map(requestIds.map((id) => [id, 0]));
      if (!requestIds.length) return m;
      const rows = await sql`select request_id, count(*)::int as n from responses where request_id = any(${requestIds}::uuid[]) group by request_id`;
      for (const r of rows) m.set(r.requestId as string, Number(r.n));
      return m;
    },
    async updateResponse(id, patch) {
      const v = values(sql, patch);
      if (Object.keys(v).length) await sql`update responses set ${sql(v)} where id = ${id}`;
    },
    async closePendingResponses(requestId, status, exceptId) {
      return (
        await sql`
          update responses set status = ${status}
          where request_id = ${requestId} and status = 'pending' ${exceptId ? sql`and id <> ${exceptId}` : sql``}
          returning *`
      ).map(toResponse);
    },

    // matches
    async insertMatch(match) {
      await unique(() => sql`insert into matches ${sql(values(sql, { ...match }))}`);
    },
    async getMatch(id, opts) {
      const [r] = await sql`select * from matches where id = ${id} ${lock(opts)}`;
      return r ? toMatch(r) : null;
    },
    async getMatchByRequest(requestId) {
      const [r] = await sql`select * from matches where request_id = ${requestId}`;
      return r ? toMatch(r) : null;
    },
    async updateMatch(id, patch) {
      const v = values(sql, patch);
      if (Object.keys(v).length) await sql`update matches set ${sql(v)} where id = ${id}`;
    },
    async countCompletedMatches(designerIds) {
      const m = new Map(designerIds.map((id) => [id, 0]));
      if (!designerIds.length) return m;
      const rows = await sql`
        select designer_id, count(*)::int as n from matches
        where status = 'completed' and designer_id = any(${designerIds}::uuid[]) group by designer_id`;
      for (const r of rows) m.set(r.designerId as string, Number(r.n));
      return m;
    },
    async countRecentDisputes(designerIds, since) {
      const m = new Map(designerIds.map((id) => [id, 0]));
      if (!designerIds.length) return m;
      const rows = await sql`
        select designer_id, count(*)::int as n from matches
        where status = 'disputed' and complete_requested_at >= ${since}
          and designer_id = any(${designerIds}::uuid[]) group by designer_id`;
      for (const r of rows) m.set(r.designerId as string, Number(r.n));
      return m;
    },
    async hasActiveMatch(userId) {
      const [r] = await sql`
        select exists (
          select 1 from matches
          where (customer_id = ${userId} or designer_id = ${userId}) and status in ('accepted', 'complete_requested')
        ) as active`;
      return Boolean(r?.active);
    },

    async listMatchesByResponses(responseIds) {
      if (!responseIds.length) return [];
      return (await sql`select * from matches where response_id = any(${responseIds}::uuid[])`).map(toMatch);
    },
    async listOverdueCompleteRequested(now, limit) {
      return (
        await sql`select * from matches where status = 'complete_requested' and confirm_deadline <= ${now} order by confirm_deadline limit ${limit}`
      ).map(toMatch);
    },
    async listCompletedBetween(from, to) {
      return (
        await sql`
          select * from matches
          where status = 'completed' and coalesce(confirmed_at, confirm_deadline) >= ${from} and coalesce(confirmed_at, confirm_deadline) < ${to}`
      ).map(toMatch);
    },

    // reviews
    async insertReview(review) {
      await unique(() => sql`insert into reviews ${sql(values(sql, { ...review }))}`);
    },
    async listReviewsByMatches(matchIds) {
      if (!matchIds.length) return [];
      return (await sql`select * from reviews where match_id = any(${matchIds}::uuid[])`).map(toReview);
    },
    async listReviewsForTarget(targetId, authorRole, page) {
      return (
        await sql`
          select * from reviews where target_id = ${targetId} and author_role = ${authorRole}
          order by created_at desc, id desc limit ${page.limit} offset ${page.offset}`
      ).map(toReview);
    },
    async countReviewsForTarget(targetId, authorRole) {
      const [r] = await sql`select count(*)::int as n from reviews where target_id = ${targetId} and author_role = ${authorRole}`;
      return Number(r?.n ?? 0);
    },

    // portfolio_items
    async insertPortfolioItem(item) {
      await unique(() => sql`insert into portfolio_items ${sql(values(sql, { ...item }))}`);
    },
    async listPortfolio(designerId, opts, page) {
      return (
        await sql`
          select * from portfolio_items
          where designer_id = ${designerId}
          ${opts.source ? sql`and source = ${opts.source}` : sql``}
          ${opts.requiredTags?.length ? sql`and hair_tags @> ${opts.requiredTags}::text[]` : sql``}
          order by created_at desc, id desc limit ${page.limit} offset ${page.offset}`
      ).map(toPortfolio);
    },
    async countPortfolio(designerId, source) {
      const [r] = await sql`select count(*)::int as n from portfolio_items where designer_id = ${designerId} and source = ${source}`;
      return Number(r?.n ?? 0);
    },

    // notifications
    async insertNotifications(rows: NotificationRow[]) {
      if (!rows.length) return;
      await sql`insert into notifications ${sql(rows.map((n) => values(sql, { ...n })))}`;
    },
    async hasNotification(userId, type, refKey, refValue) {
      const [r] = await sql`
        select exists (
          select 1 from notifications where user_id = ${userId} and type = ${type} and payload ->> ${refKey} = ${refValue}
        ) as found`;
      return Boolean(r?.found);
    },
    async listNotifications(userId, unreadOnly, page) {
      return (
        await sql`
          select * from notifications where user_id = ${userId} ${unreadOnly ? sql`and read_at is null` : sql``}
          order by created_at desc, id desc limit ${page.limit} offset ${page.offset}`
      ).map(toNotification);
    },
    async countUnread(userId) {
      const [r] = await sql`select count(*)::int as n from notifications where user_id = ${userId} and read_at is null`;
      return Number(r?.n ?? 0);
    },
    async markNotificationsRead(userId, ids, now) {
      await sql`
        update notifications set read_at = ${now}
        where user_id = ${userId} and read_at is null ${ids ? sql`and id = any(${ids}::uuid[])` : sql``}`;
    },
  };
  return repo;
}

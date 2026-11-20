// 손님: 요청 등록 · 내 요청 관리 · 응답 비교 · 수락
import { randomUUID } from 'node:crypto';
import {
  BUDGETS,
  MARKETPLACE_LIMITS,
  TIMINGS,
  type AcceptResponseResult,
  type Budget,
  type CloseRequestResponse,
  type CreateRequestResponse,
  type MyRequestFilter,
  type MyRequestItem,
  type Paged,
  type ReopenRequestResponse,
  type RequestCard,
  type RequestDetail,
  type RequestStatus,
  type ResponseCard,
  type ResponseSort,
  type Timing,
} from '../shared/index.js';
import type { AppDeps } from '../deps.js';
import { ApiFail, badRequest, forbidden, invalidState, notFound } from '../http/errors.js';
import { toPaged } from '../http/page.js';
import { FieldErrors, isObj, oneOf, optionalOneOf, regions as parseRegions, text } from '../http/validate.js';
import { parseProfile, parseStyleSource, sanitizeStyleTag } from '../lib/validate.js';
import type { Page, RequestRow } from '../repo/types.js';
import { REQUEST_TTL_MS, SIGNED_URL_TTL_SEC, assertUuid, iso, isOpen, myRequestItem, notify, requestDetail } from './common.js';
import { hairTags } from './hairTags.js';
import { expireIfOverdue, notifyMatchingDesigners, syncCustomerRequests, syncRequest } from './lifecycle.js';
import { checkUploadKey } from './uploads.js';

const FILTER_STATUSES: Record<MyRequestFilter, RequestStatus[]> = {
  open: ['open'],
  matched: ['matched'],
  closed: ['completed', 'expired', 'cancelled'],
};

function parseCard(v: unknown, e: FieldErrors): RequestCard | undefined {
  if (!isObj(v)) {
    e.add('card', '전달 카드가 필요함');
    return undefined;
  }
  const styleTag = sanitizeStyleTag(v.styleTag);
  if (!styleTag) e.add('card.styleTag', '비어 있음');
  const styleSource = parseStyleSource(v.styleSource);
  if (!styleSource) e.add('card.styleSource', '형식이 올바르지 않음');
  const profile = parseProfile(v.profile);
  if (!profile) e.add('card.profile', '모발 프로필 형식이 올바르지 않음');
  const requestText = text(v.requestText ?? '', 'card.requestText', MARKETPLACE_LIMITS.requestTextMax, e, { allowEmpty: true });
  let riskWarnings: string[] | undefined;
  const rw = v.riskWarnings ?? [];
  if (!Array.isArray(rw) || rw.length > MARKETPLACE_LIMITS.riskWarningsMax) {
    e.add('card.riskWarnings', `${MARKETPLACE_LIMITS.riskWarningsMax}개 이하 문자열 배열`);
  } else {
    const items = rw.map((w, i) => text(w, `card.riskWarnings.${i}`, MARKETPLACE_LIMITS.riskWarningMax, e));
    if (items.every((w) => w !== undefined)) riskWarnings = items as string[];
  }
  if (!styleTag || !styleSource || !profile || requestText === undefined || !riskWarnings) return undefined;
  return { styleTag, styleSource, profile, requestText, riskWarnings };
}

interface ConditionPatch {
  regions?: string[];
  timing?: Timing;
  budget?: Budget | null;
}

/** PATCH·reopen 본문: { regions?, timing?, budget? } */
function parseConditions(body: unknown, e: FieldErrors, opts: { requireOne: boolean }): ConditionPatch {
  const b = isObj(body) ? body : {};
  const patch: ConditionPatch = {};
  if (b.regions !== undefined) patch.regions = parseRegions(b.regions, 'regions', e);
  if (b.timing !== undefined) patch.timing = oneOf(b.timing, TIMINGS, 'timing', e);
  if (b.budget !== undefined) patch.budget = b.budget === null ? null : oneOf(b.budget, BUDGETS, 'budget', e);
  if (opts.requireOne && !Object.keys(patch).length) e.add('body', 'regions·timing·budget 중 하나 이상');
  e.throwIfAny();
  return patch;
}

/** 본인 요청만. 남의 요청은 403, 없으면 404. 읽을 때 만료를 다시 확인한다 */
async function loadOwnRequest(d: AppDeps, userId: string, id: string): Promise<RequestRow> {
  const r = await d.repo.getRequest(assertUuid(id, '요청을 찾을 수 없음'));
  if (!r) throw notFound('요청을 찾을 수 없음');
  if (r.customerId !== userId) throw forbidden('본인 요청이 아님');
  return syncRequest(d, r);
}

async function designUrl(d: AppDeps, r: RequestRow): Promise<string | null> {
  return (await d.storage.signedUrls([r.designImageKey], SIGNED_URL_TTL_SEC)).get(r.designImageKey) ?? null;
}

// ── POST /requests ──

export async function createRequest(d: AppDeps, userId: string, body: unknown): Promise<CreateRequestResponse> {
  if (!isObj(body)) throw badRequest();
  if (!isObj(body.consent) || body.consent.shareDesignWithVerifiedDesigners !== true) {
    throw new ApiFail(422, 'consent_required', '인증 디자이너에게 시안을 공개하는 데 동의해야 요청을 올릴 수 있음');
  }
  const e = new FieldErrors();
  const card = parseCard(body.card, e);
  const regions = parseRegions(body.regions, 'regions', e);
  const timing = oneOf(body.timing, TIMINGS, 'timing', e);
  const budget = body.budget == null ? null : oneOf(body.budget, BUDGETS, 'budget', e);
  const designImageKey = await checkUploadKey(d, body.designImageKey, 'request_design', userId, 'designImageKey', e);
  e.throwIfAny();

  const now = d.now();
  const estimate = await d.estimator.estimate(card!, now);
  const row: RequestRow = {
    id: randomUUID(),
    customerId: userId,
    cardSnapshot: card!,
    styleTag: card!.styleTag,
    ...estimate,
    hairTags: hairTags(card!.profile, now),
    designImageKey: designImageKey!,
    designHiddenAt: null,
    designConsentAt: now,
    regions: regions!,
    timing: timing!,
    budget: budget ?? null,
    status: 'open',
    version: 1,
    expiresAt: new Date(now.getTime() + REQUEST_TTL_MS),
    createdAt: now,
    updatedAt: now,
  };
  await d.repo.tx(async (repo) => {
    await repo.insertRequest(row);
    await notifyMatchingDesigners(repo, row, now);
  });
  return { id: row.id, status: 'open', expiresAt: iso(row.expiresAt), ...estimate };
}

// ── GET /requests/mine ──

export async function listMyRequests(d: AppDeps, userId: string, filter: string | undefined, page: Page): Promise<Paged<MyRequestItem>> {
  const e = new FieldErrors();
  const f = optionalOneOf(filter, ['open', 'matched', 'closed'] as const, 'status', e);
  e.throwIfAny();
  await syncCustomerRequests(d, userId);
  const rows = await d.repo.listRequestsByCustomer(userId, f ? FILTER_STATUSES[f] : null, page);
  const paged = toPaged(rows, page);
  const ids = paged.items.map((r) => r.id);
  const [counts, urls] = await Promise.all([
    d.repo.countResponses(ids),
    // 본인 요청이라 비공개 처리(design_hidden_at) 뒤에도 보여 준다
    d.storage.signedUrls(paged.items.map((r) => r.designImageKey), SIGNED_URL_TTL_SEC),
  ]);
  return {
    items: paged.items.map((r) => myRequestItem(r, counts.get(r.id) ?? 0, urls.get(r.designImageKey) ?? null)),
    nextCursor: paged.nextCursor,
  };
}

// ── GET /requests/:id ──

export async function getMyRequest(d: AppDeps, userId: string, id: string): Promise<RequestDetail> {
  const r = await loadOwnRequest(d, userId, id);
  const [counts, url, match] = await Promise.all([d.repo.countResponses([r.id]), designUrl(d, r), d.repo.getMatchByRequest(r.id)]);
  return requestDetail(r, counts.get(r.id) ?? 0, url, match);
}

// ── PATCH /requests/:id ── open일 때만, version +1 → 기존 응답은 isOutdated

export async function updateRequest(d: AppDeps, userId: string, id: string, body: unknown): Promise<RequestDetail> {
  const r0 = await loadOwnRequest(d, userId, id);
  const patch = parseConditions(body, new FieldErrors(), { requireOne: true });
  const now = d.now();
  await d.repo.tx(async (repo) => {
    const r = await repo.getRequest(r0.id, { lock: true });
    if (!r || !isOpen(r, now)) throw invalidState('진행 중(open)인 요청만 조건을 바꿀 수 있음');
    await repo.updateRequest(r.id, { ...patch, version: r.version + 1, updatedAt: now });
  });
  return getMyRequest(d, userId, r0.id);
}

// ── POST /requests/:id/close ── open → cancelled

export async function closeRequest(d: AppDeps, userId: string, id: string): Promise<CloseRequestResponse> {
  const r0 = await loadOwnRequest(d, userId, id);
  const now = d.now();
  await d.repo.tx(async (repo) => {
    const r = await repo.getRequest(r0.id, { lock: true });
    if (!r || !isOpen(r, now)) throw invalidState('진행 중(open)인 요청만 내릴 수 있음');
    await repo.updateRequest(r.id, { status: 'cancelled', designHiddenAt: now, updatedAt: now });
    const closed = await repo.closePendingResponses(r.id, 'not_selected');
    await notify(
      repo,
      now,
      closed.map((s) => ({ userId: s.designerId, type: 'request_closed', payload: { requestId: r.id, styleTag: r.styleTag, reason: 'cancelled' } })),
    );
  });
  return { id: r0.id, status: 'cancelled' };
}

// ── POST /requests/:id/reopen ── expired + 응답 0개 → open, 마감 +7일

export async function reopenRequest(d: AppDeps, userId: string, id: string, body: unknown): Promise<ReopenRequestResponse> {
  const r0 = await loadOwnRequest(d, userId, id);
  const patch = parseConditions(body ?? {}, new FieldErrors(), { requireOne: false });
  const now = d.now();
  return d.repo.tx(async (repo) => {
    const r = await expireIfOverdue(repo, r0.id, now);
    if (!r || r.status !== 'expired') throw invalidState('마감(expired)된 요청만 다시 올릴 수 있음');
    if (((await repo.countResponses([r.id])).get(r.id) ?? 0) > 0) throw invalidState('응답이 있었던 요청은 다시 올릴 수 없음');
    const next: RequestRow = {
      ...r,
      ...patch,
      status: 'open',
      version: r.version + 1,
      expiresAt: new Date(now.getTime() + REQUEST_TTL_MS),
      designHiddenAt: null,
      updatedAt: now,
    };
    await repo.updateRequest(r.id, {
      ...patch,
      status: next.status,
      version: next.version,
      expiresAt: next.expiresAt,
      designHiddenAt: null,
      updatedAt: now,
    });
    await notifyMatchingDesigners(repo, next, now);
    return { id: r.id, status: 'open', expiresAt: iso(next.expiresAt), version: next.version };
  });
}

// ── GET /requests/:id/responses ── 예약 링크·연락처 없음

export async function listResponsesForCustomer(
  d: AppDeps,
  userId: string,
  id: string,
  sortRaw: string | undefined,
  page: Page,
): Promise<Paged<ResponseCard>> {
  const e = new FieldErrors();
  const sort = optionalOneOf(sortRaw, ['price_asc', 'temperature_desc', 'works_desc'] as const, 'sort', e) as ResponseSort | undefined;
  e.throwIfAny();
  const r = await loadOwnRequest(d, userId, id);
  const responses = await d.repo.listResponsesByRequest(r.id);
  const designerIds = [...new Set(responses.map((s) => s.designerId))];
  const [users, profiles, works] = await Promise.all([
    d.repo.getUsers(designerIds),
    d.repo.getDesignerProfiles(designerIds),
    d.repo.countCompletedMatches(designerIds),
  ]);
  const userById = new Map(users.map((u) => [u.id, u]));
  const profileById = new Map(profiles.map((p) => [p.userId, p]));
  const cards: ResponseCard[] = responses.map((s) => {
    const u = userById.get(s.designerId);
    const p = profileById.get(s.designerId);
    return {
      id: s.id,
      availability: s.availability,
      condition: s.condition,
      priceMin: s.priceMin,
      priceMax: s.priceMax,
      comment: s.comment,
      isOutdated: s.requestVersion < r.version,
      status: s.status,
      createdAt: iso(s.createdAt),
      designer: {
        id: s.designerId,
        nickname: u?.nickname ?? '',
        shopName: p?.shopName ?? '',
        area: (p?.regions ?? []).join(' · '),
        temperature: u?.temperature ?? 36.5,
        verifiedWorkCount: works.get(s.designerId) ?? 0,
      },
    };
  });
  const byTime = (a: ResponseCard, b: ResponseCard) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
  cards.sort((a, b) => {
    if (sort === 'price_asc') return a.priceMin - b.priceMin || a.priceMax - b.priceMax || byTime(a, b);
    if (sort === 'temperature_desc') return b.designer.temperature - a.designer.temperature || byTime(a, b);
    if (sort === 'works_desc') return b.designer.verifiedWorkCount - a.designer.verifiedWorkCount || byTime(a, b);
    return byTime(a, b);
  });
  return toPaged(cards.slice(page.offset, page.offset + page.limit), page);
}

// ── POST /responses/:id/accept ── 예약 링크는 여기서만

export async function acceptResponse(d: AppDeps, userId: string, responseId: string): Promise<AcceptResponseResult> {
  const s0 = await d.repo.getResponse(assertUuid(responseId, '응답을 찾을 수 없음'));
  if (!s0) throw notFound('응답을 찾을 수 없음');
  const r0 = await d.repo.getRequest(s0.requestId);
  if (!r0) throw notFound('응답을 찾을 수 없음');
  if (r0.customerId !== userId) throw forbidden('본인 요청의 응답만 수락할 수 있음');
  await syncRequest(d, r0);
  const now = d.now();
  return d.repo.tx(async (repo) => {
    const r = await repo.getRequest(r0.id, { lock: true });
    if (!r || !isOpen(r, now)) throw invalidState('진행 중(open)인 요청에서만 수락할 수 있음');
    const s = await repo.getResponse(s0.id);
    if (!s || s.status !== 'pending') throw invalidState('대기 중인 응답만 수락할 수 있음');
    const designer = await repo.getDesignerProfile(s.designerId);
    if (!designer?.bookingUrl) throw invalidState('디자이너의 예약 링크가 없어 수락할 수 없음');

    const matchId = randomUUID();
    await repo.updateRequest(r.id, { status: 'matched', updatedAt: now });
    await repo.updateResponse(s.id, { status: 'accepted' });
    const others = await repo.closePendingResponses(r.id, 'not_selected', s.id);
    await repo.insertMatch({
      id: matchId,
      requestId: r.id,
      responseId: s.id,
      customerId: r.customerId,
      designerId: s.designerId,
      status: 'accepted',
      acceptedAt: now,
      completeRequestedAt: null,
      confirmedAt: null,
      confirmDeadline: null,
      autoCompleted: false,
      designerResultKeys: [],
      customerResultKeys: [],
      portfolioConsent: false,
      profileUpdate: null,
      disputeReason: null,
    });
    await notify(repo, now, [
      { userId: s.designerId, type: 'accepted', payload: { requestId: r.id, matchId, styleTag: r.styleTag } },
      ...others.map((o) => ({
        userId: o.designerId,
        type: 'request_closed' as const,
        payload: { requestId: r.id, styleTag: r.styleTag, reason: 'other_accepted' },
      })),
    ]);
    return { matchId, bookingUrl: designer.bookingUrl };
  });
}

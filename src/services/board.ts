// 디자이너: 지역 요청 게시판 · 요청 상세 · 응답 · 알림 조건
// 공개 범위: 목록(BoardItem)엔 이미지 URL 없음. 시안은 인증 디자이너 + 비공개 처리 전일 때만 10분 서명 URL.
import { randomUUID } from 'node:crypto';
import {
  BUDGETS,
  DIFFICULTIES,
  MARKETPLACE_LIMITS,
  TREATMENT_TYPES,
  type AlertSettings,
  type BoardDetail,
  type BoardItem,
  type Paged,
} from '../shared';
import type { AppDeps } from '../deps';
import { alreadyResponded, badRequest, forbidden, notFound, requestClosed } from '../http/errors';
import { toPaged } from '../http/page';
import { FieldErrors, intIn, isObj, oneOf, optionalOneOf, text } from '../http/validate';
import { UniqueViolation, type DesignerProfileRow, type Page } from '../repo/types';
import { SIGNED_URL_TTL_SEC, assertUuid, boardItem, isOpen, myResponse, notify } from './common';
import { DEFAULT_ALERT_SETTINGS, syncRequest } from './lifecycle';

/** 응답 가격 상한 (원) — 입력 실수 방지 */
const PRICE_MAX = 10_000_000;

export interface BoardFilters {
  region?: string;
  treatment?: string;
  difficulty?: string;
  budget?: string;
  sort?: string;
}

// ── GET /board ──

export async function listBoard(d: AppDeps, designer: DesignerProfileRow, f: BoardFilters, page: Page): Promise<Paged<BoardItem>> {
  const e = new FieldErrors();
  if (f.region && !designer.regions.includes(f.region)) e.add('region', `활동 지역(${designer.regions.join(', ')}) 중 하나`);
  const treatmentType = optionalOneOf(f.treatment, TREATMENT_TYPES, 'treatment', e);
  const difficulty = optionalOneOf(f.difficulty, DIFFICULTIES, 'difficulty', e);
  const budget = optionalOneOf(f.budget, BUDGETS, 'budget', e);
  const sort = optionalOneOf(f.sort, ['newest', 'fewest_responses'] as const, 'sort', e) ?? 'newest';
  e.throwIfAny();

  const rows = await d.repo.listBoard({
    now: d.now(),
    regions: f.region ? [f.region] : designer.regions,
    excludeCustomerId: designer.userId,
    treatmentType,
    difficulty,
    budget,
    sort,
    page,
  });
  const paged = toPaged(rows, page);
  const mine = new Set(
    (await d.repo.listResponsesByDesigner(designer.userId, paged.items.map((x) => x.request.id))).map((s) => s.requestId),
  );
  return {
    items: paged.items.map((x) => boardItem(x.request, x.responseCount, mine.has(x.request.id))),
    nextCursor: paged.nextCursor,
  };
}

// ── GET /board/:requestId ──

export async function getBoardDetail(d: AppDeps, designer: DesignerProfileRow, requestId: string): Promise<BoardDetail> {
  const r0 = await d.repo.getRequest(assertUuid(requestId, '요청을 찾을 수 없음'));
  if (!r0) throw notFound('요청을 찾을 수 없음');
  if (r0.customerId === designer.userId) throw forbidden('본인 요청은 게시판에서 볼 수 없음');
  const r = await syncRequest(d, r0);
  const mine = await d.repo.listResponsesByDesigner(designer.userId, [r.id]);
  const my = mine[0] ?? null;
  // 마감·취소·매칭된 요청은 응답했던 디자이너만 계속 볼 수 있다
  if (r.status !== 'open' && !my) throw notFound('요청을 찾을 수 없음');

  const canSeeDesign = designer.verifyStatus === 'verified' && r.designHiddenAt === null;
  const [counts, urls] = await Promise.all([
    d.repo.countResponses([r.id]),
    canSeeDesign ? d.storage.signedUrls([r.designImageKey], SIGNED_URL_TTL_SEC) : Promise.resolve(new Map<string, string>()),
  ]);
  return {
    ...boardItem(r, counts.get(r.id) ?? 0, Boolean(my)),
    status: r.status,
    card: { profile: r.cardSnapshot.profile, requestText: r.cardSnapshot.requestText, riskWarnings: r.cardSnapshot.riskWarnings },
    designImageUrl: canSeeDesign ? (urls.get(r.designImageKey) ?? null) : null,
    myResponse: my ? myResponse(my, r.version) : null,
  };
}

// ── POST /requests/:id/responses ── 인증 디자이너만 (미들웨어), 요청당 1회

export async function createResponse(d: AppDeps, designer: DesignerProfileRow, requestId: string, body: unknown): Promise<{ id: string }> {
  const r0 = await d.repo.getRequest(assertUuid(requestId, '요청을 찾을 수 없음'));
  if (!r0) throw notFound('요청을 찾을 수 없음');
  if (r0.customerId === designer.userId) throw forbidden('본인 요청에는 응답할 수 없음');
  const r1 = await syncRequest(d, r0);
  if (!isOpen(r1, d.now())) throw requestClosed();
  if ((await d.repo.listResponsesByDesigner(designer.userId, [r1.id])).length) throw alreadyResponded('이미 이 요청에 응답함');

  if (!isObj(body)) throw badRequest();
  const e = new FieldErrors();
  const availability = oneOf(body.availability, ['possible', 'conditional'] as const, 'availability', e);
  let condition: string | null = null;
  if (availability === 'conditional') condition = text(body.condition, 'condition', MARKETPLACE_LIMITS.conditionMax, e) ?? null;
  const priceMin = intIn(body.priceMin, 'priceMin', 0, PRICE_MAX, e);
  const priceMax = intIn(body.priceMax, 'priceMax', 0, PRICE_MAX, e);
  if (priceMin !== undefined && priceMax !== undefined && priceMin > priceMax) e.add('priceMax', 'priceMin 이상');
  const comment = text(body.comment, 'comment', MARKETPLACE_LIMITS.responseCommentMax, e);
  if (!designer.bookingUrl) e.add('bookingUrl', '디자이너 정보에 예약 링크(https)를 먼저 등록해야 응답할 수 있음');
  e.throwIfAny();

  const now = d.now();
  const id = randomUUID();
  await d.repo.tx(async (repo) => {
    const r = await repo.getRequest(r1.id, { lock: true });
    if (!r || !isOpen(r, now)) throw requestClosed();
    try {
      await repo.insertResponse({
        id,
        requestId: r.id,
        designerId: designer.userId,
        availability: availability!,
        condition,
        priceMin: priceMin!,
        priceMax: priceMax!,
        comment: comment!,
        requestVersion: r.version,
        status: 'pending',
        createdAt: now,
      });
    } catch (err) {
      if (err instanceof UniqueViolation) throw alreadyResponded('이미 이 요청에 응답함');
      throw err;
    }
    await notify(repo, now, [{ userId: r.customerId, type: 'new_response', payload: { requestId: r.id, responseId: id, styleTag: r.styleTag } }]);
  });
  return { id };
}

// ── GET·PUT /designers/me/alert-settings ──

export function getAlertSettings(designer: DesignerProfileRow): AlertSettings {
  return designer.alertSettings ?? DEFAULT_ALERT_SETTINGS;
}

export async function putAlertSettings(d: AppDeps, designer: DesignerProfileRow, body: unknown): Promise<AlertSettings> {
  if (!isObj(body)) throw badRequest();
  const e = new FieldErrors();
  if (typeof body.enabled !== 'boolean') e.add('enabled', 'true | false');
  const list = <T extends string>(v: unknown, field: string, allowed: readonly T[]): T[] | undefined => {
    if (!Array.isArray(v) || new Set(v).size !== v.length || !v.every((x) => allowed.includes(x as T))) {
      e.add(field, `${allowed.join(' | ')} 중에서 중복 없이 (빈 배열 = 전부)`);
      return undefined;
    }
    return v as T[];
  };
  // 지역은 활동 지역 안에서만 (지역 전체 알림 없음)
  const regions = list(body.regions, 'regions', designer.regions);
  const treatmentTypes = list(body.treatmentTypes, 'treatmentTypes', TREATMENT_TYPES);
  const difficulties = list(body.difficulties, 'difficulties', DIFFICULTIES);
  const budgets = list(body.budgets, 'budgets', BUDGETS);
  e.throwIfAny();
  const settings: AlertSettings = { enabled: body.enabled as boolean, regions: regions!, treatmentTypes: treatmentTypes!, difficulties: difficulties!, budgets: budgets! };
  await d.repo.updateDesignerProfile(designer.userId, { alertSettings: settings });
  return settings;
}

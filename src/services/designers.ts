// 디자이너: 공개 프로필·포트폴리오·후기 (C-04) · 면허 인증 신청 (D-01) · 정보 수정 · 내 응답 진행 관리 (D-04)
import {
  LENGTH_LABELS,
  TEXTURE_LABELS,
  type DesignerPublicProfile,
  type DesignerResponseItem,
  type DesignerResponseTab,
  type DesignerReview,
  type Me,
  type Paged,
  type PortfolioItem,
  type VerificationStatus,
} from '../shared/index.js';
import type { AppDeps } from '../deps.js';
import { badRequest, invalidState, notFound } from '../http/errors.js';
import { toPaged } from '../http/page.js';
import { FieldErrors, httpsUrl, isObj, optionalOneOf, regions as parseRegions, text } from '../http/validate.js';
import type { DesignerProfileRow, MatchRow, Page } from '../repo/types.js';
import { REVIEW_TTL_MS, SIGNED_URL_TTL_SEC, assertUuid, iso, myResponse, disputeWindowStart } from './common.js';
import { DEFAULT_ALERT_SETTINGS, syncRequest } from './lifecycle.js';
import { autoCompleteIfOverdue, completedAt } from './matches.js';
import { checkUploadKey } from './uploads.js';

/** 라벨의 괄호 설명을 뗀 태그 (hairTags와 같은 형식) */
const tag = (label: string) => label.replace(/\s*\(.*\)\s*$/, '');
/** 면허 번호 형식 (숫자·영문·하이픈). 확인에만 쓰고 저장·로그하지 않는다 */
const LICENSE_NUMBER = /^[0-9A-Za-z-]{4,30}$/;
const INSTAGRAM = /^@?[A-Za-z0-9._]{1,30}$/;

async function loadDesigner(d: AppDeps, id: string): Promise<DesignerProfileRow> {
  const p = await d.repo.getDesignerProfile(assertUuid(id, '디자이너를 찾을 수 없음'));
  if (!p) throw notFound('디자이너를 찾을 수 없음');
  return p;
}

// ── GET /designers/:id ──

export async function getDesignerProfile(d: AppDeps, id: string): Promise<DesignerPublicProfile> {
  const p = await loadDesigner(d, id);
  const [user, reviewCount, works, manualWorkCount, disputes] = await Promise.all([
    d.repo.getUser(p.userId),
    d.repo.countReviewsForTarget(p.userId, 'customer'),
    d.repo.countCompletedMatches([p.userId]),
    d.repo.countPortfolio(p.userId, 'manual'),
    d.repo.countRecentDisputes([p.userId], disputeWindowStart(d.now())),
  ]);
  return {
    id: p.userId,
    nickname: user?.nickname ?? '',
    verified: p.verifyStatus === 'verified',
    shopName: p.shopName,
    area: p.regions.join(' · '),
    instagram: p.instagram,
    temperature: user?.temperature ?? 36.5,
    reviewCount,
    verifiedWorkCount: works.get(p.userId) ?? 0,
    manualWorkCount,
    recentDisputes90d: disputes.get(p.userId) ?? 0,
  };
}

// ── GET /designers/:id/portfolio ──

export async function listPortfolio(
  d: AppDeps,
  viewerId: string,
  id: string,
  q: { source?: string; similarToMe?: string },
  page: Page,
): Promise<Paged<PortfolioItem>> {
  const e = new FieldErrors();
  const source = optionalOneOf(q.source, ['verified', 'manual'] as const, 'source', e);
  const similar = optionalOneOf(q.similarToMe, ['true', 'false'] as const, 'similarToMe', e) === 'true';
  e.throwIfAny();
  const p = await loadDesigner(d, id);
  // 내 기장·모질 태그가 둘 다 있는 작업물만. 서버 모발 프로필이 없으면 필터 없이 전체
  let requiredTags: string[] | undefined;
  if (similar) {
    const mine = await d.repo.getHairProfile(viewerId);
    if (mine) requiredTags = [tag(LENGTH_LABELS[mine.length]), TEXTURE_LABELS[mine.texture]];
  }
  const rows = await d.repo.listPortfolio(p.userId, { source, requiredTags }, page);
  const paged = toPaged(rows, page);
  const urls = await d.storage.signedUrls(
    paged.items.flatMap((x) => [x.designKey, x.resultKey].filter((k): k is string => Boolean(k))),
    SIGNED_URL_TTL_SEC,
  );
  return {
    items: paged.items.map((x) => ({
      id: x.id,
      source: x.source,
      styleTag: x.styleTag,
      treatmentType: x.treatmentType,
      beforeCard: x.beforeCard,
      designImageUrl: x.designKey ? (urls.get(x.designKey) ?? null) : null,
      resultImageUrl: x.resultKey ? (urls.get(x.resultKey) ?? null) : null,
      hairTags: x.hairTags,
      completedAt: iso(x.createdAt),
    })),
    nextCursor: paged.nextCursor,
  };
}

// ── GET /designers/:id/reviews ── 손님이 쓴 후기만

export async function listDesignerReviews(d: AppDeps, id: string, page: Page): Promise<Paged<DesignerReview>> {
  const p = await loadDesigner(d, id);
  const rows = await d.repo.listReviewsForTarget(p.userId, 'customer', page);
  const paged = toPaged(rows, page);
  return {
    items: paged.items.map((r) => ({ manner: r.manner, promiseKept: r.promiseKept, satisfaction: r.satisfaction!, text: r.text, createdAt: iso(r.createdAt) })),
    nextCursor: paged.nextCursor,
  };
}

// ── POST /designers/verification ── 202 pending. name·licenseNumber는 형식만 확인하고 버린다

export async function submitVerification(d: AppDeps, userId: string, body: unknown): Promise<{ verifyStatus: 'pending' }> {
  if (!isObj(body)) throw badRequest();
  const e = new FieldErrors();
  const licenseImageKey = await checkUploadKey(d, body.licenseImageKey, 'license', userId, 'licenseImageKey', e);
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (name.length < 2 || name.length > 20) e.add('name', '2~20자');
  if (typeof body.licenseNumber !== 'string' || !LICENSE_NUMBER.test(body.licenseNumber.trim())) e.add('licenseNumber', '숫자·영문·하이픈 4~30자');
  const regions = parseRegions(body.regions, 'regions', e);
  const shopName = text(body.shopName, 'shopName', 50, e);
  const bookingUrl = httpsUrl(body.bookingUrl, 'bookingUrl', e);
  const instagram = parseInstagram(body.instagram, e);
  e.throwIfAny();

  const now = d.now();
  await d.repo.tx(async (repo) => {
    const existing = await repo.getDesignerProfile(userId);
    if (existing && existing.verifyStatus !== 'rejected') throw invalidState('이미 신청했거나 인증된 계정 (반려된 경우에만 다시 제출)');
    await repo.upsertDesignerProfile({
      userId,
      verifyStatus: 'pending',
      rejectReason: null,
      licenseImageKey: licenseImageKey!,
      submittedAt: now,
      verifiedAt: null,
      regions: regions!,
      shopName: shopName!,
      bookingUrl: bookingUrl!,
      instagram: instagram ?? null,
      alertSettings: existing?.alertSettings ?? null,
    });
  });
  // name·licenseNumber는 여기서 끝. DB·로그 어디에도 남기지 않는다
  return { verifyStatus: 'pending' };
}

function parseInstagram(v: unknown, e: FieldErrors): string | null | undefined {
  if (v == null || v === '') return null;
  if (typeof v !== 'string' || !INSTAGRAM.test(v.trim())) {
    e.add('instagram', '인스타그램 아이디 (영문·숫자·._ 30자 이하)');
    return undefined;
  }
  return v.trim().replace(/^@/, '');
}

// ── GET /designers/verification ──

export async function getVerification(d: AppDeps, userId: string): Promise<VerificationStatus> {
  const p = await d.repo.getDesignerProfile(userId);
  if (!p) throw notFound('면허 인증을 신청한 적 없음');
  return {
    verifyStatus: p.verifyStatus,
    rejectReason: p.verifyStatus === 'rejected' ? p.rejectReason : null,
    submittedAt: p.submittedAt ? iso(p.submittedAt) : null,
    decidedAt: p.verifyStatus !== 'pending' && p.verifiedAt ? iso(p.verifiedAt) : null,
  };
}

// ── PATCH /designers/me ──

export async function updateDesigner(d: AppDeps, designer: DesignerProfileRow, body: unknown): Promise<NonNullable<Me['designer']>> {
  if (!isObj(body)) throw badRequest();
  const e = new FieldErrors();
  const patch: Partial<DesignerProfileRow> = {};
  if (body.regions !== undefined) patch.regions = parseRegions(body.regions, 'regions', e);
  if (body.shopName !== undefined) patch.shopName = text(body.shopName, 'shopName', 50, e);
  // 예약 링크는 응답·수락에 필요해서 지울 수 없다 (https만)
  if (body.bookingUrl !== undefined) patch.bookingUrl = httpsUrl(body.bookingUrl, 'bookingUrl', e);
  if (body.instagram !== undefined) patch.instagram = parseInstagram(body.instagram, e);
  if (!Object.keys(patch).length) e.add('body', 'regions·shopName·bookingUrl·instagram 중 하나 이상');
  e.throwIfAny();
  // 활동 지역이 바뀌면 알림 조건의 지역도 활동 지역 안으로 줄인다
  if (patch.regions && designer.alertSettings) {
    const settings = designer.alertSettings ?? DEFAULT_ALERT_SETTINGS;
    patch.alertSettings = { ...settings, regions: settings.regions.filter((r) => patch.regions!.includes(r)) };
  }
  await d.repo.updateDesignerProfile(designer.userId, patch);
  const next = { ...designer, ...patch };
  return { verifyStatus: next.verifyStatus, regions: next.regions, shopName: next.shopName, bookingUrl: next.bookingUrl, instagram: next.instagram };
}

// ── GET /designers/me/responses?tab= ──

export async function listMyResponses(d: AppDeps, designer: DesignerProfileRow, tabRaw: string | undefined, page: Page): Promise<Paged<DesignerResponseItem>> {
  const e = new FieldErrors();
  const tab = optionalOneOf(tabRaw, ['pending', 'in_progress', 'done'] as const, 'tab', e) as DesignerResponseTab | undefined;
  e.throwIfAny();
  const now = d.now();
  let responses = await d.repo.listAllResponsesByDesigner(designer.userId);
  // 만료·자동 완료를 먼저 반영한다
  const requests = new Map((await d.repo.getRequests([...new Set(responses.map((s) => s.requestId))])).map((r) => [r.id, r]));
  let synced = false;
  for (const r of requests.values()) {
    if (r.status === 'open' && r.expiresAt <= now) {
      requests.set(r.id, await syncRequest(d, r));
      synced = true;
    }
  }
  let matches = await d.repo.listMatchesByResponses(responses.map((s) => s.id));
  for (const m of matches) {
    if (m.status === 'complete_requested' && m.confirmDeadline && m.confirmDeadline <= now) {
      await d.repo.tx((repo) => autoCompleteIfOverdue(repo, m.id, now));
      synced = true;
    }
  }
  if (synced) {
    responses = await d.repo.listAllResponsesByDesigner(designer.userId);
    matches = await d.repo.listMatchesByResponses(responses.map((s) => s.id));
    for (const r of await d.repo.getRequests([...requests.keys()])) requests.set(r.id, r);
  }
  const matchByResponse = new Map(matches.map((m) => [m.responseId, m]));
  const reviewed = new Set(
    (await d.repo.listReviewsByMatches(matches.map((m) => m.id))).filter((r) => r.authorRole === 'designer').map((r) => r.matchId),
  );
  const tabOf = (status: string, m?: MatchRow): DesignerResponseTab =>
    status === 'pending' ? 'pending' : m && (m.status === 'accepted' || m.status === 'complete_requested') ? 'in_progress' : 'done';

  const items: DesignerResponseItem[] = [];
  for (const s of responses) {
    const r = requests.get(s.requestId);
    if (!r) continue;
    const m = matchByResponse.get(s.id);
    if (tab && tabOf(s.status, m) !== tab) continue;
    const done = m ? completedAt(m) : null;
    items.push({
      response: myResponse(s, r.version),
      request: { id: r.id, styleTag: r.styleTag, treatmentType: r.treatmentType },
      match: m ? { id: m.id, status: m.status, acceptedAt: iso(m.acceptedAt), confirmDeadline: m.confirmDeadline ? iso(m.confirmDeadline) : null } : null,
      canRequestComplete: m?.status === 'accepted',
      canReview: Boolean(m && m.status === 'completed' && done && now.getTime() <= done.getTime() + REVIEW_TTL_MS && !reviewed.has(m.id)),
    });
  }
  return toPaged(items.slice(page.offset, page.offset + page.limit), page);
}

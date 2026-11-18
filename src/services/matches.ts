// 매칭: 상세 · 완료 요청(디자이너) · 완료 확인/이의(손님) · 자동 완료 · 후기와 온도
// 상태 전이 (docs/db-v2.md): accepted → complete_requested → completed | disputed, complete_requested → completed(자동)
import { randomUUID } from 'node:crypto';
import type {
  CompleteMatchResponse,
  ConfirmMatchResponse,
  CreateReviewResponse,
  MatchDetail,
  PromiseKept,
  Satisfaction,
} from '../shared';
import type { AppDeps } from '../deps';
import { alreadyResponded, badRequest, forbidden, invalidState, notFound } from '../http/errors';
import { FieldErrors, isObj, oneOf, text } from '../http/validate';
import { UniqueViolation, type MatchRow, type Repo, type RequestRow } from '../repo/types';
import { CONFIRM_TTL_MS, REVIEW_TTL_MS, SIGNED_URL_TTL_SEC, assertUuid, iso, myResponse, notify } from './common';
import { applyTreatment, profileBefore, profileToRow } from './hairProfile';
import { checkUploadKey } from './uploads';

/** 온도 변화 (팀 결정 3): 디자이너 = 손님의 결과 만족도, 손님 = 디자이너가 남긴 약속 이행('no' = 노쇼) */
export const TEMPERATURE_DELTA = {
  satisfaction: { good: 0.5, ok: 0, bad: -1.0 } as Record<Satisfaction, number>,
  promiseKept: { yes: 0.2, partly: 0, no: -1.0 } as Record<PromiseKept, number>,
  min: 0,
  max: 99.9,
};
const RESULT_IMAGES_MAX = 2;

/** 완료 시각: 손님 확인 시각, 자동 완료면 확인 기한 */
export const completedAt = (m: MatchRow) => m.confirmedAt ?? (m.autoCompleted ? m.confirmDeadline : null);

/** 확인 기한이 지난 complete_requested 매칭을 자동 완료 (트랜잭션 안). 모발 프로필 갱신·포트폴리오 공개 없음 */
export async function autoCompleteIfOverdue(repo: Repo, id: string, now: Date): Promise<MatchRow | null> {
  const m = await repo.getMatch(id, { lock: true });
  if (!m || m.status !== 'complete_requested' || !m.confirmDeadline || m.confirmDeadline > now) return m;
  await repo.updateMatch(m.id, { status: 'completed', autoCompleted: true });
  await repo.updateRequest(m.requestId, { status: 'completed', designHiddenAt: now, updatedAt: now });
  return { ...m, status: 'completed', autoCompleted: true };
}

async function syncMatch(d: AppDeps, m: MatchRow): Promise<MatchRow> {
  const now = d.now();
  if (m.status !== 'complete_requested' || !m.confirmDeadline || m.confirmDeadline > now) return m;
  return (await d.repo.tx((repo) => autoCompleteIfOverdue(repo, m.id, now))) ?? m;
}

/** 당사자(손님·디자이너)만. 남은 403, 없으면 404 */
async function loadMatch(d: AppDeps, userId: string, id: string): Promise<{ m: MatchRow; role: 'customer' | 'designer' }> {
  const m = await d.repo.getMatch(assertUuid(id, '매칭을 찾을 수 없음'));
  if (!m) throw notFound('매칭을 찾을 수 없음');
  const role = m.customerId === userId ? 'customer' : m.designerId === userId ? 'designer' : null;
  if (!role) throw forbidden('매칭 당사자가 아님');
  return { m: await syncMatch(d, m), role };
}

/** resultImageKeys: 최대 2장, 본인이 'result'로 올린 key */
async function parseResultKeys(d: AppDeps, v: unknown, userId: string, e: FieldErrors): Promise<string[]> {
  if (v == null) return [];
  if (!Array.isArray(v) || v.length > RESULT_IMAGES_MAX || new Set(v).size !== v.length) {
    e.add('resultImageKeys', `최대 ${RESULT_IMAGES_MAX}장, 중복 없이`);
    return [];
  }
  const out: string[] = [];
  for (const [i, k] of v.entries()) {
    const key = await checkUploadKey(d, k, 'result', userId, `resultImageKeys.${i}`, e);
    if (key) out.push(key);
  }
  return out;
}

// ── GET /matches/:id ──

export async function getMatchDetail(d: AppDeps, userId: string, id: string): Promise<MatchDetail> {
  const { m, role } = await loadMatch(d, userId, id);
  const [r, s, users, profile, reviews] = await Promise.all([
    d.repo.getRequest(m.requestId),
    d.repo.getResponse(m.responseId),
    d.repo.getUsers([m.customerId, m.designerId]),
    d.repo.getDesignerProfile(m.designerId),
    d.repo.listReviewsByMatches([m.id]),
  ]);
  if (!r || !s) throw notFound('매칭을 찾을 수 없음');
  const user = new Map(users.map((u) => [u.id, u]));
  const canSeeDesign = role === 'customer' || r.designHiddenAt === null;
  const keys = [...(canSeeDesign ? [r.designImageKey] : []), ...m.designerResultKeys, ...m.customerResultKeys];
  const urls = await d.storage.signedUrls(keys, SIGNED_URL_TTL_SEC);
  const urlList = (ks: string[]) => ks.flatMap((k) => (urls.has(k) ? [urls.get(k)!] : []));

  let profilePreview: MatchDetail['profilePreview'] = null;
  if (role === 'customer') {
    const stored = m.profileUpdate as { before: MatchDetail['request']['card']['profile']; after: MatchDetail['request']['card']['profile']; changes: string[] } | null;
    if (stored) profilePreview = stored;
    else {
      const before = await profileBefore(d, m.customerId, r);
      profilePreview = { before, ...applyTreatment(before, r.treatmentType, d.now()) };
    }
  }
  const done = completedAt(m);
  return {
    id: m.id,
    status: m.status,
    myRole: role,
    request: {
      id: r.id,
      styleTag: r.styleTag,
      treatmentType: r.treatmentType,
      difficulty: r.difficulty,
      card: r.cardSnapshot,
      designImageUrl: canSeeDesign ? (urls.get(r.designImageKey) ?? null) : null,
    },
    response: myResponse(s, r.version),
    designer: {
      id: m.designerId,
      nickname: user.get(m.designerId)?.nickname ?? '',
      shopName: profile?.shopName ?? null,
      area: (profile?.regions ?? []).join(' · '),
      temperature: user.get(m.designerId)?.temperature ?? 36.5,
    },
    customer: { id: m.customerId, nickname: user.get(m.customerId)?.nickname ?? '', temperature: user.get(m.customerId)?.temperature ?? 36.5 },
    acceptedAt: iso(m.acceptedAt),
    completeRequestedAt: m.completeRequestedAt ? iso(m.completeRequestedAt) : null,
    confirmDeadline: m.confirmDeadline ? iso(m.confirmDeadline) : null,
    autoCompleted: m.autoCompleted,
    designerResultImageUrls: urlList(m.designerResultKeys),
    customerResultImageUrls: urlList(m.customerResultKeys),
    profilePreview,
    myReviewWritten: reviews.some((x) => x.authorRole === role),
    reviewDeadline: m.status === 'completed' && done ? iso(new Date(done.getTime() + REVIEW_TTL_MS)) : null,
  };
}

// ── POST /matches/:id/complete ── 디자이너, accepted → complete_requested

export async function requestComplete(d: AppDeps, userId: string, id: string, body: unknown): Promise<CompleteMatchResponse> {
  const { m, role } = await loadMatch(d, userId, id);
  if (role !== 'designer') throw forbidden('담당 디자이너만 완료를 요청할 수 있음');
  const e = new FieldErrors();
  const keys = await parseResultKeys(d, isObj(body) ? body.resultImageKeys : undefined, userId, e);
  e.throwIfAny();
  const now = d.now();
  const confirmDeadline = new Date(now.getTime() + CONFIRM_TTL_MS);
  await d.repo.tx(async (repo) => {
    const cur = await repo.getMatch(m.id, { lock: true });
    if (!cur || cur.status !== 'accepted') throw invalidState('수락된(accepted) 매칭만 완료를 요청할 수 있음');
    await repo.updateMatch(m.id, { status: 'complete_requested', completeRequestedAt: now, confirmDeadline, designerResultKeys: keys });
    const r = await repo.getRequest(m.requestId);
    await notify(repo, now, [
      { userId: m.customerId, type: 'complete_requested', payload: { matchId: m.id, requestId: m.requestId, styleTag: r?.styleTag ?? '', confirmDeadline: iso(confirmDeadline) } },
    ]);
  });
  return { status: 'complete_requested', confirmDeadline: iso(confirmDeadline) };
}

// ── POST /matches/:id/confirm ── 손님, complete_requested → completed

export async function confirmComplete(d: AppDeps, userId: string, id: string, body: unknown): Promise<ConfirmMatchResponse> {
  const { m, role } = await loadMatch(d, userId, id);
  if (role !== 'customer') throw forbidden('손님만 완료를 확인할 수 있음');
  if (!isObj(body)) throw badRequest();
  const e = new FieldErrors();
  if (typeof body.portfolioConsent !== 'boolean') e.add('portfolioConsent', 'true | false');
  const keys = await parseResultKeys(d, body.resultImageKeys, userId, e);
  e.throwIfAny();
  const consent = body.portfolioConsent as boolean;
  const now = d.now();
  return d.repo.tx(async (repo) => {
    const cur = await repo.getMatch(m.id, { lock: true });
    if (!cur || cur.status !== 'complete_requested') throw invalidState('완료 요청(complete_requested)된 매칭만 확인할 수 있음');
    const r = (await repo.getRequest(cur.requestId)) as RequestRow;
    const before = await profileBefore({ repo }, cur.customerId, r);
    const { after, changes } = applyTreatment(before, r.treatmentType, now);
    const existing = await repo.getHairProfile(cur.customerId);
    await repo.upsertHairProfile(profileToRow(cur.customerId, after, existing?.source ?? null, 'match', now));
    await repo.updateMatch(cur.id, { status: 'completed', confirmedAt: now, customerResultKeys: keys, portfolioConsent: consent, profileUpdate: { before, after, changes } });
    await repo.updateRequest(r.id, { status: 'completed', designHiddenAt: now, updatedAt: now });
    // 동의하면 인증 작업물 생성. 사진: 손님 정면, 없으면 디자이너 첨부 첫 장. 둘 다 없으면 만들지 않음 (작업물 수에는 셈)
    const resultKey = keys[0] ?? cur.designerResultKeys[0] ?? null;
    if (consent && resultKey) {
      await repo.insertPortfolioItem({
        id: randomUUID(),
        designerId: cur.designerId,
        matchId: cur.id,
        source: 'verified',
        styleTag: r.styleTag,
        treatmentType: r.treatmentType,
        beforeCard: r.cardSnapshot.profile,
        designKey: r.designImageKey,
        resultKey,
        hairTags: r.hairTags,
        createdAt: now,
      });
    }
    return { status: 'completed' as const, hairProfile: after };
  });
}

// ── POST /matches/:id/dispute ── 손님 [아니에요], complete_requested → disputed + 요청 cancelled

export async function disputeMatch(d: AppDeps, userId: string, id: string, body: unknown): Promise<{ status: 'disputed' }> {
  const { m, role } = await loadMatch(d, userId, id);
  if (role !== 'customer') throw forbidden('손님만 이의를 제기할 수 있음');
  if (!isObj(body)) throw badRequest();
  const e = new FieldErrors();
  const reason = oneOf(body.reason, ['not_done', 'different'] as const, 'reason', e);
  const note = body.note == null || body.note === '' ? null : text(body.note, 'note', 200, e);
  e.throwIfAny();
  const now = d.now();
  await d.repo.tx(async (repo) => {
    const cur = await repo.getMatch(m.id, { lock: true });
    if (!cur || cur.status !== 'complete_requested') throw invalidState('완료 요청(complete_requested)된 매칭만 이의를 제기할 수 있음');
    await repo.updateMatch(cur.id, { status: 'disputed', disputeReason: note ? `${reason}: ${note}` : reason! });
    await repo.updateRequest(cur.requestId, { status: 'cancelled', designHiddenAt: now, updatedAt: now });
  });
  return { status: 'disputed' };
}

// ── POST /matches/:id/reviews ── 완료(자동 포함) 후 7일 안, 역할당 1회

export async function createReview(d: AppDeps, userId: string, id: string, body: unknown): Promise<CreateReviewResponse> {
  const { m, role } = await loadMatch(d, userId, id);
  if (!isObj(body)) throw badRequest();
  const now = d.now();
  const done = completedAt(m);
  if (m.status !== 'completed' || !done) throw invalidState('완료된 매칭에만 후기를 쓸 수 있음');
  if (now.getTime() > done.getTime() + REVIEW_TTL_MS) throw invalidState('후기 기한(완료 후 7일)이 지남');

  const e = new FieldErrors();
  let fields: { satisfaction: Satisfaction | null; manner: 'bad' | 'ok' | 'good' | null; promiseKept: PromiseKept | null; text: string | null };
  let delta: number;
  if (role === 'customer') {
    const satisfaction = oneOf(body.satisfaction, ['good', 'ok', 'bad'] as const, 'satisfaction', e);
    const manner = body.manner == null ? null : (oneOf(body.manner, ['bad', 'ok', 'good'] as const, 'manner', e) ?? null);
    const promiseKept = body.promiseKept == null ? null : (oneOf(body.promiseKept, ['yes', 'partly', 'no'] as const, 'promiseKept', e) ?? null);
    const t = body.text == null || body.text === '' ? null : (text(body.text, 'text', 100, e) ?? null);
    e.throwIfAny();
    fields = { satisfaction: satisfaction!, manner, promiseKept, text: t };
    delta = TEMPERATURE_DELTA.satisfaction[satisfaction!];
  } else {
    const promiseKept = oneOf(body.promiseKept, ['yes', 'partly', 'no'] as const, 'promiseKept', e);
    e.throwIfAny();
    fields = { satisfaction: null, manner: null, promiseKept: promiseKept!, text: null };
    delta = TEMPERATURE_DELTA.promiseKept[promiseKept!];
  }
  const targetId = role === 'customer' ? m.designerId : m.customerId;
  const reviewId = randomUUID();
  return d.repo.tx(async (repo) => {
    try {
      await repo.insertReview({ id: reviewId, matchId: m.id, authorId: userId, targetId, authorRole: role, ...fields, createdAt: now });
    } catch (err) {
      if (err instanceof UniqueViolation) throw alreadyResponded('이 매칭에 이미 후기를 씀');
      throw err;
    }
    const next = await repo.adjustTemperature(targetId, delta, TEMPERATURE_DELTA.min, TEMPERATURE_DELTA.max);
    return { reviewId, targetTemperature: next };
  });
}

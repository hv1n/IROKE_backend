import { randomUUID } from 'node:crypto';
import { MARKETPLACE_LIMITS, type BoardItem, type MyRequestItem, type MyResponse, type NotificationType, type RequestDetail } from '../shared';
import { notFound } from '../http/errors';
import type { MatchRow, Repo, RequestRow, ResponseRow } from '../repo/types';

export const DAY_MS = 24 * 60 * 60 * 1000;
export const REQUEST_TTL_MS = MARKETPLACE_LIMITS.requestTtlDays * DAY_MS;
/** 완료 요청 후 손님 확인 기한 (지나면 자동 완료) */
export const CONFIRM_TTL_MS = 7 * DAY_MS;
/** 후기 기한 (완료·자동 완료 후) */
export const REVIEW_TTL_MS = 7 * DAY_MS;
/** 어느 테이블에도 연결되지 않은 업로드를 지우는 기준 */
export const ORPHAN_UPLOAD_MS = 24 * 60 * 60 * 1000;
export const SIGNED_URL_TTL_SEC = MARKETPLACE_LIMITS.signedUrlTtlSec;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 경로 id가 uuid가 아니면 404 (DB 형변환 오류를 막는다) */
export function assertUuid(id: string | undefined, what = '찾을 수 없음'): string {
  if (!id || !UUID.test(id)) throw notFound(what);
  return id.toLowerCase();
}

export const iso = (d: Date) => d.toISOString();

export interface NewNotification {
  userId: string;
  type: NotificationType;
  payload: Record<string, unknown>;
}

/** 알림 생성. payload에는 연락처·사진을 넣지 않는다 (id·스타일명 등만) */
export async function notify(repo: Repo, now: Date, items: NewNotification[]) {
  await repo.insertNotifications(items.map((n) => ({ id: randomUUID(), userId: n.userId, type: n.type, payload: n.payload, readAt: null, createdAt: now })));
}

/** 요청이 지금 응답을 받을 수 있는지 (만료 시각까지 확인) */
export const isOpen = (r: RequestRow, now: Date) => r.status === 'open' && r.expiresAt > now;

// ── 응답 변환 ──

export function myRequestItem(r: RequestRow, responseCount: number, designImageUrl: string | null): MyRequestItem {
  return {
    id: r.id,
    styleTag: r.styleTag,
    designImageUrl,
    regions: r.regions,
    timing: r.timing,
    budget: r.budget,
    status: r.status,
    expiresAt: iso(r.expiresAt),
    responseCount,
  };
}

export function requestDetail(r: RequestRow, responseCount: number, designImageUrl: string | null, match: MatchRow | null): RequestDetail {
  return {
    ...myRequestItem(r, responseCount, designImageUrl),
    card: r.cardSnapshot,
    version: r.version,
    matchId: match?.id ?? null,
    treatmentType: r.treatmentType,
    difficulty: r.difficulty,
    difficultyReason: r.difficultyReason,
  };
}

/** 게시판 항목: 공개 필드만. 이미지 URL은 절대 넣지 않는다 */
export function boardItem(r: RequestRow, responseCount: number, myResponded: boolean): BoardItem {
  return {
    id: r.id,
    styleTag: r.styleTag,
    treatmentType: r.treatmentType,
    difficulty: r.difficulty,
    hairTags: r.hairTags,
    budget: r.budget,
    timing: r.timing,
    regions: r.regions,
    expiresAt: iso(r.expiresAt),
    responseCount,
    myResponded,
  };
}

export function myResponse(s: ResponseRow, requestVersion: number): MyResponse {
  return {
    id: s.id,
    availability: s.availability,
    condition: s.condition,
    priceMin: s.priceMin,
    priceMax: s.priceMax,
    comment: s.comment,
    isOutdated: s.requestVersion < requestVersion,
    status: s.status,
    createdAt: iso(s.createdAt),
  };
}

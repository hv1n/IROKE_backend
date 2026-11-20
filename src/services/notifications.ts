// 알림 (X-01): 목록 + 안 읽은 수, 읽음 처리 (본인 것만)
import type { NotificationsResponse } from '../shared/index.js';
import type { AppDeps } from '../deps.js';
import { toPaged } from '../http/page.js';
import { FieldErrors, isObj, optionalOneOf } from '../http/validate.js';
import type { Page } from '../repo/types.js';
import { iso } from './common.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function listNotifications(d: AppDeps, userId: string, unreadOnlyRaw: string | undefined, page: Page): Promise<NotificationsResponse> {
  const e = new FieldErrors();
  const unreadOnly = optionalOneOf(unreadOnlyRaw, ['true', 'false'] as const, 'unreadOnly', e) === 'true';
  e.throwIfAny();
  const [rows, unreadCount] = await Promise.all([d.repo.listNotifications(userId, unreadOnly, page), d.repo.countUnread(userId)]);
  const paged = toPaged(rows, page);
  return {
    items: paged.items.map((n) => ({ id: n.id, type: n.type, payload: n.payload, readAt: n.readAt ? iso(n.readAt) : null, createdAt: iso(n.createdAt) })),
    nextCursor: paged.nextCursor,
    unreadCount,
  };
}

/** { ids? } — 비우면 전체 읽음. 남의 알림 id는 무시된다 */
export async function readNotifications(d: AppDeps, userId: string, body: unknown): Promise<void> {
  const e = new FieldErrors();
  const ids = isObj(body) ? body.ids : undefined;
  if (ids !== undefined && (!Array.isArray(ids) || ids.length > 100 || !ids.every((x) => typeof x === 'string' && UUID.test(x)))) {
    e.add('ids', '알림 id 배열 (최대 100개)');
  }
  e.throwIfAny();
  await d.repo.markNotificationsRead(userId, Array.isArray(ids) && ids.length ? (ids as string[]) : null, d.now());
}

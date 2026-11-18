// 목록: ?cursor=&limit= (기본 20, 최대 50) → { items, nextCursor }
// 커서는 불투명 문자열이다 (지금은 offset을 감싼 값).
import type { Context } from 'hono';
import { MARKETPLACE_LIMITS, type Paged } from '../shared';
import type { Page } from '../repo/types';
import { FieldErrors } from './validate';

export function readPage(c: Context, e: FieldErrors): Page {
  const limitRaw = c.req.query('limit');
  let limit: number = MARKETPLACE_LIMITS.pageDefault;
  if (limitRaw) {
    const n = Number(limitRaw);
    if (!Number.isInteger(n) || n < 1 || n > MARKETPLACE_LIMITS.pageMax) e.add('limit', `1~${MARKETPLACE_LIMITS.pageMax}`);
    else limit = n;
  }
  const cursor = c.req.query('cursor');
  let offset = 0;
  if (cursor) {
    const m = /^o(\d{1,7})$/.exec(Buffer.from(cursor, 'base64url').toString());
    if (!m) e.add('cursor', '올바르지 않은 커서');
    else offset = Number(m[1]);
  }
  // 다음 페이지가 있는지 알기 위해 하나 더 읽는다
  return { offset, limit: limit + 1 };
}

export function toPaged<T>(rows: T[], page: Page): Paged<T> {
  const limit = page.limit - 1;
  const hasMore = rows.length > limit;
  return {
    items: rows.slice(0, limit),
    nextCursor: hasMore ? Buffer.from(`o${page.offset + limit}`).toString('base64url') : null,
  };
}

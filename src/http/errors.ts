import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { ApiError, ApiErrorCode } from '../shared';

/** 에러 응답 { error, code, fields? } */
export const fail = (c: Context, status: ContentfulStatusCode, code: ApiErrorCode, error: string, fields?: Record<string, string>) =>
  c.json<ApiError>({ code, error, ...(fields ? { fields } : {}) }, status);

/** 서비스에서 던지면 app.onError가 { error, code }로 바꾼다 */
export class ApiFail extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: ApiErrorCode,
    message: string,
    readonly fields?: Record<string, string>,
  ) {
    super(message);
  }
}

export const unauthorized = (msg = '로그인이 필요함') => new ApiFail(401, 'unauthorized', msg);
export const forbidden = (msg = '권한이 없음') => new ApiFail(403, 'forbidden', msg);
export const notVerified = (msg = '면허 인증을 마친 디자이너만 할 수 있음') => new ApiFail(403, 'not_verified', msg);
export const notFound = (msg = '찾을 수 없음') => new ApiFail(404, 'not_found', msg);
export const invalidState = (msg: string) => new ApiFail(409, 'invalid_state', msg);
export const alreadyResponded = (msg: string) => new ApiFail(409, 'already_responded', msg);
export const requestClosed = (msg = '마감·취소·매칭된 요청') => new ApiFail(410, 'request_closed', msg);
export const badRequest = (msg = '요청 본문이 JSON이 아님') => new ApiFail(400, 'bad_request', msg);

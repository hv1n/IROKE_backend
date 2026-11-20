// POST /uploads: 서명 업로드 URL 발급. 클라이언트는 얼굴을 가린 사본만 PUT하고(MediaPipe, 브라우저에서),
// 돌려받은 key만 다른 API에 넘긴다. 서버는 key가 본인 것인지·실제로 올라가 있는지 확인한다.
import { randomUUID } from 'node:crypto';
import { MARKETPLACE_LIMITS, UPLOAD_CONTENT_TYPES, UPLOAD_PURPOSES, type UploadPurpose, type UploadResponse } from '../shared/index.js';
import type { AppDeps } from '../deps.js';
import { forbidden, notVerified } from '../http/errors.js';
import { FieldErrors, isObj, oneOf } from '../http/validate.js';
import { iso } from './common.js';

const KEY = /^(request_design|result|license|portfolio)\/([0-9a-f-]{36})\/([0-9a-f-]{36})$/;

export async function createUpload(d: AppDeps, userId: string, body: unknown): Promise<UploadResponse> {
  const e = new FieldErrors();
  const b = isObj(body) ? body : {};
  const purpose = oneOf(b.purpose, UPLOAD_PURPOSES, 'purpose', e);
  const contentType = oneOf(b.contentType, UPLOAD_CONTENT_TYPES, 'contentType', e);
  if (!Number.isInteger(b.size) || (b.size as number) < 1 || (b.size as number) > MARKETPLACE_LIMITS.uploadMaxBytes) {
    e.add('size', `1 ~ ${MARKETPLACE_LIMITS.uploadMaxBytes} 바이트 (5MB)`);
  }
  e.throwIfAny();

  // 용도별 권한: license·request_design = 로그인, result = 진행 중 매칭 당사자, portfolio = 인증 디자이너
  if (purpose === 'result' && !(await d.repo.hasActiveMatch(userId))) throw forbidden('진행 중인 매칭의 당사자만 결과 사진을 올릴 수 있음');
  if (purpose === 'portfolio') {
    const p = await d.repo.getDesignerProfile(userId);
    if (!p) throw forbidden('디자이너만 포트폴리오를 올릴 수 있음');
    if (p.verifyStatus !== 'verified') throw notVerified();
  }

  const key = `${purpose}/${userId}/${randomUUID()}`;
  const { uploadUrl, expiresAt } = await d.storage.createUploadUrl(key, contentType!, MARKETPLACE_LIMITS.uploadMaxBytes);
  return { key, uploadUrl, expiresAt: iso(expiresAt) };
}

/** API에 넘어온 key가 이 용도·본인 업로드이고 실제로 올라가 있는지. 아니면 field 오류 */
export async function checkUploadKey(
  d: AppDeps,
  value: unknown,
  purpose: UploadPurpose,
  userId: string,
  field: string,
  e: FieldErrors,
): Promise<string | undefined> {
  const m = typeof value === 'string' ? KEY.exec(value) : null;
  if (!m || m[1] !== purpose || m[2] !== userId) {
    e.add(field, `POST /uploads(purpose: '${purpose}')로 받은 본인 key`);
    return undefined;
  }
  if (!(await d.storage.exists(value as string))) {
    e.add(field, '업로드가 끝나지 않은 key');
    return undefined;
  }
  return value as string;
}

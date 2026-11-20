// 서버 모발 프로필 (GET·PUT /me/hair-profile)과 시술 완료 확인 때의 자동 갱신.
// 실제 결과(기장·밝기)는 서버가 알 수 없으므로, 완료 확인 때는 시술 이력에 {시술 종류, 확인 날짜}만 더한다.
import { TREATMENT_LABELS, type HairProfile, type HairProfileResponse, type TreatmentType } from '../shared/index.js';
import type { AppDeps } from '../deps.js';
import { badRequest, notFound } from '../http/errors.js';
import { FieldErrors, isObj } from '../http/validate.js';
import { parseProfile, parseProfileSource } from '../lib/validate.js';
import type { HairProfileRow, RequestRow } from '../repo/types.js';
import { iso } from './common.js';

const MAX_HISTORY = 20;
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

export function rowToProfile(r: HairProfileRow): HairProfile {
  return {
    length: r.length,
    texture: r.texture,
    density: r.density,
    damage: r.damage as HairProfile['damage'],
    history: r.history,
    ...(r.level != null ? { currentLevel: r.level } : {}),
  };
}

export function profileToRow(
  userId: string,
  p: HairProfile,
  source: HairProfileRow['source'],
  updatedBy: HairProfileRow['updatedBy'],
  now: Date,
): HairProfileRow {
  return {
    userId,
    length: p.length,
    texture: p.texture,
    density: p.density,
    damage: p.damage,
    level: p.currentLevel ?? null,
    history: p.history,
    source,
    updatedBy,
    updatedAt: now,
  };
}

const toResponse = (r: HairProfileRow): HairProfileResponse => ({
  profile: rowToProfile(r),
  confirmedAt: r.source?.confirmedAt ?? null,
  updatedAt: iso(r.updatedAt),
  updatedBy: r.updatedBy,
});

export async function getHairProfile(d: AppDeps, userId: string): Promise<HairProfileResponse> {
  const r = await d.repo.getHairProfile(userId);
  if (!r) throw notFound('서버에 저장된 모발 프로필이 없음');
  return toResponse(r);
}

/** 로그인 직후 localStorage의 확정 프로필을 옮기거나, 로그인 상태에서 S-02를 다시 확정할 때 */
export async function putHairProfile(d: AppDeps, userId: string, body: unknown): Promise<HairProfileResponse> {
  if (!isObj(body)) throw badRequest();
  const e = new FieldErrors();
  const profile = parseProfile(body.profile);
  if (!profile) e.add('profile', '모발 프로필 형식이 올바르지 않음');
  const source = parseProfileSource(body.profileSource);
  if (!source) e.add('profileSource', 'editedFields·confirmedAt이 필요함');
  e.throwIfAny();
  const row = profileToRow(userId, profile!, { editedFields: source!.editedFields, confirmedAt: source!.confirmedAt }, 'user', d.now());
  await d.repo.upsertHairProfile(row);
  return toResponse(row);
}

/** KST 날짜 (YYYY-MM-DD) */
export const kstDate = (now: Date) => new Date(now.getTime() + KST_OFFSET_MS).toISOString().slice(0, 10);

/** 완료 확인 때 갱신할 프로필: 시술 이력에 {시술 종류, 확인 날짜} 추가 (최대 20개, 오래된 것부터 버림) */
export function applyTreatment(before: HairProfile, type: TreatmentType, now: Date): { after: HairProfile; changes: string[] } {
  const date = kstDate(now);
  const history = [...before.history, { type, date }].slice(-MAX_HISTORY);
  return { after: { ...before, history }, changes: [`시술 이력에 ${TREATMENT_LABELS[type]}(${date}) 추가`] };
}

/** 갱신 전 프로필: 손님의 서버 프로필, 없으면 요청 카드의 프로필 */
export async function profileBefore(d: Pick<AppDeps, 'repo'>, customerId: string, r: RequestRow): Promise<HairProfile> {
  const row = await d.repo.getHairProfile(customerId);
  return row ? rowToProfile(row) : r.cardSnapshot.profile;
}

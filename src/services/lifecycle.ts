// 요청 상태 전이 중 여러 곳에서 쓰는 것: 만료, 알림 대상 디자이너 찾기.
// 만료는 배치에만 기대지 않고 조회·쓰기 때마다 expires_at을 다시 확인한다 (syncRequest).
import type { AlertSettings } from '../shared';
import type { AppDeps } from '../deps';
import type { DesignerProfileRow, Repo, RequestRow } from '../repo/types';
import { notify } from './common';

export const DEFAULT_ALERT_SETTINGS: AlertSettings = { enabled: true, regions: [], treatmentTypes: [], difficulties: [], budgets: [] };

/**
 * 마감이 지난 open 요청을 expired로 바꾼다 (트랜잭션 안에서 호출).
 * 시안 비공개, 대기 응답은 not_selected, 응답한 디자이너에게 마감 알림.
 */
export async function expireIfOverdue(repo: Repo, id: string, now: Date): Promise<RequestRow | null> {
  const r = await repo.getRequest(id, { lock: true });
  if (!r || r.status !== 'open' || r.expiresAt > now) return r;
  const patch = { status: 'expired' as const, designHiddenAt: r.designHiddenAt ?? now, updatedAt: now };
  await repo.updateRequest(id, patch);
  const closed = await repo.closePendingResponses(id, 'not_selected');
  await notify(
    repo,
    now,
    closed.map((s) => ({ userId: s.designerId, type: 'request_closed', payload: { requestId: id, styleTag: r.styleTag, reason: 'expired' } })),
  );
  return { ...r, ...patch };
}

/** 읽은 요청이 이미 마감 시각을 넘겼으면 그 자리에서 만료 처리한 값을 돌려준다 */
export async function syncRequest(d: AppDeps, r: RequestRow): Promise<RequestRow> {
  const now = d.now();
  if (r.status !== 'open' || r.expiresAt > now) return r;
  return (await d.repo.tx((repo) => expireIfOverdue(repo, r.id, now))) ?? r;
}

/** 한 손님의 마감 지난 요청을 모두 만료 처리 (내 요청 목록 전에) */
export async function syncCustomerRequests(d: AppDeps, customerId: string) {
  const now = d.now();
  const overdue = await d.repo.listOverdueOpenRequests(now, { customerId });
  for (const r of overdue) await d.repo.tx((repo) => expireIfOverdue(repo, r.id, now));
}

/** 이 디자이너의 알림 조건에 요청이 맞는지. 빈 배열 = 전부, regions는 활동 지역 안에서만 */
export function matchesAlert(p: DesignerProfileRow, r: RequestRow): boolean {
  if (p.verifyStatus === 'rejected') return false;
  const s = p.alertSettings ?? DEFAULT_ALERT_SETTINGS;
  if (!s.enabled) return false;
  const regions = s.regions.length ? s.regions.filter((x) => p.regions.includes(x)) : p.regions;
  if (!regions.some((x) => r.regions.includes(x))) return false;
  if (s.treatmentTypes.length && !s.treatmentTypes.includes(r.treatmentType)) return false;
  if (s.difficulties.length && !s.difficulties.includes(r.difficulty)) return false;
  // 예산 없는 요청(디자이너 제안)은 어느 예산 조건에도 맞는 것으로 본다
  if (s.budgets.length && r.budget !== null && !s.budgets.includes(r.budget)) return false;
  return true;
}

/** 알림 조건이 맞는 디자이너에게만 new_matching_request (본인 제외) */
export async function notifyMatchingDesigners(repo: Repo, r: RequestRow, now: Date) {
  const candidates = await repo.listDesignersInRegions(r.regions);
  await notify(
    repo,
    now,
    candidates
      .filter((p) => p.userId !== r.customerId && matchesAlert(p, r))
      .map((p) => ({
        userId: p.userId,
        type: 'new_matching_request',
        payload: { requestId: r.id, styleTag: r.styleTag, regions: r.regions, treatmentType: r.treatmentType, difficulty: r.difficulty },
      })),
  );
}

// 배치 (Vercel Cron → GET /api/internal/jobs/sweep, 수동 실행은 POST).
// API가 호출될 때마다 만료를 다시 확인하므로 배치가 늦어도 오동작은 없다. 여러 번 돌아도 결과가 같다(멱등).
import type { SweepResult } from '../shared';
import type { AppDeps } from '../deps';
import { DAY_MS, ORPHAN_UPLOAD_MS, notify } from './common';
import { expireIfOverdue } from './lifecycle';

const BATCH = 200;

export async function sweep(d: AppDeps): Promise<SweepResult> {
  const now = d.now();
  const result: SweepResult = { expiredRequests: 0, deadlineSoonNotified: 0, autoCompletedMatches: 0, reviewReminders: 0, orphanUploadsDeleted: 0 };

  // 1) 마감 지난 요청 → expired (시안 비공개, 대기 응답 마감 알림)
  for (const r of await d.repo.listOverdueOpenRequests(now, { limit: BATCH })) {
    const after = await d.repo.tx((repo) => expireIfOverdue(repo, r.id, now));
    if (after?.status === 'expired') result.expiredRequests++;
  }

  // 2) 마감 D-1 알림 (요청당 1회)
  for (const r of await d.repo.listOpenRequestsExpiringBetween(now, new Date(now.getTime() + DAY_MS))) {
    if (await d.repo.hasNotification(r.customerId, 'deadline_soon', 'requestId', r.id)) continue;
    await notify(d.repo, now, [
      { userId: r.customerId, type: 'deadline_soon', payload: { requestId: r.id, styleTag: r.styleTag, expiresAt: r.expiresAt.toISOString() } },
    ]);
    result.deadlineSoonNotified++;
  }

  // 3) 24시간 동안 어느 테이블에도 연결되지 않은 업로드 삭제
  const candidates = await d.storage.listUploadedBefore(new Date(now.getTime() - ORPHAN_UPLOAD_MS), BATCH);
  const orphans: string[] = [];
  for (const key of candidates) if (!(await d.repo.isImageKeyReferenced(key))) orphans.push(key);
  await d.storage.remove(orphans);
  result.orphanUploadsDeleted = orphans.length;

  return result;
}

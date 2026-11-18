// 배치 (Vercel Cron → GET /api/internal/jobs/sweep, 수동 실행은 POST).
// API가 호출될 때마다 만료를 다시 확인하므로 배치가 늦어도 오동작은 없다. 여러 번 돌아도 결과가 같다(멱등).
import type { SweepResult } from '../shared';
import type { AppDeps } from '../deps';
import { DAY_MS, ORPHAN_UPLOAD_MS, REVIEW_TTL_MS, notify } from './common';
import { expireIfOverdue } from './lifecycle';
import { autoCompleteIfOverdue } from './matches';

/** 완료 후 이만큼 지나도 후기를 안 쓴 당사자에게 리마인드 1회 (후기 기한 7일 안) */
export const REVIEW_REMINDER_AFTER_MS = 3 * DAY_MS;

const BATCH = 200;

export async function sweep(d: AppDeps): Promise<SweepResult> {
  const now = d.now();
  const result: SweepResult = {
    expiredRequests: 0,
    deadlineSoonNotified: 0,
    autoCompletedMatches: 0,
    reviewReminders: 0,
    verificationResults: 0,
    orphanUploadsDeleted: 0,
  };

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

  // 3) 완료 요청 후 7일 동안 손님이 확인하지 않은 매칭 → 자동 완료 (모발 프로필·포트폴리오는 건드리지 않음)
  for (const m of await d.repo.listOverdueCompleteRequested(now, BATCH)) {
    const after = await d.repo.tx((repo) => autoCompleteIfOverdue(repo, m.id, now));
    if (after?.autoCompleted) result.autoCompletedMatches++;
  }

  // 4) 후기 리마인드: 완료 후 3일이 지나도 후기를 안 쓴 당사자에게 1회 (기한 7일 안)
  const due = await d.repo.listCompletedBetween(new Date(now.getTime() - REVIEW_TTL_MS), new Date(now.getTime() - REVIEW_REMINDER_AFTER_MS));
  const written = await d.repo.listReviewsByMatches(due.map((m) => m.id));
  for (const m of due) {
    for (const [role, userId] of [['customer', m.customerId], ['designer', m.designerId]] as const) {
      if (written.some((r) => r.matchId === m.id && r.authorRole === role)) continue;
      if (await d.repo.hasNotification(userId, 'review_reminder', 'matchId', m.id)) continue;
      await notify(d.repo, now, [{ userId, type: 'review_reminder', payload: { matchId: m.id, requestId: m.requestId, role } }]);
      result.reviewReminders++;
    }
  }

  // 5) 면허 승인·반려 반영: 관리자가 DB에서 verify_status를 바꾸면 면허 사진을 지우고 결과 알림
  for (const p of await d.repo.listDecidedWithLicenseImage(BATCH)) {
    await d.storage.remove([p.licenseImageKey!]);
    await d.repo.tx(async (repo) => {
      await repo.updateDesignerProfile(p.userId, { licenseImageKey: null, verifiedAt: p.verifiedAt ?? now });
      await notify(repo, now, [
        { userId: p.userId, type: 'verification_result', payload: { verifyStatus: p.verifyStatus, rejectReason: p.verifyStatus === 'rejected' ? p.rejectReason : null } },
      ]);
    });
    result.verificationResults++;
  }

  // 6) 24시간 동안 어느 테이블에도 연결되지 않은 업로드 삭제
  const candidates = await d.storage.listUploadedBefore(new Date(now.getTime() - ORPHAN_UPLOAD_MS), BATCH);
  const orphans: string[] = [];
  for (const key of candidates) if (!(await d.repo.isImageKeyReferenced(key))) orphans.push(key);
  await d.storage.remove(orphans);
  result.orphanUploadsDeleted = orphans.length;

  return result;
}

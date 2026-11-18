// 로그인(users upsert + 자체 JWT)과 내 정보. 연락처는 받지도 내보내지도 않는다.
import { randomUUID } from 'node:crypto';
import type { LoginResponse, Me } from '../shared';
import type { AppDeps } from '../deps';
import { issueToken } from '../auth/jwt';
import { unauthorized } from '../http/errors';
import { UniqueViolation, type UserRow } from '../repo/types';

export async function loginWithKakaoUser(d: AppDeps, kakao: { kakaoId: string; nickname: string }): Promise<LoginResponse> {
  const now = d.now();
  let user = await d.repo.getUserByKakaoId(kakao.kakaoId);
  let isNewUser = false;
  if (!user) {
    const row: UserRow = { id: randomUUID(), kakaoId: kakao.kakaoId, nickname: kakao.nickname, temperature: 36.5, createdAt: now };
    try {
      await d.repo.insertUser(row);
      user = row;
      isNewUser = true;
    } catch (err) {
      // 같은 계정으로 동시에 로그인하면 먼저 만든 쪽을 쓴다
      if (!(err instanceof UniqueViolation)) throw err;
      user = await d.repo.getUserByKakaoId(kakao.kakaoId);
      if (!user) throw err;
    }
  }
  const accessToken = await issueToken(user.id, d.config.jwtSecret, d.config.jwtTtlSec, now);
  return { accessToken, expiresIn: d.config.jwtTtlSec, isNewUser, user: await getMe(d, user.id) };
}

export async function getMe(d: AppDeps, userId: string): Promise<Me> {
  const [user, designer, hair] = await Promise.all([d.repo.getUser(userId), d.repo.getDesignerProfile(userId), d.repo.getHairProfile(userId)]);
  if (!user) throw unauthorized();
  return {
    id: user.id,
    nickname: user.nickname,
    temperature: user.temperature,
    hasHairProfile: Boolean(hair),
    designer: designer
      ? {
          verifyStatus: designer.verifyStatus,
          regions: designer.regions,
          shopName: designer.shopName,
          bookingUrl: designer.bookingUrl,
          instagram: designer.instagram,
        }
      : null,
  };
}

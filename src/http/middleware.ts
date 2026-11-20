// 권한 미들웨어: 로그인 / 디자이너(면허 인증 신청자) / 인증 디자이너 / 배치 시크릿
import { timingSafeEqual } from 'node:crypto';
import { createMiddleware } from 'hono/factory';
import type { AppDeps } from '../deps.js';
import { readToken } from '../auth/jwt.js';
import { forbidden, notVerified, unauthorized } from './errors.js';
import type { AppEnv } from './context.js';

const BEARER = /^Bearer\s+(\S+)$/i;

/** Authorization: Bearer <accessToken> (카카오 로그인 후 발급한 JWT) */
export const requireUser = (d: AppDeps) =>
  createMiddleware<AppEnv>(async (c, next) => {
    const token = BEARER.exec(c.req.header('authorization') ?? '')?.[1];
    if (!token) throw unauthorized('로그인이 필요함');
    const userId = await readToken(token, d.config.jwtSecret, d.now());
    if (!userId || !(await d.repo.getUser(userId))) throw unauthorized('토큰이 없거나 만료됨');
    c.set('userId', userId);
    await next();
  });

/** 디자이너 = designer_profiles 행이 있는 사용자 (면허 인증을 신청한 적 있음). requireUser 뒤에 둔다 */
export const requireDesigner = (d: AppDeps) =>
  createMiddleware<AppEnv>(async (c, next) => {
    const profile = await d.repo.getDesignerProfile(c.get('userId'));
    if (!profile) throw forbidden('디자이너만 쓸 수 있음 (면허 인증 신청 필요)');
    c.set('designer', profile);
    await next();
  });

/** 인증 디자이너 (verify_status = verified). requireDesigner 뒤에 둔다 */
export const requireVerified = () =>
  createMiddleware<AppEnv>(async (c, next) => {
    if (c.get('designer').verifyStatus !== 'verified') throw notVerified();
    await next();
  });

/** Vercel Cron이 보내는 Authorization: Bearer <CRON_SECRET>. 시크릿이 비어 있으면 항상 거절 */
export const requireCronSecret = (d: AppDeps) =>
  createMiddleware<AppEnv>(async (c, next) => {
    const token = BEARER.exec(c.req.header('authorization') ?? '')?.[1] ?? '';
    const secret = d.config.cronSecret;
    const ok = secret.length > 0 && token.length === secret.length && timingSafeEqual(Buffer.from(token), Buffer.from(secret));
    if (!ok) throw unauthorized('배치 시크릿이 맞지 않음');
    await next();
  });

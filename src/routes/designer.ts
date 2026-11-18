// 디자이너: 게시판 (D-02) · 요청 상세·응답 (D-03) · 알림 조건 (D-02)
// 미인증 디자이너도 게시판은 볼 수 있다. 응답·시안 열람은 인증(verified)만.
import type { Hono } from 'hono';
import type {
  AlertSettings,
  BoardDetail,
  BoardItem,
  DesignerPublicProfile,
  DesignerResponseItem,
  DesignerReview,
  Me,
  Paged,
  PortfolioItem,
  VerificationStatus,
} from '../shared';
import type { AppDeps } from '../deps';
import { type AppEnv, readJson } from '../http/context';
import { requireDesigner, requireUser, requireVerified } from '../http/middleware';
import { readPage } from '../http/page';
import { FieldErrors } from '../http/validate';
import { createResponse, getAlertSettings, getBoardDetail, listBoard, putAlertSettings } from '../services/board';
import {
  getDesignerProfile,
  getVerification,
  listDesignerReviews,
  listMyResponses,
  listPortfolio,
  submitVerification,
  updateDesigner,
} from '../services/designers';

export function designerRoutes(app: Hono<AppEnv>, d: AppDeps) {
  const user = requireUser(d);
  const designer = requireDesigner(d);
  const verified = requireVerified();
  const page = (c: Parameters<typeof readPage>[0]) => {
    const e = new FieldErrors();
    const p = readPage(c, e);
    e.throwIfAny();
    return p;
  };

  app.get('/board', user, designer, async (c) => {
    const e = new FieldErrors();
    const page = readPage(c, e);
    e.throwIfAny();
    const q = c.req.query();
    return c.json<Paged<BoardItem>>(
      await listBoard(d, c.get('designer'), { region: q.region, treatment: q.treatment, difficulty: q.difficulty, budget: q.budget, sort: q.sort }, page),
    );
  });

  app.get('/board/:requestId', user, designer, async (c) =>
    c.json<BoardDetail>(await getBoardDetail(d, c.get('designer'), c.req.param('requestId'))),
  );

  app.post('/requests/:id/responses', user, designer, verified, async (c) =>
    c.json<{ id: string }>(await createResponse(d, c.get('designer'), c.req.param('id'), await readJson(c)), 201),
  );

  app.get('/designers/me/alert-settings', user, designer, (c) => c.json<AlertSettings>(getAlertSettings(c.get('designer'))));

  app.put('/designers/me/alert-settings', user, designer, async (c) =>
    c.json<AlertSettings>(await putAlertSettings(d, c.get('designer'), await readJson(c))),
  );

  // ── 가입 · 면허 인증 (D-01) ── /designers/:id보다 먼저 등록
  app.post('/designers/verification', user, async (c) =>
    c.json<{ verifyStatus: 'pending' }>(await submitVerification(d, c.get('userId'), await readJson(c)), 202),
  );
  app.get('/designers/verification', user, async (c) => c.json<VerificationStatus>(await getVerification(d, c.get('userId'))));

  app.patch('/designers/me', user, designer, async (c) =>
    c.json<NonNullable<Me['designer']>>(await updateDesigner(d, c.get('designer'), await readJson(c))),
  );

  /** 내 응답 · 진행 관리 (D-04) */
  app.get('/designers/me/responses', user, designer, async (c) =>
    c.json<Paged<DesignerResponseItem>>(await listMyResponses(d, c.get('designer'), c.req.query('tab'), page(c))),
  );

  // ── 디자이너 프로필 (C-04) ──
  app.get('/designers/:id', user, async (c) => c.json<DesignerPublicProfile>(await getDesignerProfile(d, c.req.param('id'))));
  app.get('/designers/:id/portfolio', user, async (c) =>
    c.json<Paged<PortfolioItem>>(
      await listPortfolio(d, c.get('userId'), c.req.param('id'), { source: c.req.query('source'), similarToMe: c.req.query('similarToMe') }, page(c)),
    ),
  );
  app.get('/designers/:id/reviews', user, async (c) =>
    c.json<Paged<DesignerReview>>(await listDesignerReviews(d, c.req.param('id'), page(c))),
  );
}

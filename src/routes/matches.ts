// 매칭 (C-06·C-07·D-04): 상세 · 완료 요청 · 완료 확인 · 이의 · 후기 (당사자만)
import type { Hono } from 'hono';
import type { CompleteMatchResponse, ConfirmMatchResponse, CreateReviewResponse, MatchDetail } from '../shared';
import type { AppDeps } from '../deps';
import { type AppEnv, readJson } from '../http/context';
import { requireUser } from '../http/middleware';
import { confirmComplete, createReview, disputeMatch, getMatchDetail, requestComplete } from '../services/matches';

export function matchRoutes(app: Hono<AppEnv>, d: AppDeps) {
  const user = requireUser(d);

  app.get('/matches/:id', user, async (c) => c.json<MatchDetail>(await getMatchDetail(d, c.get('userId'), c.req.param('id'))));

  /** 본문 선택: { resultImageKeys? } */
  app.post('/matches/:id/complete', user, async (c) =>
    c.json<CompleteMatchResponse>(await requestComplete(d, c.get('userId'), c.req.param('id'), (await readJson(c)) ?? {})),
  );

  app.post('/matches/:id/confirm', user, async (c) =>
    c.json<ConfirmMatchResponse>(await confirmComplete(d, c.get('userId'), c.req.param('id'), await readJson(c))),
  );

  app.post('/matches/:id/dispute', user, async (c) =>
    c.json<{ status: 'disputed' }>(await disputeMatch(d, c.get('userId'), c.req.param('id'), await readJson(c))),
  );

  /** 작성자 역할은 토큰으로 판단 (손님 → 디자이너 / 디자이너 → 손님) */
  app.post('/matches/:id/reviews', user, async (c) =>
    c.json<CreateReviewResponse>(await createReview(d, c.get('userId'), c.req.param('id'), await readJson(c)), 201),
  );
}

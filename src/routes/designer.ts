// 디자이너: 게시판 (D-02) · 요청 상세·응답 (D-03) · 알림 조건 (D-02)
// 미인증 디자이너도 게시판은 볼 수 있다. 응답·시안 열람은 인증(verified)만.
import type { Hono } from 'hono';
import type { AlertSettings, BoardDetail, BoardItem, Paged } from '../shared';
import type { AppDeps } from '../deps';
import { type AppEnv, readJson } from '../http/context';
import { requireDesigner, requireUser, requireVerified } from '../http/middleware';
import { readPage } from '../http/page';
import { FieldErrors } from '../http/validate';
import { createResponse, getAlertSettings, getBoardDetail, listBoard, putAlertSettings } from '../services/board';

export function designerRoutes(app: Hono<AppEnv>, d: AppDeps) {
  const user = requireUser(d);
  const designer = requireDesigner(d);
  const verified = requireVerified();

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
}

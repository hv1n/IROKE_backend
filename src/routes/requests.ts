// 손님: 요청 (C-01·C-02) · 응답 비교 (C-03) · 수락 (C-05)
import type { Hono } from 'hono';
import type {
  AcceptResponseResult,
  CloseRequestResponse,
  CreateRequestResponse,
  MyRequestItem,
  Paged,
  ReopenRequestResponse,
  RequestDetail,
  ResponseCard,
} from '../shared/index.js';
import type { AppDeps } from '../deps.js';
import { type AppEnv, readJson } from '../http/context.js';
import { badRequest } from '../http/errors.js';
import { requireUser } from '../http/middleware.js';
import { readPage } from '../http/page.js';
import { FieldErrors } from '../http/validate.js';
import {
  acceptResponse,
  closeRequest,
  createRequest,
  getMyRequest,
  listMyRequests,
  listResponsesForCustomer,
  reopenRequest,
  updateRequest,
} from '../services/requests.js';

export function requestRoutes(app: Hono<AppEnv>, d: AppDeps) {
  const user = requireUser(d);
  const page = (c: Parameters<typeof readPage>[0]) => {
    const e = new FieldErrors();
    const p = readPage(c, e);
    e.throwIfAny();
    return p;
  };

  app.post('/requests', user, async (c) =>
    c.json<CreateRequestResponse>(await createRequest(d, c.get('userId'), await readJson(c)), 201),
  );

  // /requests/mine은 /requests/:id보다 먼저
  app.get('/requests/mine', user, async (c) =>
    c.json<Paged<MyRequestItem>>(await listMyRequests(d, c.get('userId'), c.req.query('status'), page(c))),
  );

  app.get('/requests/:id', user, async (c) => c.json<RequestDetail>(await getMyRequest(d, c.get('userId'), c.req.param('id'))));

  app.patch('/requests/:id', user, async (c) => {
    const body = await readJson(c);
    if (!body) throw badRequest();
    return c.json<RequestDetail>(await updateRequest(d, c.get('userId'), c.req.param('id'), body));
  });

  app.post('/requests/:id/close', user, async (c) =>
    c.json<CloseRequestResponse>(await closeRequest(d, c.get('userId'), c.req.param('id'))),
  );

  /** 본문은 선택 ({ regions?, timing?, budget? }) */
  app.post('/requests/:id/reopen', user, async (c) =>
    c.json<ReopenRequestResponse>(await reopenRequest(d, c.get('userId'), c.req.param('id'), (await readJson(c)) ?? {})),
  );

  app.get('/requests/:id/responses', user, async (c) =>
    c.json<Paged<ResponseCard>>(await listResponsesForCustomer(d, c.get('userId'), c.req.param('id'), c.req.query('sort'), page(c))),
  );

  app.post('/responses/:id/accept', user, async (c) =>
    c.json<AcceptResponseResult>(await acceptResponse(d, c.get('userId'), c.req.param('id')), 201),
  );
}

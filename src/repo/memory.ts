// 메모리 구현체 (DATA_MODE=memory, 테스트). 서버를 다시 띄우면 초기화된다.
// 트랜잭션은 한 번에 하나만 실행하고(직렬화), 실패하면 시작 시점 상태로 되돌린다.
import type {
  BoardQuery,
  BoardRow,
  DesignerProfileRow,
  HairProfileRow,
  MatchRow,
  NotificationRow,
  Page,
  Repo,
  RequestRow,
  ResponseRow,
  UserRow,
} from './types';
import { UniqueViolation } from './types';

export interface MemoryState {
  users: Map<string, UserRow>;
  designerProfiles: Map<string, DesignerProfileRow>;
  hairProfiles: Map<string, HairProfileRow>;
  requests: Map<string, RequestRow>;
  responses: Map<string, ResponseRow>;
  matches: Map<string, MatchRow>;
  notifications: Map<string, NotificationRow>;
}

export interface MemorySeed {
  users?: UserRow[];
  designerProfiles?: DesignerProfileRow[];
  hairProfiles?: HairProfileRow[];
}

const emptyState = (): MemoryState => ({
  users: new Map(),
  designerProfiles: new Map(),
  hairProfiles: new Map(),
  requests: new Map(),
  responses: new Map(),
  matches: new Map(),
  notifications: new Map(),
});

const clone = <T>(v: T): T => structuredClone(v);
const overlaps = (a: string[], b: string[]) => a.some((x) => b.includes(x));
const byCreatedDesc = (a: { createdAt: Date; id: string }, b: { createdAt: Date; id: string }) =>
  b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : -1);
const paginate = <T>(rows: T[], page: Page) => rows.slice(page.offset, page.offset + page.limit);

export function createMemoryRepo(seed: MemorySeed = {}): Repo & { state: () => MemoryState } {
  let state = emptyState();
  for (const u of seed.users ?? []) state.users.set(u.id, clone(u));
  for (const p of seed.designerProfiles ?? []) state.designerProfiles.set(p.userId, clone(p));
  for (const h of seed.hairProfiles ?? []) state.hairProfiles.set(h.userId, clone(h));

  // 트랜잭션 직렬화
  let queue: Promise<unknown> = Promise.resolve();

  const ops = (inTx: boolean): Repo => {
    const repo: Repo = {
      async tx(fn) {
        if (inTx) return fn(repo);
        const run = queue.then(async () => {
          const snapshot = clone(state);
          try {
            return await fn(ops(true));
          } catch (err) {
            state = snapshot;
            throw err;
          }
        });
        queue = run.catch(() => undefined);
        return run;
      },

      // users
      async getUser(id) {
        return clone(state.users.get(id) ?? null);
      },
      async getUsers(ids) {
        return ids.flatMap((id) => (state.users.has(id) ? [clone(state.users.get(id)!)] : []));
      },
      async getUserByKakaoId(kakaoId) {
        for (const u of state.users.values()) if (u.kakaoId === kakaoId) return clone(u);
        return null;
      },
      async insertUser(user) {
        for (const u of state.users.values()) if (u.kakaoId === user.kakaoId) throw new UniqueViolation('users_kakao_id_key');
        state.users.set(user.id, clone(user));
      },
      async updateUser(id, patch) {
        const u = state.users.get(id);
        if (u) state.users.set(id, { ...u, ...clone(patch) });
      },

      // designer_profiles
      async getDesignerProfile(userId) {
        return clone(state.designerProfiles.get(userId) ?? null);
      },
      async getDesignerProfiles(userIds) {
        return userIds.flatMap((id) => (state.designerProfiles.has(id) ? [clone(state.designerProfiles.get(id)!)] : []));
      },
      async upsertDesignerProfile(profile) {
        state.designerProfiles.set(profile.userId, clone(profile));
      },
      async updateDesignerProfile(userId, patch) {
        const p = state.designerProfiles.get(userId);
        if (p) state.designerProfiles.set(userId, { ...p, ...clone(patch) });
      },
      async listDesignersInRegions(regions) {
        return [...state.designerProfiles.values()].filter((p) => overlaps(p.regions, regions)).map(clone);
      },

      // hair_profiles
      async getHairProfile(userId) {
        return clone(state.hairProfiles.get(userId) ?? null);
      },
      async upsertHairProfile(profile) {
        state.hairProfiles.set(profile.userId, clone(profile));
      },

      // requests
      async insertRequest(request) {
        state.requests.set(request.id, clone(request));
      },
      async getRequest(id) {
        return clone(state.requests.get(id) ?? null);
      },
      async getRequests(ids) {
        return ids.flatMap((id) => (state.requests.has(id) ? [clone(state.requests.get(id)!)] : []));
      },
      async updateRequest(id, patch) {
        const r = state.requests.get(id);
        if (r) state.requests.set(id, { ...r, ...clone(patch) });
      },
      async listRequestsByCustomer(customerId, statuses, page) {
        const rows = [...state.requests.values()]
          .filter((r) => r.customerId === customerId && (!statuses || statuses.includes(r.status)))
          .sort(byCreatedDesc);
        return paginate(rows, page).map(clone);
      },
      async listBoard(q: BoardQuery): Promise<BoardRow[]> {
        const counts = countBy([...state.responses.values()], (s) => s.requestId);
        const rows = [...state.requests.values()]
          .filter(
            (r) =>
              r.status === 'open' &&
              r.expiresAt > q.now &&
              r.customerId !== q.excludeCustomerId &&
              overlaps(r.regions, q.regions) &&
              (!q.treatmentType || r.treatmentType === q.treatmentType) &&
              (!q.difficulty || r.difficulty === q.difficulty) &&
              (!q.budget || r.budget === null || r.budget === q.budget),
          )
          .map((r) => ({ request: r, responseCount: counts.get(r.id) ?? 0 }))
          .sort((a, b) =>
            q.sort === 'fewest_responses'
              ? a.responseCount - b.responseCount || byCreatedDesc(a.request, b.request)
              : byCreatedDesc(a.request, b.request),
          );
        return paginate(rows, q.page).map(clone);
      },
      async listOverdueOpenRequests(now, opts = {}) {
        const rows = [...state.requests.values()].filter(
          (r) => r.status === 'open' && r.expiresAt <= now && (!opts.customerId || r.customerId === opts.customerId),
        );
        return rows.slice(0, opts.limit ?? rows.length).map(clone);
      },
      async listOpenRequestsExpiringBetween(now, before) {
        return [...state.requests.values()].filter((r) => r.status === 'open' && r.expiresAt > now && r.expiresAt <= before).map(clone);
      },
      async isImageKeyReferenced(key) {
        for (const r of state.requests.values()) if (r.designImageKey === key) return true;
        for (const m of state.matches.values()) if (m.designerResultKeys.includes(key) || m.customerResultKeys.includes(key)) return true;
        for (const p of state.designerProfiles.values()) if (p.licenseImageKey === key) return true;
        return false;
      },

      // responses
      async insertResponse(response) {
        for (const s of state.responses.values()) {
          if (s.requestId === response.requestId && s.designerId === response.designerId) {
            throw new UniqueViolation('responses_request_id_designer_id_key');
          }
        }
        state.responses.set(response.id, clone(response));
      },
      async getResponse(id) {
        return clone(state.responses.get(id) ?? null);
      },
      async listResponsesByRequest(requestId) {
        return [...state.responses.values()].filter((s) => s.requestId === requestId).map(clone);
      },
      async listResponsesByDesigner(designerId, requestIds) {
        return [...state.responses.values()].filter((s) => s.designerId === designerId && requestIds.includes(s.requestId)).map(clone);
      },
      async countResponses(requestIds) {
        const counts = countBy([...state.responses.values()].filter((s) => requestIds.includes(s.requestId)), (s) => s.requestId);
        return new Map(requestIds.map((id) => [id, counts.get(id) ?? 0]));
      },
      async updateResponse(id, patch) {
        const s = state.responses.get(id);
        if (s) state.responses.set(id, { ...s, ...clone(patch) });
      },
      async closePendingResponses(requestId, status, exceptId) {
        const changed: ResponseRow[] = [];
        for (const s of state.responses.values()) {
          if (s.requestId === requestId && s.status === 'pending' && s.id !== exceptId) {
            const next = { ...s, status };
            state.responses.set(s.id, next);
            changed.push(clone(next));
          }
        }
        return changed;
      },

      // matches
      async insertMatch(match) {
        for (const m of state.matches.values()) {
          if (m.requestId === match.requestId) throw new UniqueViolation('matches_request_id_key');
          if (m.responseId === match.responseId) throw new UniqueViolation('matches_response_id_key');
        }
        state.matches.set(match.id, clone(match));
      },
      async getMatch(id) {
        return clone(state.matches.get(id) ?? null);
      },
      async getMatchByRequest(requestId) {
        for (const m of state.matches.values()) if (m.requestId === requestId) return clone(m);
        return null;
      },
      async updateMatch(id, patch) {
        const m = state.matches.get(id);
        if (m) state.matches.set(id, { ...m, ...clone(patch) });
      },
      async countCompletedMatches(designerIds) {
        const counts = countBy([...state.matches.values()].filter((m) => m.status === 'completed'), (m) => m.designerId);
        return new Map(designerIds.map((id) => [id, counts.get(id) ?? 0]));
      },
      async hasActiveMatch(userId) {
        for (const m of state.matches.values()) {
          if ((m.customerId === userId || m.designerId === userId) && (m.status === 'accepted' || m.status === 'complete_requested')) return true;
        }
        return false;
      },

      // notifications
      async insertNotifications(rows) {
        for (const n of rows) state.notifications.set(n.id, clone(n));
      },
      async hasNotification(userId, type, refKey, refValue) {
        for (const n of state.notifications.values()) {
          if (n.userId === userId && n.type === type && n.payload[refKey] === refValue) return true;
        }
        return false;
      },
    };
    return repo;
  };

  return Object.assign(ops(false), { state: () => state });
}

function countBy<T>(rows: T[], key: (row: T) => string): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of rows) m.set(key(r), (m.get(key(r)) ?? 0) + 1);
  return m;
}

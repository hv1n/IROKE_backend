// v2 API 테스트 공통: 시계를 조작할 수 있는 memory 모드 앱 + 로그인·업로드·요청 생성 도우미.
// 모든 응답 본문을 모아 두었다가(responses) 연락처·카카오 ID가 섞이지 않았는지 검사한다.
import { KakaoAuthError, type KakaoClient } from '../src/auth/kakao';
import { createApp } from '../src/createApp';
import type { AppDeps } from '../src/deps';
import { createMemoryRepo } from '../src/repo/memory';
import { SEED, SEED_IDS, SEED_KAKAO_IDS } from '../src/repo/seed';
import type { DesignerProfileRow } from '../src/repo/types';
import { createMemoryStorage } from '../src/storage/memory';
import type { HairProfile, RequestCard } from '../src/shared';

export { SEED_IDS, SEED_KAKAO_IDS };

export const T0 = new Date('2026-11-18T03:00:00.000Z');
export const DAY = 24 * 60 * 60 * 1000;
export const CRON_SECRET = 'test-cron-secret';
export const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

export const PROFILE: HairProfile = {
  length: 'medium',
  texture: 'wavy',
  density: 'medium',
  damage: 3,
  currentLevel: 5,
  history: [{ type: 'color', date: '2026-10-01' }],
};

export const CARD: RequestCard = {
  styleTag: '레이어드 C컬펌',
  styleSource: { chosen: 'suggestion', suggestionIndex: 0 },
  profile: PROFILE,
  requestText: '끝만 가볍게 말아 주세요',
  riskWarnings: ['최근 3개월 염색'],
};

/** 카카오 대역: code 'bad'는 실패, 나머지는 code를 회원번호로 */
export const fakeKakao: KakaoClient = {
  async exchange(code) {
    if (code === 'bad') throw new KakaoAuthError('invalid_grant');
    return { kakaoId: `kakao-${code}`, nickname: `닉네임 ${code}` };
  },
};

export interface Res {
  status: number;
  body: any;
  text: string;
}

export function setup(overrides: Partial<AppDeps> = {}) {
  let now = new Date(T0);
  const clock = () => new Date(now);
  const repo = createMemoryRepo(SEED);
  const storage = createMemoryStorage({ baseUrl: 'http://localhost', secret: 'test-storage-secret', now: clock });
  const app = createApp({
    repo,
    storage,
    now: clock,
    kakao: fakeKakao,
    config: { jwtSecret: 'test-jwt-secret', jwtTtlSec: 7 * 24 * 60 * 60, cronSecret: CRON_SECRET, devRoutes: true },
    ...overrides,
  });
  const responses: string[] = [];

  async function call(method: string, path: string, opts: { token?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<Res> {
    const headers: Record<string, string> = { ...opts.headers };
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    const res = await app.request(path.startsWith('http') ? path : `/api${path}`, {
      method,
      headers,
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    });
    const text = await res.text();
    responses.push(text);
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    return { status: res.status, body, text };
  }

  async function login(kakaoId: string, nickname?: string): Promise<string> {
    const res = await call('POST', '/auth/dev', { body: { kakaoId, ...(nickname ? { nickname } : {}) } });
    if (res.status !== 200) throw new Error(`login failed ${res.status} ${res.text}`);
    return res.body.accessToken as string;
  }

  async function userId(token: string): Promise<string> {
    return (await call('GET', '/me', { token })).body.id;
  }

  /** POST /uploads → 서명 URL로 PUT → key */
  async function upload(token: string, purpose = 'request_design'): Promise<string> {
    const res = await call('POST', '/uploads', { token, body: { purpose, contentType: 'image/png', size: PNG_BYTES.length } });
    if (res.status !== 201) throw new Error(`upload url failed ${res.status} ${res.text}`);
    const put = await app.request(res.body.uploadUrl, { method: 'PUT', headers: { 'content-type': 'image/png' }, body: PNG_BYTES });
    if (put.status !== 200) throw new Error(`upload put failed ${put.status} ${await put.text()}`);
    return res.body.key;
  }

  async function createRequest(token: string, body: Record<string, unknown> = {}): Promise<Res> {
    const designImageKey = body.designImageKey ?? (await upload(token));
    return call('POST', '/requests', {
      token,
      body: {
        card: CARD,
        designImageKey,
        regions: ['서울 동작구'],
        timing: 'within_2_weeks',
        budget: '5_10',
        consent: { shareDesignWithVerifiedDesigners: true },
        ...body,
      },
    });
  }

  /** 응답 생성 기본값 */
  const responseBody = (over: Record<string, unknown> = {}) => ({ availability: 'possible', priceMin: 80000, priceMax: 100000, comment: '가능해요', ...over });

  /** 디자이너 프로필을 직접 넣는다 (2단계 면허 인증 API 전) */
  async function makeDesigner(token: string, over: Partial<DesignerProfileRow> = {}) {
    const id = await userId(token);
    await repo.upsertDesignerProfile({
      userId: id,
      verifyStatus: 'verified',
      rejectReason: null,
      licenseImageKey: null,
      submittedAt: T0,
      verifiedAt: T0,
      regions: ['서울 동작구'],
      shopName: '테스트 살롱',
      bookingUrl: 'https://example.com/booking/test',
      instagram: null,
      alertSettings: null,
      ...over,
    });
    return id;
  }

  return {
    app,
    repo,
    storage,
    call,
    login,
    userId,
    upload,
    createRequest,
    responseBody,
    makeDesigner,
    responses,
    now: clock,
    advance(ms: number) {
      now = new Date(now.getTime() + ms);
    },
    notificationsOf(userId: string) {
      return [...repo.state().notifications.values()].filter((n) => n.userId === userId);
    },
  };
}

/** 객체 안 어딘가에 key가 있는지 (중첩 포함) */
export function hasKeyDeep(v: unknown, pred: (key: string) => boolean): boolean {
  if (Array.isArray(v)) return v.some((x) => hasKeyDeep(x, pred));
  if (v && typeof v === 'object') return Object.entries(v).some(([k, x]) => pred(k) || hasKeyDeep(x, pred));
  return false;
}

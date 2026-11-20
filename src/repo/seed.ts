// 시연용 시드: 인증 디자이너 2명 + 손님 1명. db/seed.sql과 같은 값이다 (둘을 함께 고칠 것).
// memory 모드는 서버를 띄울 때 이 값으로 시작하고, 개발용 로그인(POST /api/auth/dev)에 kakaoId를 넣어 로그인한다.
import type { AlertSettings } from '../shared/index.js';
import type { MemorySeed } from './memory.js';

export const SEED_IDS = {
  designer1: 'a0000000-0000-4000-8000-000000000001',
  designer2: 'a0000000-0000-4000-8000-000000000002',
  customer1: 'c0000000-0000-4000-8000-000000000001',
} as const;

export const SEED_KAKAO_IDS = {
  designer1: 'seed-designer-1',
  designer2: 'seed-designer-2',
  customer1: 'seed-customer-1',
} as const;

const created = new Date('2026-11-01T00:00:00.000Z');
const allAlerts: AlertSettings = { enabled: true, regions: [], treatmentTypes: [], difficulties: [], budgets: [] };

export const SEED: MemorySeed = {
  users: [
    { id: SEED_IDS.designer1, kakaoId: SEED_KAKAO_IDS.designer1, nickname: '서윤 디자이너', temperature: 37.2, createdAt: created },
    { id: SEED_IDS.designer2, kakaoId: SEED_KAKAO_IDS.designer2, nickname: '도현 디자이너', temperature: 36.8, createdAt: created },
    { id: SEED_IDS.customer1, kakaoId: SEED_KAKAO_IDS.customer1, nickname: '하린', temperature: 36.5, createdAt: created },
  ],
  designerProfiles: [
    {
      userId: SEED_IDS.designer1,
      verifyStatus: 'verified',
      rejectReason: null,
      licenseImageKey: null,
      submittedAt: created,
      verifiedAt: created,
      regions: ['서울 동작구', '서울 관악구'],
      shopName: '이로케 시연 살롱 상도점',
      bookingUrl: 'https://example.com/booking/iroke-demo-1',
      instagram: null,
      alertSettings: allAlerts,
    },
    {
      userId: SEED_IDS.designer2,
      verifyStatus: 'verified',
      rejectReason: null,
      licenseImageKey: null,
      submittedAt: created,
      verifiedAt: created,
      regions: ['서울 마포구', '서울 동작구'],
      shopName: '이로케 시연 살롱 합정점',
      bookingUrl: 'https://example.com/booking/iroke-demo-2',
      instagram: null,
      alertSettings: allAlerts,
    },
  ],
  hairProfiles: [
    {
      userId: SEED_IDS.customer1,
      length: 'medium',
      texture: 'wavy',
      density: 'medium',
      damage: 3,
      level: 5,
      history: [{ type: 'color', date: '2026-09-20' }],
      source: { editedFields: [], confirmedAt: created.toISOString() },
      updatedBy: 'user',
      updatedAt: created,
    },
  ],
};

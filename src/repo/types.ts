// 데이터 접근 계층. 구현체는 memory(로컬·테스트)와 postgres(Supabase) 두 가지다.
// 권한·상태 전이·공개 범위 같은 규칙은 services/에 두고, 여기는 저장과 조회만 한다.
import type {
  AlertSettings,
  Availability,
  Budget,
  Difficulty,
  MatchStatus,
  NotificationType,
  RequestCard,
  RequestStatus,
  ResponseStatus,
  Timing,
  VerifyStatus,
} from '../shared/api-v2';
import type { AnalyzedField, HairDensity, HairLength, HairTexture, Treatment, TreatmentType } from '../shared/types';

export interface UserRow {
  id: string;
  kakaoId: string;
  nickname: string;
  temperature: number;
  createdAt: Date;
}

export interface DesignerProfileRow {
  userId: string;
  verifyStatus: VerifyStatus;
  rejectReason: string | null;
  licenseImageKey: string | null;
  submittedAt: Date | null;
  verifiedAt: Date | null;
  regions: string[];
  shopName: string | null;
  bookingUrl: string | null;
  instagram: string | null;
  alertSettings: AlertSettings | null;
}

export interface HairProfileRow {
  userId: string;
  length: HairLength;
  texture: HairTexture;
  density: HairDensity;
  damage: number;
  /** 현재 밝기 (HairProfile.currentLevel) */
  level: number | null;
  history: Treatment[];
  source: { editedFields: AnalyzedField[]; confirmedAt: string } | null;
  updatedBy: 'user' | 'match';
  updatedAt: Date;
}

export interface RequestRow {
  id: string;
  customerId: string;
  cardSnapshot: RequestCard;
  styleTag: string;
  treatmentType: TreatmentType;
  difficulty: Difficulty;
  difficultyReason: string;
  hairTags: string[];
  designImageKey: string;
  designHiddenAt: Date | null;
  designConsentAt: Date;
  regions: string[];
  timing: Timing;
  budget: Budget | null;
  status: RequestStatus;
  version: number;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface ResponseRow {
  id: string;
  requestId: string;
  designerId: string;
  availability: Availability;
  condition: string | null;
  priceMin: number;
  priceMax: number;
  comment: string;
  requestVersion: number;
  status: ResponseStatus;
  createdAt: Date;
}

export interface MatchRow {
  id: string;
  requestId: string;
  responseId: string;
  customerId: string;
  designerId: string;
  status: MatchStatus;
  acceptedAt: Date;
  completeRequestedAt: Date | null;
  confirmedAt: Date | null;
  confirmDeadline: Date | null;
  autoCompleted: boolean;
  designerResultKeys: string[];
  customerResultKeys: string[];
  portfolioConsent: boolean;
  profileUpdate: unknown | null;
  disputeReason: string | null;
}

export interface NotificationRow {
  id: string;
  userId: string;
  type: NotificationType;
  payload: Record<string, unknown>;
  readAt: Date | null;
  createdAt: Date;
}

/** 목록 페이지 (offset 기반, 커서는 http 계층에서 감싼다) */
export interface Page {
  offset: number;
  limit: number;
}

export interface BoardQuery {
  now: Date;
  /** 이 지역 중 하나라도 겹치는 요청 */
  regions: string[];
  /** 자기 요청은 게시판에서 뺀다 */
  excludeCustomerId: string;
  treatmentType?: TreatmentType;
  difficulty?: Difficulty;
  /** 예산 필터. 예산 없는 요청(디자이너 제안)은 어느 필터에도 포함 */
  budget?: Budget;
  sort: 'newest' | 'fewest_responses';
  page: Page;
}

export interface BoardRow {
  request: RequestRow;
  responseCount: number;
}

/** UNIQUE 제약 위반 (두 구현체 공통) */
export class UniqueViolation extends Error {
  constructor(readonly constraint: string) {
    super(`unique violation: ${constraint}`);
  }
}

export interface Repo {
  /** fn 안의 쓰기를 하나의 트랜잭션으로 묶는다. fn에는 트랜잭션에 묶인 repo가 넘어온다. */
  tx<T>(fn: (repo: Repo) => Promise<T>): Promise<T>;

  // users
  getUser(id: string): Promise<UserRow | null>;
  getUsers(ids: string[]): Promise<UserRow[]>;
  getUserByKakaoId(kakaoId: string): Promise<UserRow | null>;
  insertUser(user: UserRow): Promise<void>;
  updateUser(id: string, patch: Partial<Pick<UserRow, 'nickname' | 'temperature'>>): Promise<void>;

  // designer_profiles
  getDesignerProfile(userId: string): Promise<DesignerProfileRow | null>;
  getDesignerProfiles(userIds: string[]): Promise<DesignerProfileRow[]>;
  upsertDesignerProfile(profile: DesignerProfileRow): Promise<void>;
  updateDesignerProfile(userId: string, patch: Partial<Omit<DesignerProfileRow, 'userId'>>): Promise<void>;
  /** 활동 지역이 겹치는 디자이너 (알림 대상 후보) */
  listDesignersInRegions(regions: string[]): Promise<DesignerProfileRow[]>;

  // hair_profiles
  getHairProfile(userId: string): Promise<HairProfileRow | null>;
  upsertHairProfile(profile: HairProfileRow): Promise<void>;

  // requests
  insertRequest(request: RequestRow): Promise<void>;
  /** lock = 트랜잭션 안에서 행 잠금 (SELECT … FOR UPDATE) */
  getRequest(id: string, opts?: { lock?: boolean }): Promise<RequestRow | null>;
  getRequests(ids: string[]): Promise<RequestRow[]>;
  updateRequest(id: string, patch: Partial<Omit<RequestRow, 'id' | 'customerId'>>): Promise<void>;
  /** 최신순 */
  listRequestsByCustomer(customerId: string, statuses: RequestStatus[] | null, page: Page): Promise<RequestRow[]>;
  listBoard(query: BoardQuery): Promise<BoardRow[]>;
  /** status=open이고 expires_at ≤ now (customerId를 주면 그 손님 것만) */
  listOverdueOpenRequests(now: Date, opts?: { customerId?: string; limit?: number }): Promise<RequestRow[]>;
  /** status=open이고 now < expires_at ≤ before */
  listOpenRequestsExpiringBetween(now: Date, before: Date): Promise<RequestRow[]>;
  /** 이 이미지 key를 어느 테이블이든 참조하는지 (고아 업로드 판단) */
  isImageKeyReferenced(key: string): Promise<boolean>;

  // responses
  /** UNIQUE(request_id, designer_id) 위반이면 UniqueViolation */
  insertResponse(response: ResponseRow): Promise<void>;
  getResponse(id: string): Promise<ResponseRow | null>;
  listResponsesByRequest(requestId: string): Promise<ResponseRow[]>;
  listResponsesByDesigner(designerId: string, requestIds: string[]): Promise<ResponseRow[]>;
  countResponses(requestIds: string[]): Promise<Map<string, number>>;
  updateResponse(id: string, patch: Partial<Pick<ResponseRow, 'status'>>): Promise<void>;
  /** 이 요청의 pending 응답을 status로 바꾸고 바뀐 행을 돌려준다 (exceptId 제외) */
  closePendingResponses(requestId: string, status: ResponseStatus, exceptId?: string): Promise<ResponseRow[]>;

  // matches
  insertMatch(match: MatchRow): Promise<void>;
  getMatch(id: string, opts?: { lock?: boolean }): Promise<MatchRow | null>;
  getMatchByRequest(requestId: string): Promise<MatchRow | null>;
  updateMatch(id: string, patch: Partial<Omit<MatchRow, 'id' | 'requestId' | 'responseId' | 'customerId' | 'designerId'>>): Promise<void>;
  /** 디자이너별 완료 매칭 수 (verifiedWorkCount) */
  countCompletedMatches(designerIds: string[]): Promise<Map<string, number>>;
  /** 이 사용자가 당사자인 진행 중 매칭(accepted·complete_requested)이 있는지 */
  hasActiveMatch(userId: string): Promise<boolean>;

  // notifications
  insertNotifications(rows: NotificationRow[]): Promise<void>;
  /** 같은 사용자·유형·대상(payload[refKey] = refValue) 알림이 이미 있는지 (배치 중복 방지) */
  hasNotification(userId: string, type: NotificationType, refKey: string, refValue: string): Promise<boolean>;
}

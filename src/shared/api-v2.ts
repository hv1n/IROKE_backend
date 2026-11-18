// v2 [디자이너 구하기] API 계약. 필드는 camelCase, 시간은 ISO 8601(UTC), 금액은 원 단위 정수.
// 연락처(전화·이메일·카카오 ID)는 어떤 응답 타입에도 두지 않는다. 예약 링크는 수락 응답(AcceptResponseResult)에만 있다.
import type { HairProfile, ProfileSource, StyleSource, TreatmentType } from './types';

export type IsoDateTime = string;

export type Difficulty = 'low' | 'medium' | 'high';
export type Timing = 'this_week' | 'within_2_weeks' | 'within_month' | 'any';
/** 만 원 단위 구간. null = 디자이너 제안 */
export type Budget = 'under_5' | '5_10' | '10_15' | 'over_15';
export type VerifyStatus = 'pending' | 'verified' | 'rejected';
export type RequestStatus = 'open' | 'matched' | 'completed' | 'expired' | 'cancelled';
export type ResponseStatus = 'pending' | 'accepted' | 'not_selected';
export type Availability = 'possible' | 'conditional';
export type MatchStatus = 'accepted' | 'complete_requested' | 'completed' | 'disputed';
export type UploadPurpose = 'request_design' | 'result' | 'license' | 'portfolio';
export type UploadContentType = 'image/jpeg' | 'image/png' | 'image/webp';
export type NotificationType =
  | 'new_matching_request'
  | 'new_response'
  | 'accepted'
  | 'request_closed'
  | 'deadline_soon'
  | 'complete_requested'
  | 'review_reminder'
  | 'verification_result';

export const TIMINGS: Timing[] = ['this_week', 'within_2_weeks', 'within_month', 'any'];
export const BUDGETS: Budget[] = ['under_5', '5_10', '10_15', 'over_15'];
export const DIFFICULTIES: Difficulty[] = ['low', 'medium', 'high'];
export const TREATMENT_TYPES: TreatmentType[] = ['cut', 'perm', 'color', 'bleach'];
export const UPLOAD_PURPOSES: UploadPurpose[] = ['request_design', 'result', 'license', 'portfolio'];
export const UPLOAD_CONTENT_TYPES: UploadContentType[] = ['image/jpeg', 'image/png', 'image/webp'];

/** 서버와 화면이 같이 쓰는 한도 */
export const MARKETPLACE_LIMITS = {
  /** 요청·활동 지역 최대 개수 */
  regionsMax: 2,
  /** 응답 코멘트 최대 글자 수 */
  responseCommentMax: 50,
  /** 조건부 가능의 조건 최대 글자 수 */
  conditionMax: 100,
  /** 미용사에게 전할 말 최대 글자 수 */
  requestTextMax: 500,
  riskWarningsMax: 10,
  riskWarningMax: 100,
  /** 업로드 최대 크기 (바이트) */
  uploadMaxBytes: 5 * 1024 * 1024,
  /** 요청 마감 (등록·재등록 후 일수) */
  requestTtlDays: 7,
  /** 이미지 서명 URL 유효 시간 (초) */
  signedUrlTtlSec: 600,
  pageDefault: 20,
  pageMax: 50,
} as const;

/** 목록 응답. nextCursor가 null이면 마지막 페이지 */
export interface Paged<T> {
  items: T[];
  nextCursor: string | null;
}

// ── 인증 · 계정 ────────────────────────────────────────────

/** POST /api/auth/kakao */
export interface KakaoLoginRequest {
  code: string;
  redirectUri: string;
}

/** POST /api/auth/dev — DATA_MODE=memory이고 production이 아닐 때만 열린다 */
export interface DevLoginRequest {
  kakaoId: string;
  nickname?: string;
}

export interface LoginResponse {
  accessToken: string;
  /** 초 */
  expiresIn: number;
  isNewUser: boolean;
  user: Me;
}

/** GET /api/me */
export interface Me {
  id: string;
  nickname: string;
  /** 양방향 온도, 시작 36.5 */
  temperature: number;
  hasHairProfile: boolean;
  /** 면허 인증을 신청한 적 있으면 값이 있음 (손님·디자이너 겸업) */
  designer: null | {
    verifyStatus: VerifyStatus;
    regions: string[];
    shopName: string | null;
    bookingUrl: string | null;
    instagram: string | null;
  };
}

/** GET /api/me/hair-profile */
export interface HairProfileResponse {
  profile: HairProfile;
  confirmedAt: IsoDateTime | null;
  updatedAt: IsoDateTime;
  updatedBy: 'user' | 'match';
}

/** PUT /api/me/hair-profile — 기존 ProfileConfirmationRequest와 같은 형식 */
export interface PutHairProfileRequest {
  profile: HairProfile;
  profileSource: ProfileSource;
}

// ── 업로드 ────────────────────────────────────────────────

/** POST /api/uploads */
export interface UploadRequest {
  purpose: UploadPurpose;
  contentType: UploadContentType;
  /** 바이트, 최대 5MB */
  size: number;
}

export interface UploadResponse {
  /** {purpose}/{userId}/{uuid} — API에는 이 값만 넘긴다 */
  key: string;
  /** 이 URL에 이미지 바이트를 그대로 PUT (Content-Type 헤더 포함) */
  uploadUrl: string;
  expiresAt: IsoDateTime;
}

// ── 손님: 요청 ─────────────────────────────────────────────

/** S-07 전달 카드 */
export interface RequestCard {
  styleTag: string;
  styleSource: StyleSource;
  profile: HairProfile;
  /** 미용사에게 전할 말 */
  requestText: string;
  /** 사전 안전 경고 (예: 최근 3개월 염색) */
  riskWarnings: string[];
}

/** POST /api/requests */
export interface CreateRequestBody {
  card: RequestCard;
  /** POST /uploads (purpose: 'request_design') */
  designImageKey: string;
  /** 1~2개, '시·도 시·군·구' (예: '서울 동작구') */
  regions: string[];
  timing: Timing;
  budget: Budget | null;
  consent: { shareDesignWithVerifiedDesigners: true };
}

export interface CreateRequestResponse {
  id: string;
  status: 'open';
  expiresAt: IsoDateTime;
  treatmentType: TreatmentType;
  difficulty: Difficulty;
  /** 산정 근거 한 줄 */
  difficultyReason: string;
}

/** GET /api/requests/mine 항목 */
export interface MyRequestItem {
  id: string;
  styleTag: string;
  /** 본인 요청이므로 비공개 처리 뒤에도 내려준다 (10분 서명 URL, 얼굴 가린 사본) */
  designImageUrl: string | null;
  regions: string[];
  timing: Timing;
  budget: Budget | null;
  status: RequestStatus;
  expiresAt: IsoDateTime;
  responseCount: number;
}

/** GET /api/requests/mine?status= — closed = completed·expired·cancelled */
export type MyRequestFilter = 'open' | 'matched' | 'closed';

/** GET /api/requests/:id */
export interface RequestDetail extends MyRequestItem {
  card: RequestCard;
  version: number;
  matchId: string | null;
  treatmentType: TreatmentType;
  difficulty: Difficulty;
  difficultyReason: string;
}

/** PATCH /api/requests/:id, POST /api/requests/:id/reopen */
export interface UpdateRequestBody {
  regions?: string[];
  timing?: Timing;
  budget?: Budget | null;
}

/** POST /api/requests/:id/close */
export interface CloseRequestResponse {
  id: string;
  status: 'cancelled';
}

/** POST /api/requests/:id/reopen */
export interface ReopenRequestResponse {
  id: string;
  status: 'open';
  expiresAt: IsoDateTime;
  version: number;
}

// ── 손님: 응답 비교 · 수락 ─────────────────────────────────

export type ResponseSort = 'price_asc' | 'temperature_desc' | 'works_desc';

/** GET /api/requests/:id/responses 항목. 예약 링크·연락처 없음 */
export interface ResponseCard {
  id: string;
  availability: Availability;
  condition: string | null;
  /** 원 */
  priceMin: number;
  priceMax: number;
  /** 50자 이하 */
  comment: string;
  /** 요청 수정 전 조건에 대한 응답 */
  isOutdated: boolean;
  status: ResponseStatus;
  createdAt: IsoDateTime;
  designer: {
    id: string;
    nickname: string;
    shopName: string;
    area: string;
    temperature: number;
    verifiedWorkCount: number;
  };
}

/** POST /api/responses/:id/accept → 201. 예약 링크는 여기서만 내려준다 */
export interface AcceptResponseResult {
  matchId: string;
  bookingUrl: string;
}

// ── 디자이너: 게시판 · 응답 ────────────────────────────────

/** GET /api/board 항목. 공개 필드만 — 이미지 URL 없음 */
export interface BoardItem {
  id: string;
  styleTag: string;
  treatmentType: TreatmentType;
  difficulty: Difficulty;
  /** ['중단발', '반곱슬', '손상도 3', '최근 3개월 염색'] */
  hairTags: string[];
  budget: Budget | null;
  timing: Timing;
  regions: string[];
  expiresAt: IsoDateTime;
  responseCount: number;
  myResponded: boolean;
}

export type BoardSort = 'newest' | 'fewest_responses';

/** 디자이너 본인의 응답 */
export interface MyResponse {
  id: string;
  availability: Availability;
  condition: string | null;
  priceMin: number;
  priceMax: number;
  comment: string;
  isOutdated: boolean;
  status: ResponseStatus;
  createdAt: IsoDateTime;
}

/** GET /api/board/:requestId */
export interface BoardDetail extends BoardItem {
  status: RequestStatus;
  card: Pick<RequestCard, 'profile' | 'requestText' | 'riskWarnings'>;
  /** 인증 디자이너 + 비공개 처리 전일 때만 10분 서명 URL. 나머지는 null */
  designImageUrl: string | null;
  myResponse: MyResponse | null;
}

/** POST /api/requests/:id/responses */
export interface CreateResponseBody {
  availability: Availability;
  /** conditional이면 필수 */
  condition?: string | null;
  priceMin: number;
  priceMax: number;
  /** 50자 이하 */
  comment: string;
}

/** GET·PUT /api/designers/me/alert-settings. 빈 배열 = 전부 (regions는 활동 지역 전체) */
export interface AlertSettings {
  enabled: boolean;
  regions: string[];
  treatmentTypes: TreatmentType[];
  difficulties: Difficulty[];
  budgets: Budget[];
}

// ── 내부 배치 ──────────────────────────────────────────────

/** GET·POST /api/internal/jobs/sweep (Authorization: Bearer CRON_SECRET) */
export interface SweepResult {
  expiredRequests: number;
  deadlineSoonNotified: number;
  autoCompletedMatches: number;
  reviewReminders: number;
  orphanUploadsDeleted: number;
}

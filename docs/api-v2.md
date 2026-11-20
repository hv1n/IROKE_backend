# IROKE v2 API 명세

2026-11-20 기준 (구현 반영) · 근거: 피그마 v2 (01 User Flow · 02 명세·화면 목록 · 03 Wireframes · 04 시스템 아키텍처), GitHub main `server/src/app.ts` · `shared/src/api.ts` · `shared/src/types.ts`

## 개요

- 시안 만들기(S-00~S-07)는 지금처럼 로그인·DB 없이 기존 API 7개로 동작
- [디자이너 구하기]부터 카카오 로그인 + PostgreSQL + 비공개 이미지 버킷 사용
- 신규 API 36개, 그중 P1(시연까지 구현) 17개

설계 전제

- 셀카 원본은 저장하지 않음. 버킷에는 요청 시안과 시술 결과 사진만, 업로드 직전 얼굴을 가린 사본으로 저장 (본인 화면에서는 원본)
- 게시판 목록엔 모발 정보·요청·난이도·예산대만. 시안(얼굴 가린 사본)은 인증 디자이너에게만 10분짜리 서명 URL로
- 연락처 필드는 어떤 응답에도 넣지 않음. 예약·결제는 디자이너 외부 링크로
- 면허 번호는 확인에만 쓰고 저장하지 않음
- 요청 마감 기본 7일, 같은 요청에 디자이너당 응답 1회
- 한 카카오 계정으로 손님·디자이너 겸업 가능 (디자이너 여부 = 면허 인증 신청 여부)

## 공통 규칙

| 항목 | 규칙 |
| --- | --- |
| Base | `https://iroke-backend.vercel.app/api` (백엔드는 별도 Vercel 프로젝트라 프론트 주소 `https://iroke.vercel.app`과 다름) |
| 비로그인 구분 | `x-iroke-client-id` 헤더 (기존 그대로, 시안 만들기 흐름 전용) |
| 로그인 인증 | `Authorization: Bearer <accessToken>` (카카오 로그인 후 서버가 발급하는 JWT) |
| 권한 표기 | 공개 / 로그인 / 손님 / 디자이너 / 인증 디자이너 / 당사자(해당 요청·매칭의 손님 또는 디자이너) |
| 이미지 올리기 | `POST /uploads`로 받은 서명 업로드 URL에 직접 PUT → 돌려받은 `key`만 API에 전달 (Vercel 본문 4.5MB 제한 회피) |
| 이미지 보기 | 응답의 `…Url` 필드에 서명 URL(10분). 버킷 자체는 비공개 |
| 목록 | `?cursor=&limit=` (기본 20, 최대 50), 응답 `{ items, nextCursor }` |
| 시간 | ISO 8601 (UTC 저장, 화면에서 KST 변환) |
| 금액 | 원 단위 정수 (화면 입력은 만 원 → 클라이언트에서 ×10000) |

에러 응답은 기존과 같은 `{ error, code }` 형식이고, 기존 `ApiErrorCode`에 아래를 추가합니다.

| code | HTTP | 언제 |
| --- | --- | --- |
| `unauthorized` | 401 | 토큰 없음·만료 |
| `forbidden` | 403 | 권한 없음, 당사자가 아님, 자기 요청에 응답 |
| `not_verified` | 403 | 미인증 디자이너가 응답·시안 열람 시도 |
| `not_found` | 404 | 없거나 볼 수 없는 리소스 |
| `already_responded` | 409 | 같은 요청에 두 번째 응답, 같은 매칭에 두 번째 후기 |
| `invalid_state` | 409 | 상태 전이 규칙 위반 (예: 완료 요청 없이 확인) |
| `request_closed` | 410 | 마감·취소·매칭된 요청에 응답 |
| `consent_required` | 422 | 시안 공개 동의 없이 요청 등록 |
| `validation_failed` | 422 | 필드 규칙 위반 (지역 3곳 이상, 코멘트 50자 초과 등). `fields`로 항목 안내 |

## 엔드포인트 한눈에 보기

| 모듈 | 메서드 · 경로 | 권한 | 화면 | 우선순위 |
| --- | --- | --- | --- | --- |
| 기존 | `GET /health` · `GET /status` | 공개 | — | 구현됨 |
| 기존 | `POST /analysis/hair` | 공개 | S-02 | 구현됨 |
| 기존 | `POST /analysis/style` | 공개 | S-04 | 구현됨 + v2 변경 |
| 기존 | `POST /profile-confirmations` | 공개 | S-02 | 구현됨 |
| 기존 | `POST /generations` | 공개 | S-05·S-06 | 구현됨 + v2 변경 |
| 기존 | `PATCH /generations/:id` | 공개 | S-06 | 구현됨 |
| 인증 | `POST /auth/kakao` | 공개 | A-01 | P1 |
| 인증 | `POST /auth/logout` | 로그인 | A-01 | P1 |
| 인증 | `POST /auth/dev` | 공개 (로컬 memory 모드 전용, production에서 닫힘) | — | 개발용 |
| 계정 | `GET /me` | 로그인 | 공통 | P1 |
| 계정 | `GET /me/hair-profile` · `PUT /me/hair-profile` | 로그인 | S-02·C-06 | P2 |
| 업로드 | `POST /uploads` | 로그인 | C-01·C-06·D-01 | P1 |
| 요청 | `POST /requests` | 손님 | C-01 | P1 |
| 요청 | `GET /requests/mine` | 손님 | C-02 | P1 |
| 요청 | `GET /requests/:id` | 당사자(손님) | C-02 | P1 |
| 요청 | `PATCH /requests/:id` | 당사자(손님) | C-02 | P1 |
| 요청 | `POST /requests/:id/close` | 당사자(손님) | C-02 | P1 |
| 요청 | `POST /requests/:id/reopen` | 당사자(손님) | C-03 | P1 |
| 응답 | `GET /requests/:id/responses` | 당사자(손님) | C-03 | P1 |
| 매칭 | `POST /responses/:id/accept` | 당사자(손님) | C-05 | P1 |
| 디자이너 | `GET /designers/:id` | 로그인 | C-04 | P2 |
| 디자이너 | `GET /designers/:id/portfolio` | 로그인 | C-04·D-05 | P2 |
| 디자이너 | `GET /designers/:id/reviews` | 로그인 | C-04 | P2 |
| 매칭 | `GET /matches/:id` | 당사자 | C-06·D-04 | P2 |
| 매칭 | `POST /matches/:id/complete` | 당사자(디자이너) | D-04 | P2 |
| 매칭 | `POST /matches/:id/confirm` | 당사자(손님) | C-06 | P2 |
| 매칭 | `POST /matches/:id/dispute` | 당사자(손님) | C-06 | P2 |
| 후기 | `POST /matches/:id/reviews` | 당사자 | C-07·D-04 | P2 |
| 디자이너 인증 | `POST /designers/verification` | 로그인 | D-01 | P2 |
| 디자이너 인증 | `GET /designers/verification` | 로그인 | D-01 | P2 |
| 디자이너 정보 | `PATCH /designers/me` | 디자이너 | D-01 | P2 |
| 게시판 | `GET /board` | 디자이너 | D-02 | P1 |
| 게시판 | `GET /board/:requestId` | 디자이너 (시안은 인증만) | D-03 | P1 |
| 응답 | `POST /requests/:id/responses` | 인증 디자이너 | D-03 | P1 |
| 알림 조건 | `GET /designers/me/alert-settings` · `PUT …` | 디자이너 | D-02 | P1 |
| 진행 관리 | `GET /designers/me/responses` | 디자이너 | D-04 | P2 |
| 포트폴리오 | `POST /designers/me/portfolio` · `DELETE …/:itemId` | 인증 디자이너 | D-05 | 확장 |
| 알림 | `GET /notifications` · `POST /notifications/read` | 로그인 | X-01 | P2 |
| 신고 | `POST /reports` | 로그인 | X-02 | 확장 |
| 내부 | `GET·POST /internal/jobs/sweep` | `Bearer CRON_SECRET` | — | P1 |

`GET·POST /internal/jobs/sweep`은 화면이 없는 배치입니다.

- 마감 지난 요청을 `expired`로 바꾸고 시안을 비공개 처리
- 7일 지난 완료 요청을 자동 완료 처리
- 마감 임박·후기 리마인드·면허 결과 알림 생성, 24시간 동안 쓰이지 않은 업로드 삭제
- Vercel 무료 플랜 제한으로 **매일 03:00(KST)에 1회** 실행
- 대신 요청 조회·응답·수락, 내 요청·진행 관리 조회 때 서버가 마감·자동 완료 시점을 직접 확인해 바로 반영하므로, 배치가 늦어도 화면에 보이는 상태는 정확함. 여러 번 돌아도 결과가 같음

## 시안 만들기 (기존 + v2 변경)

| API | 요청 | 응답 | 비고 |
| --- | --- | --- | --- |
| `POST /analysis/hair` | `{ image: dataURL }` | `HairAnalysis` (5개 항목별 value·confidence·reason, colorDescription, notes) | 실패 502 `analysis_failed` → [다시 시도] / [직접 입력] |
| `POST /profile-confirmations` | `{ profile: HairProfile, profileSource }` | 204 | 파인튜닝용 JSONL 로그. DB 저장 없음 |
| `POST /analysis/style` | `{ image: dataURL }` | `StyleAnalysis` + `similarStyles` | 아래 v2 변경 1 |
| `POST /generations` | `selfie, reference?, styleTag, profile, profileSource, styleSource` | `{ generationId, image, model, promptVersion, latencyMs }` | 아래 v2 변경 2. 429 `limit_reached`, 504 `timeout`, 502 `no_image` |
| `PATCH /generations/:id` | `{ clientLatencyMs }` | 204 | — |

### v2 변경 1 · `POST /analysis/style`

응답에 비슷한 스타일을 추가합니다. 비어 있으면 화면은 그 영역만 숨깁니다.

```ts
interface StyleAnalysis {
  model: string; analyzedAt: string;
  suggestions: StyleSuggestion[];        // 이름 후보 3개 (기존)
  similarStyles: SimilarStyle[];         // NEW · 최대 4개, 없으면 []
  feasibility?: Feasibility;             // [계획] 가능 여부 판정
}
interface SimilarStyle {
  tag: string;               // [비슷한 스타일 1]
  description: string;       // [특징 한 줄]
  diffFromReference: string; // 레퍼런스보다 [다른 점]
}
```

### v2 변경 2 · `POST /generations`

비슷한 스타일을 고르면 레퍼런스 사진 대신 스타일 설명으로 시안을 만듭니다.

- `styleSource.chosen`에 `'similar'` 추가, `similarIndex` 추가
- `chosen === 'similar'`이면 `reference` 생략 가능, 대신 `styleDescription`(특징 한 줄) 필수. 서버는 `buildPrompt(…, { hasReference: false })`
- 직접 입력(`custom`)은 `styleTag` 30자 제한
- “같은 입력 24시간 재사용”은 지금처럼 브라우저 캐시(`promptVersion` 포함 키)로 처리. 서버 변경 없음

## 인증 · 계정 · 업로드

카카오 인가 코드는 클라이언트가 받아 서버에 넘기고, 서버가 카카오 토큰 교환 → `users` upsert → 자체 JWT 발급까지 합니다. 카카오 토큰은 저장하지 않습니다.

### `POST /auth/kakao` · A-01

```ts
// req
{ code: string; redirectUri: string }
// res 200
{ accessToken: string; expiresIn: number; isNewUser: boolean; user: Me }
```

### `POST /auth/logout`

204. JWT는 무상태라 클라이언트가 토큰을 버리는 것이 본체입니다.

### `GET /me`

```ts
interface Me {
  id: string; nickname: string;
  temperature: number;            // 양방향 온도, 시작 36.5
  hasHairProfile: boolean;
  designer: null | {              // 면허 인증을 신청한 적 있으면 값이 있음 (손님·디자이너 겸업)
    verifyStatus: 'pending' | 'verified' | 'rejected';
    regions: string[]; shopName: string | null; bookingUrl: string | null; instagram: string | null;
  };
}
```

### `GET /me/hair-profile` · `PUT /me/hair-profile` · S-02, C-06

- PUT 요청 = 기존 `ProfileConfirmationRequest`와 같은 `{ profile, profileSource }`
- 로그인 직후 localStorage의 확정 프로필을 서버로 옮길 때, 로그인 상태에서 S-02를 다시 확정할 때 호출
- GET 응답: `{ profile: HairProfile, confirmedAt, updatedAt, updatedBy: 'user' | 'match' }`, 없으면 404
- 시술 완료 확인(`POST /matches/:id/confirm`) 때 서버가 자동 갱신하고 `updatedBy: 'match'`로 남김

### `POST /uploads` — 서명 업로드 URL 발급

```ts
// req
{ purpose: 'request_design' | 'result' | 'license' | 'portfolio';
  contentType: 'image/jpeg' | 'image/png' | 'image/webp'; size: number } // size ≤ 5MB
// res 201
{ key: string; uploadUrl: string; expiresAt: string } // key = {purpose}/{userId}/{uuid}
```

- `license`는 로그인 사용자, `result`는 매칭 당사자만 요청 가능
- `request_design`·`result`·`portfolio`는 클라이언트가 PUT 직전에 MediaPipe로 얼굴을 찾아 가린 사본만 올림. 원본은 브라우저에만 남고 본인 화면은 원본으로 표시
- 24시간 동안 어느 테이블에도 연결되지 않은 key는 배치가 삭제

## 손님: 요청 · 응답 비교 · 수락 · 완료 · 후기

요청은 전달 카드를 스냅샷(JSON)으로 통째 저장하고, 게시판·필터에 쓰는 값만 따로 컬럼으로 뽑습니다. 시술 종류와 난이도는 손님이 고르지 않고, 요청 등록 때 Gemini가 스타일·손상도·최근 약제 시술 이력·현재 밝기를 종합해 산정합니다.

### `POST /requests` · C-01 (WF-7)

```ts
// req
{
  card: {                            // S-07 전달 카드 그대로
    styleTag: string; styleSource: StyleSource;
    profile: HairProfile;
    requestText: string;             // 미용사에게 전할 말
    riskWarnings: string[];          // 사전 안전 경고 (예: 최근 3개월 염색)
  };
  designImageKey: string;            // POST /uploads (purpose: 'request_design')
  regions: string[];                 // 1~2개, '시·도 시·군·구' 문자열 (예: '서울 동작구')
  timing: 'this_week' | 'within_2_weeks' | 'within_month' | 'any';
  budget: 'under_5' | '5_10' | '10_15' | 'over_15' | null;   // null = 디자이너 제안
  consent: { shareDesignWithVerifiedDesigners: true };       // 없으면 422 consent_required
}
// res 201
{ id: string; status: 'open'; expiresAt: string;           // +7일
  treatmentType: 'cut' | 'perm' | 'color' | 'bleach'; difficulty: 'low' | 'medium' | 'high';
  difficultyReason: string }                               // Gemini 산정 근거 한 줄
```

등록 직후 서버는 알림 조건이 맞는 **인증 디자이너**에게만 `new_matching_request` 알림을 만듭니다. 인증 대기·반려 디자이너는 받지 않습니다.

### 내 요청 관리 · C-02

| API | 요청 | 응답 · 규칙 |
| --- | --- | --- |
| `GET /requests/mine` | `?status=open` / `matched` / `closed` | `{ items: [{ id, styleTag, designImageUrl, regions, timing, budget, status, expiresAt, responseCount }] }` |
| `GET /requests/:id` | — | 위 항목 + `card`, `version`, `matchId`, `treatmentType`, `difficulty`, `difficultyReason` |
| `PATCH /requests/:id` | `{ regions?, timing?, budget? }` | `open`일 때만. `version` +1 → 기존 응답은 “이전 조건” 표시 |
| `POST /requests/:id/close` | — | → `cancelled`, 시안 즉시 비공개, 응답자에게 마감 알림 |
| `POST /requests/:id/reopen` | `{ regions?, timing?, budget? }` | `expired`이고 응답 0개일 때만. → `open`, 마감 다시 +7일 ([조건 바꿔 다시 올리기] [지역 넓히기]) |

### `GET /requests/:id/responses` · C-03 (WF-8)

정렬: `?sort=price_asc` / `temperature_desc` / `works_desc`

```ts
interface ResponseCard {
  id: string;
  availability: 'possible' | 'conditional'; condition: string | null;
  priceMin: number; priceMax: number;    // 원
  comment: string;                       // ≤ 50자
  isOutdated: boolean;                   // 요청 수정 전 조건에 대한 응답
  status: 'pending' | 'accepted' | 'not_selected';
  createdAt: string;
  designer: { id: string; nickname: string; shopName: string; area: string;
              temperature: number; verifiedWorkCount: number };
}
```

예약 링크는 목록에 넣지 않고 수락 응답에서만 내려줍니다. 수락 없이 바로 예약하면 완료 확인·후기 흐름이 끊기기 때문입니다.

### `POST /responses/:id/accept` · C-05 (WF-10)

→ 201 `{ matchId, bookingUrl }`

- 요청 `open` → `matched`, 이 응답 `accepted`, 나머지 `not_selected` + 마감 알림, 수락된 디자이너에게 `accepted` 알림
- 요청이 `open`이 아니면 409 `invalid_state`

### 디자이너 프로필 · C-04 (WF-9)

| API | 응답 |
| --- | --- |
| `GET /designers/:id` | `{ id, nickname, verified, shopName, area, instagram, temperature, reviewCount, verifiedWorkCount, manualWorkCount }` |
| `GET /designers/:id/portfolio` | `?source=verified` / `manual`, `&similarToMe=true` → `{ items: [{ id, source, styleTag, treatmentType, beforeCard, designImageUrl, resultImageUrl, hairTags, completedAt }] }` |
| `GET /designers/:id/reviews` | 손님이 쓴 후기만. `{ items: [{ manner, promiseKept, satisfaction, text, createdAt }] }` |

- `beforeCard`는 사진이 아니라 카드 스냅샷의 모발 정보입니다(클라이언트가 카드로 그림)
- `similarToMe`는 로그인한 손님의 서버 모발 프로필로 `hairTags`를 걸러냅니다
- `verifiedWorkCount`는 완료된 매칭 수입니다. 사진 공개에 동의하지 않았거나 자동 완료된 건도 세므로, 포트폴리오에 보이는 인증 작업물 수보다 클 수 있습니다

### 시술 완료 확인 · C-06 (WF-11)

| API | 요청 | 응답 · 규칙 |
| --- | --- | --- |
| `GET /matches/:id` | — | `{ id, status, myRole, request, response, designer, customer, acceptedAt, completeRequestedAt, confirmDeadline, autoCompleted, designerResultImageUrls, customerResultImageUrls, profilePreview, myReviewWritten, reviewDeadline }`. `profilePreview { before, after, changes }`는 손님에게만, 디자이너는 `null` |
| `POST /matches/:id/confirm` | `{ resultImageKeys?: string[] (≤2: 정면, 옆·뒤), portfolioConsent: boolean }` | `complete_requested`일 때만. → `completed`, 모발 프로필 갱신, 동의 시 인증 작업물 생성, 시안 비공개. 응답 `{ status, hairProfile }` |
| `POST /matches/:id/dispute` | `{ reason: 'not_done' / 'different', note? }` | [아니에요] → `disputed`. 요청도 `cancelled`로 종료, 후기 불가 |

디자이너의 완료 요청 후 7일 동안 손님이 확인하지 않으면 배치가 자동 완료합니다. 이때는 손님 확인이 없으므로 모발 프로필을 갱신하지 않고 포트폴리오에도 공개하지 않습니다(작업물 수에는 셈).

### `POST /matches/:id/reviews` · C-07 (WF-12), D-04

양쪽 공통이고, 작성자 역할은 토큰으로 판단합니다.

```ts
// 손님 → 디자이너
{ satisfaction: 'good' | 'ok' | 'bad';     // 시술 결과 만족도 → 디자이너 온도 반영
  manner?: 'bad' | 'ok' | 'good';          // 응대 → 후기에만 표시
  promiseKept?: 'yes' | 'partly' | 'no';   // 응답한 내용·가격 이행 → 후기에만 표시
  text?: string }                          // ≤ 100자
// 디자이너 → 손님
{ promiseKept: 'yes' | 'partly' | 'no' }   // 'no' = 노쇼 → 손님 온도 반영
// res 201 { reviewId, targetTemperature }
```

매칭이 `completed`일 때만, 완료(자동 완료 포함) 후 7일 안에 역할당 1회입니다. 두 번째는 409 `already_responded`.

온도 반영값: 손님 → 디자이너 `satisfaction`은 good +0.5 · ok 0 · bad −1.0, 디자이너 → 손님 `promiseKept`는 yes +0.2 · partly 0 · no(노쇼) −1.0입니다. 시작값 36.5이고 0~99.9로 제한합니다.

## 디자이너 · 알림 · 신고

디자이너 API는 면허 인증을 신청해 `designer_profiles`가 있는 사용자만 통과하고, 응답·시안 열람은 `verifyStatus = verified`까지 확인합니다. 한 계정이 손님·디자이너를 겸할 수 있어서, 자기 요청에는 응답할 수 없습니다(403 `forbidden`). 인증 대기·반려 디자이너는 게시판 목록만 볼 수 있고, 새 요청 알림은 받지 않습니다.

### 가입 · 면허 인증 · D-01 (WF-D1)

| API | 요청 | 응답 · 규칙 |
| --- | --- | --- |
| `POST /designers/verification` | `{ licenseImageKey, name, licenseNumber, regions (1~2), shopName, bookingUrl, instagram? }` | 202 `{ verifyStatus: 'pending' }`. `licenseNumber`·`name`은 대조에만 쓰고 저장 안 함. `rejected`일 때 재제출 가능 |
| `GET /designers/verification` | — | `{ verifyStatus, rejectReason?, submittedAt, decidedAt? }` |
| `PATCH /designers/me` | `{ regions?, shopName?, bookingUrl?, instagram? }` | `bookingUrl`은 https만. 활동 지역 최대 2곳 |

승인은 관리자 화면 없이 DB에서 `verify_status`를 직접 바꿉니다. 시연용 인증 디자이너 계정은 시드 데이터로 넣습니다.

### 지역 요청 게시판 · D-02 (WF-D2)

`GET /board?region=&treatment=&difficulty=&budget=&sort=newest|fewest_responses&cursor=`

- `region`을 비우면 내 활동 지역 전체, 활동 지역 밖의 값은 422
- `budget` 필터는 예산 미정(디자이너 제안) 요청도 함께 보여줌
- `status = open`이고 마감 전인 요청만 나옴

```ts
interface BoardItem {         // 공개 필드만 — 이미지 URL 없음 (화면엔 “시안 인증 후”)
  id: string; styleTag: string;
  treatmentType: 'cut' | 'perm' | 'color' | 'bleach'; difficulty: 'low' | 'medium' | 'high';
  hairTags: string[];         // ['중단발', '반곱슬', '손상도 3', '최근 3개월 염색']
  budget: string | null; timing: string; regions: string[];
  expiresAt: string; responseCount: number; myResponded: boolean;
}
```

### 요청 상세 · 응답 · D-03 (WF-D3)

| API | 요청 | 응답 · 규칙 |
| --- | --- | --- |
| `GET /board/:requestId` | — | `BoardItem` + `card { profile, requestText, riskWarnings }` + `status` + `designImageUrl` (인증 디자이너만, 나머지는 `null`) + `myResponse?`. 마감·취소·매칭된 요청은 응답했던 디자이너만 볼 수 있음 |
| `POST /requests/:id/responses` | `{ availability: 'possible' / 'conditional', condition?, priceMin, priceMax, comment }` | 201 `{ id }`. `conditional`이면 `condition` 필수, `comment` ≤ 50자, `priceMin ≤ priceMax`. 프로필에 예약 링크 없으면 422 `validation_failed`(`fields.bookingUrl`). 403 `not_verified`, 409 `already_responded`, 410 `request_closed` |

### 알림 조건 · D-02

`GET` / `PUT /designers/me/alert-settings`

```ts
{ enabled: boolean;
  regions: string[];          // 활동 지역 안에서만. 지역 전체 알림 없음
  treatmentTypes: string[]; difficulties: string[]; budgets: string[] }  // 빈 배열 = 전부
```

### 내 응답 · 진행 관리 · D-04 (WF-D4)

| API | 요청 | 응답 · 규칙 |
| --- | --- | --- |
| `GET /designers/me/responses` | `?tab=pending` / `in_progress` / `done` | `{ items: [{ response, request: { id, styleTag, treatmentType }, match?: { id, status, acceptedAt, confirmDeadline }, canRequestComplete, canReview }] }`. 미수락·마감은 `done`에 기록만 |
| `POST /matches/:id/complete` | `{ resultImageKeys?: string[] }` | `accepted`일 때만. → `complete_requested`, `confirmDeadline` = +7일 (지나면 자동 completed), 손님에게 알림 |

### 포트폴리오 직접 올리기 · D-05 (확장, 아직 구현 안 함)

- `POST /designers/me/portfolio` `{ resultImageKey, styleTag, treatmentType, hairTags (1개 이상 필수) }`
- `DELETE /designers/me/portfolio/:itemId`
- 인증 작업물은 완료 확인 때 자동 생성되므로 API가 따로 없음

### 알림 · X-01

- `GET /notifications?unreadOnly=true&cursor=` → `{ items: [{ id, type, payload, readAt, createdAt }], nextCursor, unreadCount }`
- `POST /notifications/read` `{ ids? }` → 204 (비우면 전체 읽음)

| type | 받는 사람 | 만드는 곳 |
| --- | --- | --- |
| `new_matching_request` | 디자이너 | `POST /requests` (인증 디자이너 + 알림 조건 일치만) |
| `new_response` | 손님 | `POST /requests/:id/responses` |
| `accepted` | 디자이너 | `POST /responses/:id/accept` |
| `request_closed` | 디자이너 | 다른 응답 수락 · 요청 내림 · 마감 |
| `deadline_soon` | 손님 | 배치 (마감 24시간 안으로 들어온 뒤 첫 배치, 1회) |
| `complete_requested` | 손님 | `POST /matches/:id/complete` |
| `review_reminder` | 양쪽 | 배치 (완료 후 3일이 지나도 후기를 안 쓴 쪽에 1회, 후기 기한 7일 안) |
| `verification_result` | 디자이너 | 배치 (DB에서 승인·반려한 뒤 다음 배치 때. 면허 사진도 이때 삭제) |

### 신고 · X-02 (확장, 아직 구현 안 함)

`POST /reports` `{ targetType: 'response' | 'portfolio_item' | 'user', targetId, reason }` → 201

## 팀 결정 사항 (11/18 · 11/20)

| # | 항목 | 결정 | 반영한 곳 |
| --- | --- | --- | --- |
| 1 | WF-D3 ‘지금 모습’ 사진 | 삭제. 아래 모발 정보로 충분 | API·DB에 해당 필드 없음 |
| 2 | 시술 종류·난이도 | Gemini가 스타일·손상도·최근 약제 시술·밝기를 종합 산정 | `POST /requests` 응답, requests.difficulty_reason |
| 3 | 온도 | 디자이너 온도 = 손님의 시술 결과 만족도. 손님 온도 = 디자이너가 남긴 약속 이행(노쇼) | reviews, users.temperature |
| 4 | 면허 승인 | DB에서 직접 승인, 시연용 인증 디자이너는 시드 데이터 | 디자이너 섹션 |
| 5 | 손님·디자이너 겸업 | 허용. 디자이너 여부는 면허 인증(designer_profiles)으로 판단 | users.role 제거, `Me.designer`, 자기 요청 응답 금지 |
| 6 | 완료 요청 후 미확인·이의 | 이의 제기는 요청 종료. 손님이 7일 동안 확인하지 않으면 자동 완료 | matches.auto_completed, 배치, 상태 전이 |
| 7 | 동의 안 한 완료 건 | 작업물 수에 셈 | `verifiedWorkCount` = 완료 매칭 수 |
| 8 | 얼굴 가림 | 화면에서는 원본, 버킷에 올리는 사본만 가림. 디자이너도 가린 사본으로 봄 | `POST /uploads` (업로드 직전 MediaPipe) |
| 9 | 지역 형식 | ‘서울 동작구’ 문자열 | requests·designer_profiles.regions |
| 10 | 후기 기한 | 완료(자동 포함) 후 7일 | `POST /matches/:id/reviews` |
| 11 | 배치 주기 | (11/20) 하루 1회(03:00 KST) 유지. 마감·자동 완료는 API가 조회 때 직접 확인해 바로 반영 | `vercel.json` crons, 배치 설명 |
| 12 | 인증 대기 디자이너 | (11/20) 새 요청 알림을 받지 않음. 게시판 목록만 볼 수 있고 시안 열람·응답은 불가 | `new_matching_request` 대상, 디자이너 섹션 |

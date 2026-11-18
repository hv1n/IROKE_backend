# IROKE backend

IROKE의 백엔드입니다. Hono로 만든 API이고, 경로는 모두 `/api` 아래에 있습니다.
기존 모노레포([20233027-SHB/IROKE](https://github.com/20233027-SHB/IROKE))의 `server/`와 `shared/`를 단일 패키지로 옮겼고, 그 위에 v2 [디자이너 구하기] API를 구현했습니다.

- API 명세: [docs/api-v2.md](docs/api-v2.md)
- DB 구조: [docs/db-v2.md](docs/db-v2.md)

## 실행

```bash
npm install
cp .env.example .env   # 기본 AI_MODE=mock, DATA_MODE=memory → 외부 서비스 없이 전체가 돈다
npm run dev            # http://localhost:8787/api
npm test               # 단위·API 테스트 (vitest, memory 모드 + PGlite로 Postgres 구현체 검증)
npm run typecheck
```

### 로컬에서 로그인하기 (memory 모드)

memory 모드는 시연 계정 3명([db/seed.sql](db/seed.sql)과 같은 값)으로 시작합니다. 카카오 없이 다음처럼 토큰을 받을 수 있습니다.

```bash
curl -s localhost:8787/api/auth/dev -H 'content-type: application/json' -d '{"kakaoId":"seed-customer-1"}'
# seed-designer-1 · seed-designer-2 = 인증 디자이너, seed-customer-1 = 손님. 다른 값이면 새 사용자
```

- 이 경로(`POST /api/auth/dev`)는 `DATA_MODE=memory`이면서 production이 아닐 때만 열립니다.
- 이미지 업로드도 memory 모드에서는 이 서버의 `/api/dev/uploads`(서명 URL)로 받습니다.

## 환경 변수

자세한 설명은 [.env.example](.env.example)에 있습니다.

| 이름 | 기본값 | 설명 |
|---|---|---|
| `CORS_ORIGINS` | `https://iroke.vercel.app,http://localhost:5173` | 브라우저 호출을 허용할 출처 (쉼표 구분) |
| `AI_MODE` | `mock` | `mock`: 고정 분석 + 규칙 기반 난이도. `gemini`: 실제 분석·생성·난이도 산정 |
| `DATA_MODE` | `memory` | `memory`: 로컬·테스트용. `supabase`: Postgres + Storage |
| `JWT_SECRET` | (memory 로컬만 기본값) | 로그인 토큰 서명 키 |
| `JWT_TTL_SEC` | `604800` | 로그인 유지 시간(7일) |
| `KAKAO_REST_API_KEY` · `KAKAO_CLIENT_SECRET` | | 카카오 로그인 |
| `DATABASE_URL` | | Supabase transaction pooler 연결 문자열 (supabase 모드) |
| `SUPABASE_URL` · `SUPABASE_SERVICE_ROLE_KEY` · `SUPABASE_BUCKET` | `iroke-private` | Storage 비공개 버킷 (supabase 모드) |
| `CRON_SECRET` | | 배치 보호. 비우면 배치 호출 불가 |
| `PUBLIC_BASE_URL` | `http://localhost:$PORT` | memory 모드 서명 URL 주소 |
| `PROMPT_VERSION` · `GENERATION_DAILY_LIMIT` · `LOG_DIR` | | 시안 만들기 (기존). Vercel에서는 `LOG_DIR=/tmp/logs` |

## 구조

```
src/
├─ index.ts          Vercel 진입점 (export default app)
├─ dev.ts            로컬 실행 (@hono/node-server)
├─ createApp.ts      공통 미들웨어(CORS·본문 한도·에러) + 라우트 조립
├─ deps.ts           repo · storage · 시계 · 카카오 · 난이도 산정기 묶음 (테스트에서 바꿔 끼움)
├─ env.ts
├─ shared/           ← 프론트가 복사해 갈 폴더 (Node 의존 없음)
│  ├─ api.ts            시안 만들기 API 계약 + ApiErrorCode
│  ├─ api-v2.ts         디자이너 구하기 API 계약 (요청·응답 타입, 한도 상수)
│  ├─ types.ts          모발 프로필·분석 타입
│  └─ config/ prompt/ rules/   라벨, buildPrompt, 톤 규칙
├─ routes/           creation(기존 7개) · account · requests · designer · internal · dev
├─ services/         규칙: 상태 전이 · 늦은 만료 처리 · 공개 범위 · 알림 · hairTags · 난이도 · 배치
├─ http/             에러(ApiFail) · 권한 미들웨어 · 필드 검증 · 커서
├─ repo/             Repository 인터페이스 + memory · postgres 구현체 + 시드
├─ storage/          서명 업로드/보기 URL: memory · Supabase Storage
├─ auth/             카카오 토큰 교환 · JWT
└─ analysis/ providers/ lib/   Gemini 분석·생성 (기존)
db/
├─ migrations/001_v2.sql            테이블·제약·인덱스 (docs/db-v2.md)
├─ migrations/002_storage_bucket.sql  Supabase 비공개 버킷 (5MB, jpeg·png·webp)
└─ seed.sql                         시연용 인증 디자이너 2명 + 손님 1명
test/                엔드포인트별 테스트
```

## API

공통 규칙은 [docs/api-v2.md](docs/api-v2.md)의 "공통 규칙"을 따릅니다.

- **인증:** `Authorization: Bearer <accessToken>`
- **목록:** `?cursor=&limit=` → `{ items, nextCursor }`
- **에러:** `{ error, code, fields? }`

### 시안 만들기 (로그인·DB 없음, `x-iroke-client-id`)

| 엔드포인트 | 설명 |
|---|---|
| `GET /api/health` · `GET /api/status` | 상태 확인, AI 모드·프롬프트 버전 |
| `POST /api/analysis/hair` | 셀카 → 기장·모질·숱·손상도·명도 추정 |
| `POST /api/analysis/style` | 레퍼런스 → 스타일명 3개 + 비슷한 스타일 최대 4개 (`similarStyles`) |
| `POST /api/profile-confirmations` | 확정 프로필 기록 |
| `POST /api/generations` | 시안 생성. `styleSource.chosen = 'similar'`이면 레퍼런스 없이 `styleDescription`으로 |
| `PATCH /api/generations/:id` | 클라이언트 end-to-end 시간 기록 |

### 디자이너 구하기 (v2)

| 엔드포인트 | 권한 | 설명 |
|---|---|---|
| `POST /api/auth/kakao` | 공개 | 카카오 인가 코드 → JWT |
| `POST /api/auth/logout` | 로그인 | 204 |
| `GET /api/me` | 로그인 | 내 정보 (`designer`는 면허 인증 신청자만) |
| `POST /api/uploads` | 로그인 | 서명 업로드 URL 발급 → PUT → `key` |
| `POST /api/requests` | 로그인 | 요청 등록 (시술 종류·난이도 서버 산정, 마감 +7일) |
| `GET /api/requests/mine` | 로그인 | `?status=open\|matched\|closed` |
| `GET·PATCH /api/requests/:id` | 본인 | 상세 · 조건 수정(version +1) |
| `POST /api/requests/:id/close` · `/reopen` | 본인 | 내리기 · 다시 올리기 |
| `GET /api/requests/:id/responses` | 본인 | `?sort=price_asc\|temperature_desc\|works_desc` |
| `POST /api/responses/:id/accept` | 본인 | 수락 → `{ matchId, bookingUrl }` |
| `GET /api/board` | 디자이너 | `?region=&treatment=&difficulty=&budget=&sort=newest\|fewest_responses` |
| `GET /api/board/:requestId` | 디자이너 | 시안 URL은 인증 디자이너만 |
| `POST /api/requests/:id/responses` | 인증 디자이너 | 응답 (요청당 1회) |
| `GET·PUT /api/designers/me/alert-settings` | 디자이너 | 알림 조건 |
| `GET·PUT /api/me/hair-profile` | 로그인 | 서버 모발 프로필 (완료 확인 때 자동 갱신) |
| `GET /api/designers/:id` · `/portfolio` · `/reviews` | 로그인 | 디자이너 프로필 · 포트폴리오(`?source=&similarToMe=true`) · 손님 후기 |
| `GET /api/matches/:id` | 당사자 | 매칭 상세 (손님에게 모발 프로필 미리보기) |
| `POST /api/matches/:id/complete` | 담당 디자이너 | 완료 요청 → 손님 확인 기한 +7일 |
| `POST /api/matches/:id/confirm` · `/dispute` | 손님 | 완료 확인(모발 프로필 갱신·작업물) · [아니에요] |
| `POST /api/matches/:id/reviews` | 당사자 | 후기 (완료 후 7일, 역할당 1회) → 온도 반영 |
| `POST·GET /api/designers/verification` | 로그인 | 면허 인증 신청(202) · 상태 |
| `PATCH /api/designers/me` | 디자이너 | 활동 지역 · 샵 · 예약 링크 · 인스타 |
| `GET /api/designers/me/responses` | 디자이너 | `?tab=pending\|in_progress\|done` |
| `GET /api/notifications` · `POST /api/notifications/read` | 로그인 | 알림 목록·안 읽은 수 · 읽음 처리 |
| `GET·POST /api/internal/jobs/sweep` | `Bearer CRON_SECRET` | 배치: 만료 · 마감 D-1 알림 · 자동 완료 · 후기 리마인드 · 면허 결과 반영 · 고아 업로드 삭제 |

### 면허 승인 (관리자 화면 없음)

```sql
-- 승인
update designer_profiles set verify_status = 'verified', verified_at = now() where user_id = '<사용자 id>';
-- 반려
update designer_profiles set verify_status = 'rejected', reject_reason = '면허 사진이 흐려요', verified_at = now() where user_id = '<사용자 id>';
```

다음 배치 때 면허 사진이 삭제되고, 신청자에게 `verification_result` 알림이 갑니다.

### 온도

| 후기 | 반영 |
|---|---|
| 손님 → 디자이너 `satisfaction` | good +0.5 · ok 0 · bad −1.0 |
| 디자이너 → 손님 `promiseKept` | yes +0.2 · partly 0 · no(노쇼) −1.0 |

시작값은 36.5이고, 0~99.9 사이로 제한됩니다. 수치는 [src/services/matches.ts](src/services/matches.ts)의 `TEMPERATURE_DELTA`에 있습니다.

## 배포 (Vercel)

이 저장소를 별도 Vercel 프로젝트로 연결합니다.

- Framework는 Hono이고, 진입점은 `src/index.ts`입니다.
- 배치는 [vercel.json](vercel.json)의 `crons`로 매일 03:00 KST에 돕니다. Hobby 플랜은 하루 1회가 한도입니다. 만료는 API 호출 때도 다시 확인하므로, 배치가 늦어도 오동작은 없습니다.

## 정책

- 셀카 원본은 저장하지 않습니다. 버킷에는 얼굴을 가린 시안·결과 사본만 올라갑니다.
- 연락처(전화·이메일·카카오 ID)는 어떤 응답에도 넣지 않습니다. 예약 링크는 수락 응답에서만 내려줍니다.
- 이벤트 로그(JSONL)에는 사진·개인정보를 기록하지 않습니다.
- `.env`와 키는 커밋하지 않습니다.

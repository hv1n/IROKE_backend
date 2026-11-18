# IROKE backend

IROKE의 백엔드입니다. Hono로 만든 API이고, 경로는 모두 `/api` 아래에 있습니다.
기존 모노레포([20233027-SHB/IROKE](https://github.com/20233027-SHB/IROKE))의 `server/`와 `shared/`를 단일 패키지로 옮겼고, 그 위에 v2 [디자이너 구하기] API를 구현하고 있습니다.

- API 명세: [docs/api-v2.md](docs/api-v2.md)
- DB 구조: [docs/db-v2.md](docs/db-v2.md)

## 실행

```bash
npm install
cp .env.example .env   # 기본 AI_MODE=mock (API 비용 없음)
npm run dev            # http://localhost:8787/api
npm test               # 단위·API 테스트 (vitest)
npm run typecheck
```

실제 분석·생성은 `.env`에서 `AI_MODE=gemini`로 바꾸고, 결제가 등록된 `GEMINI_API_KEY`를 넣어야 합니다.
키는 서버에만 있고, 브라우저는 이 API만 호출합니다.

## 환경 변수

설명은 [.env.example](.env.example)에 있습니다. 주요 값은 다음과 같습니다.

| 이름 | 기본값 | 설명 |
|---|---|---|
| `CORS_ORIGINS` | `https://iroke.vercel.app,http://localhost:5173` | 브라우저 호출을 허용할 출처 (쉼표로 구분) |
| `AI_MODE` | `mock` | `mock` 또는 `gemini` |
| `PROMPT_VERSION` | `v1` | 시안 프롬프트 버전 |
| `GENERATION_DAILY_LIMIT` | (없음) | 브라우저별 하루 시안 생성 횟수 |
| `LOG_DIR` | `logs` | 이벤트 로그(JSONL) 위치. Vercel에서는 `/tmp/logs` |

## 구조

```
src/
├─ index.ts        Vercel 진입점 (export default app)
├─ dev.ts          로컬 실행 (@hono/node-server)
├─ createApp.ts    미들웨어와 라우트 조립
├─ env.ts
├─ shared/         API 계약 타입, 모발 프로필 타입·라벨, buildPrompt, 톤 규칙 (Node 의존 없음, 프론트가 복사해 가는 폴더)
├─ analysis/       Gemini 모발 분석·스타일 추천 (+ mock)
├─ providers/      이미지 생성 provider (Gemini·Mock)
└─ lib/            요청 검증, 하루 생성 제한, JSONL 이벤트 로그
test/              엔드포인트 테스트
```

## API

### 시안 만들기 (로그인·DB 없음, `x-iroke-client-id` 헤더로 브라우저 구분)

| 엔드포인트 | 설명 |
|---|---|
| `GET /api/health` | 상태 확인 |
| `GET /api/status` | AI 모드, 프롬프트 버전 |
| `POST /api/analysis/hair` | 셀카 → 기장·모질·숱·손상도·명도 추정 (+확신도·근거) |
| `POST /api/analysis/style` | 레퍼런스 → 스타일명 3개 추천 + 비슷한 스타일 최대 4개 (`similarStyles`) |
| `POST /api/profile-confirmations` | 확정 프로필 기록 (AI 원본 + `editedFields`) |
| `POST /api/generations` | 시안 생성. `styleSource.chosen = 'similar'`이면 레퍼런스 없이 `styleDescription`으로 생성 |
| `PATCH /api/generations/:id` | 클라이언트 end-to-end 시간 기록 |

## 배포 (Vercel)

이 저장소를 별도 Vercel 프로젝트로 연결합니다. Framework는 Hono이고, 진입점은 `src/index.ts`입니다.
`.env.example`의 값을 Vercel 프로젝트 Environment Variables에 등록해야 합니다.

## 정책

- 셀카는 서버에 저장하지 않습니다. 이벤트 로그(JSONL)에도 사진과 개인정보는 기록하지 않습니다.
- `.env`와 키는 커밋하지 않습니다.

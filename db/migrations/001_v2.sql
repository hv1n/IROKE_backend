-- IROKE v2 [디자이너 구하기] 스키마 — docs/db-v2.md (2026-11-18) 그대로
-- 상태값은 Postgres enum 대신 text + CHECK. 서버가 서비스 키로만 접근하므로 RLS는 켜되 정책은 두지 않는다
-- (anon·authenticated 키로는 아무것도 읽고 쓸 수 없음).
-- 이미지 컬럼(…_key)은 비공개 버킷의 key이고, 모두 얼굴을 가린 사본이다.

begin;

create table users (
  id          uuid primary key default gen_random_uuid(),
  kakao_id    text not null unique,
  nickname    text not null,
  -- 디자이너: 손님의 결과 만족도, 손님: 디자이너가 남긴 약속 이행(노쇼)으로 계산
  temperature numeric(4,1) not null default 36.5,
  created_at  timestamptz not null default now()
);

create table designer_profiles (
  user_id           uuid primary key references users(id) on delete cascade,
  verify_status     text not null default 'pending' check (verify_status in ('pending', 'verified', 'rejected')),
  reject_reason     text,
  -- 승인·반려 후 삭제 (면허 번호 컬럼은 없음)
  license_image_key text,
  submitted_at      timestamptz,
  verified_at       timestamptz,
  -- '서울 동작구' 형식 문자열 1~2개
  regions           text[] not null default '{}' check (cardinality(regions) <= 2),
  shop_name         text,
  booking_url       text check (booking_url is null or booking_url like 'https://%'),
  instagram         text,
  -- { enabled, regions, treatmentTypes, difficulties, budgets }
  alert_settings    jsonb
);

create table hair_profiles (
  user_id    uuid primary key references users(id) on delete cascade,
  length     text not null check (length in ('short', 'bob', 'medium', 'long')),
  texture    text not null check (texture in ('straight', 'wavy', 'curly')),
  density    text not null check (density in ('low', 'medium', 'high')),
  damage     smallint not null check (damage between 1 and 5),
  -- 현재 밝기
  level      smallint check (level between 1 and 10),
  -- [{ type, date }] 시술 이력
  history    jsonb not null default '[]',
  -- { editedFields, confirmedAt }
  source     jsonb,
  updated_by text not null default 'user' check (updated_by in ('user', 'match')),
  updated_at timestamptz not null default now()
);

create table requests (
  id                uuid primary key default gen_random_uuid(),
  customer_id       uuid not null references users(id),
  -- styleTag·styleSource·profile·requestText·riskWarnings
  card_snapshot     jsonb not null,
  -- 목록·검색용 복사본
  style_tag         text not null,
  treatment_type    text not null check (treatment_type in ('cut', 'perm', 'color', 'bleach')),
  difficulty        text not null check (difficulty in ('low', 'medium', 'high')),
  difficulty_reason text not null default '',
  hair_tags         text[] not null default '{}',
  design_image_key  text not null,
  -- 마감·취소·완료 때 채움 → 서명 URL 발급 중단
  design_hidden_at  timestamptz,
  -- "인증 디자이너에게 시안 공개" 동의 시각
  design_consent_at timestamptz not null,
  regions           text[] not null check (cardinality(regions) between 1 and 2),
  timing            text not null check (timing in ('this_week', 'within_2_weeks', 'within_month', 'any')),
  -- null = 디자이너 제안
  budget            text check (budget in ('under_5', '5_10', '10_15', 'over_15')),
  status            text not null default 'open' check (status in ('open', 'matched', 'completed', 'expired', 'cancelled')),
  version           int not null default 1,
  expires_at        timestamptz not null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create table responses (
  id              uuid primary key default gen_random_uuid(),
  request_id      uuid not null references requests(id) on delete cascade,
  designer_id     uuid not null references users(id),
  availability    text not null check (availability in ('possible', 'conditional')),
  condition       text,
  price_min       int not null check (price_min >= 0),
  price_max       int not null,
  comment         varchar(50) not null default '',
  -- 응답 당시 요청 version ("이전 조건" 판단)
  request_version int not null,
  status          text not null default 'pending' check (status in ('pending', 'accepted', 'not_selected')),
  created_at      timestamptz not null default now(),
  constraint responses_condition_required check (availability <> 'conditional' or condition is not null),
  constraint responses_price_range check (price_min <= price_max),
  constraint responses_request_id_designer_id_key unique (request_id, designer_id)
);

create table matches (
  id                    uuid primary key default gen_random_uuid(),
  request_id            uuid not null unique references requests(id),
  response_id           uuid not null unique references responses(id),
  -- 조회용 중복
  customer_id           uuid not null references users(id),
  designer_id           uuid not null references users(id),
  status                text not null default 'accepted' check (status in ('accepted', 'complete_requested', 'completed', 'disputed')),
  accepted_at           timestamptz not null default now(),
  complete_requested_at timestamptz,
  confirmed_at          timestamptz,
  -- complete_requested_at + 7일. 지나면 배치가 completed로 바꿈
  confirm_deadline      timestamptz,
  auto_completed        boolean not null default false,
  -- 완료 요청 때 디자이너가 첨부
  designer_result_keys  text[] not null default '{}',
  -- 완료 확인 때 손님이 올림 (정면, 옆·뒤 최대 2)
  customer_result_keys  text[] not null default '{}' check (cardinality(customer_result_keys) <= 2),
  portfolio_consent     boolean not null default false,
  -- 갱신 전후 모발 프로필 (히스토리·되돌리기용)
  profile_update        jsonb,
  dispute_reason        text
);

create table reviews (
  id           uuid primary key default gen_random_uuid(),
  match_id     uuid not null references matches(id),
  author_id    uuid not null references users(id),
  target_id    uuid not null references users(id),
  author_role  text not null check (author_role in ('customer', 'designer')),
  -- 후기 표시만
  manner       text check (manner in ('bad', 'ok', 'good')),
  -- 손님이 쓰면 후기 표시만, 디자이너가 쓰면 'no' = 노쇼로 손님 온도 반영
  promise_kept text check (promise_kept in ('yes', 'partly', 'no')),
  -- 손님만 작성, 디자이너 온도 반영
  satisfaction text check (satisfaction in ('good', 'ok', 'bad')),
  text         varchar(100),
  created_at   timestamptz not null default now(),
  constraint reviews_match_id_author_role_key unique (match_id, author_role)
);

create table portfolio_items (
  id             uuid primary key default gen_random_uuid(),
  designer_id    uuid not null references users(id),
  -- 인증 작업물만
  match_id       uuid unique references matches(id),
  source         text not null check (source in ('verified', 'manual')),
  style_tag      text,
  treatment_type text check (treatment_type in ('cut', 'perm', 'color', 'bleach')),
  -- 인증 작업물의 시술 전 카드(모발 정보)
  before_card    jsonb,
  design_key     text,
  result_key     text,
  -- 직접 올림은 1개 이상
  hair_tags      text[] not null default '{}' check (source <> 'manual' or cardinality(hair_tags) >= 1),
  created_at     timestamptz not null default now()
);

create table notifications (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references users(id) on delete cascade,
  type       text not null check (type in (
    'new_matching_request', 'new_response', 'accepted', 'request_closed',
    'deadline_soon', 'complete_requested', 'review_reminder', 'verification_result'
  )),
  payload    jsonb not null default '{}',
  read_at    timestamptz,
  created_at timestamptz not null default now()
);

-- 확장 (X-02)
create table reports (
  id          uuid primary key default gen_random_uuid(),
  reporter_id uuid not null references users(id),
  target_type text not null check (target_type in ('response', 'portfolio_item', 'user')),
  target_id   uuid not null,
  reason      text not null,
  status      text not null default 'open' check (status in ('open', 'resolved')),
  created_at  timestamptz not null default now()
);

-- 인덱스 (docs/db-v2.md)
create index requests_status_expires_at_idx on requests (status, expires_at);
create index requests_regions_idx on requests using gin (regions);
create index requests_customer_id_created_at_idx on requests (customer_id, created_at desc);
create index responses_designer_id_created_at_idx on responses (designer_id, created_at desc);
create index matches_designer_id_status_idx on matches (designer_id, status);
create index matches_customer_id_status_idx on matches (customer_id, status);
create index reviews_target_id_idx on reviews (target_id);
create index portfolio_items_designer_id_source_idx on portfolio_items (designer_id, source);
create index portfolio_items_hair_tags_idx on portfolio_items using gin (hair_tags);
create index notifications_user_id_created_at_unread_idx on notifications (user_id, created_at desc) where read_at is null;

-- 서버(서비스 키·postgres 역할)만 접근. Supabase의 anon/authenticated 키로는 접근 불가.
alter table users enable row level security;
alter table designer_profiles enable row level security;
alter table hair_profiles enable row level security;
alter table requests enable row level security;
alter table responses enable row level security;
alter table matches enable row level security;
alter table reviews enable row level security;
alter table portfolio_items enable row level security;
alter table notifications enable row level security;
alter table reports enable row level security;

commit;

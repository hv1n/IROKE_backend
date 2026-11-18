-- 시연용 시드: 인증 디자이너 2명 + 손님 1명 (src/repo/seed.ts와 같은 값)
-- 면허 승인은 관리자 화면 없이 DB에서 verify_status를 직접 바꾼다. 시연 디자이너는 처음부터 verified.
-- kakao_id가 'seed-'로 시작하는 계정은 실제 카카오 계정과 겹치지 않는다 (카카오 회원번호는 숫자).

begin;

insert into users (id, kakao_id, nickname, temperature, created_at) values
  ('a0000000-0000-4000-8000-000000000001', 'seed-designer-1', '서윤 디자이너', 37.2, '2026-11-01T00:00:00Z'),
  ('a0000000-0000-4000-8000-000000000002', 'seed-designer-2', '도현 디자이너', 36.8, '2026-11-01T00:00:00Z'),
  ('c0000000-0000-4000-8000-000000000001', 'seed-customer-1', '하린', 36.5, '2026-11-01T00:00:00Z')
on conflict (id) do nothing;

insert into designer_profiles
  (user_id, verify_status, submitted_at, verified_at, regions, shop_name, booking_url, instagram, alert_settings) values
  ('a0000000-0000-4000-8000-000000000001', 'verified', '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z',
   array['서울 동작구', '서울 관악구'], '이로케 시연 살롱 상도점', 'https://example.com/booking/iroke-demo-1', null,
   '{"enabled": true, "regions": [], "treatmentTypes": [], "difficulties": [], "budgets": []}'),
  ('a0000000-0000-4000-8000-000000000002', 'verified', '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z',
   array['서울 마포구', '서울 동작구'], '이로케 시연 살롱 합정점', 'https://example.com/booking/iroke-demo-2', null,
   '{"enabled": true, "regions": [], "treatmentTypes": [], "difficulties": [], "budgets": []}')
on conflict (user_id) do nothing;

insert into hair_profiles (user_id, length, texture, density, damage, level, history, source, updated_by, updated_at) values
  ('c0000000-0000-4000-8000-000000000001', 'medium', 'wavy', 'medium', 3, 5,
   '[{"type": "color", "date": "2026-09-20"}]',
   '{"editedFields": [], "confirmedAt": "2026-11-01T00:00:00.000Z"}', 'user', '2026-11-01T00:00:00Z')
on conflict (user_id) do nothing;

commit;

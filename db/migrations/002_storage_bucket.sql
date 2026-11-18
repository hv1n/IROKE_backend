-- Supabase Storage 비공개 버킷 (Supabase 전용 — storage 스키마가 있어야 함)
-- 업로드 한도 5MB, 이미지 3종만. 이름은 env SUPABASE_BUCKET과 같아야 한다 (기본 iroke-private).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('iroke-private', 'iroke-private', false, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

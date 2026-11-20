// Supabase Storage 비공개 버킷 (DATA_MODE=supabase). 서비스 키는 서버에만 있다.
// 버킷의 크기 한도(5MB)·허용 형식은 db/migrations/002_storage_bucket.sql에서 건다
// (서명 업로드 URL 자체에는 크기 제한을 걸 수 없어서).
import { createClient } from '@supabase/supabase-js';
import type { Sql } from 'postgres';
import type { ImageStorage } from './types.js';

/** Supabase 서명 업로드 URL 유효 시간 (Supabase 고정값 2시간) */
const SIGNED_UPLOAD_TTL_MS = 2 * 60 * 60 * 1000;

export function createSupabaseStorage(opts: { url: string; serviceRoleKey: string; bucket: string; sql: Sql }): ImageStorage {
  const client = createClient(opts.url, opts.serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const bucket = () => client.storage.from(opts.bucket);

  return {
    kind: 'supabase',
    async createUploadUrl(key) {
      const { data, error } = await bucket().createSignedUploadUrl(key, { upsert: false });
      if (error) throw error;
      return { uploadUrl: data.signedUrl, expiresAt: new Date(Date.now() + SIGNED_UPLOAD_TTL_MS) };
    },
    async exists(key) {
      const { data, error } = await bucket().exists(key);
      if (error && (error as { status?: number }).status !== 400 && (error as { status?: number }).status !== 404) throw error;
      return Boolean(data);
    },
    async signedUrls(keys, ttlSec) {
      const out = new Map<string, string>();
      const unique = [...new Set(keys)];
      if (!unique.length) return out;
      const { data, error } = await bucket().createSignedUrls(unique, ttlSec);
      if (error) throw error;
      for (const item of data) if (item.path && item.signedUrl && !item.error) out.set(item.path, item.signedUrl);
      return out;
    },
    async remove(keys) {
      if (!keys.length) return;
      const { error } = await bucket().remove(keys);
      if (error) throw error;
    },
    async listUploadedBefore(before, limit) {
      // Storage API의 list는 폴더 단위라, 같은 DB의 storage.objects를 직접 본다 (읽기만)
      const rows = await opts.sql`
        select name from storage.objects
        where bucket_id = ${opts.bucket} and created_at < ${before}
        order by created_at limit ${limit}`;
      return rows.map((r) => r.name as string);
    },
  };
}

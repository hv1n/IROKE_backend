// 메모리 저장소 (DATA_MODE=memory). Supabase 서명 URL 흐름을 흉내 낸다.
// 업로드: PUT {baseUrl}/api/dev/uploads?key=&exp=&sig=   보기: GET {baseUrl}/api/dev/files?key=&exp=&sig=
// 서명은 HMAC-SHA256(secret, 용도|key|만료|제한). 이 경로는 memory 모드에서만 열린다(routes/dev.ts).
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { UploadContentType } from '../shared/api-v2.js';
import type { ImageStorage } from './types.js';

interface StoredObject {
  data: Buffer;
  contentType: string;
  createdAt: Date;
}

export interface MemoryStorage extends ImageStorage {
  readonly kind: 'memory';
  /** dev 업로드 경로에서 호출. 서명·만료·형식·크기를 확인하고 저장한다 */
  acceptUpload(q: { key: string; exp: string; ct: string; max: string; sig: string }, contentType: string, data: Buffer): 'ok' | 'bad_signature' | 'expired' | 'bad_type' | 'too_large';
  /** dev 보기 경로에서 호출 */
  read(q: { key: string; exp: string; sig: string }): StoredObject | 'bad_signature' | 'expired' | 'not_found';
  /** 테스트용: 서명 업로드 URL 없이 바로 넣기 */
  put(key: string, contentType: string, data: Buffer, createdAt?: Date): void;
}

export function createMemoryStorage(opts: { baseUrl: string; secret: string; now?: () => Date; uploadTtlSec?: number }): MemoryStorage {
  const objects = new Map<string, StoredObject>();
  const now = opts.now ?? (() => new Date());
  const uploadTtlSec = opts.uploadTtlSec ?? 600;
  const sign = (...parts: string[]) => createHmac('sha256', opts.secret).update(parts.join('|')).digest('base64url');
  const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
  const base = opts.baseUrl.replace(/\/$/, '');

  return {
    kind: 'memory',
    async createUploadUrl(key: string, contentType: UploadContentType, maxBytes: number) {
      const expiresAt = new Date(now().getTime() + uploadTtlSec * 1000);
      const exp = String(Math.floor(expiresAt.getTime() / 1000));
      const qs = new URLSearchParams({ key, exp, ct: contentType, max: String(maxBytes), sig: sign('put', key, exp, contentType, String(maxBytes)) });
      return { uploadUrl: `${base}/api/dev/uploads?${qs}`, expiresAt };
    },
    async exists(key) {
      return objects.has(key);
    },
    async signedUrls(keys, ttlSec) {
      const exp = String(Math.floor(now().getTime() / 1000) + ttlSec);
      const out = new Map<string, string>();
      for (const key of keys) {
        if (!objects.has(key)) continue;
        const qs = new URLSearchParams({ key, exp, sig: sign('get', key, exp) });
        out.set(key, `${base}/api/dev/files?${qs}`);
      }
      return out;
    },
    async remove(keys) {
      for (const k of keys) objects.delete(k);
    },
    async listUploadedBefore(before, limit) {
      return [...objects.entries()].filter(([, o]) => o.createdAt < before).slice(0, limit).map(([k]) => k);
    },
    acceptUpload(q, contentType, data) {
      if (!q.sig || !same(q.sig, sign('put', q.key, q.exp, q.ct, q.max))) return 'bad_signature';
      if (Number(q.exp) * 1000 < now().getTime()) return 'expired';
      if (contentType.split(';')[0]!.trim() !== q.ct) return 'bad_type';
      if (data.length === 0 || data.length > Number(q.max)) return 'too_large';
      objects.set(q.key, { data, contentType: q.ct, createdAt: now() });
      return 'ok';
    },
    read(q) {
      if (!q.sig || !same(q.sig, sign('get', q.key, q.exp))) return 'bad_signature';
      if (Number(q.exp) * 1000 < now().getTime()) return 'expired';
      return objects.get(q.key) ?? 'not_found';
    },
    put(key, contentType, data, createdAt) {
      objects.set(key, { data, contentType, createdAt: createdAt ?? now() });
    },
  };
}

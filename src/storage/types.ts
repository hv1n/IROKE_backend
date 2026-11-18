// 비공개 이미지 저장소. 클라이언트는 서명 업로드 URL에 직접 PUT하고(Vercel 본문 4.5MB 제한 회피),
// 보기는 10분짜리 서명 URL로만 한다. 버킷 자체는 비공개.
import type { UploadContentType } from '../shared/api-v2';

export interface ImageStorage {
  readonly kind: 'memory' | 'supabase';
  /** key에 한 번 올릴 수 있는 서명 업로드 URL */
  createUploadUrl(key: string, contentType: UploadContentType, maxBytes: number): Promise<{ uploadUrl: string; expiresAt: Date }>;
  /** 실제로 올라가 있는지 */
  exists(key: string): Promise<boolean>;
  /** 보기용 서명 URL (key → URL). 없는 key는 빠진다 */
  signedUrls(keys: string[], ttlSec: number): Promise<Map<string, string>>;
  remove(keys: string[]): Promise<void>;
  /** before 이전에 올라온 객체 key (고아 업로드 정리용) */
  listUploadedBefore(before: Date, limit: number): Promise<string[]>;
}

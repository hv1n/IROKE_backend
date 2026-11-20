// v2 API 필드 검증. 규칙 위반은 422 validation_failed + fields(필드명 → 메시지)로 모아서 돌려준다.
import { MARKETPLACE_LIMITS } from '../shared/index.js';
import { ApiFail } from './errors.js';

export const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** 필드 오류 모음. 한 번에 여러 항목을 안내한다 */
export class FieldErrors {
  readonly errors: Record<string, string> = {};
  add(field: string, message: string) {
    this.errors[field] ??= message;
  }
  get any() {
    return Object.keys(this.errors).length > 0;
  }
  throwIfAny() {
    if (this.any) throw new ApiFail(422, 'validation_failed', '입력값을 확인해 주세요', this.errors);
  }
}

export function oneOf<T extends string>(v: unknown, list: readonly T[], field: string, e: FieldErrors): T | undefined {
  if (typeof v === 'string' && (list as readonly string[]).includes(v)) return v as T;
  e.add(field, `${list.join(' | ')} 중 하나`);
  return undefined;
}

/** 쿼리 파라미터 enum (비면 undefined) */
export function optionalOneOf<T extends string>(v: string | undefined, list: readonly T[], field: string, e: FieldErrors): T | undefined {
  if (v == null || v === '') return undefined;
  return oneOf(v, list, field, e);
}

/** 짧은 텍스트: 제어문자 제거·공백 정리. allowEmpty가 아니면 비면 오류 */
export function text(v: unknown, field: string, max: number, e: FieldErrors, opts: { allowEmpty?: boolean } = {}): string | undefined {
  if (typeof v !== 'string') {
    e.add(field, '문자열이어야 함');
    return undefined;
  }
  const t = v.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim();
  if (!t && !opts.allowEmpty) e.add(field, '비어 있음');
  else if ([...t].length > max) e.add(field, `${max}자 이하`);
  else return t;
  return undefined;
}

/** '서울 동작구'처럼 '시·도 시·군·구' (공백으로 나뉜 2단어 이상) */
const REGION = /^[가-힣A-Za-z0-9]+( [가-힣A-Za-z0-9]+){1,3}$/;

export function regions(v: unknown, field: string, e: FieldErrors): string[] | undefined {
  if (!Array.isArray(v) || v.length < 1 || v.length > MARKETPLACE_LIMITS.regionsMax) {
    e.add(field, `지역은 1~${MARKETPLACE_LIMITS.regionsMax}곳`);
    return undefined;
  }
  const out = v.map((r) => (typeof r === 'string' ? r.trim().replace(/\s+/g, ' ') : ''));
  if (out.some((r) => !REGION.test(r) || r.length > 30)) {
    e.add(field, "'서울 동작구' 형식");
    return undefined;
  }
  if (new Set(out).size !== out.length) {
    e.add(field, '같은 지역이 중복됨');
    return undefined;
  }
  return out;
}

export function intIn(v: unknown, field: string, lo: number, hi: number, e: FieldErrors): number | undefined {
  if (Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi) return v as number;
  e.add(field, `${lo}~${hi} 정수`);
  return undefined;
}

/** https URL만 (예약 링크 등) */
export function httpsUrl(v: unknown, field: string, e: FieldErrors): string | undefined {
  if (typeof v === 'string') {
    try {
      const u = new URL(v.trim());
      if (u.protocol === 'https:' && v.length <= 500) return u.toString();
    } catch {
      // 아래에서 오류 처리
    }
  }
  e.add(field, 'https:// 로 시작하는 주소');
  return undefined;
}

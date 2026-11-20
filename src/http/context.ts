import type { Context } from 'hono';
import type { DesignerProfileRow } from '../repo/types.js';

export type AppEnv = {
  Variables: {
    /** 비로그인 브라우저 구분 (시안 만들기 흐름) */
    clientId: string;
    /** requireUser 통과 후 */
    userId: string;
    /** requireDesigner 통과 후 */
    designer: DesignerProfileRow;
  };
};

/** JSON 본문. 파싱 실패면 null (본문이 없어도 되는 API는 호출부에서 기본값 처리) */
export const readJson = (c: Context) => c.req.json<Record<string, unknown>>().catch(() => null);

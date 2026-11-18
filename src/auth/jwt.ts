// 자체 JWT (HS256). 무상태라 로그아웃은 클라이언트가 토큰을 버리는 것이 본체다.
import { sign, verify } from 'hono/jwt';

export async function issueToken(userId: string, secret: string, ttlSec: number, now: Date): Promise<string> {
  const iat = Math.floor(now.getTime() / 1000);
  return sign({ sub: userId, iat, exp: iat + ttlSec, typ: 'access' }, secret, 'HS256');
}

/** 유효하면 userId, 아니면 null (만료·서명 오류·형식 오류) */
export async function readToken(token: string, secret: string, now: Date): Promise<string | null> {
  try {
    // 시간 검사는 주입된 시계(now)로 직접 한다 (배치·테스트가 같은 시계를 쓰도록)
    const payload = await verify(token, secret, { alg: 'HS256', exp: false, iat: false, nbf: false });
    if (typeof payload.exp !== 'number' || payload.exp * 1000 <= now.getTime()) return null;
    return typeof payload.sub === 'string' && payload.typ === 'access' ? payload.sub : null;
  } catch {
    return null;
  }
}

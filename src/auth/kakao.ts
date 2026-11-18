// 카카오 로그인: 클라이언트가 받은 인가 코드를 서버가 토큰으로 바꾸고 사용자 정보를 읽는다.
// 카카오 토큰은 이 함수 밖으로 나가지 않고 저장하지도 않는다. 이메일·전화번호는 요청하지 않는다.
// https://developers.kakao.com/docs/latest/ko/kakaologin/rest-api

export interface KakaoUser {
  /** 카카오 회원번호 (문자열로 저장) */
  kakaoId: string;
  nickname: string;
}

export interface KakaoClient {
  /** 인가 코드 → 사용자. 코드가 잘못됐거나 만료면 KakaoAuthError */
  exchange(code: string, redirectUri: string): Promise<KakaoUser>;
}

export class KakaoAuthError extends Error {}

export function createKakaoClient(opts: { restApiKey: string; clientSecret: string }): KakaoClient {
  return {
    async exchange(code, redirectUri) {
      if (!opts.restApiKey) throw new Error('KAKAO_REST_API_KEY가 없습니다.');
      const tokenRes = await fetch('https://kauth.kakao.com/oauth/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded;charset=utf-8' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: opts.restApiKey,
          redirect_uri: redirectUri,
          code,
          ...(opts.clientSecret ? { client_secret: opts.clientSecret } : {}),
        }),
        signal: AbortSignal.timeout(10_000),
      });
      const token = (await tokenRes.json().catch(() => null)) as { access_token?: string; error_code?: string } | null;
      if (!tokenRes.ok || !token?.access_token) {
        // 응답 본문에 토큰이 있을 수 있으므로 오류 코드만 남긴다
        throw new KakaoAuthError(`카카오 토큰 교환 실패 (${tokenRes.status} ${token?.error_code ?? ''})`.trim());
      }
      const meRes = await fetch('https://kapi.kakao.com/v2/user/me', {
        headers: { authorization: `Bearer ${token.access_token}` },
        signal: AbortSignal.timeout(10_000),
      });
      const me = (await meRes.json().catch(() => null)) as {
        id?: number | string;
        properties?: { nickname?: string };
        kakao_account?: { profile?: { nickname?: string } };
      } | null;
      if (!meRes.ok || me?.id == null) throw new KakaoAuthError(`카카오 사용자 조회 실패 (${meRes.status})`);
      const nickname = me.kakao_account?.profile?.nickname || me.properties?.nickname || '이로케 사용자';
      return { kakaoId: String(me.id), nickname: nickname.slice(0, 30) };
    },
  };
}

// 전체 흐름을 한 번 돌리고, 모든 응답 본문과 이벤트 로그에 연락처·카카오 ID·사진이 없는지 본다.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { env } from '../src/env';
import { CRON_SECRET, DAY, SEED_KAKAO_IDS, setup } from './helpers';

describe('개인정보 · 공개 범위', () => {
  it('어떤 응답에도 카카오 ID·이메일·전화번호가 없고, 예약 링크는 수락 응답에만 있다', async () => {
    const t = setup();
    const customer = await t.login(SEED_KAKAO_IDS.customer1);
    const d1 = await t.login(SEED_KAKAO_IDS.designer1);
    const d2 = await t.login(SEED_KAKAO_IDS.designer2);
    await t.call('POST', '/auth/kakao', { body: { code: '12345', redirectUri: 'http://localhost:5173/auth' } });
    const id = (await t.createRequest(customer)).body.id;
    await t.call('GET', '/me', { token: customer });
    await t.call('GET', '/board', { token: d1 });
    await t.call('GET', `/board/${id}`, { token: d1 });
    const r1 = (await t.call('POST', `/requests/${id}/responses`, { token: d1, body: t.responseBody() })).body.id;
    await t.call('POST', `/requests/${id}/responses`, { token: d2, body: t.responseBody() });
    await t.call('GET', `/requests/${id}/responses`, { token: customer });
    await t.call('GET', '/requests/mine', { token: customer });
    await t.call('GET', `/requests/${id}`, { token: customer });
    const before = t.responses.length;
    const accept = await t.call('POST', `/responses/${r1}/accept`, { token: customer });
    t.advance(DAY);
    await t.call('POST', '/internal/jobs/sweep', { headers: { authorization: `Bearer ${CRON_SECRET}` } });

    const all = t.responses.join('\n');
    for (const kakaoId of [...Object.values(SEED_KAKAO_IDS), 'kakao-12345']) expect(all).not.toContain(kakaoId);
    expect(all).not.toMatch(/kakaoId|kakao_id/i);
    expect(all).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/); // 이메일
    expect(all).not.toMatch(/(?<![\w-])01[016789]-?\d{3,4}-?\d{4}(?![\w-])/); // 휴대전화 (uuid·토큰 속 숫자와 구분)
    // 예약 링크는 수락 응답에만. 단, 로그인 응답의 Me(디자이너 본인 정보)에는 자기 예약 링크가 있다 (명세 Me 타입)
    const notOwnInfo = t.responses.filter((r) => !r.includes('"accessToken"'));
    expect(notOwnInfo.filter((r) => r.includes('example.com/booking'))).toEqual([accept.text]);
    expect(t.responses.slice(0, before).filter((r) => !r.includes('"accessToken"')).some((r) => r.includes('bookingUrl'))).toBe(false);
  });

  it('이벤트 로그(JSONL)에 사진·카카오 ID가 남지 않는다', async () => {
    const t = setup();
    const c = await t.login(SEED_KAKAO_IDS.customer1);
    await t.call('POST', '/auth/kakao', { body: { code: 'bad', redirectUri: 'http://localhost:5173/auth' } });
    await t.createRequest(c);
    await new Promise((r) => setTimeout(r, 20));
    if (!existsSync(env.logDir)) return;
    const logs = readdirSync(env.logDir).map((f) => readFileSync(path.join(env.logDir, f), 'utf8')).join('');
    expect(logs).not.toContain('base64');
    expect(logs).not.toContain(SEED_KAKAO_IDS.customer1);
    expect(logs).not.toContain('request_design/');
  });
});

// Vercel 배포 진입점. Vercel은 default export된 Hono 앱을 함수로 실행한다.
// Vercel의 Hono 프리셋은 진입 파일 소스에서 'hono' import를 찾아 앱을 인식하므로 여기서 직접 import한다.
// 로컬 개발(npm run dev)은 dev.ts가 node-server로 직접 띄운다.
import { Hono } from 'hono';
import { createApp } from './createApp.js';
import type { AppEnv } from './http/context.js';

const app: Hono<AppEnv, {}, '/api'> = createApp();

export default app;

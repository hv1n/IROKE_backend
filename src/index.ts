// Vercel 배포 진입점. Vercel은 default export된 Hono 앱을 함수로 실행한다.
// 로컬 개발(npm run dev)은 dev.ts가 node-server로 직접 띄운다.
import { createApp } from './createApp';

export default createApp();

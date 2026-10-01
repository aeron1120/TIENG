import type { DemoCaseDto, DemoResultsDto } from '@rider-guard/contract';
import { Hono } from 'hono';

import { ApiError } from '../lib.ts';
import { esp32Case, esp32Results, isEsp32CaseId } from '../services/esp32-cases.ts';

/**
 * 시연용 공개 API — 로그인 없이 읽기만. 개인 정보 없이 ESP32·MPU6050 실측 기록과 서버 판정만 돌려준다.
 * 판정은 운영과 같은 analyzeImu(imu-report-v1). 시연 화면의 라이더·관제·주문 흐름은 앱 안의 시연 데이터다.
 */
export function demoRoutes() {
  const app = new Hono();
  // 원본도 규칙도 배포 중에는 바뀌지 않는다
  app.use('*', async (c, next) => {
    await next();
    if (c.res.ok) c.header('Cache-Control', 'public, max-age=600');
  });

  app.get('/results', (c) => c.json<DemoResultsDto>(esp32Results()));

  app.get('/cases/:id', (c) => {
    const id = c.req.param('id');
    if (!isEsp32CaseId(id)) throw new ApiError(404, 'not_found', '없는 조건이에요.');
    return c.json<DemoCaseDto>(esp32Case(id));
  });

  return app;
}

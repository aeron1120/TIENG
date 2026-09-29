import type { EmergencyDelivery } from '@rider-guard/contract';
import { Hono } from 'hono';

import type { AppContext } from '../context.ts';
import { escapeHtml as h, seoulClock } from '../lib.ts';
import { emergencyDelivery } from '../services/incidents.ts';
import { displayName } from '../services/riders.ts';
import { OPEN_STATUSES, acknowledgeShareLink, viewShareLink, type ShareView } from '../services/sharing.ts';

/** 비상연락처가 문자로 받은 링크를 여는 공개 페이지. 앱 없이 휴대폰 브라우저에서 열린다. */
export function shareRoutes(ctx: AppContext) {
  const app = new Hono();

  app.get('/:token', async (c) => {
    const view = await viewShareLink(ctx, c.req.param('token'));
    const status = view.kind === 'invalid' ? 404 : view.kind === 'expired' ? 410 : 200;
    c.header('Cache-Control', 'no-store');
    c.header('Referrer-Policy', 'no-referrer');
    c.header('X-Robots-Tag', 'noindex');
    const emergency = view.kind === 'ok' && view.incident ? (await emergencyDelivery(ctx, view.incident)).delivery : null;
    return c.html(renderSharePage(ctx, view, c.req.param('token'), emergency), status);
  });

  app.post('/:token/ack', async (c) => {
    const token = c.req.param('token');
    await acknowledgeShareLink(ctx, token);
    return c.redirect(`/s/${encodeURIComponent(token)}`, 303);
  });

  return app;
}

const LEVEL_HINT = {
  realtime: '운행 중일 때만 위치를 볼 수 있어요. 지금은 운행 중이 아니에요.',
  on_anomaly: '사고가 감지됐을 때만 위치를 볼 수 있어요.',
  on_incident: '사고가 확정됐을 때만 위치를 볼 수 있어요.',
} as const;

/** 사고 중 안내 — 관제센터가 없으니 119 신고가 어디까지 갔는지 알려 주고, 실패했으면 직접 신고를 부탁한다. */
const EMERGENCY_LEAD: Record<EmergencyDelivery, string> = {
  waiting: '라이더의 응답을 기다리고 있어요. 응답이 없으면 119에 자동으로 신고해요.',
  sending: '119에 자동으로 신고하고 있어요.',
  retrying: '119 자동 신고가 늦어지고 있어요. 위급해 보이면 바로 119에 신고해 주세요.',
  sent: '119에 자동으로 신고했어요. 가까이 있다면 현장을 확인해 주세요.',
  failed: '119 자동 신고가 전송되지 않았어요. 아래 위치로 지금 119에 신고해 주세요.',
  cancelled: '위급해 보이면 바로 119에 신고해 주세요.',
};

function renderSharePage(ctx: AppContext, view: ShareView, token: string, emergency: EmergencyDelivery | null): string {
  if (view.kind !== 'ok') {
    return page('Rider Guard', `<h1>${view.kind === 'expired' ? '링크가 만료됐어요' : '링크를 찾을 수 없어요'}</h1><p class="muted">받은 문자의 링크가 맞는지 확인해 주세요.</p>`);
  }
  const { rider, contact, incident, link, location, visible } = view;
  const name = h(displayName(rider));
  const open = !!incident && (OPEN_STATUSES as readonly string[]).includes(incident.status);
  const now = ctx.clock.now();

  let badge = '';
  let title = `${name}님의 위치`;
  let lead = '';
  if (link.scope === 'incident' && incident && !open) {
    badge = '<span class="badge done">대응 종료</span>';
    title = `${name}님 사고 대응이 종료됐어요`;
    lead =
      incident.resolution === 'rider_ok'
        ? `${name}님이 괜찮다고 응답했어요.`
        : incident.resolution === 'false_alarm'
          ? '오탐으로 종료됐어요.'
          : '대응 기간이 끝나 위치 공유를 멈췄어요.';
  } else if (incident && open) {
    badge = '<span class="badge">사고 대응 진행 중</span>';
    title = incident.riderResponse === 'help' ? `${name}님이 도움을 요청했어요` : `${name}님에게 사고가 감지됐어요`;
    lead = EMERGENCY_LEAD[emergency ?? 'cancelled'];
  } else if (!visible) {
    lead = LEVEL_HINT[contact.shareLevel];
  }

  const where = location
    ? `<div class="card">
        <div class="muted small">마지막 위치 · ${seoulClock(location.recordedAt)} (${Math.max(0, Math.round((now - location.recordedAt) / 60_000))}분 전)</div>
        <div class="mono">${location.lat.toFixed(6)}, ${location.lng.toFixed(6)}${location.accuracy != null ? ` · 오차 ${Math.round(location.accuracy)}m` : ''}</div>
        <div class="row">
          <a class="btn dark" href="https://map.kakao.com/link/map/${encodeURIComponent(displayName(rider))},${location.lat},${location.lng}">카카오맵</a>
          <a class="btn outline" href="https://www.google.com/maps/search/?api=1&amp;query=${location.lat},${location.lng}">Google 지도</a>
        </div>
      </div>`
    : visible
      ? '<div class="card muted">아직 받은 위치가 없어요. 잠시 후 새로고침해 주세요.</div>'
      : '';

  const calls =
    incident && open
      ? `<div class="row">
          <a class="btn accent" href="tel:119">119 전화</a>
        </div>`
      : '';

  const ack =
    link.scope === 'incident' && incident && open
      ? link.acknowledgedAt
        ? '<p class="ok">확인해 주셔서 고마워요. 다음 순위 연락처에게는 문자를 보내지 않아요.</p>'
        : `<form method="post" action="/s/${h(encodeURIComponent(token))}/ack"><button class="btn outline wide" type="submit">확인했어요 — 제가 연락해 볼게요</button></form>`
      : '';

  const body = `
    ${badge}
    <h1>${title}</h1>
    ${lead ? `<p class="muted">${lead}</p>` : ''}
    ${calls}
    ${where}
    ${ack}
    <p class="foot">${name}님이 정한 공개 범위 안에서만 보이는 링크예요. 열람 기록은 ${name}님에게 제공돼요.</p>`;
  return page('Rider Guard 위치 공유', body, open ? 30 : 0);
}

function page(title: string, body: string, refreshSeconds = 0): string {
  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
${refreshSeconds ? `<meta http-equiv="refresh" content="${refreshSeconds}">` : ''}
<title>${h(title)}</title>
<style>
  body{margin:0;background:#F4F1EA;color:#16181D;font:15px/1.55 system-ui,-apple-system,'Apple SD Gothic Neo','Malgun Gothic',sans-serif}
  main{max-width:440px;margin:0 auto;padding:28px 20px 40px;display:flex;flex-direction:column;gap:14px}
  h1{margin:0;font-size:24px;line-height:1.35;letter-spacing:-.5px}
  p{margin:0}.muted{color:#5B5E66}.small{font-size:13px}
  .badge{align-self:flex-start;padding:5px 10px;border-radius:999px;background:#FDE3D3;color:#9A3412;font-size:12px;font-weight:700}
  .badge.done{background:#EDE9E0;color:#45474D}
  .card{display:flex;flex-direction:column;gap:8px;padding:16px;background:#fff;border:1px solid #DDD6C8;border-radius:16px}
  .mono{font-family:ui-monospace,Menlo,Consolas,monospace;font-weight:600}
  .row{display:flex;gap:10px}.row .btn{flex:1}
  .btn{display:flex;align-items:center;justify-content:center;height:52px;border-radius:14px;font-weight:700;font-size:16px;text-decoration:none;border:0;cursor:pointer;font-family:inherit}
  .btn.accent{background:#C2410C;color:#fff}.btn.dark{background:#16181D;color:#fff}
  .btn.outline{background:#fff;color:#16181D;border:1.5px solid #16181D}.btn.wide{width:100%}
  .ok{padding:14px 16px;border-radius:14px;background:#DBE4FB;color:#1D3FA8;font-weight:600}
  .foot{font-size:12px;color:#9A9DA6}
</style></head>
<body><main>${body}</main></body></html>`;
}

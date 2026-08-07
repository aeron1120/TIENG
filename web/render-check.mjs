// 일회성 확인용. 컴포넌트를 실제로 렌더해 README §2 표시 규칙을 검사한다.
// node render-check.mjs
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer } from 'vite'

const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom' })
const { MetricCard } = await vite.ssrLoadModule('/src/components/MetricCard.tsx')
const { TrendChart } = await vite.ssrLoadModule('/src/components/TrendChart.tsx')

const metric = (over) => ({
  key: 'hr', value: 72.4, unit: 'bpm', source: 'rppg',
  mode: 'live', state: 'ok', confidence: 0.88, ts: '2026-01-01T00:00:00Z', ...over,
})
const render = (el) => renderToStaticMarkup(el)
const attr = (html, name) => [...html.matchAll(new RegExp(`${name}="([a-z_]+)"`, 'g'))].map((m) => m[1])

let failed = 0
const check = (name, ok, detail) => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(24)} ${detail}`)
}

// --- MetricCard: 값 표시 규칙 ---
const cases = [
  ['live/ok 숫자',     metric(), false, false],
  ['value=null',       metric({ value: null, state: 'no_adapter', mode: 'unavailable', confidence: null }), false, true],
  ['low_quality 보류', metric({ key: 'rr', value: null, unit: 'rpm', state: 'low_quality', mode: 'simulated', confidence: 0.2 }), false, true],
  ['문자열 value',     metric({ key: 'posture', value: 'lying', unit: null, mode: 'simulated', confidence: 0.7 }), false, false],
  ['stale 덮어쓰기',   metric(), true, true],
]

for (const [name, m, stale, expectDash] of cases) {
  const html = render(React.createElement(MetricCard, { metric: m, stale }))
  const dash = html.includes('—')
  const zero = />0</.test(html)
  const [mode] = attr(html, 'data-mode')
  const [state] = attr(html, 'data-state')
  check(name, dash === expectDash && !zero && mode && state, `표시=${dash ? '—' : '값'} 뱃지=${mode}/${state}`)
}

// --- TrendChart: 보류 구간은 선을 끊는다 ---
const snap = (hr) => ({
  device_id: 'x', ts: '2026-01-01T00:00:00Z', interventions: [],
  metrics: [{ ...metric(), value: hr, state: hr === null ? 'low_quality' : 'ok' }],
})

const contiguous = render(React.createElement(TrendChart, {
  history: [70, 71, 72, 71, 70].map(snap), metricKey: 'hr', stale: false,
}))
check('연속 구간 = 선 1개', (contiguous.match(/<path/g) || []).length === 1,
  `path ${(contiguous.match(/<path/g) || []).length}개`)

const gapped = render(React.createElement(TrendChart, {
  history: [70, 71, null, null, 72, 71].map(snap), metricKey: 'hr', stale: false,
}))
const paths = (gapped.match(/<path/g) || []).length
check('보류 구간에서 끊김', paths === 2, `path ${paths}개 (보류 전후로 분리)`)
check('보류율 표기', gapped.includes('보류 33%'), gapped.match(/보류 \d+%/)?.[0] ?? '없음')

await vite.close()
console.log(failed === 0 ? '\n전부 통과' : `\n${failed}건 실패`)
process.exit(failed === 0 ? 0 : 1)

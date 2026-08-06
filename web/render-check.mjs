// 일회성 확인용. MetricCard가 README §2 표시 규칙을 지키는지 실제 렌더로 검사한다.
// node render-check.mjs
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer } from 'vite'

const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom' })
const { MetricCard } = await vite.ssrLoadModule('/src/components/MetricCard.tsx')

const metric = (over) => ({
  key: 'hr', value: 72.4, unit: 'bpm', source: 'rppg',
  mode: 'live', state: 'ok', confidence: 0.88, ts: '2026-01-01T00:00:00Z', ...over,
})

const cases = [
  ['live/ok 숫자',      metric(), false],
  ['value=null',        metric({ value: null, state: 'no_adapter', mode: 'unavailable', confidence: null }), false],
  ['low_quality 보류',  metric({ key: 'rr', value: null, unit: 'rpm', state: 'low_quality', mode: 'simulated', confidence: 0.2 }), false],
  ['문자열 value',      metric({ key: 'posture', value: 'lying', unit: null, mode: 'simulated', confidence: 0.7 }), false],
  ['stale 덮어쓰기',    metric(), true],
]

let failed = 0
for (const [name, m, stale] of cases) {
  const html = renderToStaticMarkup(React.createElement(MetricCard, { metric: m, stale }))
  const dash = html.includes('—')
  const badges = [...html.matchAll(/class="badge ([a-z_-]+)"/g)].map((x) => x[1])
  const number = html.match(/class="number[^"]*">([^<]*)</)?.[1] ?? ''

  // 값이 없거나(stale 포함) 보류 상태면 반드시 —, 숫자는 없어야 한다.
  const shouldHold = stale || m.value === null
  const ok = shouldHold === dash && badges.length === 2
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(16)} 표시="${number}" 뱃지=${badges.join(',')}`)
}

await vite.close()
console.log(failed === 0 ? '\n전부 통과' : `\n${failed}건 실패`)
process.exit(failed === 0 ? 0 : 1)

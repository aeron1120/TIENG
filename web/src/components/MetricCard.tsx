import type { Metric } from '../types'
import { StateBadge } from './StateBadge'

const LABEL: Record<string, string> = {
  hr: '심박수',
  rr: '호흡수',
  temp: '온도',
  humidity: '습도',
  lux: '조도',
  noise: '소음',
  occupancy: '재실',
  posture: '자세',
}

const POSTURE_LABEL: Record<string, string> = {
  sitting: '앉음',
  standing: '섬',
  lying: '누움',
}

export function MetricCard({ metric, stale }: { metric: Metric; stale: boolean }) {
  // 수신이 끊기면 서버가 뭐라 했든 프론트가 stale로 덮는다 (README §2).
  const state = stale ? 'stale' : metric.state

  // value가 null이거나 신뢰할 수 없으면 반드시 "—". 0으로 대체하지 않는다 (README §2).
  const showValue = !stale && metric.value !== null

  return (
    <article className={`card state-${state}`}>
      <header className="card-head">
        <h2>{LABEL[metric.key] ?? metric.key}</h2>
        <StateBadge mode={metric.mode} state={state} />
      </header>

      <div className="value">
        {showValue ? (
          <>
            <span className="number">
              {typeof metric.value === 'string'
                ? (POSTURE_LABEL[metric.value] ?? metric.value)
                : metric.value}
            </span>
            {metric.unit && <span className="unit">{metric.unit}</span>}
          </>
        ) : (
          <span className="number blank">—</span>
        )}
      </div>

      <footer className="card-foot">
        <span className="source">{metric.source}</span>
        {showValue && metric.confidence !== null && (
          <span className="confidence">신뢰도 {(metric.confidence * 100).toFixed(0)}%</span>
        )}
      </footer>
    </article>
  )
}

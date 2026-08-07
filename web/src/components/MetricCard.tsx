import { ICON, LABEL, displayValue, effectiveState } from '../metrics'
import type { Metric } from '../types'
import { StateBadge } from './StateBadge'

export function MetricCard({ metric, stale }: { metric: Metric; stale: boolean }) {
  const state = effectiveState(metric, stale)
  const shown = displayValue(metric, stale)
  const Icon = ICON[metric.key] ?? ICON.posture
  const dim = state === 'no_adapter' || state === 'stale'

  return (
    <article
      className={`hairline flex flex-col justify-between rounded-xl p-3.5 sm:p-4 ${
        dim ? 'bg-panel-dim border-gold/15 opacity-85' : 'bg-panel border-gold/20'
      } ${state === 'error' ? 'border-alert/60' : ''}`}
    >
      <header className="mb-2 flex min-w-0 items-center justify-between gap-1">
        <span className="flex shrink-0 items-center gap-1.5 font-mono text-[10px] tracking-wide text-muted uppercase sm:text-[11px]">
          <Icon className={`h-3.5 w-3.5 ${dim ? 'text-muted' : 'text-gold'}`} />
          {LABEL[metric.key] ?? metric.key}
        </span>
        <StateBadge mode={metric.mode} state={state} />
      </header>

      <div className="mt-1 mb-2 flex items-baseline gap-1.5">
        {shown === null ? (
          // 값이 없다는 사실 자체가 정보다. 숫자처럼 보이면 안 된다.
          <span className="font-serif text-3xl font-extralight text-muted/60 sm:text-4xl">—</span>
        ) : (
          <>
            <span className="font-serif text-3xl font-light tracking-tight text-fg sm:text-4xl">
              {shown}
            </span>
            {metric.unit && <span className="font-mono text-xs text-muted">{metric.unit}</span>}
          </>
        )}
      </div>

      <footer className="hairline-t mt-auto flex justify-between gap-2 border-gold/15 pt-2 font-mono text-[10px] whitespace-nowrap text-muted sm:text-xs">
        <span>{metric.source}</span>
        {/* 값이 없어도 confidence 는 보여준다. 왜 보류됐는지 읽을 단서가 된다. */}
        {metric.confidence !== null && !stale && (
          <span>신뢰도 {(metric.confidence * 100).toFixed(0)}%</span>
        )}
      </footer>
    </article>
  )
}

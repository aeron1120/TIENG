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
      className={`border-[0.5px] rounded-lg px-4 py-3 transition-colors ${
        dim ? 'border-faint/15 bg-panel-dim' : 'border-gold/20 bg-panel'
      } ${state === 'error' ? 'border-alert/50' : ''}`}
    >
      <header className="flex min-w-0 items-center justify-between gap-2">
        <span
          className={`flex min-w-0 items-center gap-1.5 font-mono text-[11px] tracking-[0.12em] uppercase ${
            dim ? 'text-faint' : 'text-muted'
          }`}
        >
          <Icon className={`h-3.5 w-3.5 shrink-0 ${dim ? 'text-faint' : 'text-gold'}`} />
          <span className="truncate">{LABEL[metric.key] ?? metric.key}</span>
        </span>
        <StateBadge mode={metric.mode} state={state} />
      </header>

      <div className="mt-2.5 flex items-baseline gap-1.5">
        {shown === null ? (
          // 값이 없다는 사실 자체가 정보다. 숫자처럼 보이면 안 된다.
          <span className="font-serif text-[26px] leading-none text-faint/70">—</span>
        ) : (
          <>
            <span className="tnum font-serif text-[30px] leading-none tracking-tight text-fg">
              {shown}
            </span>
            {metric.unit && <span className="font-mono text-[11px] text-muted">{metric.unit}</span>}
          </>
        )}
      </div>

      <footer className="mt-2.5 flex items-center justify-between gap-2 font-mono text-[10px] whitespace-nowrap text-faint">
        <span className="truncate">{metric.source}</span>
        {/* 값이 없어도 confidence 는 보여준다. 왜 보류됐는지 읽을 단서가 된다. */}
        {metric.confidence !== null && !stale && (
          <span className="tnum shrink-0">{(metric.confidence * 100).toFixed(0)}%</span>
        )}
      </footer>
    </article>
  )
}

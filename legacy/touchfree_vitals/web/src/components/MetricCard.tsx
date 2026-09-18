import { GripVertical } from 'lucide-react'
import type { DragEvent, KeyboardEvent } from 'react'
import { ICON, LABEL, displayValue, effectiveState, isWarmingUp } from '../metrics'
import type { Metric } from '../types'
import { StateBadge } from './StateBadge'

// 실시간 화면에서는 이 카드가 곧 블록이다. 끌어서 순서를 바꾸고, 누르면 주지표로
// 올라가 아래 그래프가 그 지표로 바뀐다.
//
// 상호작용은 전부 선택 사항이다. onSelect·drag 를 안 주면 예전처럼 보기 전용
// 카드로 그려진다.

const allowDrop = (e: DragEvent) => e.preventDefault()

const activate = (e: KeyboardEvent, run: () => void) => {
  if (e.key !== 'Enter' && e.key !== ' ') return
  e.preventDefault() // 스페이스가 페이지를 스크롤하지 않게
  run()
}

export interface DragHandlers {
  dragging: boolean
  onStart: () => void
  onEnter: () => void
  onEnd: () => void
}

export function MetricCard({
  metric,
  stale,
  onSelect,
  drag,
}: {
  metric: Metric
  stale: boolean
  onSelect?: () => void
  drag?: DragHandlers
}) {
  const state = effectiveState(metric, stale)
  const shown = displayValue(metric, stale)
  const Icon = ICON[metric.key] ?? ICON.posture
  const dim = state === 'no_adapter' || state === 'stale'
  const label = LABEL[metric.key] ?? metric.key
  const warmingUp = isWarmingUp(metric, stale)

  return (
    <article
      draggable={drag !== undefined}
      onDragStart={drag?.onStart}
      onDragEnter={drag?.onEnter}
      // preventDefault 를 안 하면 브라우저가 이 자리를 "놓을 수 없는 곳"으로 본다.
      onDragOver={drag ? allowDrop : undefined}
      onDragEnd={drag?.onEnd}
      // 카드 전체가 버튼이다. 작은 아이콘을 조준하게 만들면 몇 걸음 떨어진
      // 화면에서는 누를 수가 없다.
      role={onSelect && 'button'}
      tabIndex={onSelect && 0}
      onClick={onSelect}
      onKeyDown={onSelect ? (e: KeyboardEvent) => activate(e, onSelect) : undefined}
      aria-label={onSelect && `${label} 크게 보기`}
      className={`group relative rounded-lg border-[0.5px] px-4 py-3 transition-all ${
        dim ? 'border-faint/15 bg-panel-dim' : 'border-gold/20 bg-panel'
      } ${state === 'error' ? 'border-alert/50' : ''} ${
        drag ? 'cursor-grab active:cursor-grabbing' : ''
      } ${drag?.dragging ? 'opacity-40' : ''} ${
        onSelect ? 'hover:border-gold/50 focus-visible:border-gold focus-visible:outline-none' : ''
      }`}
    >
      {drag && (
        <GripVertical className="absolute top-3 left-1 h-3.5 w-3.5 text-faint/0 transition-colors group-hover:text-faint/60" />
      )}

      <header className="flex min-w-0 items-center justify-between gap-2">
        <span
          className={`kr flex min-w-0 items-center gap-1.5 text-[15px] font-medium ${
            dim ? 'text-faint' : 'text-muted'
          }`}
        >
          <Icon className={`h-3.5 w-3.5 shrink-0 ${dim ? 'text-faint' : 'text-gold'}`} />
          <span className="truncate">{label}</span>
        </span>
        <StateBadge mode={metric.mode} state={state} warmingUp={warmingUp} />
      </header>

      <div className="mt-2.5 flex items-baseline gap-1.5">
        {shown === null ? (
          // 값이 없다는 사실 자체가 정보다. 숫자처럼 보이면 안 된다.
          <span className="text-[30px] leading-none font-extralight text-faint/70">—</span>
        ) : (
          <>
            <span className="tnum text-[34px] leading-none font-light tracking-[-0.02em] text-fg">
              {shown}
            </span>
            {metric.unit && <span className="font-mono text-[13px] text-muted">{metric.unit}</span>}
          </>
        )}
      </div>

      {/* 준비 중이면 "—" 옆에 얼마나 왔는지를 붙인다. 이게 없으면 값이 안 뜨는
          카드가 고장 난 것처럼 보인다. */}
      {warmingUp && (
        <div className="mt-2 h-[2px] w-full overflow-hidden rounded-full bg-white/5">
          <div
            className="h-full rounded-full bg-gold-soft transition-all duration-700"
            style={{ width: `${(metric.progress ?? 0) * 100}%` }}
          />
        </div>
      )}

      <footer className="mt-2.5 flex items-center justify-between gap-2 font-mono text-[12px] whitespace-nowrap text-faint">
        <span className="truncate">{metric.source}</span>
        {warmingUp ? (
          <span className="kr shrink-0">준비 {Math.round((metric.progress ?? 0) * 100)}%</span>
        ) : (
          /* 값이 없어도 confidence 는 보여준다. 왜 보류됐는지 읽을 단서가 된다. */
          metric.confidence !== null &&
          !stale && (
            <span className="tnum shrink-0">{(metric.confidence * 100).toFixed(0)}%</span>
          )
        )}
      </footer>
    </article>
  )
}

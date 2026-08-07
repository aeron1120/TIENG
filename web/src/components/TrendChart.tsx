import { useState } from 'react'
import { LABEL } from '../metrics'
import type { Snapshot } from '../types'

// upstream 의 차트는 하드코딩된 베지어 곡선이었다. 여기서는 실제 수신 이력을 그린다.
// 보류(value=null) 구간은 선을 잇지 않고 끊는다. 없는 값을 이어 그리면 그 구간에도
// 측정이 있었던 것처럼 보인다 (README §2).

const WINDOWS = [
  { key: '1m', label: '1분', points: 60 },
  { key: '5m', label: '5분', points: 300 },
  { key: '10m', label: '10분', points: 600 },
] as const

const MIN_HALF_SPAN = 10 // 값이 안 움직여도 축이 확대돼 요동치는 것처럼 보이지 않게

interface Point {
  x: number
  y: number
}

export function TrendChart({
  history,
  metricKey,
  stale,
}: {
  history: Snapshot[]
  metricKey: string
  stale: boolean
}) {
  const [window, setWindow] = useState<(typeof WINDOWS)[number]['key']>('5m')
  const span = WINDOWS.find((w) => w.key === window) ?? WINDOWS[1]

  const series = history.slice(-span.points).map((snap) => {
    const metric = snap.metrics.find((m) => m.key === metricKey)
    const value = metric && typeof metric.value === 'number' ? metric.value : null
    return value
  })

  const measured = series.filter((v): v is number => v !== null)
  const heldRatio = series.length ? 1 - measured.length / series.length : 0

  const title = `${LABEL[metricKey] ?? metricKey} 추세`

  if (measured.length < 2) {
    return (
      <Frame title={title} window={window} onWindow={setWindow} held={null}>
        <div className="flex h-full items-center justify-center font-mono text-xs text-muted">
          추세를 그릴 만큼 쌓이지 않았다
        </div>
      </Frame>
    )
  }

  const hi = Math.max(...measured)
  const lo = Math.min(...measured)
  const center = (hi + lo) / 2
  const half = Math.max((hi - lo) / 2, MIN_HALF_SPAN) * 1.2
  const yMin = center - half
  const yMax = center + half

  const toPoint = (value: number, index: number): Point => ({
    x: series.length > 1 ? (index / (series.length - 1)) * 100 : 50,
    y: 95 - ((value - yMin) / (yMax - yMin)) * 90,
  })

  // 보류 구간에서 끊어 여러 조각으로 나눈다.
  const segments: Point[][] = []
  let current: Point[] = []
  series.forEach((value, index) => {
    if (value === null) {
      if (current.length) segments.push(current)
      current = []
      return
    }
    current.push(toPoint(value, index))
  })
  if (current.length) segments.push(current)

  const last = segments.at(-1)?.at(-1)
  const liveTip = !stale && series.at(-1) !== null ? last : undefined

  return (
    <Frame title={title} window={window} onWindow={setWindow} held={heldRatio}>
      <div className="relative h-full w-full">
        <div className="pointer-events-none absolute inset-0 flex flex-col justify-between">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="hairline-b w-full border-gold/10" />
          ))}
        </div>

        <div className="pointer-events-none absolute left-0 flex h-full flex-col justify-between py-0.5 font-mono text-[10px] text-muted">
          <span>{Math.round(yMax)}</span>
          <span>{Math.round(center)}</span>
          <span>{Math.round(yMin)}</span>
        </div>

        <svg
          className={`absolute inset-0 h-full w-full overflow-visible ${stale ? 'opacity-30' : ''}`}
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
        >
          {segments.map((seg, i) => (
            <path
              key={i}
              d={pathOf(seg)}
              fill="none"
              stroke="#c5a059"
              strokeWidth="2"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />
          ))}
          {liveTip && <circle cx={liveTip.x} cy={liveTip.y} r="2.5" fill="#c5a059" />}
        </svg>
      </div>
    </Frame>
  )
}

function Frame({
  title,
  window,
  onWindow,
  held,
  children,
}: {
  title: string
  window: string
  onWindow: (key: (typeof WINDOWS)[number]['key']) => void
  held: number | null
  children: React.ReactNode
}) {
  return (
    <section className="hairline flex w-full flex-col gap-2 rounded-xl border-gold/20 bg-panel p-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="m-0 font-mono text-xs tracking-wider text-muted uppercase">
          {title}
          {/* 보류율은 검증 슬라이드의 근거가 되는 숫자다 (README §8). 숨기지 않는다. */}
          {held !== null && held > 0 && (
            <span className="ml-2 text-gold">보류 {(held * 100).toFixed(0)}%</span>
          )}
        </h2>
        <div className="flex gap-1 font-mono text-[11px]">
          {WINDOWS.map((w) => (
            <button
              key={w.key}
              onClick={() => onWindow(w.key)}
              className={`rounded px-2 py-0.5 transition-colors ${
                window === w.key ? 'bg-gold font-semibold text-ink' : 'text-muted hover:bg-white/5'
              }`}
            >
              {w.label}
            </button>
          ))}
        </div>
      </div>
      <div className="relative mt-1 h-32 w-full">{children}</div>
    </section>
  )
}

function pathOf(points: Point[]): string {
  if (points.length === 0) return ''
  if (points.length === 1) {
    // 조각이 한 점뿐이면 아주 짧은 선으로 그려 눈에 보이게 한다.
    const p = points[0]
    return `M ${p.x.toFixed(1)},${p.y.toFixed(1)} L ${(p.x + 0.4).toFixed(1)},${p.y.toFixed(1)}`
  }
  let d = `M ${points[0].x.toFixed(1)},${points[0].y.toFixed(1)}`
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]
    const b = points[i + 1]
    const cx = (a.x + b.x) / 2
    d += ` C ${cx.toFixed(1)},${a.y.toFixed(1)} ${cx.toFixed(1)},${b.y.toFixed(1)} ${b.x.toFixed(1)},${b.y.toFixed(1)}`
  }
  return d
}

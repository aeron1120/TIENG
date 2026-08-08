import { useId, useState } from 'react'
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

type WindowKey = (typeof WINDOWS)[number]['key']

// 값이 안 움직여도 축이 확대돼 요동치는 것처럼 보이지 않게 하는 하한.
// 너무 크게 잡으면 반대로 실제 변동이 납작해지고 그래프 위쪽이 텅 빈다.
//
// 절대값이 아니라 비율인 이유: 이제 어느 지표든 주지표가 될 수 있다. 하한을
// 5 로 고정하면 심박수(±5bpm)에는 맞지만 온도(24.2℃)는 ±5℃ 축에 깔려 완전히
// 납작해진다. 0 근처 지표를 위해 절대 하한도 같이 둔다.
const MIN_HALF_SPAN_RATIO = 0.04
const MIN_HALF_SPAN_ABS = 0.05
const BASELINE = 100 // viewBox 바닥. 면적 채우기용

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
  const [win, setWin] = useState<WindowKey>('5m')
  const gradientId = useId()
  const span = WINDOWS.find((w) => w.key === win) ?? WINDOWS[1]

  const raw = history
    .slice(-span.points)
    .map((snap) => snap.metrics.find((m) => m.key === metricKey)?.value ?? null)
  const series = raw.map((value) => (typeof value === 'number' ? value : null))

  const measured = series.filter((v): v is number => v !== null)
  const heldRatio = series.length ? 1 - measured.length / series.length : 0
  const title = `${LABEL[metricKey] ?? metricKey} 추세`

  if (measured.length < 2) {
    return (
      <Frame title={title} win={win} onWin={setWin} held={null} span={span.label}>
        <div className="kr flex h-full items-center justify-center text-[12px] text-faint">
          {/* 자세처럼 값이 문자열인 지표는 선으로 그릴 게 없다. "아직 안 쌓였다"고
              하면 기다리면 그려지는 줄 알게 된다. */}
          {raw.some((value) => typeof value === 'string')
            ? '수치가 아니라 추세를 그리지 않는다'
            : '추세를 그릴 만큼 쌓이지 않았다'}
        </div>
      </Frame>
    )
  }

  const hi = Math.max(...measured)
  const lo = Math.min(...measured)
  const center = (hi + lo) / 2
  const floor = Math.max(Math.abs(center) * MIN_HALF_SPAN_RATIO, MIN_HALF_SPAN_ABS)
  const half = Math.max((hi - lo) / 2, floor) * 1.15
  const yMin = center - half
  const yMax = center + half

  const toPoint = (value: number, index: number): Point => ({
    x: series.length > 1 ? (index / (series.length - 1)) * 100 : 50,
    y: 92 - ((value - yMin) / (yMax - yMin)) * 84,
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

  const paths = segments.map((seg) => {
    const line = pathOf(seg)
    return { line, area: closeToBaseline(line, seg) }
  })

  const tip = series.at(-1) !== null ? segments.at(-1)?.at(-1) : undefined

  return (
    <Frame title={title} win={win} onWin={setWin} held={heldRatio} span={span.label}>
      <div className="flex h-full w-full">
        <div className="flex w-10 shrink-0 flex-col justify-between py-[2px] pr-2 text-right font-mono text-[10px] text-faint tabular-nums">
          {/* 축 폭이 좁으면 정수로 반올림했을 때 세 눈금이 같은 숫자가 된다.
              온도처럼 소수점이 곧 정보인 지표가 있다. */}
          {[yMax, center, yMin].map((value, i) => (
            <span key={i}>{yMax - yMin < 10 ? value.toFixed(1) : Math.round(value)}</span>
          ))}
        </div>

        <div className="relative min-w-0 flex-1">
          <div className="pointer-events-none absolute inset-0 flex flex-col justify-between">
            {[0, 1, 2, 3, 4].map((i) => (
              <div key={i} className="border-b-[0.5px] w-full border-gold/[0.08]" />
            ))}
          </div>

          <svg
            className={`absolute inset-0 h-full w-full ${stale ? 'opacity-25' : ''}`}
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
          >
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#c5a059" stopOpacity="0.16" />
                <stop offset="100%" stopColor="#c5a059" stopOpacity="0" />
              </linearGradient>
            </defs>

            {/* 경로 문자열은 한 번만 만든다. areaOf 가 pathOf 를 다시 부르면 10분 창
                기준 22KB 짜리 문자열을 매 초 두 번 만들게 된다 (측정: 렌더당 0.29ms). */}
            {paths.map(({ area }, i) => (
              <path key={`fill-${i}`} d={area} fill={`url(#${gradientId})`} stroke="none" />
            ))}
            {paths.map(({ line }, i) => (
              <path
                key={`line-${i}`}
                d={line}
                fill="none"
                stroke="#c5a059"
                strokeWidth="1.75"
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
              />
            ))}
          </svg>

          {/* 끝점 마커는 SVG 밖에 둔다. preserveAspectRatio=none 안의 원은 찌그러진다. */}
          {tip && !stale && (
            <span
              className="absolute h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-gold shadow-[0_0_8px_rgba(197,160,89,0.8)]"
              style={{ left: `${tip.x}%`, top: `${tip.y}%` }}
            />
          )}
        </div>
      </div>
    </Frame>
  )
}

function Frame({
  title,
  win,
  onWin,
  held,
  span,
  children,
}: {
  title: string
  win: WindowKey
  onWin: (key: WindowKey) => void
  held: number | null
  span: string
  children: React.ReactNode
}) {
  return (
    // h-full: 남는 세로 공간을 그래프가 흡수한다. 안 그러면 화면 아래가 통째로 빈다.
    <section className="border-[0.5px] flex h-full w-full flex-col gap-3 rounded-lg border-gold/15 bg-panel px-4 py-3.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="kr m-0 flex items-center gap-2.5 text-[12px] font-medium text-faint">
          {title}
          {/* 보류율은 검증 슬라이드의 근거가 되는 숫자다 (README §8). 숨기지 않는다. */}
          {held !== null && held > 0 && (
            <span className="tnum rounded-full border border-gold/30 px-1.5 py-[2px] text-[11px] text-gold">
              보류 {(held * 100).toFixed(0)}%
            </span>
          )}
        </h2>
        <div className="kr flex gap-1 text-[11px]">
          {WINDOWS.map((w) => (
            <button
              key={w.key}
              onClick={() => onWin(w.key)}
              className={`rounded px-2 py-[3px] transition-colors ${
                win === w.key
                  ? 'bg-gold font-medium text-ink'
                  : 'text-faint hover:bg-white/[0.06] hover:text-muted'
              }`}
            >
              {w.label}
            </button>
          ))}
        </div>
      </div>

      <div className="relative min-h-24 w-full flex-1">{children}</div>

      <div className="flex justify-between pl-10 font-mono text-[10px] text-faint">
        <span className="kr">-{span}</span>
        <span className="tracking-[0.15em]">now</span>
      </div>
    </section>
  )
}

function pathOf(points: Point[]): string {
  if (points.length === 0) return ''
  if (points.length === 1) {
    // 조각이 한 점뿐이면 아주 짧은 선으로 그려 눈에 보이게 한다.
    const p = points[0]
    return `M ${p.x.toFixed(2)},${p.y.toFixed(2)} L ${(p.x + 0.3).toFixed(2)},${p.y.toFixed(2)}`
  }
  let d = `M ${points[0].x.toFixed(2)},${points[0].y.toFixed(2)}`
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]
    const b = points[i + 1]
    const cx = (a.x + b.x) / 2
    d += ` C ${cx.toFixed(2)},${a.y.toFixed(2)} ${cx.toFixed(2)},${b.y.toFixed(2)} ${b.x.toFixed(2)},${b.y.toFixed(2)}`
  }
  return d
}

/** 이미 만든 선 경로를 바닥까지 닫아 면으로 만든다. 경로를 다시 계산하지 않는다. */
function closeToBaseline(line: string, points: Point[]): string {
  if (points.length < 2) return ''
  const first = points[0]
  const last = points[points.length - 1]
  return `${line} L ${last.x.toFixed(2)},${BASELINE} L ${first.x.toFixed(2)},${BASELINE} Z`
}

import { Gauge } from 'lucide-react'
import { DROWSINESS_LABEL, DROWSINESS_TONE, effectiveState, isWarmingUp } from '../metrics'
import type { Metric } from '../types'

// 졸음은 지표 하나가 아니라 판정이라 카드로 두지 않았다. 카드는 "지금 몇인가"를
// 보여주는 물건인데, 여기서 궁금한 건 "그래서 지금 위험한가"다.
//
// 근거를 같이 띄우는 이유: 판정만 크게 뜨면 왜 그렇게 나왔는지 알 수 없고, 임계를
// 조정할 때 무엇을 만져야 하는지도 모른다. PERCLOS 와 깜빡임을 나란히 두면 어느
// 채널이 판정을 끌고 갔는지 바로 읽힌다.

export function DrowsinessPanel({
  metrics,
  stale,
}: {
  metrics: Metric[]
  stale: boolean
}) {
  const verdict = metrics.find((m) => m.key === 'drowsiness')
  // 어댑터가 아예 없는 구성(mock, 카메라 미연결)에서는 패널 자체를 띄우지 않는다.
  // 값이 영영 안 나올 자리를 비워 두면 화면만 길어진다.
  if (!verdict) return null

  const state = effectiveState(verdict, stale)
  const warmingUp = isWarmingUp(verdict, stale)
  const key = stale || verdict.value === null ? null : String(verdict.value)
  const tone = key ? (DROWSINESS_TONE[key] ?? 'text-faint') : 'text-faint'

  const perclos = metrics.find((m) => m.key === 'perclos')
  const blink = metrics.find((m) => m.key === 'blink_dur')

  return (
    <div className="border-[0.5px] border-gold/15 bg-panel/60 p-4">
      <div className="mb-3 flex items-baseline justify-between gap-2">
        <span className="kr flex items-center gap-2 text-[15px] font-medium text-muted">
          <Gauge className="h-4 w-4 text-gold" />
          졸음 판정
        </span>
        <span className="font-mono text-[11px] tracking-[0.18em] text-faint uppercase">
          perclos + blink
        </span>
      </div>

      <div className="flex items-baseline gap-3">
        {key === null ? (
          <span className="animate-measuring text-[2.6rem] leading-none font-thin text-faint/50">
            —
          </span>
        ) : (
          <span className={`text-[2.6rem] leading-none font-extralight tracking-[-0.03em] ${tone}`}>
            {DROWSINESS_LABEL[key] ?? key}
          </span>
        )}
      </div>

      {key === null && (
        <p className="kr mt-2 text-[13px] text-muted">
          {warmingUp
            ? `관측 창을 채우는 중입니다 — ${Math.round((verdict.progress ?? 0) * 100)}%`
            : state === 'low_quality'
              ? '눈이 잡히지 않아 판정을 보류합니다'
              : '판정할 수 없습니다'}
        </p>
      )}

      {/* 판정의 근거 두 줄. 값이 없으면 0 을 쓰지 않고 — 로 둔다 (README §2). */}
      <dl className="mt-4 grid grid-cols-2 gap-3 border-t-[0.5px] border-gold/10 pt-3">
        <Evidence label="눈감김 P80" metric={perclos} stale={stale} suffix="%" digits={1} />
        <Evidence label="깜빡임 지속" metric={blink} stale={stale} suffix="ms" digits={0} />
      </dl>

      <p className="kr mt-3 text-[12px] leading-relaxed text-faint">
        임계는 문헌 통상값이고 이 기기로 보정하지 않았습니다 — 참고 표시입니다
      </p>
    </div>
  )
}

function Evidence({
  label,
  metric,
  stale,
  suffix,
  digits,
}: {
  label: string
  metric: Metric | undefined
  stale: boolean
  suffix: string
  digits: number
}) {
  const value =
    !metric || stale || typeof metric.value !== 'number' ? null : metric.value.toFixed(digits)

  return (
    <div>
      <dt className="kr text-[12px] text-faint">{label}</dt>
      <dd className="mt-0.5 flex items-baseline gap-1">
        <span className={`tnum text-lg font-light ${value === null ? 'text-faint/50' : 'text-fg'}`}>
          {value ?? '—'}
        </span>
        {value !== null && (
          <span className="font-mono text-[11px] tracking-[0.1em] text-gold">{suffix}</span>
        )}
      </dd>
    </div>
  )
}

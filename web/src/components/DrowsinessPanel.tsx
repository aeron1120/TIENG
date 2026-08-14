import { Gauge } from 'lucide-react'
import { DROWSINESS_LABEL, DROWSINESS_TONE, effectiveState, isWarmingUp } from '../metrics'
import type { Metric } from '../types'

// 졸음은 지표 하나가 아니라 판정이라 카드로 두지 않았다. 카드는 "지금 몇인가"를
// 보여주는 물건인데, 여기서 궁금한 건 "그래서 지금 위험한가"다.
//
// 점수를 같이 띄우는 이유: 목표가 졸음 **직전**을 잡는 것이라 3단계 라벨만으로는
// 부족하다. 각성에서 주의로 넘어가기 전에 점수가 차오르는 게 보여야 조기 경보다.
//
// 근거 세 줄을 붙이는 이유: 판정만 크면 왜 그렇게 나왔는지도, 임계를 조정할 때
// 무엇을 만져야 하는지도 알 수 없다. 특히 PERCLOS 는 후행 지표라 그것만 낮다고
// 안심하면 안 되는데, 나란히 두면 앞의 둘이 먼저 움직이는 게 보인다.

const WARN_AT = 30
const ALERT_AT = 60

export function DrowsinessPanel({
  metrics,
  stale,
}: {
  metrics: Metric[]
  stale: boolean
}) {
  const verdict = metrics.find((m) => m.key === 'drowsiness')
  // 어댑터가 없는 구성(mock, 카메라 미연결)에서는 패널 자체를 띄우지 않는다.
  // 값이 영영 안 나올 자리를 비워 두면 화면만 길어진다.
  if (!verdict) return null

  const state = effectiveState(verdict, stale)
  const warmingUp = isWarmingUp(verdict, stale)
  const key = stale || verdict.value === null ? null : String(verdict.value)
  const tone = key ? (DROWSINESS_TONE[key] ?? 'text-faint') : 'text-faint'

  const pick = (k: string) => metrics.find((m) => m.key === k)
  const scoreMetric = pick('drowsy_score')
  const score =
    !scoreMetric || stale || typeof scoreMetric.value !== 'number' ? null : scoreMetric.value

  return (
    <div className="border-[0.5px] border-gold/15 bg-panel/60 p-4">
      <div className="mb-3 flex items-baseline justify-between gap-2">
        <span className="kr flex items-center gap-2 text-[15px] font-medium text-muted">
          <Gauge className="h-4 w-4 text-gold" />
          졸음 판정
        </span>
        <span className="font-mono text-[11px] tracking-[0.18em] text-faint uppercase">
          early warning
        </span>
      </div>

      <div className="flex items-baseline gap-3">
        {key === null ? (
          <span className="animate-measuring text-[2.4rem] leading-none font-thin text-faint/50">
            —
          </span>
        ) : (
          <>
            <span
              className={`text-[2.4rem] leading-none font-extralight tracking-[-0.03em] ${tone}`}
            >
              {DROWSINESS_LABEL[key] ?? key}
            </span>
            {score !== null && (
              <span className="tnum text-lg font-light text-muted">{score.toFixed(0)}</span>
            )}
          </>
        )}
      </div>

      {/* 점수 막대. 주의·경고 지점을 눈금으로 세워 두면 지금이 어디쯤인지 읽힌다. */}
      {score !== null && (
        <div className="relative mt-3 h-[3px] w-full rounded-full bg-white/5">
          <div
            className={`h-full rounded-full transition-all duration-700 ${
              score >= ALERT_AT ? 'bg-alert' : score >= WARN_AT ? 'bg-gold' : 'bg-muted/60'
            }`}
            style={{ width: `${Math.min(Math.max(score, 0), 100)}%` }}
          />
          {[WARN_AT, ALERT_AT].map((at) => (
            <span
              key={at}
              className="absolute top-[-2px] h-[7px] w-px bg-faint/50"
              style={{ left: `${at}%` }}
            />
          ))}
        </div>
      )}

      {key === null && (
        <p className="kr mt-2 text-[13px] text-muted">
          {warmingUp
            ? `평소 깜빡임을 익히는 중입니다 — ${Math.round((verdict.progress ?? 0) * 100)}%`
            : state === 'low_quality'
              ? '눈이 잡히지 않아 판정을 보류합니다'
              : '판정할 수 없습니다'}
        </p>
      )}

      {/* 값이 없으면 0 을 쓰지 않고 — 로 둔다 (README §2). */}
      <dl className="mt-4 grid grid-cols-3 gap-3 border-t-[0.5px] border-gold/10 pt-3">
        <Evidence label="재개안" metric={pick('reopen_ms')} stale={stale} suffix="ms" digits={0} />
        <Evidence label="깜빡임" metric={pick('blink_dur')} stale={stale} suffix="ms" digits={0} />
        <Evidence label="빈도" metric={pick('blink_rate')} stale={stale} suffix="/분" digits={0} />
        <Evidence label="고개" metric={pick('head_drop')} stale={stale} suffix="%" digits={1} />
        <Evidence label="추세" metric={pick('drowsy_trend')} stale={stale} suffix="/분" digits={1} />
        <Evidence label="눈감김" metric={pick('perclos')} stale={stale} suffix="%" digits={1} late />
      </dl>

      <p className="kr mt-3 text-[12px] leading-relaxed text-faint">
        고개는 눈꺼풀과 무관한 유일한 채널입니다. 눈감김은 늦게 오르는 지표라 무게를
        낮췄고, 추세가 가파르면 임계 아래에서도 주의로 올립니다.
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
  late = false,
}: {
  label: string
  metric: Metric | undefined
  stale: boolean
  suffix: string
  digits: number
  /** 후행 지표. 앞의 둘과 같은 무게로 읽히면 안 되므로 라벨을 흐리게 둔다. */
  late?: boolean
}) {
  const value =
    !metric || stale || typeof metric.value !== 'number' ? null : metric.value.toFixed(digits)

  return (
    <div>
      <dt className={`kr text-[12px] ${late ? 'text-faint/70' : 'text-faint'}`}>{label}</dt>
      <dd className="mt-0.5 flex items-baseline gap-1">
        <span
          className={`tnum text-[15px] font-light ${value === null ? 'text-faint/50' : 'text-fg'}`}
        >
          {value ?? '—'}
        </span>
        {value !== null && (
          <span className="font-mono text-[10px] tracking-[0.08em] text-gold">{suffix}</span>
        )}
      </dd>
    </div>
  )
}

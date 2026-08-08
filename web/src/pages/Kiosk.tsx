import { Activity } from 'lucide-react'
import { InterventionLog } from '../components/InterventionLog'
import { MetricCard } from '../components/MetricCard'
import { SignalBanner } from '../components/SignalBanner'
import { StateBadge } from '../components/StateBadge'
import { TrendChart } from '../components/TrendChart'
import { ICON, LABEL, STATE_LABEL, displayValue, effectiveState } from '../metrics'
import { useFeed } from '../snapshotContext'

// 기기 옆 대형 화면. 몇 걸음 떨어져 읽는다는 전제로 주지표 하나를 크게 세우고
// 나머지는 오른쪽에 모은다.
//
// 폭에 상한(max-w-shell)을 두는 이유: 상한이 없으면 초광폭 모니터에서 주지표가
// 좌상단에 홀로 남고 화면 가운데가 통째로 비어 버린다.

const HERO_KEY = 'hr'

export function Kiosk() {
  const { snapshot, history, stale } = useFeed()

  if (!snapshot) {
    return (
      <main className="flex flex-1 items-center justify-center">
        <p className="kr animate-measuring text-sm text-muted">서버 연결 대기 중</p>
      </main>
    )
  }

  const hero = snapshot.metrics.find((m) => m.key === HERO_KEY) ?? snapshot.metrics[0]
  const rest = snapshot.metrics.filter((m) => m !== hero)
  const heroState = hero ? effectiveState(hero, stale) : 'no_adapter'
  const heroValue = hero ? displayValue(hero, stale) : null
  const HeroIcon = hero ? (ICON[hero.key] ?? Activity) : Activity
  const confidence = !stale && hero ? hero.confidence : null

  return (
    <>
      <main className="mx-auto flex w-full max-w-shell flex-1 flex-col gap-8 px-6 py-8 md:px-10 lg:grid lg:grid-cols-[minmax(0,1fr)_380px] lg:items-center lg:gap-12">
        {/* 주지표는 위, 추세는 남는 높이를 전부 먹는다. 그래야 오른쪽 사이드바와
            윗줄이 맞고 왼쪽 열에 빈 구멍이 생기지 않는다. */}
        <section className="hero-glow relative flex min-w-0 flex-col gap-8 lg:self-stretch">
          <div className="relative z-10">
            <div className="mb-5 flex flex-wrap items-center gap-3">
              <span className="kr flex items-center gap-2 text-[15px] font-medium text-gold">
                <HeroIcon className="h-4 w-4" />
                {hero ? (LABEL[hero.key] ?? hero.key) : '지표 없음'}
              </span>
              {hero && <StateBadge mode={hero.mode} state={heroState} />}
            </div>

            <div className="flex items-baseline gap-4">
              {heroValue === null ? (
                <span className="animate-measuring text-[clamp(3.5rem,min(9vw,18vh),12rem)] leading-[0.85] font-thin text-faint/50">
                  —
                </span>
              ) : (
                <>
                  {/* 계기판처럼 읽히도록 얇은 산세리프 + 고정폭 숫자. 값이 바뀔 때
                      자릿수가 흔들리지 않아야 한다. */}
                  <span className="tnum text-[clamp(4.5rem,min(13vw,26vh),20rem)] leading-[0.9] font-extralight tracking-[-0.045em] text-fg">
                    {heroValue}
                  </span>
                  {hero?.unit && (
                    <span className="font-mono text-xl tracking-[0.1em] text-gold sm:text-3xl">
                      {hero.unit}
                    </span>
                  )}
                </>
              )}
            </div>

            {heroValue === null && (
              <p className="kr mt-5 text-lg font-light text-muted sm:text-xl">
                {STATE_LABEL[heroState]} — 값을 표시하지 않는다
              </p>
            )}

            {/* 신뢰도. 값이 없으면 비운다. 임의의 숫자로 채우지 않는다. */}
            <div className="mt-10 w-full max-w-lg">
              <div className="mb-2 flex justify-between font-mono text-[10px] tracking-[0.22em] text-faint uppercase">
                <span>confidence</span>
                <span className="tnum text-muted">
                  {confidence === null ? '—' : `${Math.round(confidence * 100)}%`}
                </span>
              </div>
              <div className="h-[3px] w-full overflow-hidden rounded-full bg-white/5">
                <div
                  className="h-full rounded-full bg-gold transition-all duration-700"
                  style={{ width: confidence === null ? '0%' : `${confidence * 100}%` }}
                />
              </div>
            </div>
          </div>

          <div className="relative z-10 h-[clamp(220px,36vh,460px)] lg:h-auto lg:min-h-56 lg:flex-1">
            <TrendChart history={history} metricKey={hero?.key ?? HERO_KEY} stale={stale} />
          </div>
        </section>

        {/* 오른쪽: 나머지 지표. 세로선이 왼쪽 열 전체 높이를 따라가도록 늘리고,
            카드는 위에서부터 쌓아 주지표 라벨과 눈높이를 맞춘다. */}
        <section className="flex flex-col gap-3 border-t-[0.5px] border-gold/15 pt-6 lg:self-stretch lg:justify-start lg:border-t-0 lg:border-l-[0.5px] lg:pt-1 lg:pl-12">
          <h2 className="kr mb-1 text-[12px] font-medium text-muted">보조 지표</h2>
          {rest.map((metric) => (
            <MetricCard key={`${metric.source}:${metric.key}`} metric={metric} stale={stale} />
          ))}
          <div className="mt-1">
            <InterventionLog events={snapshot.interventions} />
          </div>
        </section>
      </main>

      <SignalBanner state={heroState} />

      <footer className="border-t-[0.5px] border-gold/15">
        <div className="kr mx-auto flex w-full max-w-shell items-center justify-between px-6 py-3 text-[11px] text-faint md:px-10">
          <span className="tnum">
            지표 {snapshot.metrics.length} · 이력 {history.length}틱
          </span>
          <span className="tnum">개입 {snapshot.interventions.length}건</span>
        </div>
      </footer>
    </>
  )
}

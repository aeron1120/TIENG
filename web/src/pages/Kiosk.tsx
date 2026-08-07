import { Activity } from 'lucide-react'
import { MetricCard } from '../components/MetricCard'
import { SignalBanner } from '../components/SignalBanner'
import { StateBadge } from '../components/StateBadge'
import { TrendChart } from '../components/TrendChart'
import { useSnapshot } from '../hooks/useSnapshot'
import { ICON, LABEL, STATE_LABEL, displayValue, effectiveState } from '../metrics'

// 기기 옆 대형 화면. 몇 걸음 떨어져 읽는다는 전제로 주지표 하나를 크게 세우고
// 나머지는 오른쪽에 모은다 (tieng_stitch KioskView 레이아웃).

const HERO_KEY = 'hr'

export function Kiosk() {
  const { snapshot, history, stale } = useSnapshot()

  if (!snapshot) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-ink">
        <p className="animate-measuring font-mono text-sm tracking-widest text-muted uppercase">
          서버 연결 대기 중…
        </p>
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
    <div className="flex min-h-screen flex-col bg-ink font-sans text-fg select-none">
      <header className="hairline-b z-20 flex items-center justify-between border-gold/20 px-6 py-4 md:px-12">
        <div className="flex items-center gap-3 font-mono text-xs tracking-[0.3em] text-gold uppercase">
          <Activity className="h-4 w-4" />
          <span>VITAL_MONITOR_SYS</span>
          <span className="tracking-normal text-muted">[{snapshot.device_id}]</span>
        </div>
        <div className="flex items-center gap-2 font-mono text-xs tracking-wider text-muted uppercase">
          <span
            className={`h-2.5 w-2.5 rounded-full ${
              stale ? 'bg-muted' : 'animate-pulse bg-gold'
            }`}
          />
          <span>
            {stale ? '수신 끊김' : new Date(snapshot.ts).toLocaleTimeString('ko-KR')}
          </span>
        </div>
      </header>

      <main className="flex flex-1 flex-col gap-8 px-6 py-8 md:px-12 lg:flex-row">
        {/* 왼쪽: 주지표 하나를 크게 */}
        <section className="flex flex-1 flex-col justify-between lg:pr-8">
          <div className="flex flex-1 flex-col justify-center">
            <div className="mb-4 flex items-center gap-3">
              <span className="font-mono text-xs tracking-[0.3em] text-gold uppercase">
                {hero ? (LABEL[hero.key] ?? hero.key) : '지표 없음'}
              </span>
              <HeroIcon className="h-4 w-4 text-gold" />
              {hero && <StateBadge mode={hero.mode} state={heroState} />}
            </div>

            <div className="flex items-baseline gap-4">
              {heroValue === null ? (
                <span className="animate-measuring font-serif text-7xl leading-none font-extralight tracking-tight text-muted/60 sm:text-9xl">
                  —
                </span>
              ) : (
                <>
                  <span className="font-serif text-7xl leading-none font-light tracking-tight text-fg sm:text-9xl lg:text-[170px]">
                    {heroValue}
                  </span>
                  {hero?.unit && (
                    <span className="font-mono text-xl text-gold sm:text-3xl">{hero.unit}</span>
                  )}
                </>
              )}
            </div>

            {heroValue === null && (
              <p className="mt-4 font-sans text-xl font-light text-muted sm:text-2xl">
                {STATE_LABEL[heroState]} — 값을 표시하지 않는다
              </p>
            )}

            {/* 신뢰도. 값이 없으면 없다고 그린다. 임의의 숫자로 채우지 않는다. */}
            <div className="mt-6 w-full max-w-md">
              <div className="mb-1.5 flex justify-between font-mono text-xs text-muted">
                <span>CONFIDENCE</span>
                <span>{confidence === null ? '—' : `${Math.round(confidence * 100)}%`}</span>
              </div>
              <div className="hairline h-1 w-full overflow-hidden rounded-full border-gold/20 bg-panel">
                <div
                  className="h-full bg-gold transition-all duration-500"
                  style={{ width: confidence === null ? '0%' : `${confidence * 100}%` }}
                />
              </div>
            </div>
          </div>

          <div className="mt-6">
            <TrendChart history={history} metricKey={hero?.key ?? HERO_KEY} stale={stale} />
          </div>
        </section>

        {/* 오른쪽: 나머지 지표 */}
        <section className="hairline-t flex w-full flex-col gap-3.5 border-gold/20 pt-6 lg:hairline-l lg:w-96 lg:border-t-0 lg:pt-0 lg:pl-8">
          {rest.map((metric) => (
            <MetricCard key={`${metric.source}:${metric.key}`} metric={metric} stale={stale} />
          ))}
        </section>
      </main>

      <SignalBanner state={heroState} />

      <footer className="hairline-t flex items-center justify-between border-gold/20 px-6 py-2.5 font-mono text-[11px] tracking-widest text-muted uppercase md:px-12">
        <span>
          지표 {snapshot.metrics.length} · 이력 {history.length}틱
        </span>
        <span>{snapshot.interventions.length}건 개입 기록</span>
      </footer>
    </div>
  )
}

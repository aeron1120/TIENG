import { Activity } from 'lucide-react'
import { useState } from 'react'
import { CameraPanel } from '../components/CameraPanel'
import { InterventionLog } from '../components/InterventionLog'
import { MetricCard } from '../components/MetricCard'
import { SignalBanner } from '../components/SignalBanner'
import { StateBadge } from '../components/StateBadge'
import { TrendChart } from '../components/TrendChart'
import { useLayout } from '../hooks/useLayout'
import { ICON, LABEL, STATE_LABEL, displayValue, effectiveState, isWarmingUp } from '../metrics'
import { useFeed } from '../snapshotContext'
import type { Metric } from '../types'

// 기기 옆 대형 화면. 몇 걸음 떨어져 읽는다는 전제로 주지표 하나를 크게 세우고
// 나머지는 오른쪽에 블록으로 모은다.
//
// 어느 지표를 크게 볼지는 고정이 아니다. 블록을 누르면 그 지표가 위로 올라오고
// 아래 그래프도 같이 바뀐다. 순서는 끌어서 바꾼다. 심박수만 크게 보고 싶은 방이
// 있고 조도를 크게 보고 싶은 방이 있는데, 그걸 코드에 박아 둘 이유가 없다.
//
// 폭에 상한(max-w-shell)을 두는 이유: 상한이 없으면 초광폭 모니터에서 주지표가
// 좌상단에 홀로 남고 화면 가운데가 통째로 비어 버린다.

export function Kiosk() {
  const { snapshot, history, stale } = useFeed()
  const { layout, save, saveError } = useLayout()
  // 드래그 중에는 서버에 쓰지 않는다. 지나가는 칸마다 PUT 을 날리면 한 번
  // 끌 때마다 파일을 수십 번 덮어쓴다.
  const [dragKey, setDragKey] = useState<string | null>(null)
  const [draft, setDraft] = useState<string[] | null>(null)

  if (!snapshot) {
    return (
      <main className="flex flex-1 items-center justify-center">
        <p className="kr animate-measuring text-sm text-muted">서버 연결 대기 중</p>
      </main>
    )
  }

  const hero = snapshot.metrics.find((m) => m.key === layout.hero) ?? snapshot.metrics[0]
  const blocks = sortBlocks(snapshot.metrics, draft ?? layout.order, hero?.key)
  const keys = blocks.map((m) => m.key)

  const heroState = hero ? effectiveState(hero, stale) : 'no_adapter'
  const heroValue = hero ? displayValue(hero, stale) : null
  const warmingUp = hero ? isWarmingUp(hero, stale) : false
  const HeroIcon = hero ? (ICON[hero.key] ?? Activity) : Activity
  const confidence = !stale && hero ? hero.confidence : null

  const promote = (key: string) => {
    if (!hero || key === hero.key) return
    // 내려온 주지표는 블록 맨 위로 보낸다. 방금까지 보던 지표가 목록 어딘가로
    // 사라지면 다시 찾아야 한다.
    save({ hero: key, order: [hero.key, ...keys.filter((k) => k !== key)] })
  }

  const finishDrag = () => {
    if (draft) save({ hero: layout.hero, order: draft })
    setDraft(null)
    setDragKey(null)
  }

  return (
    <>
      <main className="mx-auto flex w-full max-w-shell flex-1 flex-col gap-8 px-6 py-8 md:px-10 lg:grid lg:grid-cols-[minmax(0,1fr)_360px] lg:items-center lg:gap-12">
        {/* 주지표는 위, 추세는 남는 높이를 전부 먹는다. 그래야 오른쪽 사이드바와
            윗줄이 맞고 왼쪽 열에 빈 구멍이 생기지 않는다. */}
        <section className="hero-glow relative flex min-w-0 flex-col gap-8 lg:self-stretch">
          {/* 카메라를 큰 숫자 옆에 둔다. 사이드바에 넣으면 보조 지표가 화면 아래로
              밀려 스크롤이 생기고, 여기는 어차피 비어 있던 자리다. 값이 왜 보류
              중인지 확인할 때 숫자와 얼굴을 같이 봐야 한다는 점도 맞아떨어진다. */}
          <div className="relative z-10 flex flex-wrap items-start justify-between gap-x-10 gap-y-6">
            <div className="min-w-0 flex-1">
              <div className="mb-5 flex flex-wrap items-center gap-3">
                <span className="kr flex items-center gap-2 text-[15px] font-medium text-gold">
                  <HeroIcon className="h-4 w-4" />
                  {hero ? (LABEL[hero.key] ?? hero.key) : '지표 없음'}
                </span>
                {hero && (
                  <StateBadge mode={hero.mode} state={heroState} warmingUp={warmingUp} />
                )}
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
                  {warmingUp
                    ? '측정을 준비하고 있습니다 — 곧 값이 나옵니다'
                    : `${STATE_LABEL[heroState]} — 값을 표시하지 않습니다`}
                </p>
              )}

              {/* 막대 하나가 두 가지를 번갈아 보여준다. 준비 중에는 신뢰도가 아직
                  뜻이 없고, 준비가 끝나면 진행률이 뜻이 없다. 둘을 같이 띄우면
                  어느 쪽을 봐야 하는지 매번 판단해야 한다. */}
              <div className="mt-10 w-full max-w-lg">
                <div className="mb-2 flex justify-between font-mono text-[10px] tracking-[0.22em] text-faint uppercase">
                  <span>{warmingUp ? 'preparing' : 'confidence'}</span>
                  <span className="tnum text-muted">
                    {warmingUp
                      ? `${Math.round((hero?.progress ?? 0) * 100)}%`
                      : confidence === null
                        ? '—'
                        : `${Math.round(confidence * 100)}%`}
                  </span>
                </div>
                <div className="h-[3px] w-full overflow-hidden rounded-full bg-white/5">
                  <div
                    className={`h-full rounded-full transition-all duration-700 ${
                      warmingUp ? 'animate-measuring bg-gold-soft' : 'bg-gold'
                    }`}
                    style={{
                      width: warmingUp
                        ? `${(hero?.progress ?? 0) * 100}%`
                        : confidence === null
                          ? '0%'
                          : `${confidence * 100}%`,
                    }}
                  />
                </div>
              </div>
            </div>

            <div className="w-full max-w-[300px] shrink-0">
              <CameraPanel />
            </div>
          </div>

          <div className="relative z-10 h-[clamp(220px,36vh,460px)] lg:h-auto lg:min-h-56 lg:flex-1">
            <TrendChart history={history} metricKey={hero?.key ?? layout.hero} stale={stale} />
          </div>
        </section>

        {/* 오른쪽: 나머지 지표. 세로선이 왼쪽 열 전체 높이를 따라가도록 늘리고,
            블록은 위에서부터 쌓아 주지표 라벨과 눈높이를 맞춘다. */}
        <section className="flex flex-col gap-3 border-t-[0.5px] border-gold/15 pt-6 lg:self-stretch lg:justify-start lg:border-t-0 lg:border-l-[0.5px] lg:pt-1 lg:pl-12">
          <div className="flex items-baseline justify-between gap-2">
            <h2 className="kr text-[12px] font-medium text-muted">보조 지표</h2>
            <span className="kr text-[10px] text-faint">눌러서 크게 · 끌어서 순서</span>
          </div>

          {saveError && (
            <p className="kr text-[11px] text-alert">배치를 저장하지 못했다 — {saveError}</p>
          )}

          {blocks.map((metric) => (
            <MetricCard
              key={`${metric.source}:${metric.key}`}
              metric={metric}
              stale={stale}
              onSelect={() => promote(metric.key)}
              drag={{
                dragging: dragKey === metric.key,
                onStart: () => setDragKey(metric.key),
                onEnter: () => {
                  if (dragKey && dragKey !== metric.key) {
                    setDraft(move(keys, dragKey, metric.key))
                  }
                },
                onEnd: finishDrag,
              }}
            />
          ))}

          <div className="mt-1">
            <InterventionLog events={snapshot.interventions} />
          </div>
        </section>
      </main>

      <SignalBanner state={heroState} warmingUp={warmingUp} />

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

/**
 * 저장된 순서대로 블록을 세운다.
 *
 * order 에 없는 지표는 뒤에 붙이고 (센서를 새로 꽂아도 기존 배치가 안 흔들린다),
 * order 에 있지만 지금 안 오는 지표는 저절로 빠진다.
 */
function sortBlocks(metrics: Metric[], order: string[], heroKey: string | undefined): Metric[] {
  const rank = new Map(order.map((key, i) => [key, i]))
  return metrics
    .filter((m) => m.key !== heroKey)
    .map((m, i) => ({ m, rank: rank.get(m.key) ?? order.length + i }))
    .sort((a, b) => a.rank - b.rank)
    .map((entry) => entry.m)
}

/** from 을 빼서 to 자리에 끼워 넣는다. */
function move(keys: string[], from: string, to: string): string[] {
  const next = keys.filter((key) => key !== from)
  const at = next.indexOf(to)
  next.splice(at < 0 ? next.length : at, 0, from)
  return next
}

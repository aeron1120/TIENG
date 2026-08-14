import { Activity } from 'lucide-react'
import { useState } from 'react'
import { CameraPanel } from '../components/CameraPanel'
import { InterventionLog } from '../components/InterventionLog'
import { MetricCard } from '../components/MetricCard'
import { SignalBanner } from '../components/SignalBanner'
import { StateBadge } from '../components/StateBadge'
import { TrendChart } from '../components/TrendChart'
import { useLayout } from '../hooks/useLayout'
import {
  ICON,
  LABEL,
  STATE_LABEL,
  displayValue,
  effectiveState,
  isDetached,
  isWarmingUp,
} from '../metrics'
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

/** 주지표 자리에 카메라를 세울 때 쓰는 키. 지표 키와 겹치지 않는다. */
const CAMERA = 'camera'

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

  // 카메라도 주지표 자리에 설 수 있다. 얼굴을 상자에 맞추는 일은 사이드바 크기에서
  // 하기 어려워서, 지표와 같은 방식으로 크게 볼 수 있어야 한다. layout.hero 는 서버가
  // 화이트리스트로 막지 않으므로 (core/layout.py) 이 값을 그대로 저장할 수 있다.
  const cameraHero = layout.hero === CAMERA
  const hero = cameraHero ? undefined : pickHero(snapshot.metrics, layout.hero, layout.order, stale)
  const blocks = sortBlocks(snapshot.metrics, draft ?? layout.order, hero?.key, stale)
  const keys = blocks.map((m) => m.key)

  const heroState = hero ? effectiveState(hero, stale) : 'no_adapter'
  const heroValue = hero ? displayValue(hero, stale) : null
  const warmingUp = hero ? isWarmingUp(hero, stale) : false
  const HeroIcon = hero ? (ICON[hero.key] ?? Activity) : Activity
  const confidence = !stale && hero ? hero.confidence : null

  /** 카메라를 큰 자리로 보내거나, 거기 있으면 원래 보던 지표로 되돌린다.
   *
   * 되돌릴 지표는 order 맨 앞이다. 카메라를 올릴 때 내려온 주지표를 그 자리에
   * 넣어 두므로 (promote), 누른 사람이 직전에 보던 것으로 돌아간다. */
  const toggleCamera = () => {
    if (!cameraHero) {
      promote(CAMERA)
      return
    }
    const back = layout.order.find((key) => snapshot.metrics.some((m) => m.key === key))
    if (back) promote(back)
  }

  const promote = (key: string) => {
    if (key === layout.hero) return
    // 내려온 주지표는 블록 맨 위로 보낸다. 방금까지 보던 지표가 목록 어딘가로
    // 사라지면 다시 찾아야 한다. 카메라는 목록에 넣지 않는다 — 자리가 정해져 있다.
    const demoted = hero ? [hero.key] : []
    save({ hero: key, order: [...demoted, ...keys.filter((k) => k !== key)] })
  }

  const finishDrag = () => {
    if (draft) save({ hero: layout.hero, order: draft })
    setDraft(null)
    setDragKey(null)
  }

  return (
    <>
      {/* 초광폭에서는 사이드바를 넓혀 블록을 두 줄로 세운다. 글자를 키운 만큼
          카드가 높아져 한 줄로는 화면 밖으로 나간다. 벽에 거는 화면이라 스크롤이
          생기면 아래쪽 지표는 아무도 못 본다.

          overflow-clip 은 hero-glow 때문이다. 장식용 ::before 가 아래로 30% 삐져나와
          내용이 다 들어가는데도 200px 넘게 스크롤이 생겼다. 여기서 잘라도 그 지점은
          이미 투명해서 보이는 건 그대로다. (clip 은 hidden 과 달리 스크롤 컨테이너를
          만들지 않는다.) */}
      <main className="mx-auto flex w-full max-w-shell flex-1 flex-col gap-8 overflow-clip px-6 py-8 md:px-10 lg:grid lg:grid-cols-[minmax(0,1fr)_360px] lg:items-center lg:gap-12 2xl:grid-cols-[minmax(0,1fr)_620px]">
        {/* 주지표는 위, 추세는 남는 높이를 전부 먹는다. 그래야 오른쪽 사이드바와
            윗줄이 맞고 왼쪽 열에 빈 구멍이 생기지 않는다. */}
        <section className="hero-glow relative flex min-w-0 flex-col gap-8 lg:self-stretch">
          {cameraHero ? (
            /* 카메라가 주지표 자리에 섰다. 지표로 돌아가려면 오른쪽 블록을 누르면 된다. */
            <div className="relative z-10 min-h-[clamp(320px,50vh,700px)] lg:flex-1">
              <CameraPanel variant="hero" onToggle={toggleCamera} />
            </div>
          ) : (
          <>
          <div className="relative z-10">
              <div className="mb-5 flex flex-wrap items-center gap-3">
                <span className="kr flex items-center gap-2 text-[18px] font-medium text-gold">
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
                <div className="mb-2 flex justify-between font-mono text-[12px] tracking-[0.22em] text-faint uppercase">
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

          <div className="relative z-10 h-[clamp(220px,36vh,460px)] lg:h-auto lg:min-h-56 lg:flex-1">
            <TrendChart history={history} metricKey={hero?.key ?? layout.hero} stale={stale} />
          </div>
          </>
          )}
        </section>

        {/* 오른쪽: 나머지 지표. 세로선이 왼쪽 열 전체 높이를 따라가도록 늘리고,
            블록은 위에서부터 쌓아 주지표 라벨과 눈높이를 맞춘다. */}
        <section className="flex flex-col gap-3 border-t-[0.5px] border-gold/15 pt-6 lg:self-stretch lg:justify-start lg:border-t-0 lg:border-l-[0.5px] lg:pt-1 lg:pl-12">
          <div className="flex items-baseline justify-between gap-2">
            <h2 className="kr text-[15px] font-medium text-muted">보조 지표</h2>
            <span className="kr text-[12px] text-faint">눌러서 크게 · 끌어서 순서</span>
          </div>

          {saveError && (
            <p className="kr text-[13px] text-alert">배치를 저장하지 못했습니다 — {saveError}</p>
          )}

          {/* 카메라는 사이드바 안이다. 큰 숫자 옆에 두면 초광폭에서 단위(bpm)를
              가리고, 사이드바는 두 줄이 된 뒤로 아래쪽이 통째로 비어 있었다.
              맨 뒤에 두는 이유: 카메라가 카드보다 높아서 같은 줄에 선 카드가
              덩달아 늘어난다. 마지막 줄에 혼자 두면 늘어날 짝이 없다. */}
          <div className="grid gap-3 2xl:grid-cols-2">
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
            {!cameraHero && (
              <div className="2xl:col-span-2">
                <CameraPanel onToggle={toggleCamera} />
              </div>
            )}
          </div>

          <div className="mt-1">
            <InterventionLog events={snapshot.interventions} />
          </div>
        </section>
      </main>

      <SignalBanner state={heroState} warmingUp={warmingUp} />

      <footer className="border-t-[0.5px] border-gold/15">
        <div className="kr mx-auto flex w-full max-w-shell items-center justify-between px-6 py-3 text-[13px] text-faint md:px-10">
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
 * 크게 세울 지표.
 *
 * 저장된 선택이 먼저다. 다만 그 지표의 어댑터가 안 붙어 있으면 화면 한가운데가
 * 커다란 "—" 하나로 남는다 — 센서 없이 브라우저 카메라만 켠 경우가 그렇다.
 * 그때는 값이 나오는 지표로 임시 승격한다.
 *
 * 저장하지는 않는다. 센서가 돌아오면 원래 고른 지표로 그대로 되돌아가야 한다.
 */
function pickHero(
  metrics: Metric[],
  saved: string,
  order: string[],
  stale: boolean,
): Metric | undefined {
  const chosen = metrics.find((m) => m.key === saved)
  if (chosen && !isDetached(chosen, stale)) return chosen

  const rank = new Map(order.map((key, i) => [key, i]))
  const alive = metrics
    .filter((m) => !isDetached(m, stale))
    .sort((a, b) => (rank.get(a.key) ?? order.length) - (rank.get(b.key) ?? order.length))
  return alive[0] ?? chosen ?? metrics[0]
}

/**
 * 블록 순서. 값이 나오는 카드를 위로 올리고, 그 안에서는 저장된 순서를 지킨다.
 *
 * 안 붙은 카드를 지우지 않는 이유: 이 기기가 무엇을 볼 수 있는 물건인지가 카드
 * 목록으로 드러난다. 센서를 꽂으면 그 자리가 그대로 채워진다.
 *
 * order 에 없는 지표는 뒤에 붙이고 (센서를 새로 꽂아도 기존 배치가 안 흔들린다),
 * order 에 있지만 지금 안 오는 지표는 저절로 빠진다.
 */
function sortBlocks(
  metrics: Metric[],
  order: string[],
  heroKey: string | undefined,
  stale: boolean,
): Metric[] {
  const rank = new Map(order.map((key, i) => [key, i]))
  return metrics
    .filter((m) => m.key !== heroKey)
    .map((m, i) => ({
      m,
      detached: isDetached(m, stale) ? 1 : 0,
      rank: rank.get(m.key) ?? order.length + i,
    }))
    .sort((a, b) => a.detached - b.detached || a.rank - b.rank)
    .map((entry) => entry.m)
}

/** from 을 빼서 to 자리에 끼워 넣는다. */
function move(keys: string[], from: string, to: string): string[] {
  const next = keys.filter((key) => key !== from)
  const at = next.indexOf(to)
  next.splice(at < 0 ? next.length : at, 0, from)
  return next
}

import { AlertTriangle, Power, ShieldAlert } from 'lucide-react'
import { useEffect, useState } from 'react'
import { CameraPanel } from '../components/CameraPanel'
import { DrowsinessPanel } from '../components/DrowsinessPanel'
import { Page } from '../components/Page'
import { TrendChart } from '../components/TrendChart'
import { useGet, usePost } from '../hooks/useApi'
import { DROWSINESS_LABEL, DROWSINESS_TONE } from '../metrics'
import { useFeed } from '../snapshotContext'

// 졸음 방지 전용 화면. 실시간 화면과 나눈 이유는 보는 사람이 다르기 때문이다 —
// 저기는 벽에 걸어 두고 지나가며 보는 화면이고, 여기는 운전 전에 켜 두고
// "지금 내 상태가 어떤가"를 보는 화면이다.
//
// 그래서 점수와 그 추이를 크게 세운다. 목표가 졸음 **직전**을 잡는 것이라, 판정이
// 바뀌기 전에 점수가 차오르는 게 보여야 한다.

interface ModeInfo {
  mode: string
  available: string[]
}

export function Drowsy() {
  const { snapshot, history, stale } = useFeed()
  const modeApi = useGet<ModeInfo>('/api/mode')
  const switching = usePost<{ mode: string }>('/api/mode')
  const [mode, setMode] = useState<string | null>(null)

  useEffect(() => {
    if (modeApi.data) setMode(modeApi.data.mode)
  }, [modeApi.data])
  useEffect(() => {
    if (switching.data) setMode(switching.data.mode)
  }, [switching.data])

  const on = mode === 'drowsy'
  const metrics = snapshot?.metrics ?? []
  const verdict = metrics.find((m) => m.key === 'drowsiness')
  const key = stale || !verdict || verdict.value === null ? null : String(verdict.value)

  return (
    <Page title="졸음 방지" description="눈꺼풀 움직임으로 졸음 직전을 먼저 잡습니다">
      <div className="flex flex-col gap-6">
        {/* 모드 스위치. 켜면 심박 측정을 쉬게 하고 카메라와 CPU 를 이쪽에 몰아준다. */}
        <section className="border-[0.5px] border-gold/15 bg-panel/60 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="kr flex items-center gap-2 text-[15px] font-medium text-fg">
                <Power className={`h-4 w-4 ${on ? 'text-gold' : 'text-faint'}`} />
                졸음 방지 모드 {on ? '켜짐' : '꺼짐'}
              </p>
              <p className="kr mt-1 text-[13px] leading-relaxed text-muted">
                {on
                  ? '심박 측정을 쉬게 하고 카메라 프레임을 졸음 쪽에 몰아주고 있습니다.'
                  : '지금은 심박과 졸음을 함께 재고 있습니다. 켜면 졸음 쪽 정확도가 올라갑니다.'}
              </p>
            </div>
            <button
              onClick={() => switching.send({ mode: on ? 'vitals' : 'drowsy' })}
              disabled={switching.loading || mode === null}
              className={`kr shrink-0 rounded border-[0.5px] px-4 py-2 text-[14px] transition-colors disabled:opacity-40 ${
                on
                  ? 'border-gold/40 bg-gold/10 text-gold hover:bg-gold/20'
                  : 'border-gold/25 text-muted hover:bg-white/[0.06] hover:text-gold'
              }`}
            >
              {switching.loading ? '바꾸는 중' : on ? '끄기' : '켜기'}
            </button>
          </div>
          {switching.error && (
            <p className="kr mt-2 text-[13px] text-alert">바꾸지 못했습니다 — {switching.error}</p>
          )}
          {on && (
            <p className="kr mt-3 flex items-start gap-2 border-t-[0.5px] border-gold/10 pt-3 text-[12px] leading-relaxed text-faint">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              눈깜빡임은 100~400ms 라 프레임률이 곧 정확도입니다. 그래서 켜는 동안
              심박 카드는 값을 내지 않습니다.
            </p>
          )}
        </section>

        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
          <section className="flex min-w-0 flex-col gap-4">
            {/* 큰 판정 하나. 몇 걸음 떨어져서도 읽혀야 한다. */}
            <div className="border-[0.5px] border-gold/15 bg-panel/60 p-6">
              <div className="flex items-center gap-2 font-mono text-[11px] tracking-[0.2em] text-faint uppercase">
                <ShieldAlert className="h-3.5 w-3.5" />
                현재 판정
              </div>
              <p
                className={`mt-3 text-[clamp(2.5rem,7vw,5rem)] leading-none font-extralight tracking-[-0.04em] ${
                  key ? (DROWSINESS_TONE[key] ?? 'text-faint') : 'text-faint/50'
                }`}
              >
                {key ? (DROWSINESS_LABEL[key] ?? key) : '—'}
              </p>
            </div>

            {/* 점수 추이. 판정이 바뀌기 전에 점수가 오르는 게 보여야 조기 경보다. */}
            <div className="h-[clamp(200px,32vh,380px)] border-[0.5px] border-gold/15 bg-panel/60 p-4">
              <p className="kr mb-2 text-[13px] text-muted">졸음 점수 추이</p>
              <div className="h-[calc(100%-1.75rem)]">
                <TrendChart history={history} metricKey="drowsy_score" stale={stale} />
              </div>
            </div>
          </section>

          <section className="flex flex-col gap-4">
            <DrowsinessPanel metrics={metrics} stale={stale} />
            <CameraPanel />
          </section>
        </div>
      </div>
    </Page>
  )
}

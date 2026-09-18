import { AlertTriangle, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useGet } from '../hooks/useApi'
import { ACTION_LABEL, LABEL, displayValue } from '../metrics'
import { useFeed } from '../snapshotContext'

// 되돌릴 수 없는 개입은 바로 실행되지 않고 취소 창을 거친다. 그 창이 도는 동안
// 화면 어디에 있든 앞을 막고 뜬다 — 기록 페이지를 보던 중에 보호자에게 메일이
// 나가면 안 된다.
//
// 화면을 덮는 대신 판단에 필요한 값을 팝업 안에 같이 넣는다. 감시 화면을 가려
// 놓고 "보낼까요"라고 물으면 정작 무엇을 보고 판단해야 할지가 뒤에 숨는다.
//
// "되돌릴 수 없다"는 판단은 서버가 한다. 여기서 레벨을 하드코딩하면 정책을
// 추가할 때마다 프론트를 고쳐야 한다.

interface PolicyInfo {
  level: string
  reversible: boolean
  evaluate_after_s: number
}

export function PendingAlert() {
  const { snapshot, stale } = useFeed()
  const system = useGet<{ policies?: PolicyInfo[] }>('/api/system')
  const [now, setNow] = useState(() => Date.now())
  const [cancelling, setCancelling] = useState(false)
  const cancelRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 250)
    return () => window.clearInterval(timer)
  }, [])

  const irreversible = new Map(
    (system.data?.policies ?? []).filter((p) => !p.reversible).map((p) => [p.level, p]),
  )
  // accepted === null 은 "사용자 확인 대기 중"이다. 자동 개입(L1)도 null 이므로
  // 되돌릴 수 없는 정책의 것만 고른다.
  const pending = snapshot?.interventions.find(
    (e) => e.accepted === null && irreversible.has(e.level),
  )

  // 훅은 조기 반환보다 먼저 와야 한다.
  useEffect(() => {
    if (pending) cancelRef.current?.focus()
  }, [pending])

  if (!pending) return null

  const window_s = irreversible.get(pending.level)?.evaluate_after_s ?? 30
  const left = Math.max(0, window_s - (now - new Date(pending.ts).getTime()) / 1000)

  // 판단에 쓰인 지표의 지금 값. 뒤가 가려도 이걸 보고 정할 수 있어야 한다.
  const shown = Object.keys(pending.before)
    .map((key) => snapshot?.metrics.find((m) => m.key === key))
    .filter((m) => m !== undefined)

  const cancel = () => {
    setCancelling(true)
    fetch(`/api/interventions/${encodeURIComponent(pending.id)}/cancel`, { method: 'POST' })
      .finally(() => setCancelling(false))
  }

  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="pending-alert-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 px-6 backdrop-blur-sm"
    >
      <div className="w-full max-w-lg rounded-xl border-[0.5px] border-alert/50 bg-panel px-7 py-6 shadow-[0_0_60px_rgba(0,0,0,0.7)]">
        <div className="flex items-center gap-3">
          <AlertTriangle className="h-6 w-6 shrink-0 text-alert" />
          <h2 id="pending-alert-title" className="kr text-xl font-medium text-alert">
            {left > 0
              ? `${Math.ceil(left)}초 뒤 ${ACTION_LABEL[pending.action] ?? pending.action}을 실행합니다`
              : '실행하는 중입니다'}
          </h2>
        </div>

        <p className="kr mt-3 text-[15px] leading-relaxed text-fg">{pending.trigger}</p>

        {shown.length > 0 && (
          <div className="mt-5 flex flex-wrap gap-x-8 gap-y-3 border-t-[0.5px] border-gold/15 pt-4">
            {shown.map((metric) => (
              <div key={metric.key}>
                <p className="kr text-[12px] text-faint">{LABEL[metric.key] ?? metric.key}</p>
                <p className="mt-1 flex items-baseline gap-1">
                  <span className="tnum text-[26px] leading-none font-light text-fg">
                    {displayValue(metric, stale) ?? '—'}
                  </span>
                  {metric.unit && (
                    <span className="font-mono text-[12px] text-muted">{metric.unit}</span>
                  )}
                </p>
              </div>
            ))}
          </div>
        )}

        {/* 남은 시간을 막대로도 보여준다. 숫자만 있으면 몇 걸음 떨어져서는 안 읽힌다. */}
        <div className="mt-6 h-[4px] w-full overflow-hidden rounded-full bg-white/10">
          <div
            className="h-full rounded-full bg-alert transition-[width] duration-200 ease-linear"
            style={{ width: `${(left / window_s) * 100}%` }}
          />
        </div>

        <div className="mt-5 flex items-center justify-between gap-4">
          <p className="kr text-[12px] text-faint">
            취소하면 보내지 않고 사유만 기록에 남습니다.
          </p>
          <button
            ref={cancelRef}
            onClick={cancel}
            disabled={cancelling || left <= 0}
            className="kr flex shrink-0 items-center gap-2 rounded-md border-[0.5px] border-alert/60 bg-alert/10 px-5 py-2.5 text-[15px] font-medium text-alert transition-colors hover:bg-alert/20 focus-visible:outline focus-visible:outline-2 focus-visible:outline-alert disabled:opacity-40"
          >
            <X className="h-4 w-4" />
            취소
          </button>
        </div>
      </div>
    </div>
  )
}

import { AlertTriangle, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useGet } from '../hooks/useApi'
import { ACTION_LABEL } from '../metrics'
import { useFeed } from '../snapshotContext'

// 되돌릴 수 없는 개입은 바로 실행되지 않고 취소 창을 거친다. 그 창이 도는 동안
// 화면 어디에 있든 보여야 한다 — 기록 페이지를 보던 중에 보호자에게 메일이
// 나가면 안 된다.
//
// "되돌릴 수 없다"는 판단은 서버가 한다. 여기서 레벨을 하드코딩하면 정책을
// 추가할 때마다 프론트를 고쳐야 한다.

interface PolicyInfo {
  level: string
  reversible: boolean
  evaluate_after_s: number
}

export function PendingAlert() {
  const { snapshot } = useFeed()
  const system = useGet<{ policies?: PolicyInfo[] }>('/api/system')
  const [now, setNow] = useState(() => Date.now())
  const [cancelling, setCancelling] = useState(false)

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
  if (!pending) return null

  const window_s = irreversible.get(pending.level)?.evaluate_after_s ?? 30
  const left = Math.max(0, window_s - (now - new Date(pending.ts).getTime()) / 1000)

  const cancel = () => {
    setCancelling(true)
    fetch(`/api/interventions/${encodeURIComponent(pending.id)}/cancel`, { method: 'POST' })
      .finally(() => setCancelling(false))
  }

  return (
    <div className="border-b-[0.5px] border-alert/40 bg-alert/[0.09]">
      <div className="mx-auto flex w-full max-w-shell flex-wrap items-center gap-x-5 gap-y-2 px-6 py-3 md:px-10">
        <AlertTriangle className="h-5 w-5 shrink-0 text-alert" />

        <div className="min-w-0 flex-1">
          <p className="kr text-[15px] font-medium text-alert">
            {left > 0
              ? `${Math.ceil(left)}초 뒤 ${ACTION_LABEL[pending.action] ?? pending.action}을 실행합니다`
              : '실행하는 중입니다'}
          </p>
          <p className="kr mt-0.5 text-[13px] text-muted">{pending.trigger}</p>
        </div>

        {/* 남은 시간을 막대로도 보여준다. 숫자만 있으면 몇 걸음 떨어져서는 안 읽힌다. */}
        <div className="h-[3px] w-40 shrink-0 overflow-hidden rounded-full bg-white/10">
          <div
            className="h-full rounded-full bg-alert transition-[width] duration-200 ease-linear"
            style={{ width: `${(left / window_s) * 100}%` }}
          />
        </div>

        <button
          onClick={cancel}
          disabled={cancelling || left <= 0}
          className="kr flex shrink-0 items-center gap-1.5 rounded-md border-[0.5px] border-alert/50 px-3.5 py-1.5 text-[14px] font-medium text-alert transition-colors hover:bg-alert/15 disabled:opacity-40"
        >
          <X className="h-4 w-4" />
          취소
        </button>
      </div>
    </div>
  )
}

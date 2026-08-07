import { AlertTriangle, WifiOff } from 'lucide-react'
import type { State } from '../types'

// upstream 배너에는 "Fix Signal" / "Recalibrate" 버튼이 있었지만 가져오지 않았다.
// 눌러서 신호가 좋아지는 장치가 없는데 버튼만 두면 거짓말이 된다. 상태만 알린다.

const MESSAGE: Partial<Record<State, string>> = {
  stale: '서버 수신이 끊겼다 · 표시된 값은 최신이 아니다',
  low_quality: '신호 품질이 기준에 못 미쳐 값을 보류하는 중',
  error: '어댑터에 오류가 발생했다',
  no_adapter: '연결된 어댑터가 없다',
}

export function SignalBanner({ state }: { state: State }) {
  const message = MESSAGE[state]
  if (!message) return null

  const severe = state === 'stale' || state === 'error'
  const Icon = state === 'stale' ? WifiOff : AlertTriangle

  return (
    <div
      className={`border-t-[0.5px] ${
        severe ? 'border-alert/30 bg-alert/[0.07]' : 'border-gold/30 bg-gold/[0.05]'
      }`}
    >
      <div
        className={`mx-auto flex w-full max-w-shell items-center gap-3 px-6 py-2.5 md:px-10 ${
          severe ? 'text-alert' : 'text-gold'
        }`}
      >
        <Icon className="h-3.5 w-3.5 shrink-0" />
        <span className="kr text-[12px] font-medium">{message}</span>
      </div>
    </div>
  )
}

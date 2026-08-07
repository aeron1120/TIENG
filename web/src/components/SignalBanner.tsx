import { AlertTriangle, WifiOff } from 'lucide-react'
import type { State } from '../types'

// upstream 배너에는 "Fix Signal" / "Recalibrate" 버튼이 있었지만 가져오지 않았다.
// 눌러서 신호가 좋아지는 장치가 없는데 버튼만 두면 거짓말이 된다. 상태만 알린다.

const MESSAGE: Partial<Record<State, string>> = {
  stale: '서버 수신이 끊겼다. 표시된 값은 최신이 아니다',
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
      className={`hairline-t flex w-full items-center justify-center gap-3 px-8 py-3 ${
        severe ? 'border-alert/40 bg-alert/10 text-alert' : 'border-gold/40 bg-[#1a160e] text-gold'
      }`}
    >
      <Icon className="h-4 w-4 shrink-0" />
      <span className="font-mono text-xs font-medium tracking-widest uppercase">{message}</span>
    </div>
  )
}

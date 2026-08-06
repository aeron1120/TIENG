import type { Mode, State } from '../types'

// 뱃지는 "이 숫자를 얼마나 믿어도 되는가"를 말한다. 값보다 먼저 눈에 들어와야 한다.
const MODE_LABEL: Record<Mode, string> = {
  live: '실측',
  simulated: '시뮬레이션',
  unavailable: '미연결',
}

const STATE_LABEL: Record<State, string> = {
  ok: '정상',
  low_quality: '품질 미달',
  stale: '수신 끊김',
  error: '오류',
  no_adapter: '어댑터 없음',
}

export function StateBadge({ mode, state }: { mode: Mode; state: State }) {
  return (
    <div className="badges">
      <span className={`badge mode-${mode}`}>{MODE_LABEL[mode]}</span>
      <span className={`badge state-${state}`}>{STATE_LABEL[state]}</span>
    </div>
  )
}

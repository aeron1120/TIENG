import { MODE_LABEL, STATE_LABEL } from '../metrics'
import type { Mode, State } from '../types'

// 뱃지는 "이 숫자를 얼마나 믿어도 되는가"를 말한다. 값보다 먼저 눈에 들어와야 한다.
// data-mode / data-state 는 스타일이 아니라 테스트가 잡는 고정 표식이다.

const MODE_TONE: Record<Mode, string> = {
  live: 'bg-gold/15 text-gold border-gold/40',
  simulated: 'bg-gold/5 text-gold-soft border-gold/25',
  unavailable: 'bg-transparent text-muted border-gold/20',
}

const STATE_TONE: Record<State, string> = {
  ok: 'bg-transparent text-muted border-gold/20',
  low_quality: 'bg-gold/10 text-gold border-gold/40',
  stale: 'bg-transparent text-muted border-muted/30',
  error: 'bg-alert/10 text-alert border-alert/40',
  no_adapter: 'bg-transparent text-muted border-gold/15',
}

const CHIP = 'shrink-0 px-1.5 py-0.5 rounded-full border font-mono whitespace-nowrap'

export function StateBadge({ mode, state }: { mode: Mode; state: State }) {
  return (
    <div className="flex shrink-0 items-center gap-1 text-[9px] sm:text-[10px]">
      <span data-mode={mode} className={`${CHIP} ${MODE_TONE[mode]}`}>
        {MODE_LABEL[mode]}
      </span>
      <span data-state={state} className={`${CHIP} ${STATE_TONE[state]}`}>
        {STATE_LABEL[state]}
      </span>
    </div>
  )
}

import { MODE_LABEL, STATE_LABEL } from '../metrics'
import type { Mode, State } from '../types'

// 뱃지는 "이 숫자를 얼마나 믿어도 되는가"를 말한다.
// state 가 ok 일 때는 칩을 그리지 않는다. 정상은 기본값이라 굳이 말할 필요가 없고,
// 모든 카드에 칩 두 개가 붙으면 진짜 이상한 카드가 묻힌다.
// data-mode / data-state 는 스타일이 아니라 테스트가 잡는 고정 표식이다.

const MODE_TONE: Record<Mode, string> = {
  live: 'bg-gold/15 text-gold border-gold/40',
  simulated: 'bg-gold/[0.06] text-gold-soft border-gold/25',
  unavailable: 'bg-transparent text-faint border-faint/25',
}

const STATE_TONE: Record<State, string> = {
  ok: '',
  low_quality: 'bg-gold/10 text-gold border-gold/40',
  stale: 'bg-transparent text-faint border-faint/25',
  error: 'bg-alert/10 text-alert border-alert/40',
  no_adapter: 'bg-transparent text-faint border-faint/20',
}

const CHIP =
  'shrink-0 rounded-full border px-2 py-[3px] font-mono text-[10px] leading-none tracking-wide whitespace-nowrap'

export function StateBadge({ mode, state }: { mode: Mode; state: State }) {
  return (
    <div className="flex shrink-0 items-center gap-1.5">
      <span data-mode={mode} className={`${CHIP} ${MODE_TONE[mode]}`}>
        {MODE_LABEL[mode]}
      </span>
      {state !== 'ok' && (
        <span data-state={state} className={`${CHIP} ${STATE_TONE[state]}`}>
          {STATE_LABEL[state]}
        </span>
      )}
    </div>
  )
}

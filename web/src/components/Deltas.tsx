import { deltaLabel } from '../metrics'

// 개입 전후로 무엇이 얼마나 움직였는지 (README §8). 실시간 화면과 기록 화면이
// 같은 CSV 행을 보므로 같은 모양으로 그린다 — 따로 그리면 한쪽에만 지표를
// 추가하고 지나간다.

export function Deltas({
  before,
  after,
  pending,
}: {
  before: Record<string, number>
  after: Record<string, number> | null
  /** 평가 창이 아직 안 끝났을 때 할 말. 지금 도는 개입과 지나간 기록은 다르다. */
  pending: string
}) {
  // after 가 없으면 없는 걸 0 으로 채우지 않는다 (README §0-4).
  if (after === null) {
    return <p className="kr text-[10px] text-faint">{pending}</p>
  }

  const keys = Object.keys(before).filter((key) => key in after)
  if (keys.length === 0) {
    return <p className="kr text-[10px] text-faint">측정값 없음</p>
  }

  return (
    <div className="flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[10px] text-faint">
      {keys.map((key) => (
        <span key={key} className="tnum">
          <span className="kr">{deltaLabel(key)}</span> {before[key]} →{' '}
          <span className={after[key] > before[key] ? 'text-gold' : ''}>{after[key]}</span>
        </span>
      ))}
    </div>
  )
}

// api/schemas.py 의 거울. 한쪽만 고치면 계약이 깨진다 (README §0-1).

export type Mode = 'live' | 'simulated' | 'unavailable'
/**
 * rejected 는 low_quality 와 다르다. 신호는 기준을 넘었는데 값이 생리학적으로
 * 불가능해서 버린 것이다. 묶어 두면 "품질 미달" 옆에 높은 신뢰도가 같이 뜬다.
 */
export type State = 'ok' | 'low_quality' | 'rejected' | 'stale' | 'error' | 'no_adapter'

export interface Metric {
  key: string
  value: number | string | null
  unit: string | null
  source: string
  mode: Mode
  state: State
  confidence: number | null
  /**
   * 값이 나오기까지의 진행률 (0~1). 준비 시간 개념이 없는 지표는 null.
   *
   * state 만으로는 "기다리면 나온다"와 "신호가 나빠서 못 낸다"가 둘 다
   * low_quality 라 구분되지 않는다.
   */
  progress: number | null
  ts: string
}

export interface InterventionEvent {
  id: string
  level: 'L0' | 'L1' | 'L2' | 'L3' | 'L4'
  action: string
  trigger: string
  before: Record<string, number>
  after: Record<string, number> | null
  accepted: boolean | null
  ts: string
}

export interface Snapshot {
  device_id: string
  ts: string
  metrics: Metric[]
  interventions: InterventionEvent[]
}

// api/schemas.py 의 거울. 한쪽만 고치면 계약이 깨진다 (README §0-1).

export type Mode = 'live' | 'simulated' | 'unavailable'
export type State = 'ok' | 'low_quality' | 'stale' | 'error' | 'no_adapter'

export interface Metric {
  key: string
  value: number | string | null
  unit: string | null
  source: string
  mode: Mode
  state: State
  confidence: number | null
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

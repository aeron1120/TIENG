// core/schemas.py 의 거울. 한쪽만 고치면 계약이 깨진다 (CLAUDE.md §0-1).
//
// 이 파일이 맞는지는 web/fixtures/snapshot.json 으로 확인한다. 그 표본은 실제
// pydantic 모델에서 생성되므로 (tools/export_contract.py), 여기가 어긋나면
// tsc 가 픽스처를 읽는 자리에서 걸린다.

export type Mode = 'live' | 'replay' | 'simulated' | 'unavailable'

/** no_adapter 는 low_quality 와 다르다. 전자는 어댑터가 아예 없는 것이고, */
/** 후자는 어댑터가 재긴 했는데 믿을 수 없는 것이다. 화면 문구가 달라야 한다. */
export type State = 'ok' | 'low_quality' | 'stale' | 'error' | 'no_adapter'

export type SpeedSource = 'flow' | 'gps' | 'blend' | 'none'

export interface FusedState {
  t: number
  roll: number
  roll_state: State
  pitch: number
  speed: number | null
  speed_state: State
  speed_source: SpeedSource
  accel_h: number
  yaw_rate: number
}

export interface Indicator {
  key: string
  /** null 이면 값을 못 구한 것이다. 0 으로 그리면 안 된다 (§0-4). */
  value: number | null
  unit: string | null
  state: State
  sqi: number | null
  t: number
}

export interface RuleTrace {
  rule: string
  fired: boolean
  inputs: Record<string, number | null>
  thresholds: Record<string, number>
  /** 채워져 있으면 '기각' 이 아니라 '판정 불가' 다 (§6.7). */
  blocked_by: string | null
}

export interface MotoEvent {
  id: string
  t: number
  kind: 'trigger' | 'confirm' | 'reject' | 'manual_mark' | 'sqi_drop'
  traces: RuleTrace[]
  ring_dump_path: string | null
}

export interface Snapshot {
  device_id: string
  session_id: string
  t: number
  mode: Mode
  fused: FusedState | null
  indicators: Indicator[]
  recent_events: MotoEvent[]
  health: Record<string, number>
}

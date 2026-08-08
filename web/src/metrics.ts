import {
  Activity,
  Droplets,
  Heart,
  type LucideIcon,
  PersonStanding,
  Sun,
  Thermometer,
  Volume2,
  Wind,
} from 'lucide-react'
import type { Metric, Mode, State } from './types'

export const LABEL: Record<string, string> = {
  hr: '심박수',
  rr: '호흡수',
  temp: '온도',
  humidity: '습도',
  lux: '조도',
  noise: '소음',
  occupancy: '재실',
  posture: '자세',
}

export const ICON: Record<string, LucideIcon> = {
  hr: Heart,
  rr: Wind,
  temp: Thermometer,
  humidity: Droplets,
  lux: Sun,
  noise: Volume2,
  occupancy: PersonStanding,
  posture: Activity,
}

export const MODE_LABEL: Record<Mode, string> = {
  live: '실측',
  simulated: '시뮬레이션',
  unavailable: '미연결',
}

export const STATE_LABEL: Record<State, string> = {
  ok: '정상',
  low_quality: '품질 미달',
  stale: '수신 끊김',
  error: '오류',
  no_adapter: '어댑터 없음',
}

const POSTURE_LABEL: Record<string, string> = {
  sitting: '앉음',
  standing: '섬',
  lying: '누움',
}

export const ACTION_LABEL: Record<string, string> = {
  light_up: '조명 켬',
  ventilate: '환기',
  breathing_guide: '호흡 안내',
  notify_guardian: '보호자 알림',
}

/** 수신이 끊기면 서버가 뭐라 했든 프론트가 stale 로 덮는다 (README §2). */
export function effectiveState(metric: Metric, stale: boolean): State {
  return stale ? 'stale' : metric.state
}

/**
 * 화면에 찍을 문자열. 값이 없거나 믿을 수 없으면 null 을 돌려주고, 호출부는
 * 반드시 "—" 를 그린다. 0 으로 대체하지 않는다 (README §2).
 */
export function displayValue(metric: Metric, stale: boolean): string | null {
  if (stale || metric.value === null) return null
  if (typeof metric.value === 'string') return POSTURE_LABEL[metric.value] ?? metric.value
  // 재실은 1/0 로 오지만 화면에 "1"이라고 띄우면 아무 뜻도 전달되지 않는다.
  if (metric.key === 'occupancy') return metric.value >= 0.5 ? '감지' : '없음'
  return String(metric.value)
}

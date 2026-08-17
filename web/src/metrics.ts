import {
  Activity,
  Droplets,
  Eye,
  EyeOff,
  Gauge,
  Heart,
  Timer,
  TrendingUp,
  type LucideIcon,
  PersonStanding,
  Sun,
  Thermometer,
  Volume2,
  Wind,
} from 'lucide-react'
import type { InterventionEvent, Metric, Mode, State } from './types'

export const LABEL: Record<string, string> = {
  hr: '심박수',
  rr: '호흡수',
  temp: '온도',
  humidity: '습도',
  lux: '조도',
  noise: '소음',
  occupancy: '재실',
  posture: '자세',
  perclos: '눈감김',
  blink_dur: '깜빡임',
  reopen_ms: '재개안 지연',
  blink_rate: '깜빡임 빈도',
  head_drop: '고개 떨굼',
  drowsy_score: '졸음 점수',
  drowsy_trend: '졸음 추세',
  drowsiness: '졸음',
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
  perclos: EyeOff,
  blink_dur: Eye,
  reopen_ms: Timer,
  blink_rate: Eye,
  head_drop: PersonStanding,
  drowsy_score: Gauge,
  drowsy_trend: TrendingUp,
  drowsiness: Gauge,
}

/**
 * 졸음 어댑터가 내는 지표. 전용 패널(DrowsinessPanel)이 통째로 맡으므로
 * 보조 지표 카드에서는 뺀다 — 같은 값을 두 군데 그리면 어느 쪽이 최신인지
 * 매번 확인하게 된다.
 */
export const DROWSINESS_KEYS = [
  'drowsiness',
  'drowsy_score',
  'drowsy_trend',
  'reopen_ms',
  'blink_dur',
  'blink_rate',
  'head_drop',
  'perclos',
]

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

/** 졸음 판정. 어댑터는 영문 키로 보내고 화면이 제 말로 옮긴다. */
export const DROWSINESS_LABEL: Record<string, string> = {
  awake: '각성',
  warning: '주의',
  drowsy: '졸음',
  unknown: '판정 불가',
}

/** 판정별 색. 정상일 때는 조용히 둔다 — 늘 켜져 있는 화면이라 평소에 눈에 띄면 피로하다. */
export const DROWSINESS_TONE: Record<string, string> = {
  awake: 'text-muted',
  warning: 'text-gold',
  drowsy: 'text-alert',
  unknown: 'text-faint',
}

export const ACTION_LABEL: Record<string, string> = {
  light_up: '조명 켬',
  ventilate: '환기',
  breathing_guide: '호흡 안내',
  notify_guardian: '보호자 알림',
  drowsy_notice: '졸음 관심',
  drowsy_alert: '졸음 위험 — 조명 상향',
}

// 개입 전후 비교에 나오는 키. 지표에서 파생된 값만 따로 적고 나머지는 LABEL 을
// 그대로 쓴다. 표를 두 벌 두면 한쪽에만 지표를 추가하고 지나가게 된다 —
// 실제로 기록 화면에서 hr·rr 이 라벨 없이 원본 키로 나오고 있었다.
const DERIVED_LABEL: Record<string, string> = { hr_confidence: '신뢰도' }

export function deltaLabel(key: string): string {
  return DERIVED_LABEL[key] ?? LABEL[key] ?? key
}

// 되돌릴 수 없어서 사용자 확인을 거치는 개입. 확인 전에는 아직 실행되지 않았다.
const NEEDS_CONFIRMATION = new Set(['notify_guardian'])

/**
 * 아직 실행되지 않고 취소를 기다리는 중인가.
 *
 * 자동 개입도 accepted 가 null 이라 그것만으로는 구분되지 않는다. 구분하지 않으면
 * 아직 보내지도 않은 알림 옆에 "효과 측정 중"이라고 쓰게 된다 — 측정할 효과가
 * 아직 없다.
 */
export function awaitsConfirmation(event: InterventionEvent): boolean {
  return event.accepted === null && NEEDS_CONFIRMATION.has(event.action)
}

export interface Verdict {
  text: string
  why: string
  tone: string
}

/**
 * "지금 괜찮은가" 한 줄. 지금은 보호자 화면 하나만 쓴다.
 *
 * 판정은 셋 중 하나다. 애매하게 "주의"를 남발하면 아무도 안 본다.
 */
export function verdict(measured: number, stale: boolean): Verdict {
  if (stale) {
    return { text: '연결이 끊겼습니다', why: '서버에서 값이 오지 않습니다', tone: 'text-alert' }
  }
  if (measured === 0) {
    return {
      text: '측정 중입니다',
      why: '아직 믿을 만한 값이 없어 표시하지 않습니다',
      tone: 'text-muted',
    }
  }
  return {
    text: '특이사항 없습니다',
    why: `지표 ${measured}개가 정상 범위에서 측정되고 있습니다`,
    tone: 'text-gold',
  }
}

/** 수신이 끊기면 서버가 뭐라 했든 프론트가 stale 로 덮는다 (README §2). */
export function effectiveState(metric: Metric, stale: boolean): State {
  return stale ? 'stale' : metric.state
}

/**
 * 값이 없는 이유가 "아직 시간이 덜 됐다"인가.
 *
 * rPPG 는 8초 분량이 모여야 첫 값을 낸다. 그 구간과 "신호가 나빠서 못 낸다"가
 * 둘 다 state=low_quality 라, 진행률을 봐야 구분된다. 구분하지 않으면 켤 때마다
 * 처음 8초 동안 품질 경고가 뜬다.
 */
export function isWarmingUp(metric: Metric, stale: boolean): boolean {
  return (
    !stale && metric.state === 'low_quality' && metric.progress !== null && metric.progress < 1
  )
}

/**
 * 화면에 찍을 문자열. 값이 없거나 믿을 수 없으면 null 을 돌려주고, 호출부는
 * 반드시 "—" 를 그린다. 0 으로 대체하지 않는다 (README §2).
 */
export function displayValue(metric: Metric, stale: boolean): string | null {
  if (stale || metric.value === null) return null
  if (typeof metric.value === 'string')
    return POSTURE_LABEL[metric.value] ?? DROWSINESS_LABEL[metric.value] ?? metric.value
  // 재실은 1/0 로 오지만 화면에 "1"이라고 띄우면 아무 뜻도 전달되지 않는다.
  if (metric.key === 'occupancy') return metric.value >= 0.5 ? '감지' : '없음'
  return String(metric.value)
}

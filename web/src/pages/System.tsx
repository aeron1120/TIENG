import { RefreshCw } from 'lucide-react'
import { useState } from 'react'
import { Empty, Page, Panel } from '../components/Page'
import { useGet } from '../hooks/useApi'

// scripts/hwcheck.py 의 화면판. 파이 옆에서 폰으로 열어 두고 센서를 하나씩 꽂으면
// 카드가 실패에서 정상으로 바뀌는 걸 볼 수 있다.
//
// 실패 사유를 요약하지 않고 그대로 보여준다. "연결 실패"만 띄우면 배선을 고칠
// 단서가 사라진다.

interface Component {
  id: string
  module: string
  mode: string
  state: 'running' | 'disabled' | 'failed'
  detail: string
  provides?: string[]
  is_on?: boolean
}

type CameraBackend = 'opencv' | 'picamera2'

interface SystemStatus {
  ready: boolean
  device_id?: string
  config_path?: string
  sample_rate_hz?: number
  thresholds_path?: string
  // 카메라 어댑터가 없는 구성(mock)에서는 null 이다. 그때는 선택칸을 감춘다.
  camera_backend?: CameraBackend | null
  camera_adapter?: string | null
  thresholds?: {
    profile: string
    confidence_min: number
    night_mode: { start: string; end: string }
    policies: Record<string, Record<string, number>>
  } | null
  adapters?: Component[]
  actuators?: Component[]
  policies?: {
    level: string
    module: string
    reversible: boolean
    cooldown_s: number
    evaluate_after_s: number
    last_reason: string
    near_miss: boolean
  }[]
}

const STATE_TONE: Record<string, string> = {
  running: 'border-gold/40 bg-gold/10 text-gold',
  disabled: 'border-faint/25 text-faint',
  failed: 'border-alert/40 bg-alert/10 text-alert',
}
const STATE_LABEL: Record<string, string> = {
  running: '정상',
  disabled: '꺼 둠',
  failed: '실패',
}

// 하드웨어를 처음 붙일 때 제일 자주 막히는 지점들. hwcheck 와 같은 힌트를 준다.
const HINTS: Record<string, string[]> = {
  'core.adapters.env_bme680': [
    'sudo raspi-config → Interface Options → I2C 활성화',
    'i2cdetect -y 1 에 0x76 (또는 0x77) 이 보이는지',
  ],
  'core.adapters.env_bh1750': ['ADDR 핀이 GND 면 0x23, VCC 면 0x5c'],
  'core.adapters.pir': ['pin 번호는 BCM 기준이다', 'Pi 5 는 lgpio 가 필요하다'],
  'core.adapters.rppg': [
    'rpicam-hello --list-cameras 에 카메라가 보이는지 — 리본 케이블부터',
    'venv 를 --system-site-packages 로 만들어야 picamera2 가 보인다',
    'USB 웹캠이면 v4l2-ctl --list-devices 로 camera_index 확인',
  ],
  'actuators.tuya_plug': [
    'python -m tinytuya wizard 로 device_id / local_key 를 뽑는다',
    '플러그와 파이가 같은 네트워크에 있어야 한다',
  ],
}

// 카메라를 여는 방식. 파이에 ssh 로 붙어 device.yaml 을 고치고 서비스를 재시작하는
// 대신 여기서 바꾼다 — CSI 가 안 잡힐 때 원인을 좁히려고 제일 자주 하는 일이다.
// 고른 값은 device.yaml 이 아니라 state/ 에 남는다 (core/overrides.py).
const BACKENDS: { value: CameraBackend; label: string; module: string }[] = [
  { value: 'picamera2', label: 'CSI 리본', module: 'picamera2' },
  { value: 'opencv', label: 'USB 웹캠', module: 'opencv' },
]

function CameraBackendPicker({
  current,
  adapter,
  onSwitched,
}: {
  current: CameraBackend
  adapter: string
  onSwitched: (next: SystemStatus) => void
}) {
  const [busy, setBusy] = useState<CameraBackend | null>(null)
  const [failure, setFailure] = useState<string | null>(null)

  const pick = async (backend: CameraBackend) => {
    if (backend === current || busy) return
    setBusy(backend)
    setFailure(null)
    try {
      const res = await fetch('/api/system/camera-backend', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ backend }),
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body?.detail ?? `${res.status} ${res.statusText}`)
      // 실패해도 200 이다. 왜 안 열렸는지는 아래 어댑터 카드에 사유로 실려 온다.
      onSwitched(body as SystemStatus)
    } catch (e) {
      setFailure((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="mb-3 border-b-[0.5px] border-gold/10 pb-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="kr text-[12px] text-muted">카메라 연결 방식</span>
        <span className="flex gap-1.5">
          {BACKENDS.map((b) => (
            <button
              key={b.value}
              onClick={() => pick(b.value)}
              disabled={busy !== null}
              className={`kr rounded-md border-[0.5px] px-2.5 py-1 text-[11px] transition-colors disabled:opacity-40 ${
                b.value === current
                  ? 'border-gold/40 bg-gold/10 text-gold'
                  : 'border-gold/20 text-muted hover:bg-gold/5'
              }`}
            >
              {busy === b.value ? '여는 중…' : b.label}
              <span className="ml-1 font-mono text-[10px] text-faint">{b.module}</span>
            </button>
          ))}
        </span>
      </div>
      <p className="kr mt-1.5 text-[11px] text-faint">
        {adapter} 어댑터만 다시 연다. 나머지 카드와 측정은 그대로 돈다. 고른 값은 재시작
        후에도 남는다.
      </p>
      {failure && <p className="kr mt-1 text-[12px] text-alert">{failure}</p>}
    </div>
  )
}

function Row({ item }: { item: Component }) {
  const hints = item.state === 'failed' ? (HINTS[item.module] ?? []) : []
  return (
    <div className="border-t-[0.5px] border-gold/10 py-3 first:border-t-0 first:pt-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-2">
          <span className="font-mono text-[13px] text-fg">{item.id}</span>
          <span
            className={`kr shrink-0 rounded-full border px-2 py-[2px] text-[10px] ${STATE_TONE[item.state]}`}
          >
            {STATE_LABEL[item.state]}
          </span>
          <span className="kr shrink-0 rounded-full border border-gold/20 px-2 py-[2px] text-[10px] text-muted">
            {item.mode}
          </span>
          {item.is_on && (
            <span className="kr shrink-0 rounded-full border border-gold/40 bg-gold/10 px-2 py-[2px] text-[10px] text-gold">
              켜짐
            </span>
          )}
        </span>
        <span className="font-mono text-[10px] text-faint">{item.module}</span>
      </div>

      {item.provides && item.provides.length > 0 && (
        <p className="mt-1.5 font-mono text-[10px] text-faint">→ {item.provides.join(', ')}</p>
      )}
      {item.detail && (
        <p className="kr mt-1.5 text-[12px] break-words text-alert">{item.detail}</p>
      )}
      {hints.map((h) => (
        <p key={h} className="kr mt-1 text-[11px] text-faint">
          · {h}
        </p>
      ))}
    </div>
  )
}

export function System() {
  const { data, error, loading, run } = useGet<SystemStatus>('/api/system')
  // backend 를 바꾸면 서버가 새 상태를 통째로 돌려준다. 다시 받아 올 필요가 없다.
  const [switched, setSwitched] = useState<SystemStatus | null>(null)
  const status = switched ?? data

  const refresh = () => {
    setSwitched(null)
    run()
  }

  return (
    <Page
      title="시스템 상태"
      actions={
        <button
          onClick={refresh}
          disabled={loading}
          className="kr flex items-center gap-1.5 rounded-md border-[0.5px] border-gold/30 px-3 py-1.5 text-[12px] text-gold transition-colors hover:bg-gold/10 disabled:opacity-40"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
          새로고침
        </button>
      }
    >
      {error && <Panel className="mb-4 border-alert/40 text-alert">{error}</Panel>}
      {!status?.ready && !error && <Empty>서버 상태를 불러오는 중</Empty>}

      {status?.ready && (
        <div className="flex flex-col gap-4">
          <Panel>
            <h2 className="kr mb-2 text-[12px] font-medium text-muted">설정</h2>
            <dl className="grid grid-cols-2 gap-x-6 gap-y-1.5 font-mono text-[12px] sm:grid-cols-4">
              <Field label="device_id" value={status.device_id} />
              <Field label="config" value={status.config_path} />
              <Field label="sample_rate" value={`${status.sample_rate_hz} Hz`} />
              <Field label="profile" value={status.thresholds?.profile ?? '없음'} />
              <Field
                label="confidence_min"
                value={String(status.thresholds?.confidence_min ?? '—')}
              />
              <Field
                label="night_mode"
                value={
                  status.thresholds
                    ? `${status.thresholds.night_mode.start}~${status.thresholds.night_mode.end}`
                    : '—'
                }
              />
            </dl>
          </Panel>

          <Panel>
            <h2 className="kr mb-2 text-[12px] font-medium text-muted">
              센서 어댑터 ({status.adapters?.length ?? 0})
            </h2>
            {status.camera_backend && status.camera_adapter && (
              <CameraBackendPicker
                current={status.camera_backend}
                adapter={status.camera_adapter}
                onSwitched={setSwitched}
              />
            )}
            {status.adapters?.map((a) => <Row key={a.id} item={a} />)}
          </Panel>

          <Panel>
            <h2 className="kr mb-2 text-[12px] font-medium text-muted">
              액추에이터 ({status.actuators?.length ?? 0})
            </h2>
            {status.actuators?.length ? (
              status.actuators.map((a) => <Row key={a.id} item={a} />)
            ) : (
              <Empty>설정된 액추에이터가 없다</Empty>
            )}
          </Panel>

          <Panel>
            <h2 className="kr mb-2 text-[12px] font-medium text-muted">
              개입 정책 ({status.policies?.length ?? 0})
            </h2>
            {status.policies?.length ? (
              status.policies.map((p) => (
                <div
                  key={p.level}
                  className="border-t-[0.5px] border-gold/10 py-3 first:border-t-0 first:pt-0"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="flex items-center gap-2">
                      <span className="rounded-full border border-gold/30 px-2 py-[2px] font-mono text-[11px] text-gold">
                        {p.level}
                      </span>
                      <span className="kr text-[12px] text-muted">
                        쿨다운 {p.cooldown_s}초 · 평가 {p.evaluate_after_s}초 후
                        {p.reversible ? ' · 되돌릴 수 있음' : ' · 되돌릴 수 없음'}
                      </span>
                    </span>
                    <span className="font-mono text-[10px] text-faint">{p.module}</span>
                  </div>
                  {/* 지금 왜 발화하지 않는지. 데모 중에 제일 궁금한 정보다. */}
                  {p.last_reason && (
                    <p
                      className={`kr mt-1.5 text-[12px] ${p.near_miss ? 'text-gold' : 'text-faint'}`}
                    >
                      현재 판단: {p.last_reason}
                    </p>
                  )}
                </div>
              ))
            ) : (
              <Empty>로드된 정책이 없다</Empty>
            )}
          </Panel>
        </div>
      )}
    </Page>
  )
}

function Field({ label, value }: { label: string; value?: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] tracking-wide text-faint uppercase">{label}</dt>
      <dd className="truncate text-fg">{value ?? '—'}</dd>
    </div>
  )
}

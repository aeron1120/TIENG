import { Camera, CameraOff, Maximize2, RotateCw, Server, Smartphone, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useDeviceCamera, type Box, type DeviceCamera } from '../hooks/useDeviceCamera'
import { useGet } from '../hooks/useApi'
import { useFeed } from '../snapshotContext'

// 카메라 미리보기와 소스 선택.
//
// 소스가 둘인 이유는 이 화면이 두 자리에서 열리기 때문이다. 침실 앞 태블릿은 방에
// 붙은 카메라를 보고, 밖에서 주소로 들어온 사람에게는 그 카메라가 없다 — 대신
// 자기 기기 카메라가 있다.
//
// 서버 카메라는 MJPEG 를 <img> 하나로 받는다. 브라우저가 알아서 프레임을 갈아
// 끼우므로 프론트에 디코딩 코드가 없다. 자기 기기 카메라는 <video> 로 직접 본다 —
// 그 영상은 서버에 가지 않으므로 받아 올 것도 없다.
//
// 크게 보는 길이 둘이다. 지표처럼 왼쪽 자리로 승격하면 계속 크게 두고 볼 수 있고,
// 확대는 잠깐 얼굴을 맞출 때 쓴다. 얼굴을 상자에 넣는 일은 작은 화면에서 하기 어렵다.

interface Status {
  available: boolean
  sources: string[]
}

const STATE_TEXT: Record<string, string> = {
  starting: '카메라를 여는 중입니다',
  denied: '카메라 권한이 필요합니다',
  unsupported: '이 브라우저는 카메라를 열 수 없습니다',
  failed: '카메라를 열지 못했습니다',
}

export function CameraPanel({
  variant = 'panel',
  onPromote,
}: {
  variant?: 'panel' | 'hero'
  onPromote?: () => void
}) {
  const status = useGet<Status>('/api/camera')
  const { source, setSource } = useFeed()
  const [on, setOn] = useState(true)
  const [zoom, setZoom] = useState(false)
  // 스트림을 다시 붙일 때 <img> 를 새로 만들기 위한 값. src 가 같으면 브라우저가
  // 재요청을 하지 않는다.
  const [attempt, setAttempt] = useState(0)
  const [failed, setFailed] = useState(false)

  const serverCamera = status.data?.available === true
  const device = useDeviceCamera(source === 'device' && on)
  const hero = variant === 'hero'

  return (
    <section
      className={`overflow-hidden rounded-lg border-[0.5px] border-gold/15 bg-panel ${
        hero ? 'flex h-full flex-col' : ''
      }`}
    >
      <header className="flex items-center justify-between gap-2 px-4 py-2.5">
        <h2 className="kr flex items-center gap-1.5 text-[15px] font-medium text-muted">
          <Camera className="h-3.5 w-3.5 text-gold" />
          카메라
        </h2>
        <div className="flex items-center gap-1">
          {!hero && onPromote && (
            <Action onClick={onPromote} title="크게 보기">
              크게
            </Action>
          )}
          <Action onClick={() => setZoom(true)} title="확대">
            <Maximize2 className="h-3.5 w-3.5" />
          </Action>
          <Action
            onClick={() => {
              setOn((prev) => !prev)
              setFailed(false)
            }}
          >
            {on ? '끄기' : '켜기'}
          </Action>
        </div>
      </header>

      {/* 어느 기기의 카메라를 볼 것인가. 서버 카메라가 없으면 그 칸은 눌러도
          소용없으므로 왜 못 쓰는지 같이 적는다 — 비활성만 시켜 두면 고장으로 보인다. */}
      <div className="flex gap-1.5 px-4 pb-2.5">
        <Pick
          icon={Smartphone}
          label="이 기기"
          active={source === 'device'}
          onClick={() => setSource('device')}
        />
        <Pick
          icon={Server}
          label={serverCamera ? '서버' : '서버 (없음)'}
          active={source === 'server'}
          disabled={!serverCamera && source !== 'server'}
          onClick={() => setSource('server')}
        />
      </div>

      {/* 두 칸을 차지할 때는 영상 옆에 설명을 세운다. 영상 자체를 16:9 로 늘리면
          위아래가 잘리는데, 책상에 앉으면 얼굴이 화면 아래쪽에 오기 때문에 이마
          ROI 가 먼저 날아간다. 미리보기는 그걸 확인하라고 있는 화면이다. */}
      <div className={hero ? 'flex min-h-0 flex-1 flex-col' : '2xl:flex 2xl:items-stretch'}>
        <div
          className={
            hero
              ? 'relative min-h-0 flex-1 bg-black'
              : 'relative aspect-[4/3] w-full bg-black 2xl:w-[300px] 2xl:shrink-0'
          }
        >
          {source === 'device' ? (
            <DeviceView device={device} showing={on} />
          ) : !serverCamera ? (
            <Notice icon={CameraOff}>
              {status.loading ? '카메라 확인 중' : '이 서버에는 카메라가 없습니다'}
            </Notice>
          ) : failed ? (
            <Notice icon={CameraOff}>
              <span className="kr">스트림이 끊겼습니다</span>
              <button
                onClick={() => {
                  setFailed(false)
                  setAttempt((n) => n + 1)
                }}
                className="kr mt-2 flex items-center gap-1 rounded border-[0.5px] border-gold/30 px-2 py-1 text-[13px] text-gold hover:bg-gold/10"
              >
                <RotateCw className="h-3 w-3" />
                다시 시도
              </button>
            </Notice>
          ) : on ? (
            <img
              key={attempt}
              src={`/api/camera/stream?t=${attempt}`}
              alt="카메라 미리보기"
              onError={() => setFailed(true)}
              className="h-full w-full object-cover"
            />
          ) : (
            <Notice icon={CameraOff}>미리보기를 껐습니다</Notice>
          )}
        </div>

        {source === 'device' && on && device.state === 'running' && (
          <Lock tracking={device.tracking} skinRatio={device.skinRatio} />
        )}

        {/* README §1 비목표. 화면에 적어 둔다 — 카메라가 보이는 순간 가장 먼저
            드는 의문이고, 코드 주석은 쓰는 사람에게 보이지 않는다. */}
        <p
          className={`kr px-4 py-2 text-[12px] leading-snug text-faint ${
            hero ? '' : '2xl:flex-1 2xl:self-center 2xl:py-0'
          }`}
        >
          {source === 'device'
            ? '영상은 이 기기를 벗어나지 않고, 측정에 쓰는 평균 색만 서버로 갑니다.'
            : '측정에 쓰는 영역을 함께 표시합니다. 영상은 저장하지 않고 이 기기 밖으로 나가지 않습니다.'}
        </p>
      </div>

      {zoom && (
        <Zoom device={device} source={source} serverCamera={serverCamera} onClose={() => setZoom(false)} />
      )}
    </section>
  )
}

/** 자기 기기 카메라 화면. 영상 위에 추적 상자를 얹는다. */
function DeviceView({ device, showing }: { device: DeviceCamera; showing: boolean }) {
  return (
    <>
      {/* 영상과 상자를 같은 상자 안에서 함께 뒤집는다. 거울이 아니면 얼굴을 맞추려
          할수록 반대로 움직이고, 영상만 뒤집으면 상자가 반대편에 그려진다. */}
      <div className="absolute inset-0 -scale-x-100">
        {/* 꺼져 있어도 <video> 를 남긴다. 지우면 훅이 붙일 자리가 사라져 다시 켤 때
            첫 프레임을 놓친다. */}
        <video
          ref={device.videoRef}
          muted
          playsInline
          // 브라우저의 '화면 속 화면'을 막는다. 그 창에는 이쪽 CSS 가 안 걸려서
          // 좌우 반전이 풀리고, 안내 상자도 같이 잃는다.
          disablePictureInPicture
          className={`h-full w-full object-cover ${
            showing && device.state === 'running' ? '' : 'invisible'
          }`}
        />
        {showing && device.state === 'running' && <Roi roi={device.roi} tracking={device.tracking} />}
      </div>

      {!showing ? (
        <Notice icon={CameraOff}>미리보기를 껐습니다</Notice>
      ) : device.state !== 'running' ? (
        <Notice icon={CameraOff}>
          {device.detail || STATE_TEXT[device.state] || '카메라 준비 중'}
        </Notice>
      ) : null}
    </>
  )
}

/** 지금 얼굴로 보고 있는 자리. 못 잡았으면 흐리게 두어 "여기 맞춰라"로 읽히게 한다. */
function Roi({ roi, tracking }: { roi: Box; tracking: boolean }) {
  return (
    <div
      aria-hidden
      className={`pointer-events-none absolute rounded-md border-2 transition-[border-color] ${
        tracking ? 'border-gold' : 'border-dashed border-gold/30'
      }`}
      style={{
        left: `${roi.x * 100}%`,
        top: `${roi.y * 100}%`,
        width: `${roi.w * 100}%`,
        height: `${roi.h * 100}%`,
      }}
    />
  )
}

/**
 * 지금 잡히고 있는지 알려 주는 줄.
 *
 * 상자만 그려 두면 "이게 맞게 잡은 건가"를 알 수 없다. 상자 안이 얼마나 피부인지를
 * 같이 보여 주면, 값이 안 나올 때 조명을 고칠지 자세를 고칠지 판단할 수 있다.
 */
function Lock({ tracking, skinRatio }: { tracking: boolean; skinRatio: number }) {
  const percent = Math.round(skinRatio * 100)
  return (
    <div className="px-4 pb-1">
      <div className="mb-1 flex items-center justify-between font-mono text-[11px] tracking-[0.18em] text-faint uppercase">
        <span>{tracking ? 'tracking' : 'searching'}</span>
        <span className="tnum text-muted">{tracking ? `${percent}%` : '—'}</span>
      </div>
      <div className="h-[3px] w-full overflow-hidden rounded-full bg-white/5">
        <div
          className={`h-full rounded-full transition-all duration-300 ${
            tracking ? 'bg-gold' : 'animate-measuring bg-gold-soft'
          }`}
          style={{ width: tracking ? `${Math.min(100, percent)}%` : '100%' }}
        />
      </div>
    </div>
  )
}

/** 확대 창. 같은 스트림에 <video> 를 하나 더 붙인다 — 처리는 원래 것이 계속 한다. */
function Zoom({
  device,
  source,
  serverCamera,
  onClose,
}: {
  device: DeviceCamera
  source: string
  serverCamera: boolean
  onClose: () => void
}) {
  const ref = useRef<HTMLVideoElement | null>(null)

  useEffect(() => {
    const video = ref.current
    if (!video || !device.stream) return
    video.srcObject = device.stream
    void video.play().catch(() => {})
    return () => {
      video.srcObject = null
    }
  }, [device.stream])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/95 p-6"
      role="dialog"
      aria-label="카메라 확대"
      onClick={onClose}
    >
      <div
        className="relative aspect-[4/3] w-full max-w-4xl overflow-hidden rounded-lg bg-black"
        onClick={(e) => e.stopPropagation()}
      >
        {source === 'device' ? (
          device.stream ? (
            <div className="absolute inset-0 -scale-x-100">
              <video ref={ref} muted playsInline disablePictureInPicture className="h-full w-full object-cover" />
              <Roi roi={device.roi} tracking={device.tracking} />
            </div>
          ) : (
            <Notice icon={CameraOff}>카메라가 꺼져 있습니다</Notice>
          )
        ) : serverCamera ? (
          <img src="/api/camera/stream?zoom=1" alt="카메라 확대" className="h-full w-full object-cover" />
        ) : (
          <Notice icon={CameraOff}>이 서버에는 카메라가 없습니다</Notice>
        )}
      </div>

      <button
        onClick={onClose}
        aria-label="닫기"
        className="absolute top-6 right-6 rounded-md border-[0.5px] border-gold/30 p-2 text-faint transition-colors hover:bg-white/[0.06] hover:text-gold"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  )
}

function Action({
  onClick,
  title,
  children,
}: {
  onClick: () => void
  title?: string
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className="kr flex items-center rounded px-2 py-[3px] text-[13px] text-faint transition-colors hover:bg-white/[0.06] hover:text-gold"
    >
      {children}
    </button>
  )
}

function Pick({
  icon: Icon,
  label,
  active,
  disabled = false,
  onClick,
}: {
  icon: typeof Server
  label: string
  active: boolean
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      className={`kr flex flex-1 items-center justify-center gap-1.5 rounded-md border-[0.5px] px-2 py-1.5 text-[12px] transition-colors disabled:opacity-40 ${
        active
          ? 'border-gold/60 bg-gold/10 text-gold'
          : 'border-gold/15 text-faint hover:border-gold/40 hover:text-muted'
      }`}
    >
      <Icon className="h-3.5 w-3.5 shrink-0" />
      {label}
    </button>
  )
}

function Notice({ icon: Icon, children }: { icon: typeof CameraOff; children: React.ReactNode }) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-4 text-center">
      <Icon className="h-5 w-5 text-faint/60" />
      <span className="kr text-[13px] text-faint">{children}</span>
    </div>
  )
}

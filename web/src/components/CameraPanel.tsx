import { Camera, CameraOff, RotateCw, Server, Smartphone } from 'lucide-react'
import { useState } from 'react'
import { useDeviceCamera } from '../hooks/useDeviceCamera'
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

export function CameraPanel() {
  const status = useGet<Status>('/api/camera')
  const { source, setSource } = useFeed()
  const [on, setOn] = useState(true)
  // 스트림을 다시 붙일 때 <img> 를 새로 만들기 위한 값. src 가 같으면 브라우저가
  // 재요청을 하지 않는다.
  const [attempt, setAttempt] = useState(0)
  const [failed, setFailed] = useState(false)

  const serverCamera = status.data?.available === true
  const device = useDeviceCamera(source === 'device' && on)
  const showing = source === 'device' ? on : on && serverCamera

  return (
    <section className="overflow-hidden rounded-lg border-[0.5px] border-gold/15 bg-panel">
      <header className="flex items-center justify-between gap-2 px-4 py-2.5">
        <h2 className="kr flex items-center gap-1.5 text-[15px] font-medium text-muted">
          <Camera className="h-3.5 w-3.5 text-gold" />
          카메라
        </h2>
        <button
          onClick={() => {
            setOn((prev) => !prev)
            setFailed(false)
          }}
          className="kr rounded px-2 py-[3px] text-[13px] text-faint transition-colors hover:bg-white/[0.06] hover:text-gold"
        >
          {on ? '끄기' : '켜기'}
        </button>
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
      <div className="2xl:flex 2xl:items-stretch">
        <div className="relative aspect-[4/3] w-full bg-black 2xl:w-[300px] 2xl:shrink-0">
          {source === 'device' ? (
            <>
              {/* 꺼져 있어도 <video> 를 남긴다. 지우면 훅이 붙일 자리가 사라져
                  다시 켤 때 첫 프레임을 놓친다. */}
              <video
                ref={device.videoRef}
                muted
                playsInline
                // 거울처럼 뒤집는다. 얼굴을 박스에 맞추는 화면이라 좌우가 반대면
                // 맞추려 할수록 반대로 움직인다.
                className={`h-full w-full -scale-x-100 object-cover ${
                  showing && device.state === 'running' ? '' : 'invisible'
                }`}
              />
              {showing && device.state === 'running' && (
                <div
                  aria-hidden
                  className="pointer-events-none absolute rounded-md border-2 border-gold/70"
                  style={{
                    left: `${device.roi.x * 100}%`,
                    top: `${device.roi.y * 100}%`,
                    width: `${device.roi.w * 100}%`,
                    height: `${device.roi.h * 100}%`,
                  }}
                />
              )}
              {!showing ? (
                <Notice icon={CameraOff}>미리보기를 껐습니다</Notice>
              ) : device.state !== 'running' ? (
                <Notice icon={CameraOff}>
                  {device.detail || STATE_TEXT[device.state] || '카메라 준비 중'}
                </Notice>
              ) : null}
            </>
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

        {/* README §1 비목표. 화면에 적어 둔다 — 카메라가 보이는 순간 가장 먼저
            드는 의문이고, 코드 주석은 쓰는 사람에게 보이지 않는다. */}
        <p className="kr px-4 py-2 text-[12px] leading-snug text-faint 2xl:flex-1 2xl:self-center 2xl:py-0">
          {source === 'device'
            ? '얼굴을 박스에 맞춰 주세요. 영상은 이 기기를 벗어나지 않고, 측정에 쓰는 평균 색만 서버로 갑니다.'
            : '측정에 쓰는 영역을 함께 표시합니다. 영상은 저장하지 않고 이 기기 밖으로 나가지 않습니다.'}
        </p>
      </div>
    </section>
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

function Notice({
  icon: Icon,
  children,
}: {
  icon: typeof CameraOff
  children: React.ReactNode
}) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-4 text-center">
      <Icon className="h-5 w-5 text-faint/60" />
      <span className="kr text-[13px] text-faint">{children}</span>
    </div>
  )
}

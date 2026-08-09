import { Camera, CameraOff, RotateCw } from 'lucide-react'
import { useState } from 'react'
import { useGet } from '../hooks/useApi'

// 카메라 미리보기. <img> 하나가 MJPEG 를 받아 브라우저가 알아서 프레임을 갈아
// 끼운다 — 프론트에 디코딩 코드가 없다.
//
// 끄면 <img> 를 아예 없앤다. src 만 비우면 연결이 남아 서버가 계속 JPEG 을 굽는다.
// 어댑터는 보는 사람이 없으면 인코딩을 멈추므로, 언마운트가 곧 절전이다.

interface Status {
  available: boolean
  sources: string[]
}

export function CameraPanel() {
  const status = useGet<Status>('/api/camera')
  const [on, setOn] = useState(true)
  // 스트림을 다시 붙일 때 <img> 를 새로 만들기 위한 값. src 가 같으면 브라우저가
  // 재요청을 하지 않는다.
  const [attempt, setAttempt] = useState(0)
  const [failed, setFailed] = useState(false)

  const available = status.data?.available === true

  return (
    <section className="overflow-hidden rounded-lg border-[0.5px] border-gold/15 bg-panel">
      <header className="flex items-center justify-between gap-2 px-4 py-2.5">
        <h2 className="kr flex items-center gap-1.5 text-[15px] font-medium text-muted">
          <Camera className="h-3.5 w-3.5 text-gold" />
          카메라
        </h2>
        {available && (
          <button
            onClick={() => {
              setOn((prev) => !prev)
              setFailed(false)
            }}
            className="kr rounded px-2 py-[3px] text-[13px] text-faint transition-colors hover:bg-white/[0.06] hover:text-gold"
          >
            {on ? '끄기' : '켜기'}
          </button>
        )}
      </header>

      {/* 두 칸을 차지할 때는 영상 옆에 설명을 세운다. 영상 자체를 16:9 로 늘리면
          위아래가 잘리는데, 책상에 앉으면 얼굴이 화면 아래쪽에 오기 때문에 이마
          ROI 가 먼저 날아간다. 미리보기는 그걸 확인하라고 있는 화면이다. */}
      <div className="2xl:flex 2xl:items-stretch">
        <div className="relative aspect-[4/3] w-full bg-black 2xl:w-[300px] 2xl:shrink-0">
        {!available ? (
          <Notice icon={CameraOff}>
            {status.loading ? '카메라 확인 중' : 'rPPG 어댑터가 올라오면 여기에 화면이 뜹니다'}
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
          측정에 쓰는 영역을 함께 표시합니다. 영상은 저장하지 않고 이 기기 밖으로
          나가지 않습니다.
        </p>
      </div>
    </section>
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

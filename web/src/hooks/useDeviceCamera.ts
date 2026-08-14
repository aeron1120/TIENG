import { useCallback, useEffect, useRef, useState } from 'react'
import type { Metric } from '../types'

// 이 기기의 카메라로 심박을 잰다.
//
// 영상은 이 함수 밖으로 나가지 않는다. 프레임에서 얼굴 영역의 피부 픽셀만 골라
// 평균 RGB 세 숫자로 줄인 뒤 그것만 서버로 보낸다 (README §1 비목표). 30fps 로
// 초당 30묶음, 1KB 남짓이다.
//
// 계산은 서버가 한다 (core/pulse.py). 여기서 하면 옥시미터로 검증한 공식을 두 벌로
// 유지하게 되고, 두 배포의 숫자가 갈리는 순간 "검증된 값"이라고 말할 근거가 사라진다.
// 여기가 맡는 것은 픽셀을 봐야만 나오는 값들뿐이다 — 서버에는 프레임이 없다.

const FPS = 30
const FRAME_MS = 1000 / FPS
const POST_MS = 1000 // 한 묶음에 30개 남짓

// 처리용 캔버스 크기. 얼굴 영역의 평균색만 쓰므로 이 이상 필요 없고, 작을수록
// 프레임당 비용이 준다 — 폰에서 배터리와 발열로 바로 드러난다.
const W = 160
const H = 120

// 화면 가운데 고정 박스. 브라우저에는 얼굴 검출이 없으므로 (있는 API 는 브라우저마다
// 달라 못 믿는다) 사람이 맞추게 하고, 안 맞으면 피부 비율이 떨어져 서버가 값을
// 보류한다 — 못 맞춘 채로 숫자가 나오지는 않는다.
const ROI = { x: 0.3, y: 0.15, w: 0.4, h: 0.5 }

// YCrCb 피부 범위. core/adapters/rppg.py 의 _SKIN_LO/_SKIN_HI 와 같은 값이다.
const SKIN = { yLo: 40, yHi: 250, crLo: 133, crHi: 173, cbLo: 77, cbHi: 127 }

// 이만큼 흔들리면 jitter_norm = 1. 어댑터의 JITTER_SCALE_PX 와 같은 자리지만
// 여기 좌표계는 160x120 이라 그 비율로 줄여 잡는다.
const JITTER_SCALE = 6.0 * (W / 640)

export type CameraState = 'off' | 'starting' | 'running' | 'denied' | 'unsupported' | 'failed'

export interface DeviceCamera {
  videoRef: React.RefObject<HTMLVideoElement | null>
  state: CameraState
  detail: string
  /** 서버가 방금 표본으로 낸 값. WebSocket 으로도 오지만 이쪽이 한 박자 빠르다. */
  reading: Metric | null
  /** 화면에 그릴 안내 박스 (0~1 비율). */
  roi: typeof ROI
}

interface Sample {
  t: number
  r: number
  g: number
  b: number
}

/** 한 프레임에서 뽑은 것. 피부가 너무 적으면 rgb 가 null 이다. */
interface Frame {
  rgb: [number, number, number] | null
  skinRatio: number
  brightness: number
  center: [number, number] | null
}

export function useDeviceCamera(active: boolean): DeviceCamera {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const [state, setState] = useState<CameraState>('off')
  const [detail, setDetail] = useState('')
  const [reading, setReading] = useState<Metric | null>(null)

  // 렌더마다 새로 만들지 않는다. 프레임 루프가 계속 들고 있어야 하는 값들이다.
  const pending = useRef<Sample[]>([])
  const quality = useRef({ jitter: 0, skinRatio: 0, brightness: 0 })
  const prevCenter = useRef<[number, number] | null>(null)

  const stop = useCallback(() => {
    const video = videoRef.current
    const stream = video?.srcObject as MediaStream | null
    stream?.getTracks().forEach((track) => track.stop())
    if (video) video.srcObject = null
    pending.current = []
    prevCenter.current = null
    // 서버가 마지막 값을 바로 버리게 한다. 안 불러도 몇 초 뒤 저절로 내려가지만,
    // 끈 사람이 자기 심박이 남아 있는 것을 보면 안 꺼진 줄 안다.
    void fetch('/api/rppg/samples', { method: 'DELETE' }).catch(() => {})
  }, [])

  useEffect(() => {
    if (!active) {
      stop()
      setState('off')
      setReading(null)
      return
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      setState('unsupported')
      setDetail('이 브라우저는 카메라를 열 수 없습니다')
      return
    }

    let disposed = false
    let raf = 0
    let timer: number | undefined
    const canvas = document.createElement('canvas')
    canvas.width = W
    canvas.height = H
    const ctx = canvas.getContext('2d', { willReadFrequently: true })

    const send = async () => {
      const batch = pending.current
      if (batch.length === 0) return
      pending.current = []
      try {
        const res = await fetch('/api/rppg/samples', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            samples: batch.map((s) => [s.t, s.r, s.g, s.b]),
            jitter_norm: clamp01(quality.current.jitter),
            skin_ratio: clamp01(quality.current.skinRatio),
            brightness: Math.min(255, Math.max(0, quality.current.brightness)),
          }),
        })
        if (!res.ok) throw new Error(`${res.status}`)
        const body = (await res.json()) as { metric: Metric }
        if (!disposed) setReading(body.metric)
      } catch {
        // 한 묶음을 놓쳐도 다음 묶음이 간다. 창은 서버가 들고 있으므로 재전송할
        // 이유가 없고, 여기서 쌓아 두면 끊긴 동안 메모리만 는다.
      }
    }

    const tick = (now: number) => {
      raf = requestAnimationFrame(tick)
      const video = videoRef.current
      if (!ctx || !video || video.readyState < 2) return

      // rAF 는 화면 주사율을 따라간다 (보통 60Hz, 120Hz 도 있다). 서버가 30Hz
      // 격자로 다시 샘플링하므로 그 이상은 비용만 는다.
      const last = pending.current[pending.current.length - 1]
      if (last && now - last.t * 1000 < FRAME_MS) return

      ctx.drawImage(video, 0, 0, W, H)
      const frame = readFrame(ctx)

      let jitter = 0
      if (frame.center && prevCenter.current) {
        const dx = frame.center[0] - prevCenter.current[0]
        const dy = frame.center[1] - prevCenter.current[1]
        jitter = Math.min(1, Math.hypot(dx, dy) / JITTER_SCALE)
      }
      if (frame.center) prevCenter.current = frame.center

      // EMA 로 눌러야 한 프레임 튄 것 때문에 창이 통째로 보류되지 않는다.
      // 어댑터(core/adapters/rppg.py)와 같은 계수다.
      quality.current.jitter = 0.7 * quality.current.jitter + 0.3 * jitter
      quality.current.skinRatio = frame.skinRatio
      quality.current.brightness = frame.brightness

      if (frame.rgb) {
        pending.current.push({ t: now / 1000, r: frame.rgb[0], g: frame.rgb[1], b: frame.rgb[2] })
      }
    }

    setState('starting')
    setDetail('')
    navigator.mediaDevices
      // 앞 카메라를 기본으로 한다. 얼굴을 찍는 화면이라 폰에서 뒤 카메라가 열리면
      // 아무것도 안 잡힌다.
      .getUserMedia({ video: { facingMode: 'user', width: 640, height: 480 }, audio: false })
      .then(async (stream) => {
        if (disposed) {
          stream.getTracks().forEach((t) => t.stop())
          return
        }
        const video = videoRef.current
        if (!video) return
        video.srcObject = stream
        await video.play().catch(() => {})
        setState('running')
        raf = requestAnimationFrame(tick)
        timer = window.setInterval(() => void send(), POST_MS)
      })
      .catch((error: DOMException) => {
        if (disposed) return
        const denied = error.name === 'NotAllowedError' || error.name === 'SecurityError'
        setState(denied ? 'denied' : 'failed')
        setDetail(
          denied
            ? '카메라 권한이 필요합니다. 주소창 옆에서 허용해 주세요'
            : `카메라를 열지 못했습니다 (${error.name})`,
        )
      })

    return () => {
      disposed = true
      cancelAnimationFrame(raf)
      if (timer) window.clearInterval(timer)
      stop()
    }
  }, [active, stop])

  return { videoRef, state, detail, reading, roi: ROI }
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}

/**
 * 이 픽셀을 피부로 볼 것인가. core/adapters/rppg.py 의 _skin_mask 와 같은 판정이다.
 *
 * 따로 내보내는 이유는 대조할 수 있게 하기 위해서다. 손으로 옮긴 식이라 파이썬 쪽과
 * 갈리면 피부 비율이 달라지고, 그러면 같은 얼굴을 두 배포가 다르게 판정한다.
 * 변환식은 BT.601 로 cv2.cvtColor(..., COLOR_BGR2YCrCb) 가 쓰는 것과 같다.
 */
export function isSkin(r: number, g: number, b: number): boolean {
  // cv2 의 고정소수점 연산을 그대로 옮긴다. 0.299 같은 십진수를 실수로 계산하면
  // 경계에 걸친 픽셀에서 판정이 갈린다 — 실제로 백만 개 중 수십 개가 어긋났다.
  //
  // OpenCV 는 14비트 고정소수점 계수(4899/9617/1868, 11682/9241)를 쓰고 DESCALE 로
  // 반올림하며, Cr·Cb 에는 실수가 아니라 이미 반올림된 정수 Y 를 뺀다.
  const y = (r * 4899 + g * 9617 + b * 1868 + 8192) >> 14
  const cr = ((r - y) * 11682 + (128 << 14) + 8192) >> 14
  const cb = ((b - y) * 9241 + (128 << 14) + 8192) >> 14
  return (
    y >= SKIN.yLo &&
    y <= SKIN.yHi &&
    cr >= SKIN.crLo &&
    cr <= SKIN.crHi &&
    cb >= SKIN.cbLo &&
    cb <= SKIN.cbHi
  )
}

/**
 * 안내 박스 안의 피부 픽셀 평균색.
 *
 * 어댑터는 얼굴을 찾아 이마와 양 볼 셋을 가중 평균하지만 (core/adapters/rppg.py),
 * 여기는 고정 박스 하나다. 뽑아 내는 값의 뜻은 같다 — 피부로 보이는 픽셀의 평균색,
 * 그 비율, 밝기, 그리고 중심이 얼마나 움직였는가.
 */
function readFrame(ctx: CanvasRenderingContext2D): Frame {
  const bx = Math.round(ROI.x * W)
  const by = Math.round(ROI.y * H)
  const bw = Math.round(ROI.w * W)
  const bh = Math.round(ROI.h * H)
  const { data } = ctx.getImageData(bx, by, bw, bh)

  let count = 0
  let sumR = 0
  let sumG = 0
  let sumB = 0
  let sumX = 0
  let sumY = 0

  for (let i = 0, px = 0; i < data.length; i += 4, px++) {
    const r = data[i]
    const g = data[i + 1]
    const b = data[i + 2]
    if (!isSkin(r, g, b)) continue

    count++
    sumR += r
    sumG += g
    sumB += b
    sumX += px % bw
    sumY += Math.floor(px / bw)
  }

  const total = bw * bh
  // 어댑터의 MIN_SKIN_PIXELS 와 같은 뜻이다. 몇 픽셀만 남은 평균색은 얼굴이 아니라
  // 배경일 가능성이 크고, 그 값으로 맥파를 뽑으면 잡음에 락온한다.
  if (count < total * 0.02) {
    return { rgb: null, skinRatio: count / total, brightness: 0, center: null }
  }
  return {
    rgb: [sumR / count, sumG / count, sumB / count],
    skinRatio: count / total,
    brightness: (sumR + sumG + sumB) / (3 * count),
    center: [sumX / count, sumY / count],
  }
}

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

// 아직 얼굴을 못 찾았을 때 보여 주는 자리. 여기 맞춰 달라는 안내이기도 하다.
const HOME: Box = { x: 0.3, y: 0.15, w: 0.4, h: 0.5 }

// 피부 픽셀 분포에서 ROI 를 잡는다. 중심에서 표준편차의 이만큼까지를 얼굴로 본다.
// 1.6 이면 정규분포 기준 약 89% 를 덮는다 — 목·어깨까지 끌고 오지 않으면서 이마와
// 볼을 다 담는 값이다.
const SPREAD = 1.6
// 프레임 전체에서 피부가 이보다 적으면 얼굴이 없다고 본다.
const MIN_SKIN = 0.01
// ROI 를 프레임마다 그대로 옮기면 상자가 떨린다. 눌러서 따라가게 한다.
const ROI_ALPHA = 0.25
// 상자를 화면에 다시 그리는 주기. 30fps 로 상태를 갱신하면 리액트가 그만큼 렌더한다.
const ROI_PUSH_MS = 100

// YCrCb 피부 범위. core/adapters/rppg.py 의 _SKIN_LO/_SKIN_HI 와 같은 값이다.
const SKIN = { yLo: 40, yHi: 250, crLo: 133, crHi: 173, cbLo: 77, cbHi: 127 }

// 이만큼 흔들리면 jitter_norm = 1. 어댑터의 JITTER_SCALE_PX 와 같은 자리지만
// 여기 좌표계는 160x120 이라 그 비율로 줄여 잡는다.
const JITTER_SCALE = 6.0 * (W / 640)

export type CameraState = 'off' | 'starting' | 'running' | 'denied' | 'unsupported' | 'failed'

/** 0~1 비율. 캔버스 크기와 무관해야 화면에 그대로 얹을 수 있다. */
export interface Box {
  x: number
  y: number
  w: number
  h: number
}

export interface DeviceCamera {
  videoRef: React.RefObject<HTMLVideoElement | null>
  /** 확대 창처럼 같은 영상을 한 번 더 그릴 때 붙인다. 한 스트림에 <video> 여럿이 붙는다. */
  stream: MediaStream | null
  state: CameraState
  detail: string
  /** 서버가 방금 표본으로 낸 값. WebSocket 으로도 오지만 이쪽이 한 박자 빠르다. */
  reading: Metric | null
  /** 지금 얼굴로 보고 있는 자리. 화면에 그대로 그린다. */
  roi: Box
  /** 얼굴을 잡았는가. 못 잡았으면 roi 는 안내용 기본 자리다. */
  tracking: boolean
  /** ROI 안이 얼마나 피부인가 (0~1). 화면이 "잡히고 있다"를 보여 주는 데 쓴다. */
  skinRatio: number
}

interface Sample {
  t: number
  r: number
  g: number
  b: number
}

/** 한 프레임에서 뽑은 것. 얼굴을 못 찾으면 rgb 가 null 이다. */
interface Frame {
  rgb: [number, number, number] | null
  skinRatio: number
  brightness: number
  center: [number, number] | null
  box: Box | null
}

export function useDeviceCamera(active: boolean): DeviceCamera {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const [stream, setStream] = useState<MediaStream | null>(null)
  const [state, setState] = useState<CameraState>('off')
  const [detail, setDetail] = useState('')
  const [reading, setReading] = useState<Metric | null>(null)
  const [roi, setRoi] = useState<Box>(HOME)
  const [tracking, setTracking] = useState(false)
  const [skinRatio, setSkinRatio] = useState(0)

  // 렌더마다 새로 만들지 않는다. 프레임 루프가 계속 들고 있어야 하는 값들이다.
  const pending = useRef<Sample[]>([])
  const quality = useRef({ jitter: 0, skinRatio: 0, brightness: 0 })
  const prevCenter = useRef<[number, number] | null>(null)
  const box = useRef<Box>(HOME)

  const stop = useCallback(() => {
    const video = videoRef.current
    const live = (video?.srcObject as MediaStream | null) ?? null
    live?.getTracks().forEach((track) => track.stop())
    if (video) video.srcObject = null
    setStream(null)
    pending.current = []
    prevCenter.current = null
    box.current = HOME
    // 서버가 마지막 값을 바로 버리게 한다. 안 불러도 몇 초 뒤 저절로 내려가지만,
    // 끈 사람이 자기 심박이 남아 있는 것을 보면 안 꺼진 줄 안다.
    void fetch('/api/rppg/samples', { method: 'DELETE' }).catch(() => {})
  }, [])

  useEffect(() => {
    if (!active) {
      stop()
      setState('off')
      setReading(null)
      setTracking(false)
      setRoi(HOME)
      setSkinRatio(0)
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
    let lastPush = 0
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

      if (frame.box) {
        // 잡은 자리로 눌러서 따라간다. 한 프레임 튄 것 때문에 상자가 날아다니면
        // 맞추는 사람이 그걸 따라 움직이게 된다.
        box.current = blend(box.current, frame.box, ROI_ALPHA)
      }

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

      if (now - lastPush >= ROI_PUSH_MS) {
        lastPush = now
        setRoi({ ...box.current })
        setTracking(frame.box !== null)
        setSkinRatio(frame.skinRatio)
      }
    }

    setState('starting')
    setDetail('')
    navigator.mediaDevices
      // 앞 카메라를 기본으로 한다. 얼굴을 찍는 화면이라 폰에서 뒤 카메라가 열리면
      // 아무것도 안 잡힌다.
      .getUserMedia({ video: { facingMode: 'user', width: 640, height: 480 }, audio: false })
      .then(async (opened) => {
        if (disposed) {
          opened.getTracks().forEach((t) => t.stop())
          return
        }
        const video = videoRef.current
        if (!video) return
        video.srcObject = opened
        await video.play().catch(() => {})
        setStream(opened)
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

  return { videoRef, stream, state, detail, reading, roi, tracking, skinRatio }
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}

function blend(from: Box, to: Box, alpha: number): Box {
  const mix = (a: number, b: number) => a + (b - a) * alpha
  return {
    x: mix(from.x, to.x),
    y: mix(from.y, to.y),
    w: mix(from.w, to.w),
    h: mix(from.h, to.h),
  }
}

/**
 * 이 픽셀을 피부로 볼 것인가. core/adapters/rppg.py 의 _skin_mask 와 같은 판정이다.
 *
 * 따로 내보내는 이유는 대조할 수 있게 하기 위해서다. 손으로 옮긴 식이라 파이썬 쪽과
 * 갈리면 피부 비율이 달라지고, 그러면 같은 얼굴을 두 배포가 다르게 판정한다.
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
 * 얼굴을 찾고 그 안의 평균색을 뽑는다.
 *
 * 얼굴 검출기를 쓰지 않는다. 브라우저마다 있는 API 가 다르고, 모델을 번들하면 폰에서
 * 첫 로딩이 그만큼 늦어진다. 대신 이미 프레임마다 하고 있는 피부 판정을 그대로 써서
 * 피부 픽셀이 모여 있는 자리를 얼굴로 본다 — 분포의 중심과 퍼짐으로 상자를 만든다.
 *
 * 한계가 있다. 살색 배경(나무 벽, 살구색 가구)이 크게 잡히면 상자가 그쪽으로 끌린다.
 * 그때는 상자 안 피부 비율이 떨어지고 신호도 나빠져서 서버가 값을 보류한다 —
 * 틀린 자리를 잡은 채로 숫자가 나오지는 않는다.
 *
 * 어댑터(core/adapters/rppg.py)는 얼굴을 찾은 뒤 이마와 양 볼 셋을 가중 평균한다.
 * 여기는 상자 하나지만 뽑는 값의 뜻은 같다 — 피부 픽셀의 평균색, 그 비율, 밝기,
 * 그리고 중심이 얼마나 움직였는가.
 */
function readFrame(ctx: CanvasRenderingContext2D): Frame {
  const { data } = ctx.getImageData(0, 0, W, H)

  // 1차: 프레임 전체에서 피부가 어디에 모여 있는지 본다.
  let n = 0
  let sx = 0
  let sy = 0
  let sxx = 0
  let syy = 0
  for (let i = 0, px = 0; i < data.length; i += 4, px++) {
    if (!isSkin(data[i], data[i + 1], data[i + 2])) continue
    const x = px % W
    const y = (px / W) | 0
    n++
    sx += x
    sy += y
    sxx += x * x
    syy += y * y
  }

  if (n < W * H * MIN_SKIN) {
    // 얼굴이 없다. 상자는 부르는 쪽이 안내 자리로 되돌린다.
    return { rgb: null, skinRatio: 0, brightness: 0, center: null, box: null }
  }

  const cx = sx / n
  const cy = sy / n
  const halfW = Math.max(8, SPREAD * Math.sqrt(Math.max(0, sxx / n - cx * cx)))
  const halfH = Math.max(8, SPREAD * Math.sqrt(Math.max(0, syy / n - cy * cy)))

  const x0 = Math.max(0, Math.round(cx - halfW))
  const y0 = Math.max(0, Math.round(cy - halfH))
  const x1 = Math.min(W, Math.round(cx + halfW))
  const y1 = Math.min(H, Math.round(cy + halfH))
  const bw = x1 - x0
  const bh = y1 - y0
  if (bw <= 0 || bh <= 0) {
    return { rgb: null, skinRatio: 0, brightness: 0, center: null, box: null }
  }

  // 2차: 그 상자 안의 피부 픽셀만으로 평균색을 낸다. 밖에 있는 살색 배경이
  // 평균에 섞이지 않게 하려는 것이다.
  let count = 0
  let sumR = 0
  let sumG = 0
  let sumB = 0
  let inX = 0
  let inY = 0
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * W + x) * 4
      const r = data[i]
      const g = data[i + 1]
      const b = data[i + 2]
      if (!isSkin(r, g, b)) continue
      count++
      sumR += r
      sumG += g
      sumB += b
      inX += x
      inY += y
    }
  }

  const ratio = count / (bw * bh)
  const box = { x: x0 / W, y: y0 / H, w: bw / W, h: bh / H }
  // 어댑터의 MIN_SKIN_PIXELS 와 같은 뜻이다. 몇 픽셀만 남은 평균색은 얼굴이 아니라
  // 배경일 가능성이 크고, 그 값으로 맥파를 뽑으면 잡음에 락온한다.
  if (count < bw * bh * 0.02) {
    return { rgb: null, skinRatio: ratio, brightness: 0, center: null, box }
  }

  // 상자를 눌러 따라가게 하는 것은 부르는 쪽이 한다. 여기서는 이번 프레임만 본다.
  return {
    rgb: [sumR / count, sumG / count, sumB / count],
    skinRatio: ratio,
    brightness: (sumR + sumG + sumB) / (3 * count),
    center: [inX / count, inY / count],
    box,
  }
}

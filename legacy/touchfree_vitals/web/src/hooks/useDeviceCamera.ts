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
//
// 어디를 재고 있는지는 화면에 그대로 나가야 한다. 재는 쪽이 아무 반응도 없으면
// 값이 나와도 믿기 어렵고, 얼굴을 어떻게 놓아야 하는지도 알 수 없다. 그래서 얼굴
// 자리와 실제로 재는 구역을 같이 돌려준다 — 그리는 것과 재는 것이 같아야 한다.

const FPS = 30
const FRAME_MS = 1000 / FPS
// 프레임을 거를 때 쓰는 간격. FRAME_MS 를 그대로 쓰면 60Hz 화면에서 두 프레임
// 간격(33.33ms)이 FRAME_MS 와 딱 같아, 부동소수점이 조금만 모자라도 한 프레임을
// 더 건너뛰어 30 이 아니라 20fps 로 주저앉는다.
const FRAME_GAP_MS = FRAME_MS - 2
const POST_MS = 1000 // 한 묶음에 30개 남짓

// 처리용 캔버스 크기. 얼굴 영역의 평균색만 쓰므로 이 이상 필요 없고, 작을수록
// 프레임당 비용이 준다 — 폰에서 배터리와 발열로 바로 드러난다.
const W = 160
const H = 120

// 아직 얼굴을 못 찾았을 때 보여 주는 자리. 여기 맞춰 달라는 안내이기도 하다.
const HOME: Box = { x: 0.3, y: 0.15, w: 0.4, h: 0.5 }

// 살색 덩어리가 이보다 작으면 얼굴이 아니라고 본다 (프레임 대비).
const MIN_BLOB = 0.01
// 얼굴 덩어리가 세로로 이보다 길면 목·가슴까지 이어진 것으로 보고 위쪽만 남긴다.
// 얼굴은 대략 가로:세로 = 1:1.3 이라, 그보다 훨씬 길면 옷이 붙은 것이다.
const FACE_ASPECT = 1.4
// 상자를 프레임마다 그대로 옮기면 떨린다. 눌러서 따라가게 한다.
const ROI_ALPHA = 0.25
// 상자를 화면에 다시 그리는 주기. 30fps 로 상태를 갱신하면 리액트가 그만큼 렌더한다.
const ROI_PUSH_MS = 100

// 얼굴 상자 안에서 실제로 재는 자리. core/adapters/rppg.py 의 _roi_candidates 와
// 같은 비율이다 — 두 배포가 같은 곳을 재야 숫자를 나란히 놓고 말할 수 있다.
const PATCHES: { label: string; x: number; y: number; w: number; h: number }[] = [
  { label: '이마', x: 0.3, y: 0.08, w: 0.4, h: 0.16 },
  { label: '왼쪽 볼', x: 0.18, y: 0.42, w: 0.24, h: 0.22 },
  { label: '오른쪽 볼', x: 0.58, y: 0.42, w: 0.24, h: 0.22 },
]

// YCrCb 피부 범위. core/adapters/rppg.py 의 _SKIN_LO/_SKIN_HI 와 같은 값이다.
const SKIN = { yLo: 40, yHi: 250, crLo: 133, crHi: 173, cbLo: 77, cbHi: 127 }

// 이만큼 흔들리면 jitter_norm = 1. 어댑터의 JITTER_SCALE_PX 와 같은 자리지만
// 여기 좌표계는 160x120 이라 그 비율로 줄여 잡는다.
const JITTER_SCALE = 6.0 * (W / 640)

// 프레임마다 새로 만들지 않는다. 30fps 로 19,200칸짜리 배열을 두 개씩 버리면
// 가비지 수집이 계속 돈다.
//
// mask 칸의 뜻: 0 피부 아님 / 1 피부인데 아직 안 세어 봄 / COUNTED 피부이고 세어 봤음.
// largestBlob 이 다 돌고 나면 1 은 남지 않으므로, 그 뒤로는 COUNTED 가 곧 "피부"다.
const mask = new Uint8Array(W * H)
const stack = new Int32Array(W * H)
const COUNTED = 2

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
  /** 얼굴로 보고 있는 자리. 화면에 옅게 그린다. */
  face: Box
  /** 실제로 재고 있는 구역들 (이마·양 볼). 화면에 진하게 그린다. */
  rois: Box[]
  /** 얼굴을 잡았는가. 못 잡았으면 face 는 안내용 기본 자리다. */
  tracking: boolean
  /** 재는 구역이 얼마나 피부인가 (0~1). "잡히고 있다"를 보여 주는 데 쓴다. */
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
  face: Box | null
  rois: Box[]
}

export function useDeviceCamera(active: boolean): DeviceCamera {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const [stream, setStream] = useState<MediaStream | null>(null)
  const [state, setState] = useState<CameraState>('off')
  const [detail, setDetail] = useState('')
  const [reading, setReading] = useState<Metric | null>(null)
  const [face, setFace] = useState<Box>(HOME)
  const [rois, setRois] = useState<Box[]>([])
  const [tracking, setTracking] = useState(false)
  const [skinRatio, setSkinRatio] = useState(0)

  // 렌더마다 새로 만들지 않는다. 프레임 루프가 계속 들고 있어야 하는 값들이다.
  const pending = useRef<Sample[]>([])
  const quality = useRef({ jitter: 0, skinRatio: 0, brightness: 0 })
  const prevCenter = useRef<[number, number] | null>(null)
  const held = useRef<Box>(HOME)

  const stop = useCallback(() => {
    const video = videoRef.current
    const live = (video?.srcObject as MediaStream | null) ?? null
    live?.getTracks().forEach((track) => track.stop())
    if (video) video.srcObject = null
    setStream(null)
    pending.current = []
    prevCenter.current = null
    held.current = HOME
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
      setFace(HOME)
      setRois([])
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
    let lastFrame = 0
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
      //
      // 마지막 프레임을 따로 들고 있는다. 예전에는 마지막으로 보낸 표본의 시각을
      // 봤는데, 표본은 얼굴을 찾았을 때만 쌓인다 — 얼굴을 못 찾는 동안에는 볼
      // 것이 없어서 이 걸름이 통째로 풀렸다. 화면을 맞추느라 얼굴이 안 잡히는
      // 그 시간에 폰이 가장 더워지고 있었다. 묶음을 보낸 직후에도 같은 일이
      // 벌어졌다 (send 가 pending 을 비운다).
      if (now - lastFrame < FRAME_GAP_MS) return
      lastFrame = now

      ctx.drawImage(video, 0, 0, W, H)
      const frame = readFrame(ctx)

      if (frame.face) {
        // 잡은 자리로 눌러서 따라간다. 한 프레임 튄 것 때문에 상자가 날아다니면
        // 맞추는 사람이 그걸 따라 움직이게 된다.
        held.current = blend(held.current, frame.face, ROI_ALPHA)
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
        setFace({ ...held.current })
        // 눌러 둔 얼굴 자리에서 다시 잘라야 화면의 세 칸도 같이 눌린다.
        setRois(frame.face ? patchesOf(held.current) : [])
        setTracking(frame.face !== null)
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

  return { videoRef, stream, state, detail, reading, face, rois, tracking, skinRatio }
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

/** 얼굴 상자 안의 측정 구역들. 화면에 그리는 것과 실제로 재는 것이 같아야 한다. */
function patchesOf(face: Box): Box[] {
  return PATCHES.map((p) => ({
    x: face.x + p.x * face.w,
    y: face.y + p.y * face.h,
    w: p.w * face.w,
    h: p.h * face.h,
  }))
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
 * 가장 큰 살색 덩어리를 찾는다.
 *
 * 흩어진 피부 픽셀의 평균으로 상자를 잡으면 안 된다. 방에 살색이 여기저기 있으면
 * (나무 벽, 손, 살색 옷, 조명 받은 벽) 중심이 그 가운데로 끌리고 퍼짐이 커져서
 * 상자가 화면 전체가 된다 — 얼굴을 잡은 것이 아니라 살색이 있는 범위를 감싼 것이다.
 *
 * 서로 붙어 있는 것끼리 묶으면 벽은 벽대로, 얼굴은 얼굴대로 세어진다. 픽셀마다
 * 한 번씩만 방문하므로 비용은 전체 한 바퀴와 같다.
 *
 * 끝나고 나면 mask 에 피부 판정이 그대로 남는다 (COUNTED). 다 훑고 나온 참이라 1 은
 * 하나도 안 남는다 — readFrame 이 이걸 다시 계산하지 않고 읽는다.
 */
function largestBlob(data: Uint8ClampedArray): { x0: number; y0: number; x1: number; y1: number; count: number } | null {
  for (let i = 0, px = 0; i < data.length; i += 4, px++) {
    mask[px] = isSkin(data[i], data[i + 1], data[i + 2]) ? 1 : 0
  }

  let best: { x0: number; y0: number; x1: number; y1: number; count: number } | null = null
  for (let seed = 0; seed < mask.length; seed++) {
    if (mask[seed] !== 1) continue

    let top = 0
    stack[top++] = seed
    mask[seed] = COUNTED // 밀어 넣기 전에 표시한다. 안 그러면 같은 칸이 여러 번 쌓인다.
    let count = 0
    let x0 = W
    let y0 = H
    let x1 = 0
    let y1 = 0

    while (top > 0) {
      const p = stack[--top]
      const x = p % W
      const y = (p / W) | 0
      count++
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y

      if (x > 0 && mask[p - 1] === 1) (mask[p - 1] = COUNTED), (stack[top++] = p - 1)
      if (x < W - 1 && mask[p + 1] === 1) (mask[p + 1] = COUNTED), (stack[top++] = p + 1)
      if (y > 0 && mask[p - W] === 1) (mask[p - W] = COUNTED), (stack[top++] = p - W)
      if (y < H - 1 && mask[p + W] === 1) (mask[p + W] = COUNTED), (stack[top++] = p + W)
    }

    if (!best || count > best.count) best = { x0, y0, x1: x1 + 1, y1: y1 + 1, count }
  }
  return best
}

/**
 * 얼굴을 찾고, 그 안의 이마·양 볼에서 평균색을 뽑는다.
 *
 * 어댑터(core/adapters/rppg.py)는 Haar cascade 로 얼굴을 찾은 뒤 같은 비율로 세
 * 구역을 자르고 피부 픽셀 수로 가중 평균한다. 여기는 얼굴을 찾는 방법만 다르다 —
 * 브라우저에는 검출기가 없어서 가장 큰 살색 덩어리를 얼굴로 본다. 그 뒤로는 같다.
 *
 * 세 구역으로 나누는 이유는 한 곳이 가려져도 나머지로 버티기 위해서다. 손으로 볼을
 * 괴면 그 칸만 빠지고 이마로 계속 잰다.
 */
function readFrame(ctx: CanvasRenderingContext2D): Frame {
  const { data } = ctx.getImageData(0, 0, W, H)
  const blob = largestBlob(data)
  const empty = { rgb: null, skinRatio: 0, brightness: 0, center: null, face: null, rois: [] }

  if (!blob || blob.count < W * H * MIN_BLOB) return empty

  // 목·가슴이 살색이면 얼굴과 한 덩어리가 된다. 얼굴은 세로가 가로의 1.3배쯤이라
  // 그보다 길면 위쪽(머리)만 남긴다.
  const bw = blob.x1 - blob.x0
  const bh = Math.min(blob.y1 - blob.y0, Math.round(bw * FACE_ASPECT))
  if (bw < 8 || bh < 8) return empty
  const face = { x: blob.x0 / W, y: blob.y0 / H, w: bw / W, h: bh / H }

  // 세 구역 각각의 평균색을 내고 피부 픽셀 수로 가중 평균한다 (_select_hr_roi 와 같다).
  let total = 0
  let wr = 0
  let wg = 0
  let wb = 0
  let bestCount = 0
  let bestRatio = 0
  let bestBright = 0
  let bestCenter: [number, number] | null = null

  for (const patch of patchesOf(face)) {
    const px0 = Math.max(0, Math.round(patch.x * W))
    const py0 = Math.max(0, Math.round(patch.y * H))
    const px1 = Math.min(W, Math.round((patch.x + patch.w) * W))
    const py1 = Math.min(H, Math.round((patch.y + patch.h) * H))
    const area = (px1 - px0) * (py1 - py0)
    if (area <= 0) continue

    let count = 0
    let sr = 0
    let sg = 0
    let sb = 0
    for (let y = py0; y < py1; y++) {
      for (let x = px0; x < px1; x++) {
        // 피부인지는 largestBlob 이 방금 프레임 전체에 대해 정해 뒀다. 여기서 다시
        // 재면 같은 픽셀을 두 번 판정하는 것이고, 판정이 두 군데 적히면 언젠가
        // 갈린다.
        const px = y * W + x
        if (mask[px] !== COUNTED) continue
        const i = px * 4
        count++
        sr += data[i]
        sg += data[i + 1]
        sb += data[i + 2]
      }
    }
    // 몇 픽셀만 남은 평균색은 얼굴이 아니라 배경일 가능성이 크다. 어댑터의
    // MIN_SKIN_PIXELS 와 같은 뜻이다.
    if (count < area * 0.1) continue

    total += count
    wr += (sr / count) * count
    wg += (sg / count) * count
    wb += (sb / count) * count
    if (count > bestCount) {
      bestCount = count
      bestRatio = count / area
      bestBright = (sr + sg + sb) / (3 * count)
      bestCenter = [(px0 + px1) / 2, (py0 + py1) / 2]
    }
  }

  if (total === 0) {
    // 얼굴 자리는 잡았는데 잴 만한 피부가 없다. 상자는 보여 주되 값은 안 만든다.
    return { rgb: null, skinRatio: 0, brightness: 0, center: null, face, rois: patchesOf(face) }
  }

  return {
    rgb: [wr / total, wg / total, wb / total],
    skinRatio: bestRatio,
    brightness: bestBright,
    center: bestCenter,
    face,
    rois: patchesOf(face),
  }
}

import { useEffect, useRef, useState } from 'react'
import fixture from '../fixtures/snapshot.json'
import type { Snapshot } from './types'

// 상태는 서버가 소유하고 프론트는 이 훅 하나로만 받는다. 브라우저 저장소는 쓰지
// 않는다 — 권위 있는 상태가 아니라서다.
//
// 백엔드가 없으면 픽스처로 넘어간다. 프론트를 모듈과 따로 만들 수 있게 하는 것이
// 이 폴백이고, 그래서 픽스처는 손으로 적지 않고 실제 모델에서 생성한다
// (tools/export_contract.py).

const STALE_MS = 3000
/** 이 시간 안에 한 번도 못 붙으면 픽스처로 간다. */
const FALLBACK_MS = 1200

// 재연결 간격은 늘려 가되 상한을 둔다.
//
// 고정 2초로 두면 백엔드가 아예 없는 정적 배포(Cloudflare Pages)에서 방문자마다
// 없는 주소를 2초마다 영원히 두드린다. 그렇다고 아주 포기하면 로컬에서 화면을
// 먼저 띄우고 백엔드를 나중에 켜는 흔한 순서가 깨진다 — 늘리되 멈추지는 않는다.
const RETRY_MIN_MS = 2000
const RETRY_MAX_MS = 30000

export type Feed = 'live' | 'fixture' | 'connecting'

export interface SnapshotFeed {
  snapshot: Snapshot | null
  feed: Feed
  stale: boolean
}

export function useSnapshot(): SnapshotFeed {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [feed, setFeed] = useState<Feed>('connecting')
  const [stale, setStale] = useState(false)
  const lastRecv = useRef(0)
  const backoff = useRef(RETRY_MIN_MS)

  useEffect(() => {
    let socket: WebSocket | null = null
    let retry: number | undefined
    let disposed = false

    const connect = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws'
      socket = new WebSocket(`${proto}://${location.host}/ws`)

      socket.onopen = () => {
        backoff.current = RETRY_MIN_MS
      }
      socket.onmessage = (event) => {
        const next = JSON.parse(event.data as string) as Snapshot
        lastRecv.current = Date.now()
        setSnapshot(next)
        setFeed('live')
        setStale(false)
      }
      socket.onclose = () => {
        if (disposed) return
        retry = window.setTimeout(connect, backoff.current)
        backoff.current = Math.min(backoff.current * 2, RETRY_MAX_MS)
      }
    }
    connect()

    // 백엔드가 없는 채로 개발 중일 수 있다. 잠깐 기다려 보고 안 붙으면 픽스처를
    // 그린다 — 화면이 영영 빈 채로 남는 것보다 낫다.
    const fallback = window.setTimeout(() => {
      if (lastRecv.current === 0) {
        setSnapshot(fixture as Snapshot)
        setFeed('fixture')
      }
    }, FALLBACK_MS)

    // 서버가 조용히 끊긴 경우 onclose 가 늦게 올 수 있어 수신 시각을 직접 감시한다.
    const watchdog = window.setInterval(() => {
      if (lastRecv.current > 0 && Date.now() - lastRecv.current > STALE_MS) setStale(true)
    }, 1000)

    return () => {
      disposed = true
      window.clearTimeout(fallback)
      window.clearInterval(watchdog)
      if (retry) window.clearTimeout(retry)
      socket?.close()
    }
  }, [])

  return { snapshot, feed, stale }
}

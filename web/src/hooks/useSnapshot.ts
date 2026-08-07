import { useEffect, useRef, useState } from 'react'
import type { Snapshot } from '../types'

// 상태는 서버가 소유하고 프론트는 이 훅 하나로만 받는다 (README §10).
// 브라우저 저장소는 쓰지 않는다. history 는 화면에 추세를 그리기 위한 휘발성
// 버퍼일 뿐이라 새로고침하면 사라진다 — 권위 있는 상태가 아니다.

const STALE_MS = 5000 // 마지막 수신 후 5초 (README §2)
const RETRY_MS = 1000
const HISTORY_MAX = 600 // 1Hz 기준 10분

export interface SnapshotFeed {
  snapshot: Snapshot | null
  history: Snapshot[]
  stale: boolean
}

export function useSnapshot(): SnapshotFeed {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [history, setHistory] = useState<Snapshot[]>([])
  const [stale, setStale] = useState(false)
  const lastRecv = useRef(0)

  useEffect(() => {
    let socket: WebSocket | null = null
    let retry: number | undefined
    let disposed = false

    const connect = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws'
      socket = new WebSocket(`${proto}://${location.host}/ws`)

      socket.onmessage = (event) => {
        const next = JSON.parse(event.data as string) as Snapshot
        lastRecv.current = Date.now()
        setSnapshot(next)
        setHistory((prev) => {
          const grown = [...prev, next]
          return grown.length > HISTORY_MAX ? grown.slice(-HISTORY_MAX) : grown
        })
        setStale(false)
      }
      socket.onclose = () => {
        if (!disposed) retry = window.setTimeout(connect, RETRY_MS)
      }
    }
    connect()

    // 서버가 조용히 끊긴 경우 onclose 가 늦게 올 수 있어, 수신 시각을 직접 감시한다.
    const watchdog = window.setInterval(() => {
      if (lastRecv.current > 0 && Date.now() - lastRecv.current > STALE_MS) setStale(true)
    }, 1000)

    return () => {
      disposed = true
      window.clearInterval(watchdog)
      if (retry) window.clearTimeout(retry)
      socket?.close()
    }
  }, [])

  return { snapshot, history, stale }
}

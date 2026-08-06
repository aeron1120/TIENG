import { useEffect, useRef, useState } from 'react'
import type { Snapshot } from '../types'

// 상태는 서버가 소유하고 프론트는 이 훅 하나로만 받는다 (README §10).
// 브라우저 저장소는 쓰지 않는다.

const STALE_MS = 5000 // 마지막 수신 후 5초 (README §2)
const RETRY_MS = 1000

export function useSnapshot(): { snapshot: Snapshot | null; stale: boolean } {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
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
        lastRecv.current = Date.now()
        setSnapshot(JSON.parse(event.data as string) as Snapshot)
        setStale(false)
      }
      socket.onclose = () => {
        if (!disposed) retry = window.setTimeout(connect, RETRY_MS)
      }
    }
    connect()

    // 서버가 조용히 끊긴 경우 onclose가 늦게 올 수 있어, 수신 시각을 직접 감시한다.
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

  return { snapshot, stale }
}

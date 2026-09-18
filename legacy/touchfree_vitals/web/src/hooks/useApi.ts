import { useCallback, useEffect, useState } from 'react'

// 스냅샷은 WebSocket 으로 밀려오지만 상태·기록·검증은 눌렀을 때 한 번 가져오면 된다.
// 그 한 번을 위해 로딩/에러 처리를 매 페이지에서 다시 쓰지 않으려고 여기 모은다.

export interface Async<T> {
  data: T | null
  error: string | null
  loading: boolean
  run: () => void
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init)
  if (!res.ok) {
    // FastAPI 는 실패 사유를 detail 에 담는다. 그게 화면에 보여야 고칠 수 있다.
    const body = await res.json().catch(() => null)
    throw new Error(body?.detail ?? `${res.status} ${res.statusText}`)
  }
  return (await res.json()) as T
}

/** 페이지에 들어오면 한 번 가져오고, 필요하면 다시 부를 수 있다. */
export function useGet<T>(url: string, auto = true): Async<T> {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const run = useCallback(() => {
    setLoading(true)
    setError(null)
    request<T>(url)
      .then(setData)
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false))
  }, [url])

  useEffect(() => {
    if (auto) run()
  }, [auto, run])

  return { data, error, loading, run }
}

/** 버튼을 눌렀을 때만 실행된다. 검증처럼 시간이 걸리는 작업용. */
export function usePost<T>(url: string): Async<T> & { send: (body?: unknown) => void } {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const send = useCallback(
    (body?: unknown) => {
      setLoading(true)
      setError(null)
      request<T>(url, {
        method: 'POST',
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      })
        .then(setData)
        .catch((e: Error) => setError(e.message))
        .finally(() => setLoading(false))
    },
    [url],
  )

  return { data, error, loading, run: () => send(), send }
}

import { useCallback, useEffect, useState } from 'react'

// 블록 배치는 서버가 들고 있다 (README §10). localStorage 를 쓰면 같은 기기를
// 다른 브라우저로 열었을 때 배치가 달라지고, 그건 "상태는 서버가 소유한다"에
// 어긋난다.
//
// 저장은 낙관적으로 한다. 드래그를 놓을 때마다 서버 왕복을 기다리면 손이 끊긴다.
// 대신 실패하면 조용히 넘기지 않고 사유를 돌려준다 — 배치가 안 남는데 아무 말이
// 없으면 원인을 찾을 수 없다.

export interface Layout {
  /** 크게 볼 지표. */
  hero: string
  /** 보조 블록 순서. 여기 없는 지표는 뒤에 붙고, 지금 없는 지표는 건너뛴다. */
  order: string[]
}

const FALLBACK: Layout = { hero: 'hr', order: [] } // core/layout.py 의 기본값과 같다

export function useLayout(): {
  layout: Layout
  save: (next: Layout) => void
  saveError: string | null
} {
  const [layout, setLayout] = useState<Layout>(FALLBACK)
  const [saveError, setSaveError] = useState<string | null>(null)

  useEffect(() => {
    let disposed = false
    fetch('/api/layout')
      .then((res) => res.json() as Promise<Layout>)
      .then((next) => {
        if (!disposed) setLayout(next)
      })
      // 못 읽으면 기본 배치로 그냥 뜬다. 화면이 안 뜨는 것보다 낫다.
      .catch(() => undefined)
    return () => {
      disposed = true
    }
  }, [])

  const save = useCallback((next: Layout) => {
    setLayout(next)
    setSaveError(null)
    fetch('/api/layout', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(next),
    })
      .then((res) => {
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
      })
      .catch((e: Error) => setSaveError(e.message))
  }, [])

  return { layout, save, saveError }
}

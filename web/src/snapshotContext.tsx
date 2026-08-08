import { createContext, useContext, type ReactNode } from 'react'
import { useSnapshot, type SnapshotFeed } from './hooks/useSnapshot'

// WebSocket 은 앱 전체에 하나만 연다. 페이지마다 useSnapshot 을 부르면 페이지를
// 옮길 때마다 연결이 새로 생겨 서버가 같은 화면에 여러 번 브로드캐스트한다.

const Ctx = createContext<SnapshotFeed>({ snapshot: null, history: [], stale: false })

export function SnapshotProvider({ children }: { children: ReactNode }) {
  return <Ctx.Provider value={useSnapshot()}>{children}</Ctx.Provider>
}

export function useFeed(): SnapshotFeed {
  return useContext(Ctx)
}

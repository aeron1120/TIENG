import { createContext, useContext, useState, type ReactNode } from 'react'
import { useSnapshot, type Source, type SnapshotFeed } from './hooks/useSnapshot'

// WebSocket 은 앱 전체에 하나만 연다. 페이지마다 useSnapshot 을 부르면 페이지를
// 옮길 때마다 연결이 새로 생겨 서버가 같은 화면에 여러 번 브로드캐스트한다.
//
// 어느 기기의 센서를 볼지도 여기 있다. 고르는 곳(카메라 패널)과 받는 곳(소켓)이
// 다른 컴포넌트라, 둘 다 보이는 자리에 둬야 한다.

interface Feed extends SnapshotFeed {
  source: Source
  setSource: (next: Source) => void
}

const Ctx = createContext<Feed>({
  snapshot: null,
  history: [],
  stale: false,
  source: 'server',
  setSource: () => {},
})

export function SnapshotProvider({ children }: { children: ReactNode }) {
  // 저장하지 않는다. 새로고침하면 서버 센서로 돌아간다 — 카메라는 사람이 그때그때
  // 켜는 것이지 기기에 기억시켜 둘 설정이 아니다.
  const [source, setSource] = useState<Source>('server')
  const feed = useSnapshot(source)

  return <Ctx.Provider value={{ ...feed, source, setSource }}>{children}</Ctx.Provider>
}

export function useFeed(): Feed {
  return useContext(Ctx)
}

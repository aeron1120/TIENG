import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'

// 지금 보고 있는 사람이 누구인지를 앱 전체가 하나로 본다. 화면마다 물어보면 새로고침
// 직후에 잠깐씩 다른 답이 나와, 관문이 떴다가 사라지는 깜빡임이 생긴다.
//
// 토큰은 여기 없다. 세션은 HttpOnly 쿠키라서 (api/auth.py) 스크립트가 읽지 못하고,
// fetch 와 WebSocket 에 브라우저가 알아서 실어 보낸다. 화면은 "누구인가"만 안다.

export type Role = 'guest' | 'member' | 'admin'

export interface Principal {
  username: string | null // 비회원이면 null
  role: Role
}

const RANK: Record<Role, number> = { guest: 0, member: 1, admin: 2 }

/** 이 사람이 그 등급 이상인가. 서버의 권한 판정(api/main.py)과 같은 순서를 쓴다. */
export function atLeast(role: Role | undefined, minimum: Role): boolean {
  return role !== undefined && RANK[role] >= RANK[minimum]
}

export interface Auth {
  principal: Principal | null
  /** 첫 조회가 끝나기 전. 이 동안은 관문도 본문도 띄우지 않는다. */
  checking: boolean
  enterAsGuest: () => Promise<void>
  logIn: (username: string, password: string) => Promise<void>
  /** 가입하면 그 자리에서 들어온다. 승인을 기다리지 않는다. */
  register: (username: string, password: string) => Promise<void>
  logOut: () => Promise<void>
}

const Ctx = createContext<Auth>({
  principal: null,
  checking: true,
  enterAsGuest: async () => {},
  logIn: async () => {},
  register: async () => {},
  logOut: async () => {},
})

async function post<T>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    // 거절 사유가 그대로 보여야 한다. "승인 대기 중"과 "비밀번호가 틀렸다"는
    // 사용자가 할 일이 전혀 다르다.
    const detail = await res.json().catch(() => null)
    throw new Error(detail?.detail ?? `${res.status} ${res.statusText}`)
  }
  return (await res.json()) as T
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [principal, setPrincipal] = useState<Principal | null>(null)
  const [checking, setChecking] = useState(true)

  useEffect(() => {
    fetch('/api/auth/me')
      .then((res) => (res.ok ? res.json() : null))
      .then(setPrincipal)
      .catch(() => setPrincipal(null)) // 서버가 아직 안 떴으면 관문을 띄운다
      .finally(() => setChecking(false))
  }, [])

  const enterAsGuest = useCallback(async () => {
    setPrincipal(await post<Principal>('/api/auth/guest'))
  }, [])

  const logIn = useCallback(async (username: string, password: string) => {
    setPrincipal(await post<Principal>('/api/auth/login', { username, password }))
  }, [])

  const register = useCallback(async (username: string, password: string) => {
    setPrincipal(await post<Principal>('/api/auth/register', { username, password }))
  }, [])

  const logOut = useCallback(async () => {
    await post('/api/auth/logout')
    setPrincipal(null)
  }, [])

  return (
    <Ctx.Provider value={{ principal, checking, enterAsGuest, logIn, register, logOut }}>
      {children}
    </Ctx.Provider>
  )
}

export function useAuth(): Auth {
  return useContext(Ctx)
}

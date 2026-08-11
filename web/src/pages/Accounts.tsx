import { RotateCcw, ShieldOff } from 'lucide-react'
import { useState } from 'react'
import { useAuth } from '../authContext'
import { Empty, Page, Panel } from '../components/Page'
import { ProfileForm } from '../components/ProfileForm'
import { useGet } from '../hooks/useApi'

// 두 가지 일이 한 화면에 있다. 자기 정보를 고치는 건 로그인한 사람 누구나 하고,
// 계정을 차단하는 건 관리자만 한다. 탭을 나눈 이유는 후자가 앞에 있으면 대부분의
// 사용자에게는 쓸 일 없는 목록이 먼저 보이기 때문이다.
//
// 관리자가 아니면 탭 자체를 그리지 않는다. 눌러도 403 만 받는 탭은 없느니만 못하다.

interface Account {
  id: number
  username: string
  role: 'guest' | 'member' | 'admin'
  active: boolean
  created_at: string
}

function AccountList() {
  const { data, error, loading, run } = useGet<Account[]>('/api/auth/users')
  const [accounts, setAccounts] = useState<Account[] | null>(null)
  const [busy, setBusy] = useState<number | null>(null)
  const [failure, setFailure] = useState<string | null>(null)

  const list = accounts ?? data ?? []
  const blocked = list.filter((a) => !a.active)
  const active = list.filter((a) => a.active)

  const act = async (id: number, next: boolean) => {
    setBusy(id)
    setFailure(null)
    try {
      const res = await fetch(`/api/auth/users/${id}/active`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: next }),
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body?.detail ?? `${res.status} ${res.statusText}`)
      setAccounts(body as Account[])
    } catch (e) {
      setFailure((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const row = (a: Account) => (
    <li
      key={a.id}
      className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t-[0.5px] border-gold/10 py-2.5 first:border-t-0 first:pt-0"
    >
      <span className="kr min-w-0 flex-1 text-[13px] text-fg">{a.username}</span>
      <span className="font-mono text-[11px] tracking-[0.12em] text-faint uppercase">{a.role}</span>
      <span className="kr tnum text-[11px] text-faint">
        {new Date(a.created_at).toLocaleDateString('ko-KR')}
      </span>
      {a.active ? (
        a.role === 'admin' ? (
          // 마지막 관리자를 막으면 아무도 차단을 못 한다. 서버도 거절한다.
          <span className="kr text-[11px] text-faint">차단 불가</span>
        ) : (
          <button
            onClick={() => act(a.id, false)}
            disabled={busy !== null}
            className="kr flex items-center gap-1.5 rounded-md border-[0.5px] border-alert/40 px-2.5 py-1 text-[12px] text-alert transition-colors hover:bg-alert/10 disabled:opacity-40"
          >
            <ShieldOff className="h-3.5 w-3.5" />
            차단
          </button>
        )
      ) : (
        <button
          onClick={() => act(a.id, true)}
          disabled={busy !== null}
          className="kr flex items-center gap-1.5 rounded-md border-[0.5px] border-gold/40 px-2.5 py-1 text-[12px] text-gold transition-colors hover:bg-gold/10 disabled:opacity-40"
        >
          <RotateCcw className="h-3.5 w-3.5" />
          차단 해제
        </button>
      )}
    </li>
  )

  return (
    <div className="flex flex-col gap-4">
      {(error || failure) && (
        <Panel className="border-alert/40">
          <p className="kr text-[12px] text-alert">{failure ?? error}</p>
        </Panel>
      )}

      {blocked.length > 0 && (
        <Panel className="border-alert/40">
          <h2 className="kr mb-2.5 text-[12px] font-medium text-muted">
            차단됨 <span className="tnum text-alert">{blocked.length}</span>
          </h2>
          <ul className="flex flex-col">{blocked.map(row)}</ul>
        </Panel>
      )}

      <Panel>
        <h2 className="kr mb-2.5 text-[12px] font-medium text-muted">
          사용 중 <span className="tnum text-gold">{active.length}</span>
        </h2>
        {active.length ? <ul className="flex flex-col">{active.map(row)}</ul> : <Empty>없다</Empty>}
      </Panel>

      <div className="flex justify-end">
        <button
          onClick={() => {
            setAccounts(null)
            run()
          }}
          disabled={loading}
          className="kr rounded-md border-[0.5px] border-gold/25 px-3 py-1.5 text-[12px] text-muted transition-colors hover:border-gold/50 hover:text-fg disabled:opacity-40"
        >
          {loading ? '불러오는 중…' : '새로고침'}
        </button>
      </div>
    </div>
  )
}

const TABS = [
  { key: 'me' as const, label: '내 정보' },
  { key: 'manage' as const, label: '계정 관리' },
]

export function Accounts() {
  const { principal } = useAuth()
  const [tab, setTab] = useState<'me' | 'manage'>('me')
  const isAdmin = principal?.role === 'admin'

  return (
    <Page title="계정">
      {isAdmin && (
        <div className="mb-5 flex items-center gap-1 border-b-[0.5px] border-gold/15">
          {TABS.map(({ key, label }) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={`kr -mb-[0.5px] border-b px-3 py-2 text-[13px] transition-colors ${
                tab === key
                  ? 'border-gold text-gold'
                  : 'border-transparent text-faint hover:text-muted'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      )}

      {isAdmin && tab === 'manage' ? <AccountList /> : <ProfileForm />}
    </Page>
  )
}

import {
  Activity,
  ClipboardList,
  FlaskConical,
  LogOut,
  type LucideIcon,
  Ruler,
  ShieldAlert,
  ShieldCheck,
  UserRound,
} from 'lucide-react'
import { Link, NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { atLeast, AuthProvider, useAuth, type Role } from './authContext'
import { PendingAlert } from './components/PendingAlert'
import { ICON, LABEL, displayValue, effectiveState } from './metrics'
import { Accounts } from './pages/Accounts'
import { Drowsy } from './pages/Drowsy'
import { Gate } from './pages/Gate'
import { Guardian } from './pages/Guardian'
import { Kiosk } from './pages/Kiosk'
import { Records } from './pages/Records'
import { Selftest } from './pages/Selftest'
import { System } from './pages/System'
import { Validation } from './pages/Validation'
import { SnapshotProvider, useFeed } from './snapshotContext'

// 상단 바 하나를 앱 전체가 공유한다. 어느 페이지에 있든 기기 이름과 수신 상태가
// 같은 자리에 있어야, 화면을 옮겨 다녀도 "지금 살아 있나"를 다시 찾지 않는다.

// min 은 서버가 라우터에 건 등급(api/main.py)과 같아야 한다. 화면에서만 숨기면
// 주소를 직접 치는 순간 빈 화면에 401 이 뜬다.
//
// 실시간은 여기 없다. 첫 화면이 곧 실시간이라 탭으로 한 번 더 걸면 지금 보고 있는
// 곳으로 가는 버튼이 하나 더 생길 뿐이다. 돌아오는 문은 왼쪽 위 로고다.
const NAV: { to: string; label: string; icon: LucideIcon; min: Role }[] = [
  { to: '/drowsy', label: '졸음 방지', icon: ShieldAlert, min: 'member' },
  { to: '/guardian', label: '보호자', icon: UserRound, min: 'member' },
  { to: '/system', label: '시스템', icon: Activity, min: 'member' },
  { to: '/records', label: '기록', icon: ClipboardList, min: 'member' },
  { to: '/selftest', label: '자체검증', icon: FlaskConical, min: 'member' },
  { to: '/validation', label: '정량검증', icon: Ruler, min: 'member' },
  // 계정 화면은 누구나 자기 정보를 고치러 온다. 관리자 전용 목록은 그 안에서 나눈다.
  { to: '/accounts', label: '계정', icon: ShieldCheck, min: 'member' },
]

const PAGES: Record<string, React.ReactElement> = {
  '/drowsy': <Drowsy />,
  '/guardian': <Guardian />,
  '/system': <System />,
  '/records': <Records />,
  '/selftest': <Selftest />,
  '/validation': <Validation />,
  '/accounts': <Accounts />,
}

// 홈(실시간)을 떠나 있을 때만 맨 위에 남기는 지표. 실시간 화면에는 같은 값이 이미
// 크게 떠 있어서 두 번 쓸 자리가 없고, 다른 화면에서는 여기 말고 볼 곳이 없다.
const VITALS = ['temp', 'hr']

function TopBar({ nav }: { nav: typeof NAV }) {
  const { snapshot, stale } = useFeed()
  const { principal, logOut } = useAuth()
  const away = useLocation().pathname !== '/'

  return (
    <header className="border-b-[0.5px] border-gold/15">
      <div className="mx-auto flex w-full max-w-shell flex-wrap items-center justify-between gap-3 px-6 py-3 md:px-10">
        {/* 로고가 곧 홈 버튼이다. 웹에서 왼쪽 위를 누르면 처음으로 돌아간다는 건
            따로 배우지 않아도 아는 규칙이라, 탭을 하나 더 늘리지 않는다. */}
        <Link
          to="/"
          className="flex items-center gap-3 font-mono text-[11px] tracking-[0.32em] text-gold uppercase transition-opacity hover:opacity-70"
        >
          <Activity className="h-4 w-4" />
          <span>VITAL_MONITOR_SYS</span>
          <span className="tracking-[0.12em] text-faint">
            [{snapshot?.device_id ?? '연결 대기'}]
          </span>
        </Link>

        <nav className="flex flex-wrap items-center gap-1">
          {nav.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                `kr flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[12px] transition-colors ${
                  isActive
                    ? 'bg-gold/15 text-gold'
                    : 'text-faint hover:bg-white/[0.05] hover:text-muted'
                }`
              }
            >
              <Icon className="h-3.5 w-3.5" />
              {label}
            </NavLink>
          ))}
        </nav>

        <div className="flex items-center gap-2.5 text-[12px] text-muted">
          <span
            className={
              stale || !snapshot
                ? 'h-2 w-2 rounded-full bg-faint'
                : 'h-2 w-2 animate-pulse rounded-full bg-gold shadow-[0_0_8px_rgba(197,160,89,0.7)]'
            }
          />
          <span className="kr tnum">
            {!snapshot
              ? '연결 중'
              : stale
                ? '수신 끊김'
                : new Date(snapshot.ts).toLocaleTimeString('ko-KR')}
          </span>

          {away &&
            snapshot &&
            VITALS.map((key) => {
              const metric = snapshot.metrics.find((m) => m.key === key)
              if (!metric) return null
              const Icon = ICON[key]
              // 품질 미달인 값은 여기에 뱃지를 붙일 자리가 없다. 상태를 못 적을
              // 바에는 숫자를 안 적는다 (README §2).
              const ok = effectiveState(metric, stale) === 'ok'
              const shown = ok ? displayValue(metric, stale) : null
              return (
                <span key={key} className="flex items-center gap-1" title={LABEL[key]}>
                  <Icon className={`h-3.5 w-3.5 ${shown === null ? 'text-faint' : 'text-gold'}`} />
                  {shown === null ? (
                    <span className="text-faint">—</span>
                  ) : (
                    <span className="tnum font-mono text-fg">{shown + (metric.unit ?? '')}</span>
                  )}
                </span>
              )
            })}

          {/* 비회원에게도 나가는 문은 보여야 한다. 태블릿을 여러 사람이 지나가며
              쓰므로, 다음 사람이 앞사람 세션을 물려받지 않게 한다. */}
          <button
            onClick={logOut}
            title={principal?.username ?? '비회원'}
            className="kr flex items-center gap-1.5 rounded-md px-2 py-1 text-faint transition-colors hover:bg-white/[0.05] hover:text-muted"
          >
            <LogOut className="h-3.5 w-3.5" />
            <span className="max-w-[10ch] truncate">{principal?.username ?? '비회원'}</span>
          </button>
        </div>
      </div>
    </header>
  )
}

function Shell() {
  const { principal, checking } = useAuth()

  // 첫 조회가 끝나기 전에는 아무것도 그리지 않는다. 여기서 관문을 먼저 띄우면
  // 이미 로그인해 둔 사람도 새로고침할 때마다 관문이 한 번 번쩍인다.
  if (checking) return null
  if (principal === null) return <Gate />

  const nav = NAV.filter((item) => atLeast(principal.role, item.min))

  return (
    // WebSocket 은 이 안에서만 열린다. 관문 뒤에 두지 않으면 로그인 화면을 띄운
    // 채로 지표가 흐르고, 서버가 거절할 때마다 1초 간격으로 재연결을 시도한다.
    <SnapshotProvider>
      <div className="flex min-h-screen flex-col bg-ink font-sans text-fg">
        <TopBar nav={nav} />
        {/* 취소 창은 어느 페이지에 있든 보여야 한다. 기록을 보던 중에 보호자에게
            메일이 나가면 안 된다. */}
        {atLeast(principal.role, 'member') && <PendingAlert />}
        <Routes>
          {/* 첫 화면이 실시간이다. 등급을 가리지 않으므로 비회원도 여기까지는 온다. */}
          <Route path="/" element={<Kiosk />} />
          {nav.map(({ to }) => (
            <Route key={to} path={to} element={PAGES[to]} />
          ))}
          {/* 권한 밖 주소를 직접 치면 볼 수 있는 화면으로 돌려보낸다. 빈 화면에
              401 을 띄우는 것보다 낫다. */}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </div>
    </SnapshotProvider>
  )
}

export function App() {
  return (
    <AuthProvider>
      <Shell />
    </AuthProvider>
  )
}

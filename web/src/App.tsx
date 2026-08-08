import {
  Activity,
  ClipboardList,
  FlaskConical,
  Gauge,
  Ruler,
  UserRound,
} from 'lucide-react'
import { Link, NavLink, Route, Routes } from 'react-router-dom'
import { Guardian } from './pages/Guardian'
import { Home } from './pages/Home'
import { Kiosk } from './pages/Kiosk'
import { Records } from './pages/Records'
import { Selftest } from './pages/Selftest'
import { System } from './pages/System'
import { Validation } from './pages/Validation'
import { SnapshotProvider, useFeed } from './snapshotContext'

// 상단 바 하나를 앱 전체가 공유한다. 어느 페이지에 있든 기기 이름과 수신 상태가
// 같은 자리에 있어야, 화면을 옮겨 다녀도 "지금 살아 있나"를 다시 찾지 않는다.

const NAV = [
  { to: '/live', label: '실시간', icon: Gauge },
  { to: '/guardian', label: '보호자', icon: UserRound },
  { to: '/system', label: '시스템', icon: Activity },
  { to: '/records', label: '기록', icon: ClipboardList },
  { to: '/selftest', label: '자체검증', icon: FlaskConical },
  { to: '/validation', label: '정량검증', icon: Ruler },
]

function TopBar() {
  const { snapshot, stale } = useFeed()

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
          {NAV.map(({ to, label, icon: Icon }) => (
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
        </div>
      </div>
    </header>
  )
}

export function App() {
  return (
    <SnapshotProvider>
      <div className="flex min-h-screen flex-col bg-ink font-sans text-fg">
        <TopBar />
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/live" element={<Kiosk />} />
          <Route path="/guardian" element={<Guardian />} />
          <Route path="/system" element={<System />} />
          <Route path="/records" element={<Records />} />
          <Route path="/selftest" element={<Selftest />} />
          <Route path="/validation" element={<Validation />} />
        </Routes>
      </div>
    </SnapshotProvider>
  )
}

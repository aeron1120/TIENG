import {
  Activity,
  ClipboardList,
  FlaskConical,
  Gauge,
  type LucideIcon,
  Ruler,
  UserRound,
} from 'lucide-react'
import { Link } from 'react-router-dom'
import { useGet } from '../hooks/useApi'
import { LABEL, displayValue, verdict } from '../metrics'
import { useFeed } from '../snapshotContext'

// 첫 화면. 상단 탭만으로도 이동은 되지만, 처음 여는 사람은 탭 여섯 개가 각각
// 뭘 하는 곳인지 모른다. 여기서 한 줄씩 설명하고 지금 상태를 같이 보여준다.
//
// 카드마다 살아 있는 값을 하나씩 붙인 이유: 메뉴만 있는 화면은 한 번 보고 나면
// 다시 올 일이 없다. 여기서 이미 "지금 괜찮은가"가 읽혀야 한다.

interface SystemStatus {
  ready: boolean
  adapters?: { id: string; state: string }[]
  actuators?: { id: string; state: string }[]
}

interface Section {
  to: string
  label: string
  icon: LucideIcon
  desc: string
}

const SECTIONS: Section[] = [
  {
    to: '/live',
    label: '실시간',
    icon: Gauge,
    desc: '지금 이 방의 지표와 카메라 화면. 블록을 눌러 크게 보고 끌어서 배치를 바꾼다',
  },
  {
    to: '/guardian',
    label: '보호자',
    icon: UserRound,
    desc: '숫자를 걷어 내고 "지금 괜찮은가" 한 줄과 그 근거만',
  },
  {
    to: '/system',
    label: '시스템',
    icon: Activity,
    desc: '어댑터·액추에이터·정책이 올라왔는지, 안 올라왔으면 왜인지',
  },
  {
    to: '/records',
    label: '기록',
    icon: ClipboardList,
    desc: '개입 이력과 로그 CSV. 발화하지 않은 순간도 사유와 함께 남는다',
  },
  {
    to: '/selftest',
    label: '자체검증',
    icon: FlaskConical,
    desc: '계약·품질 게이트·정책 조건을 한 번에 점검한다',
  },
  {
    to: '/validation',
    label: '정량검증',
    icon: Ruler,
    desc: '펄스옥시미터 기준으로 MAE·RMSE·보류율을 낸다',
  },
]

export function Home() {
  const { snapshot, stale } = useFeed()
  const system = useGet<SystemStatus>('/api/system')

  const measured = snapshot?.metrics.filter((m) => !stale && m.state === 'ok' && m.value !== null)
  const held = snapshot?.metrics.filter((m) => m.state === 'low_quality').length ?? 0
  const adapters = system.data?.adapters ?? []
  const running = adapters.filter((a) => a.state === 'running').length

  // 카드 밑에 붙는 한 줄. 값이 없으면 지어내지 않고 아예 붙이지 않는다.
  const status: Record<string, string | null> = {
    '/live': measured?.length
      ? measured
          .slice(0, 3)
          .map((m) => `${LABEL[m.key] ?? m.key} ${displayValue(m, stale)}${m.unit ?? ''}`)
          .join(' · ')
      : null,
    // 보호자 화면과 같은 문장이어야 한다. 판정은 metrics.ts 가 정한다.
    '/guardian': snapshot ? verdict(measured?.length ?? 0, stale).text : null,
    '/system': adapters.length ? `어댑터 ${running}/${adapters.length} 정상` : null,
    '/records': snapshot ? `이번 세션 개입 ${snapshot.interventions.length}건` : null,
    '/selftest': null,
    '/validation': null,
  }

  return (
    <main className="mx-auto w-full max-w-shell flex-1 px-6 py-10 md:px-10">
      <section className="mb-10">
        <h1 className="kr text-2xl font-light text-fg sm:text-3xl">
          {snapshot ? (
            stale ? (
              <>수신이 끊겼습니다</>
            ) : (
              <>
                <span className="tnum text-gold">{measured?.length ?? 0}</span>개 지표를 받고
                있습니다
              </>
            )
          ) : (
            <span className="animate-measuring text-muted">서버 연결 대기 중</span>
          )}
        </h1>
        <p className="kr mt-2 text-[13px] text-faint">
          {snapshot?.device_id ?? '기기 미확인'}
          {held > 0 && ` · 품질 미달로 ${held}개 보류 중`}
          {system.data && ` · 설정 ${adapters.length}개 어댑터`}
        </p>
      </section>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {SECTIONS.map(({ to, label, icon: Icon, desc }) => (
          <Link
            key={to}
            to={to}
            className="group flex flex-col rounded-lg border-[0.5px] border-gold/15 bg-panel px-5 py-4 transition-colors hover:border-gold/50 hover:bg-gold/[0.04] focus-visible:border-gold focus-visible:outline-none"
          >
            <span className="kr flex items-center gap-2 text-[14px] font-medium text-fg">
              <Icon className="h-4 w-4 text-gold" />
              {label}
            </span>
            <span className="kr mt-2 flex-1 text-[12px] leading-relaxed text-faint">{desc}</span>
            {status[to] && (
              <span className="kr mt-3 border-t-[0.5px] border-gold/10 pt-2.5 text-[12px] text-gold-soft">
                {status[to]}
              </span>
            )}
          </Link>
        ))}
      </div>
    </main>
  )
}

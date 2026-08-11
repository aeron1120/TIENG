import { ArrowRight, Camera, Lock, Thermometer, Wind } from 'lucide-react'
import { Link } from 'react-router-dom'
import { useAuth } from '../authContext'
import { Panel } from '../components/Page'
import { RoleMatrix } from '../components/RoleMatrix'
import { displayValue, ICON, LABEL } from '../metrics'
import { useFeed } from '../snapshotContext'

// 비회원이 처음 보는 화면.
//
// 예전에는 /가 곧장 실시간이었다. 침대 옆 태블릿에서는 그게 맞지만, 이 화면이 공개
// 주소로도 열리면서 처음 온 사람이 숫자만 보고 이게 뭔지 모르는 상태가 됐다.
// 로그인한 사람은 지금도 곧장 실시간으로 간다 (App.tsx) — 매일 보는 사람에게
// 설명을 다시 읽히지 않는다.

const DOES = [
  { icon: Camera, text: '카메라만으로 심박을 잽니다. 몸에 아무것도 붙이지 않습니다.' },
  { icon: Wind, text: '열화상으로 호흡을 셉니다. 코 앞의 온도 진동을 봅니다.' },
  { icon: Thermometer, text: '방이 어두워지면 불을 켜고, 이상이 이어지면 보호자에게 알립니다.' },
]

// 안 하는 것을 같이 적는다. 카메라가 달린 기기라 "녹화되나"가 먼저 떠오르고,
// 그 답을 안 하면 나머지 설명이 읽히지 않는다 (README §1 비목표).
const DOES_NOT = [
  '영상을 저장하지 않습니다. 프레임은 숫자 세 개로 줄인 뒤 바로 버립니다.',
  '값을 지어내지 않습니다. 신호가 나쁘면 숫자 대신 이유를 보여 줍니다.',
]

export function Intro() {
  const { principal } = useAuth()
  const { snapshot, stale } = useFeed()

  // 지금 방이 어떤지 네 칸만 먼저 보여 준다. 설명을 다 읽어야 뭐가 나오는지 알 수
  // 있으면 아무도 안 읽는다.
  const summary = (snapshot?.metrics ?? []).filter((m) =>
    ['hr', 'rr', 'temp', 'lux'].includes(m.key),
  )

  return (
    <main className="mx-auto flex w-full max-w-[720px] flex-1 flex-col gap-5 px-6 py-10">
      <header>
        <p className="font-mono text-[11px] tracking-[0.32em] text-gold uppercase">
          VITAL_MONITOR_SYS
        </p>
        <h1 className="kr mt-3 text-[22px] leading-snug font-medium text-fg">
          비접촉으로 방의 상태를 봅니다
        </h1>
        <p className="kr mt-2 text-[13px] leading-relaxed text-muted">
          카메라와 센서로 심박·호흡·환경을 재고, 필요하면 방을 직접 조절합니다.
        </p>
      </header>

      {summary.length > 0 && (
        <Panel>
          <div className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4">
            {summary.map((metric) => {
              const Icon = ICON[metric.key]
              const shown = displayValue(metric, stale)
              return (
                <div key={metric.key} className="min-w-0">
                  <span className="kr flex items-center gap-1.5 text-[11px] text-faint">
                    {Icon && <Icon className="h-3 w-3 shrink-0" />}
                    {LABEL[metric.key] ?? metric.key}
                  </span>
                  <span className="tnum mt-1 block truncate text-[20px] text-fg">
                    {/* 값이 없으면 0 이 아니라 없음으로 둔다. 지어내지 않는다. */}
                    {shown ?? '—'}
                    {shown && metric.unit && (
                      <span className="ml-1 text-[12px] text-faint">{metric.unit}</span>
                    )}
                  </span>
                </div>
              )
            })}
          </div>
        </Panel>
      )}

      <Link
        to="/live"
        className="flex items-center gap-3 rounded-lg border-[0.5px] border-gold/30 bg-gold/[0.06] px-4 py-3.5 transition-colors hover:border-gold/60 hover:bg-gold/10"
      >
        <span className="kr flex-1 text-[14px] font-medium text-gold">실시간 화면 보기</span>
        <ArrowRight className="h-4 w-4 shrink-0 text-gold" />
      </Link>

      <Panel>
        <h2 className="kr mb-3 text-[12px] font-medium text-muted">하는 일</h2>
        <ul className="flex flex-col gap-2.5">
          {DOES.map(({ icon: Icon, text }) => (
            <li key={text} className="flex items-start gap-2.5">
              <Icon className="mt-[3px] h-3.5 w-3.5 shrink-0 text-gold" />
              <span className="kr text-[13px] leading-relaxed text-fg">{text}</span>
            </li>
          ))}
        </ul>

        <h2 className="kr mt-5 mb-3 text-[12px] font-medium text-muted">하지 않는 일</h2>
        <ul className="flex flex-col gap-2.5">
          {DOES_NOT.map((text) => (
            <li key={text} className="flex items-start gap-2.5">
              <Lock className="mt-[3px] h-3.5 w-3.5 shrink-0 text-faint" />
              <span className="kr text-[13px] leading-relaxed text-muted">{text}</span>
            </li>
          ))}
        </ul>
      </Panel>

      <Panel>
        <h2 className="kr mb-1 text-[12px] font-medium text-muted">등급별로 열리는 것</h2>
        <p className="kr mb-3 text-[11px] text-faint">
          비회원은 실시간 화면만 봅니다. 기록·시스템·검증은 관리자 승인을 받은 회원부터입니다.
        </p>
        <RoleMatrix current={principal?.role} />
      </Panel>
    </main>
  )
}

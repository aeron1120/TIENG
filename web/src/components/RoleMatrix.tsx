import { Check, Minus } from 'lucide-react'
import type { Role } from '../authContext'

// 등급마다 무엇이 열리는지 한 자리에 적는다.
//
// 지금까지는 이 차이가 상단 NAV 가 조용히 필터되는 것으로만 드러났다. 그러면 못 보는
// 쪽은 자기가 뭘 못 보는지조차 모른다 — 비회원은 가입할 이유를 알 수 없고, 회원은
// 관리자와 뭐가 다른지 알 수 없다.
//
// 화면 두 곳에서 같은 표를 쓴다. 소개 화면에서는 "가입하면 이게 열린다"로, 계정
// 화면에서는 "지금 내 등급은 여기"로 읽힌다. 표가 둘로 갈라지면 한쪽만 고쳐져서
// 서로 다른 말을 하게 된다.

const RANK: Record<Role, number> = { guest: 0, member: 1, admin: 2 }

const TIERS: { role: Role; label: string; note: string }[] = [
  { role: 'guest', label: '비회원', note: '가입 없이 바로' },
  { role: 'member', label: '회원', note: '관리자 승인 후' },
  { role: 'admin', label: '관리자', note: '첫 가입자' },
]

// api/main.py 의 라우터 등급과 같아야 한다. 한쪽만 고치면 화면이 거짓말을 한다.
const ROWS: { what: string; min: Role }[] = [
  { what: '실시간 화면 · 카메라 미리보기', min: 'guest' },
  { what: '보호자 · 개입 기록', min: 'member' },
  { what: '시스템 상태 · 센서 진단', min: 'member' },
  { what: '기록 내려받기', min: 'member' },
  { what: '자체검증 · 정량검증', min: 'member' },
  { what: '가입 승인 · 계정 차단', min: 'admin' },
]

export function RoleMatrix({ current }: { current?: Role }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[380px] border-collapse">
        <thead>
          <tr>
            <th className="w-full py-2 text-left">
              <span className="kr text-[11px] font-medium text-faint">볼 수 있는 것</span>
            </th>
            {TIERS.map((tier) => (
              <th key={tier.role} className="px-2 py-2 text-center align-bottom">
                <span
                  className={`kr block text-[12px] ${
                    tier.role === current ? 'font-medium text-gold' : 'text-muted'
                  }`}
                >
                  {tier.label}
                </span>
                <span className="kr mt-0.5 block text-[10px] whitespace-nowrap text-faint">
                  {tier.role === current ? '지금 나' : tier.note}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {ROWS.map((row) => (
            <tr key={row.what} className="border-t-[0.5px] border-gold/10">
              <td className="py-2 pr-3">
                <span className="kr text-[12px] text-fg">{row.what}</span>
              </td>
              {TIERS.map((tier) => {
                const allowed = RANK[tier.role] >= RANK[row.min]
                return (
                  <td key={tier.role} className="px-2 py-2 text-center">
                    {allowed ? (
                      <Check
                        aria-label="볼 수 있음"
                        className={`mx-auto h-3.5 w-3.5 ${
                          tier.role === current ? 'text-gold' : 'text-gold-soft'
                        }`}
                      />
                    ) : (
                      // 빈 칸으로 두면 "아직 안 정해짐"처럼 보인다. 막혔다고 말한다.
                      <Minus aria-label="볼 수 없음" className="mx-auto h-3.5 w-3.5 text-faint/50" />
                    )}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

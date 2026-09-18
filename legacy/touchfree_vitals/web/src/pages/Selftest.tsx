import { Play } from 'lucide-react'
import { Empty, Page, Panel } from '../components/Page'
import { usePost } from '../hooks/useApi'

// scripts/selftest.py 를 별도 프로세스로 돌린 결과를 보여준다.
// 서버 안에서 직접 부르지 않는 이유는 api/routes/diagnostics.py 주석 참고.

interface Check {
  section: string
  name: string
  ok: boolean
  detail: string
}
interface Result {
  total: number
  passed: number
  checks: Check[]
  exit_code: number
}

export function Selftest() {
  const { data, error, loading, send } = usePost<Result>('/api/selftest')

  const sections = data
    ? [...new Set(data.checks.map((c) => c.section))].map((name) => ({
        name,
        checks: data.checks.filter((c) => c.section === name),
      }))
    : []

  return (
    <Page
      title="자체 검증"
      actions={
        <button
          onClick={() => send()}
          disabled={loading}
          className="kr flex items-center gap-1.5 rounded-md bg-gold px-3.5 py-1.5 text-[12px] font-medium text-ink transition-colors hover:bg-gold-soft disabled:opacity-40"
        >
          <Play className="h-3.5 w-3.5" />
          {loading ? '실행 중…' : '실행'}
        </button>
      }
    >
      {error && <Panel className="mb-4 border-alert/40">
        <pre className="kr text-[12px] whitespace-pre-wrap text-alert">{error}</pre>
      </Panel>}

      {!data && !error && !loading && <Empty>실행을 누르면 23개 항목을 검사한다</Empty>}
      {loading && <Empty>검사 중…</Empty>}

      {data && (
        <div className="flex flex-col gap-4">
          <Panel className={data.passed === data.total ? 'border-gold/40' : 'border-alert/40'}>
            <div className="flex items-baseline gap-3">
              <span
                className={`tnum text-3xl font-light ${
                  data.passed === data.total ? 'text-gold' : 'text-alert'
                }`}
              >
                {data.passed}/{data.total}
              </span>
              <span className="kr text-[13px] text-muted">
                {data.passed === data.total ? '전부 통과' : `${data.total - data.passed}건 실패`}
              </span>
            </div>
          </Panel>

          {sections.map((s) => (
            <Panel key={s.name}>
              <h2 className="kr mb-2.5 text-[12px] font-medium text-muted">{s.name}</h2>
              <ul className="flex flex-col">
                {s.checks.map((c) => (
                  <li
                    key={c.name}
                    className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-t-[0.5px] border-gold/10 py-2 first:border-t-0 first:pt-0"
                  >
                    <span
                      className={`shrink-0 font-mono text-[11px] ${c.ok ? 'text-gold' : 'text-alert'}`}
                    >
                      {c.ok ? 'OK' : 'XX'}
                    </span>
                    <span className="kr min-w-0 flex-1 text-[13px] text-fg">{c.name}</span>
                    {c.detail && (
                      <span className="kr font-mono text-[11px] text-faint">{c.detail}</span>
                    )}
                  </li>
                ))}
              </ul>
            </Panel>
          ))}
        </div>
      )}
    </Page>
  )
}

import { Download, RefreshCw } from 'lucide-react'
import { useState } from 'react'
import { Deltas } from '../components/Deltas'
import { Empty, Page, Panel } from '../components/Page'
import { useGet } from '../hooks/useApi'
import { ACTION_LABEL } from '../metrics'

// 메모리에 든 최근 개입은 20건뿐이라 그 이상은 CSV 를 읽는다. 발표 자료를 만들 때
// 원본을 그대로 받아 갈 수 있게 다운로드도 연다.

interface LogFile {
  name: string
  size_kb: number
  rows: number
}
interface Row {
  ts: string
  kind: string
  id: string
  level: string
  action: string
  trigger: string
  before: Record<string, number> | null
  after: Record<string, number> | null
}

const KIND_TONE: Record<string, string> = {
  fired: 'border-gold/40 bg-gold/10 text-gold',
  evaluated: 'border-gold/25 text-gold-soft',
  blocked: 'border-faint/25 text-faint',
}
const KIND_LABEL: Record<string, string> = {
  fired: '발화',
  evaluated: '평가 완료',
  blocked: '보류',
}

export function Records() {
  const files = useGet<LogFile[]>('/api/logs')
  const [source, setSource] = useState('interventions.csv')
  const rows = useGet<Row[]>(`/api/logs/interventions?name=${encodeURIComponent(source)}`)

  return (
    <Page
      title="기록"
      actions={
        <button
          onClick={rows.run}
          disabled={rows.loading}
          className="kr flex items-center gap-1.5 rounded-md border-[0.5px] border-gold/30 px-3 py-1.5 text-[12px] text-gold transition-colors hover:bg-gold/10 disabled:opacity-40"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${rows.loading ? 'animate-spin' : ''}`} />
          새로고침
        </button>
      }
    >
      <div className="flex flex-col gap-4">
        <Panel>
          <h2 className="kr mb-2.5 text-[12px] font-medium text-muted">로그 파일</h2>
          {files.data?.length ? (
            <ul className="flex flex-col">
              {files.data.map((f) => (
                <li
                  key={f.name}
                  className="flex flex-wrap items-center justify-between gap-2 border-t-[0.5px] border-gold/10 py-2 first:border-t-0 first:pt-0"
                >
                  <span className="flex items-center gap-2.5">
                    <span className="font-mono text-[12px] text-fg">{f.name}</span>
                    <span className="tnum font-mono text-[10px] text-faint">
                      {f.rows.toLocaleString()}행 · {f.size_kb} KB
                    </span>
                  </span>
                  <span className="flex items-center gap-2">
                    {f.name.startsWith('interventions') && (
                      <button
                        onClick={() => setSource(f.name)}
                        className={`kr rounded px-2 py-[3px] text-[11px] transition-colors ${
                          source === f.name
                            ? 'bg-gold font-medium text-ink'
                            : 'text-faint hover:bg-white/[0.06] hover:text-muted'
                        }`}
                      >
                        보기
                      </button>
                    )}
                    <a
                      href={`/api/logs/${encodeURIComponent(f.name)}/download`}
                      className="flex items-center gap-1 rounded px-2 py-[3px] font-mono text-[11px] text-faint transition-colors hover:bg-white/[0.06] hover:text-gold"
                    >
                      <Download className="h-3 w-3" />
                      CSV
                    </a>
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <Empty>logs/ 에 CSV 가 없다</Empty>
          )}
        </Panel>

        <Panel>
          <h2 className="kr mb-2.5 text-[12px] font-medium text-muted">
            개입 이력 · {source}
          </h2>
          {rows.error && <p className="kr text-[12px] text-alert">{rows.error}</p>}
          {!rows.data?.length && !rows.error && <Empty>기록이 없다</Empty>}

          <ul className="flex flex-col">
            {rows.data?.map((r, i) => (
              <li
                key={`${r.ts}-${r.id}-${i}`}
                className="flex flex-col gap-1 border-t-[0.5px] border-gold/10 py-2.5 first:border-t-0 first:pt-0"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={`kr shrink-0 rounded-full border px-2 py-[2px] text-[10px] ${KIND_TONE[r.kind] ?? ''}`}
                  >
                    {KIND_LABEL[r.kind] ?? r.kind}
                  </span>
                  {r.level && (
                    <span className="shrink-0 rounded-full border border-gold/25 px-1.5 py-[1px] font-mono text-[10px] text-gold">
                      {r.level}
                    </span>
                  )}
                  {r.action && (
                    <span className="kr text-[13px] text-fg">
                      {ACTION_LABEL[r.action] ?? r.action}
                    </span>
                  )}
                  <span className="tnum ml-auto font-mono text-[10px] text-faint">
                    {new Date(r.ts).toLocaleString('ko-KR')}
                  </span>
                </div>
                <p className="kr text-[12px] text-muted">{r.trigger}</p>
                {/* 지나간 기록이라 after 가 없으면 평가가 끝나지 않은 채로 남은 것이다. */}
                {r.before && <Deltas before={r.before} after={r.after} pending="효과 측정 전" />}
              </li>
            ))}
          </ul>
        </Panel>
      </div>
    </Page>
  )
}


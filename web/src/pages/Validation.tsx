import { useState } from 'react'
import { Ruler } from 'lucide-react'
import { Empty, Page, Panel } from '../components/Page'
import { useGet, usePost } from '../hooks/useApi'

// 펄스옥시미터 대조 리포트를 화면에서 만든다. 발표에 쓸 숫자라 어떤 인자로
// 돌렸는지가 리포트 안에 같이 박힌다.

interface Dataset {
  path: string
  name: string
  kind: 'estimate' | 'reference'
  size_kb: string
}

export function Validation() {
  const datasets = useGet<Dataset[]>('/api/validation/datasets')
  const report = usePost<{ markdown: string }>('/api/validation')

  const [rppg, setRppg] = useState('')
  const [ref, setRef] = useState('')
  const [warmup, setWarmup] = useState(20)

  const estimates = datasets.data?.filter((d) => d.kind === 'estimate') ?? []
  const references = datasets.data?.filter((d) => d.kind === 'reference') ?? []
  const ready = rppg !== '' && ref !== ''

  return (
    <Page
      title="정량 검증"
      description="펄스옥시미터 기준으로 MAE·RMSE·보류율을 낸다. 못 믿을 구간을 걸러서 정확해진 것과 원래 정확한 것은 다르다"
    >
      <div className="flex flex-col gap-4">
        <Panel>
          <h2 className="kr mb-3 text-[12px] font-medium text-muted">데이터 선택</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            <Select
              label="추정 (rPPG)"
              value={rppg}
              onChange={setRppg}
              options={estimates}
              hint="logs/metrics.csv 또는 legacy 세션"
            />
            <Select
              label="기준 (옥시미터)"
              value={ref}
              onChange={setRef}
              options={references}
              hint="_ref.csv 로 끝나는 파일"
            />
          </div>

          <div className="mt-3 flex flex-wrap items-end gap-4">
            <label className="flex flex-col gap-1">
              <span className="kr text-[11px] text-faint">기준 초반 제외 (초)</span>
              <input
                type="number"
                value={warmup}
                min={0}
                onChange={(e) => setWarmup(Number(e.target.value))}
                className="w-28 rounded-md border-[0.5px] border-gold/25 bg-ink px-2.5 py-1.5 font-mono text-[13px] text-fg"
              />
            </label>
            <p className="kr max-w-md flex-1 text-[11px] text-faint">
              옥시미터는 손가락에 끼운 뒤 안정되기까지 20초쯤 걸린다. 그 구간을 기준으로 쓰면
              카메라가 틀린 것처럼 보인다.
            </p>
            <button
              onClick={() =>
                report.send({ rppg, ref, gate: 0.5, ref_warmup_sec: warmup, tolerance: 2.0 })
              }
              disabled={!ready || report.loading}
              className="kr flex items-center gap-1.5 rounded-md bg-gold px-3.5 py-1.5 text-[12px] font-medium text-ink transition-colors hover:bg-gold-soft disabled:opacity-40"
            >
              <Ruler className="h-3.5 w-3.5" />
              {report.loading ? '계산 중…' : '리포트 생성'}
            </button>
          </div>
        </Panel>

        {datasets.error && <Panel className="border-alert/40 text-alert">{datasets.error}</Panel>}
        {report.error && (
          <Panel className="border-alert/40">
            <pre className="kr text-[12px] whitespace-pre-wrap text-alert">{report.error}</pre>
          </Panel>
        )}

        {!report.data && !report.error && !report.loading && (
          <Empty>
            {ready ? '리포트 생성을 누르세요' : '추정 CSV 와 기준 CSV 를 하나씩 고르세요'}
          </Empty>
        )}

        {report.data && (
          <Panel>
            {/* 마크다운 렌더러를 넣지 않는다. 표와 숫자를 그대로 보는 게 목적이고,
                파서를 하나 더 들이면 그만큼 틀릴 자리가 생긴다. */}
            <pre className="kr overflow-x-auto text-[12px] leading-relaxed whitespace-pre-wrap text-fg">
              {report.data.markdown}
            </pre>
          </Panel>
        )}
      </div>
    </Page>
  )
}

function Select({
  label,
  value,
  onChange,
  options,
  hint,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  options: Dataset[]
  hint: string
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="kr text-[11px] text-faint">
        {label} <span className="text-faint/70">· {hint}</span>
      </span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-md border-[0.5px] border-gold/25 bg-ink px-2.5 py-1.5 font-mono text-[12px] text-fg"
      >
        <option value="">선택하세요</option>
        {options.map((d) => (
          <option key={d.path} value={d.path}>
            {d.name} ({d.size_kb} KB)
          </option>
        ))}
      </select>
    </label>
  )
}

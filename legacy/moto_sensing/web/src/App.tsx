import type { Indicator, Snapshot } from './types'
import { useSnapshot } from './useSnapshot'

// 값이 없으면 — 를 쓴다. 0 으로 대체하지 않는다 (CLAUDE.md §0-4, §14).
// 이 한 줄이 이 화면의 존재 이유다.
function reading(ind: Indicator): string {
  if (ind.value === null) return '—'
  return ind.unit ? `${ind.value.toFixed(2)} ${ind.unit}` : ind.value.toFixed(2)
}

const STATE_LABEL: Record<string, string> = {
  ok: '정상',
  low_quality: '품질 미달',
  stale: '오래됨',
  error: '오류',
  no_adapter: '어댑터 없음',
}

function Indicators({ items }: { items: Indicator[] }) {
  if (items.length === 0) {
    // 지어낸 값으로 칸을 채우지 않는다. 없으면 없다고 적는다.
    return (
      <p className="empty">
        지표 어댑터가 아직 없다 (§13-9). 값을 지어내지 않으므로 이 자리는 비어 있다.
      </p>
    )
  }
  return (
    <table>
      <thead>
        <tr>
          <th>지표</th>
          <th className="num">값</th>
          <th className="num">SQI</th>
          <th>상태</th>
        </tr>
      </thead>
      <tbody>
        {items.map((ind) => (
          <tr key={ind.key} className={ind.value === null ? 'held' : undefined}>
            <td>{ind.key}</td>
            <td className="num">{reading(ind)}</td>
            <td className="num">{ind.sqi === null ? '—' : ind.sqi.toFixed(2)}</td>
            <td>
              <span className={`badge ${ind.state}`}>{STATE_LABEL[ind.state] ?? ind.state}</span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function Health({ health }: { health: Snapshot['health'] }) {
  const keys = Object.keys(health).sort()
  if (keys.length === 0) return <p className="empty">아직 보고된 것이 없다.</p>
  return (
    <div className="health">
      {keys.map((key) => (
        <div key={key} className="cell">
          <span className="k">{key}</span>
          <span className="v">{health[key].toFixed(2)}</span>
        </div>
      ))}
    </div>
  )
}

export default function App() {
  const { snapshot, feed, stale } = useSnapshot()

  if (snapshot === null) {
    return (
      <main>
        <p className="empty">파이프라인에 붙는 중…</p>
      </main>
    )
  }

  return (
    <main>
      <header>
        <div>
          <h1>이륜차 사고 감지</h1>
          <p className="sub">
            {snapshot.device_id} · {snapshot.session_id}
          </p>
        </div>
        <div className="tags">
          <span className={`badge mode-${snapshot.mode}`}>{snapshot.mode}</span>
          {feed === 'fixture' && <span className="badge warn">픽스처 (백엔드 없음)</span>}
          {stale && <span className="badge error">수신 끊김</span>}
          <span className="clock">t = {snapshot.t.toFixed(1)}s</span>
        </div>
      </header>

      <section>
        <h2>지표</h2>
        <Indicators items={snapshot.indicators} />
      </section>

      <section>
        <h2>상태 (§12)</h2>
        <Health health={snapshot.health} />
      </section>

      <section>
        <h2>이벤트</h2>
        {snapshot.recent_events.length === 0 ? (
          <p className="empty">규칙이 아직 없으므로 이벤트도 없다 (§13-9).</p>
        ) : (
          <ul>
            {snapshot.recent_events.map((e) => (
              <li key={e.id}>
                {e.kind} · t={e.t.toFixed(2)}
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  )
}

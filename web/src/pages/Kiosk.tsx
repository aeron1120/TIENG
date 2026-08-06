import { MetricCard } from '../components/MetricCard'
import { useSnapshot } from '../hooks/useSnapshot'

export function Kiosk() {
  const { snapshot, stale } = useSnapshot()

  if (!snapshot) {
    return (
      <main className="kiosk">
        <p className="waiting">서버 연결 대기 중…</p>
      </main>
    )
  }

  return (
    <main className="kiosk">
      <header className="kiosk-head">
        <h1>TouchFree Vitals</h1>
        <div className="meta">
          <span>{snapshot.device_id}</span>
          <span className={stale ? 'link down' : 'link up'}>
            {stale ? '수신 끊김' : new Date(snapshot.ts).toLocaleTimeString('ko-KR')}
          </span>
        </div>
      </header>

      <section className="grid">
        {snapshot.metrics.map((metric) => (
          <MetricCard key={`${metric.source}:${metric.key}`} metric={metric} stale={stale} />
        ))}
      </section>
    </main>
  )
}

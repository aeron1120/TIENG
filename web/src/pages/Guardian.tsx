import { Empty, Page, Panel } from '../components/Page'
import { ACTION_LABEL, ICON, LABEL, displayValue, verdict } from '../metrics'
import { useFeed } from '../snapshotContext'

// 보호자 요약. 기기 옆 대형 화면과 달리 "지금 괜찮은가"만 빨리 읽히면 된다.
// 숫자를 잔뜩 늘어놓지 않고 한 줄 판정과 근거만 보여준다.
//
// 알림 발송(L4)은 아직 없다. 자격증명이 필요해서 Phase 5 로 미뤘고, 여기서
// "알림을 보냈다"고 쓰지 않는 이유이기도 하다. 안 한 일을 했다고 하면 안 된다.

export function Guardian() {
  const { snapshot, stale } = useFeed()

  if (!snapshot) {
    return (
      <Page title="보호자 요약">
        <Empty>서버 연결 대기 중</Empty>
      </Page>
    )
  }

  const measured = snapshot.metrics.filter((m) => !stale && m.state === 'ok' && m.value !== null)
  const held = snapshot.metrics.filter((m) => m.state === 'low_quality')
  const offline = snapshot.metrics.filter((m) => m.state === 'no_adapter' || m.state === 'error')

  // 홈 화면과 같은 판단을 써야 한다. 판정 기준은 metrics.ts 한 곳에만 있다.
  const summary = verdict(measured.length, stale)

  return (
    <Page
      title="보호자 요약"
      description={`${snapshot.device_id} · ${new Date(snapshot.ts).toLocaleString('ko-KR')}`}
    >
      <div className="flex flex-col gap-4">
        <Panel className="py-6">
          <p className={`kr text-2xl font-light sm:text-3xl ${summary.tone}`}>{summary.text}</p>
          <p className="kr mt-2 text-[13px] text-muted">{summary.why}</p>
        </Panel>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {measured.map((m) => {
            const Icon = ICON[m.key] ?? ICON.posture
            return (
              <Panel key={`${m.source}:${m.key}`}>
                <span className="kr flex items-center gap-1.5 text-[12px] text-muted">
                  <Icon className="h-3.5 w-3.5 text-gold" />
                  {LABEL[m.key] ?? m.key}
                </span>
                <p className="mt-2 flex items-baseline gap-1.5">
                  <span className="tnum text-3xl font-light text-fg">
                    {displayValue(m, stale)}
                  </span>
                  {m.unit && <span className="font-mono text-[12px] text-muted">{m.unit}</span>}
                </p>
              </Panel>
            )
          })}
        </div>

        {held.length > 0 && (
          <Panel>
            <h2 className="kr mb-1.5 text-[12px] font-medium text-muted">잠시 보류 중인 지표</h2>
            <p className="kr text-[13px] text-fg">
              {held.map((m) => LABEL[m.key] ?? m.key).join(', ')}
            </p>
            <p className="kr mt-1 text-[12px] text-faint">
              신호 품질이 기준에 못 미쳐 값을 내지 않고 있습니다. 잘못된 값을 보여주는 것보다
              안전합니다.
            </p>
          </Panel>
        )}

        {offline.length > 0 && (
          <Panel>
            <h2 className="kr mb-1.5 text-[12px] font-medium text-muted">연결되지 않은 센서</h2>
            <p className="kr text-[13px] text-faint">
              {offline.map((m) => LABEL[m.key] ?? m.key).join(', ')}
            </p>
          </Panel>
        )}

        <Panel>
          <h2 className="kr mb-2.5 text-[12px] font-medium text-muted">오늘의 조치</h2>
          {snapshot.interventions.length === 0 ? (
            <Empty>시스템이 개입한 일이 없습니다</Empty>
          ) : (
            <ul className="flex flex-col">
              {snapshot.interventions.map((e) => (
                <li
                  key={e.id}
                  className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-t-[0.5px] border-gold/10 py-2 first:border-t-0 first:pt-0"
                >
                  <span className="kr text-[13px] text-fg">
                    {ACTION_LABEL[e.action] ?? e.action}
                  </span>
                  <span className="kr min-w-0 flex-1 text-[12px] text-faint">{e.trigger}</span>
                  <span className="tnum font-mono text-[10px] text-faint">
                    {new Date(e.ts).toLocaleTimeString('ko-KR')}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </Page>
  )
}

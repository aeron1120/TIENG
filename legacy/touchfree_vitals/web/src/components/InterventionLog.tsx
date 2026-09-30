import { Eye, Lightbulb, Wind } from 'lucide-react'
import { ACTION_LABEL, awaitsConfirmation } from '../metrics'
import type { InterventionEvent } from '../types'
import { Deltas } from './Deltas'

// 개입은 "무엇을 했는가"보다 "왜 했고 효과가 있었는가"가 중요하다. trigger 문구와
// before→after 를 같이 보여주는 이유다 (README §8).

const ICON: Record<string, typeof Lightbulb> = {
  light_up: Lightbulb,
  ventilate: Wind,
  drowsy_notice: Eye,
  drowsy_alert: Lightbulb,
}

export function InterventionLog({ events }: { events: InterventionEvent[] }) {
  return (
    <section className="rounded-lg border-[0.5px] border-gold/15 bg-panel px-4 py-3">
      <h2 className="kr mb-2 text-[15px] font-medium text-muted">개입 기록</h2>

      {events.length === 0 ? (
        <p className="kr text-[13px] text-faint">아직 개입이 없습니다</p>
      ) : (
        <ul className="flex flex-col gap-2.5">
          {events.slice(0, 4).map((event) => (
            <Row key={event.id} event={event} />
          ))}
        </ul>
      )}
    </section>
  )
}

function Row({ event }: { event: InterventionEvent }) {
  const Icon = ICON[event.action] ?? Lightbulb
  const time = new Date(event.ts).toLocaleTimeString('ko-KR', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })

  return (
    <li className="flex flex-col gap-1 border-t-[0.5px] border-gold/10 pt-2 first:border-t-0 first:pt-0">
      <div className="flex items-center justify-between gap-2">
        <span className="kr flex min-w-0 items-center gap-1.5 text-[15px] text-fg">
          <Icon className="h-3.5 w-3.5 shrink-0 text-gold" />
          <span className="truncate">{ACTION_LABEL[event.action] ?? event.action}</span>
          <span className="shrink-0 rounded-full border border-gold/30 px-1.5 py-[1px] font-mono text-[12px] text-gold">
            {event.level}
          </span>
        </span>
        <span className="tnum shrink-0 font-mono text-[12px] text-faint">{time}</span>
      </div>

      <p className="kr text-[13px] leading-snug text-muted">{event.trigger}</p>
      <Deltas
        before={event.before}
        after={event.after}
        pending={awaitsConfirmation(event) ? '취소 대기 중 · 아직 보내지 않았습니다' : '효과 측정 중'}
      />
    </li>
  )
}

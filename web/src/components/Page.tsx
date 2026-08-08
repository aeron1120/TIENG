import type { ReactNode } from 'react'

/** 실시간 화면을 뺀 나머지 페이지의 공통 틀. 제목·설명·본문 간격을 한 곳에서 잡는다. */
export function Page({
  title,
  description,
  actions,
  children,
}: {
  title: string
  description?: string
  actions?: ReactNode
  children: ReactNode
}) {
  return (
    <main className="mx-auto w-full max-w-shell flex-1 px-6 py-8 md:px-10">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="kr text-xl font-medium text-fg">{title}</h1>
          {description && <p className="kr mt-1 text-[13px] text-faint">{description}</p>}
        </div>
        {actions}
      </div>
      {children}
    </main>
  )
}

export function Panel({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <section
      className={`rounded-lg border-[0.5px] border-gold/15 bg-panel px-4 py-3.5 ${className}`}
    >
      {children}
    </section>
  )
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="kr py-8 text-center text-[13px] text-faint">{children}</p>
}

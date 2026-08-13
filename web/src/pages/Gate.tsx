import {
  Activity,
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  Check,
  Clock,
  Eye,
  LogIn,
  ShieldCheck,
  UserPlus,
} from 'lucide-react'
import {
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type RefObject,
} from 'react'
import { useAuth } from '../authContext'

// 앱을 처음 열면 나오는 관문. 여기를 지나기 전에는 WebSocket 도 열지 않는다 —
// 지표가 흐르는 통로를 열어 두고 화면만 가리는 건 가린 게 아니다 (App.tsx).
//
// 갈래가 셋인 이유: 침실 앞 태블릿 앞에 선 사람은 대개 "지금 괜찮은가"만 보면 되고
// (비회원), 기록과 설정까지 보는 사람은 따로 있다. 매번 로그인을 요구하면 앞의
// 경우가 불편해지고, 아무나 다 보게 두면 뒤의 경우가 위험해진다.

type Mode = 'choose' | 'login' | 'register' | 'admin'

/** GET /api/auth/available 의 답. 못 쓰는 아이디면 detail 에 이유가 있다. */
interface Availability {
  available: boolean
  detail: string
}

/** 중복확인 결과. 어떤 아이디를 확인한 것인지 같이 들고 있어야 한다 — 확인한 뒤에
 *  아이디를 고치면 그 결과는 더 이상 이 아이디의 것이 아니다. */
interface Checked extends Availability {
  username: string
}

const CHOICES = [
  {
    mode: 'login' as const,
    icon: LogIn,
    label: '로그인',
    desc: '기록·시스템·검증까지 전부 봅니다',
  },
  {
    mode: 'register' as const,
    icon: UserPlus,
    label: '회원가입',
    desc: '관리자 승인 뒤에 사용할 수 있습니다',
  },
  {
    mode: 'admin' as const,
    icon: ShieldCheck,
    label: '관리자 로그인',
    desc: '가입 승인과 계정 차단을 합니다',
  },
]

const FIELD =
  'kr w-full rounded-md border-[0.5px] border-gold/20 bg-panel-dim px-3 py-2.5 text-[14px] text-fg placeholder:text-faint focus:border-gold/60 focus:outline-none'

// Enter 로 다음 칸에 넘어간다. 태블릿 앞에서 칸마다 손을 뻗지 않아도 되고, 마지막
// 칸에서는 손대지 않으므로 브라우저가 그대로 폼을 제출한다.
//
// 여기서 가로채지 않으면 중간 칸의 Enter 는 아무 일도 하지 않는다. 제출 버튼이
// 아직 disabled 라서 브라우저가 암묵적 제출을 건너뛰기 때문이다.
//
// 조합 중인 Enter 는 흘려보낸다. 한글을 치는 동안 IME 가 글자를 확정하려고 누르는
// Enter 라서, 잡아 버리면 아이디를 다 치기도 전에 칸이 바뀐다.
const advance =
  (next: RefObject<HTMLInputElement | null>) => (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
    event.preventDefault()
    next.current?.focus()
  }

export function Gate() {
  const { enterAsGuest, logIn, register } = useAuth()
  const [mode, setMode] = useState<Mode>('choose')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [checked, setChecked] = useState<Checked | null>(null)
  const [checking, setChecking] = useState(false)
  // 가입은 됐는데 아직 못 들어온 상태. 관문에 그대로 두면 방금 가입한 사람이
  // 비밀번호를 잘못 쳤다고 생각하고 계속 다시 시도한다.
  const [waiting, setWaiting] = useState<string | null>(null)
  const passwordRef = useRef<HTMLInputElement>(null)
  const confirmRef = useRef<HTMLInputElement>(null)

  // 중복확인을 거친 아이디만 가입으로 넘어간다. 확인한 뒤에 아이디를 한 글자라도
  // 고치면 그 결과는 더 이상 이 아이디의 것이 아니므로 다시 확인해야 한다.
  const verified = checked !== null && checked.username === username.trim() && checked.available
  // "이 아이디는 못 쓴다"와 "확인한 뒤에 아이디를 고쳤다"는 다른 일이다. 앞은 아이디를
  // 바꿔야 하고 뒤는 버튼을 다시 누르면 된다 — 같은 빨간 줄로 뭉개면 안 된다.
  const rejected = checked !== null && checked.username === username.trim() && !checked.available

  const check = async () => {
    const name = username.trim()
    if (!name || checking) return

    setChecking(true)
    setChecked(null)
    setError(null)
    try {
      const res = await fetch(`/api/auth/available?username=${encodeURIComponent(name)}`)
      if (!res.ok) throw new Error('아이디를 확인하지 못했습니다')
      const body = (await res.json()) as Availability
      setChecked({ ...body, username: name })
      // 쓸 수 있으면 그대로 다음 칸으로 넘긴다. 눌러서 확인했는데 다시 손으로
      // 칸을 짚어야 하면 버튼을 둔 만큼 손이 더 간다.
      if (body.available) passwordRef.current?.focus()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setChecking(false)
    }
  }

  const go = (next: Mode) => {
    setMode(next)
    setError(null)
    setPassword('')
    setConfirm('')
    setChecked(null)
  }

  // 비밀번호를 되찾을 방법이 없는 기기다. 오타로 잠기면 되돌릴 수 없으므로 확인란이
  // 어긋나는 순간 바로 말해 준다 — 제출한 뒤에 알려 주면 이미 두 번 틀린 뒤다.
  //
  // 확인란이 비어 있을 때는 아무 말도 하지 않는다. 첫 글자를 치기도 전에 "다르다"가
  // 뜨면 그건 알림이 아니라 잡음이다.
  const mismatch = mode === 'register' && confirm.length > 0 && password !== confirm
  // 가입은 중복확인을 통과해야 열린다. 서버도 같은 판정을 하지만(409), 거기까지
  // 가면 비밀번호를 두 번 다 채운 뒤다.
  const incomplete =
    !username || !password || (mode === 'register' && (!confirm || !verified))

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      if (mode !== 'register') {
        // 관리자도 같은 경로로 들어온다. 계정에 붙은 등급이 무엇을 열지 정하므로
        // (api/auth.py) 입구를 나눈다고 인증까지 나눌 이유는 없다.
        await logIn(username, password)
      } else {
        const { pending } = await register(username, password)
        // pending 이면 AuthProvider 가 principal 을 안 세운다. 관문이 그대로 남으므로
        // 여기서 무슨 일이 벌어졌는지 말해 줘야 한다.
        if (pending) setWaiting(username.trim())
      }
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const guest = async () => {
    setBusy(true)
    setError(null)
    try {
      await enterAsGuest()
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center px-6 py-12">
      <div className="hero-glow relative w-full max-w-[380px]">
        <div className="relative z-10">
          <div className="mb-9 flex flex-col items-center text-center">
            <Activity className="mb-4 h-7 w-7 text-gold" />
            <p className="font-mono text-[11px] tracking-[0.32em] text-gold uppercase">
              VITAL_MONITOR_SYS
            </p>
            <p className="kr mt-3 text-[13px] leading-relaxed text-faint">
              비접촉으로 이 방의 상태를 봅니다.
              <br />
              어떻게 들어오시겠습니까?
            </p>
          </div>

          {waiting ? (
            <div className="flex flex-col gap-3">
              <div className="rounded-lg border-[0.5px] border-gold/25 bg-panel px-4 py-4">
                <p className="kr flex items-center gap-2 text-[14px] font-medium text-gold">
                  <Clock className="h-4 w-4 shrink-0" />
                  승인을 기다리는 중입니다
                </p>
                <p className="kr mt-2 text-[12px] leading-relaxed text-faint">
                  <span className="text-muted">{waiting}</span> 계정이 만들어졌습니다. 관리자가
                  승인하면 로그인할 수 있습니다. 방의 생체지표와 기록을 보는 화면이라 가입만으로
                  열어 두지 않습니다.
                </p>
                <p className="kr mt-2 text-[12px] leading-relaxed text-faint">
                  기다리는 동안 <span className="text-muted">비회원 접속</span>으로 실시간 화면은
                  볼 수 있습니다.
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  setWaiting(null)
                  go('choose')
                }}
                className={LINK}
              >
                <ArrowLeft className="h-3.5 w-3.5" />
                처음으로
              </button>
            </div>
          ) : mode === 'choose' ? (
            <div className="flex flex-col gap-2.5">
              <button onClick={guest} disabled={busy} className={CARD}>
                <Eye className="h-4 w-4 shrink-0 text-gold" />
                <span className="min-w-0 flex-1">
                  <span className="kr block text-[14px] font-medium text-fg">비회원 접속</span>
                  <span className="kr mt-0.5 block text-[12px] text-faint">
                    실시간 화면만 봅니다. 가입 없이 바로
                  </span>
                </span>
                <ArrowRight className="h-3.5 w-3.5 shrink-0 text-faint" />
              </button>

              {CHOICES.map(({ mode: next, icon: Icon, label, desc }) => (
                <button key={next} onClick={() => go(next)} disabled={busy} className={CARD}>
                  <Icon className="h-4 w-4 shrink-0 text-gold" />
                  <span className="min-w-0 flex-1">
                    <span className="kr block text-[14px] font-medium text-fg">{label}</span>
                    <span className="kr mt-0.5 block text-[12px] text-faint">{desc}</span>
                  </span>
                  <ArrowRight className="h-3.5 w-3.5 shrink-0 text-faint" />
                </button>
              ))}
            </div>
          ) : (
            <form onSubmit={submit} className="flex flex-col gap-2.5">
              <div>
                <div className="flex gap-2">
                  <input
                    className={`${FIELD} ${
                      rejected ? 'border-alert/60 focus:border-alert' : ''
                    }`}
                    placeholder="아이디"
                    autoComplete="username"
                    autoFocus
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    onKeyDown={(event) => {
                      if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
                      event.preventDefault()
                      // 가입은 여기서 확인부터 한다. 확인 없이 다음 칸으로 보내면
                      // 비밀번호를 다 채우고 나서야 막힌 이유를 알게 된다.
                      if (mode === 'register') void check()
                      else passwordRef.current?.focus()
                    }}
                    aria-invalid={rejected}
                    aria-describedby={mode === 'register' ? 'username-check' : undefined}
                  />
                  {mode === 'register' && (
                    <button
                      type="button"
                      onClick={() => void check()}
                      disabled={!username.trim() || checking || verified}
                      className="kr shrink-0 rounded-md border-[0.5px] border-gold/30 px-3 text-[13px] whitespace-nowrap text-gold transition-colors hover:bg-gold/10 disabled:opacity-40"
                    >
                      {checking ? '확인 중…' : verified ? '확인됨' : '중복확인'}
                    </button>
                  )}
                </div>
                {mode === 'register' && (
                  <p
                    id="username-check"
                    aria-live="polite"
                    className={`kr mt-1.5 flex items-center gap-1.5 text-[12px] ${
                      verified ? 'text-gold-soft' : rejected ? 'text-alert' : 'text-faint'
                    }`}
                  >
                    {verified ? (
                      <Check className="h-3.5 w-3.5 shrink-0" />
                    ) : (
                      <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                    )}
                    {verified
                      ? '쓸 수 있는 아이디입니다'
                      : checked && checked.username !== username.trim()
                        ? '아이디가 바뀌었습니다 — 다시 확인해 주세요'
                        : checked
                          ? checked.detail
                          : '중복확인을 눌러 주세요'}
                  </p>
                )}
              </div>
              <input
                ref={passwordRef}
                className={FIELD}
                type="password"
                placeholder="비밀번호"
                autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                // 로그인은 여기가 마지막 칸이라 손대지 않는다 — Enter 가 그대로 제출한다.
                onKeyDown={mode === 'register' ? advance(confirmRef) : undefined}
              />
              {mode === 'register' && (
                <div>
                  <input
                    ref={confirmRef}
                    className={`${FIELD} ${mismatch ? 'border-alert/60 focus:border-alert' : ''}`}
                    type="password"
                    placeholder="비밀번호 확인"
                    autoComplete="new-password"
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                    aria-invalid={mismatch}
                    aria-describedby={mismatch ? 'confirm-mismatch' : undefined}
                  />
                  {mismatch && (
                    <p
                      id="confirm-mismatch"
                      // 화면 낭독기가 매 글자마다 읽으면 오히려 방해가 된다. polite 로
                      // 두어 타이핑이 멎은 뒤에 한 번 읽게 한다.
                      aria-live="polite"
                      className="kr mt-1.5 flex items-center gap-1.5 text-[12px] text-alert"
                    >
                      <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                      비밀번호가 일치하지 않습니다
                    </p>
                  )}
                </div>
              )}

              <button
                type="submit"
                disabled={busy || incomplete || mismatch}
                className="kr mt-1 rounded-md bg-gold px-3.5 py-2.5 text-[14px] font-medium text-ink transition-colors hover:bg-gold-soft disabled:opacity-40"
              >
                {busy ? '확인 중…' : mode === 'register' ? '가입 신청' : '로그인'}
              </button>

              <button type="button" onClick={() => go('choose')} className={`${LINK} mt-1`}>
                <ArrowLeft className="h-3.5 w-3.5" />
                처음으로
              </button>
            </form>
          )}

          {error && (
            <p className="kr mt-4 text-center text-[12px] text-alert" role="alert">
              {error}
            </p>
          )}
        </div>
      </div>
    </main>
  )
}

const CARD =
  'flex items-center gap-3 rounded-lg border-[0.5px] border-gold/15 bg-panel px-4 py-3.5 text-left transition-colors hover:border-gold/50 hover:bg-gold/[0.04] focus-visible:border-gold focus-visible:outline-none disabled:opacity-40'

const LINK =
  'kr flex items-center justify-center gap-1.5 py-1 text-[12px] text-faint transition-colors hover:text-muted'

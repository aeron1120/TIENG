import { Save } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useGet } from '../hooks/useApi'
import { Panel } from './Page'

// 계정에 딸린 개인정보. 전부 선택 입력이라 "필수" 표시를 붙이지 않는다 — 이 화면에서
// 적지 않아도 기기는 그대로 돈다.
//
// 저장 버튼은 고친 게 있을 때만 살아난다. 아무것도 안 바꾸고 누르는 저장은 서버에
// 같은 값을 다시 쓰고 갱신 시각만 밀어 놓는다.

export interface Profile {
  display_name: string
  birthdate: string
  sex: string
  phone: string
  email: string
  guardian_name: string
  guardian_email: string
  notes: string
  updated_at: string | null
}

const EMPTY: Profile = {
  display_name: '',
  birthdate: '',
  sex: '',
  phone: '',
  email: '',
  guardian_name: '',
  guardian_email: '',
  notes: '',
  updated_at: null,
}

const FIELD =
  'kr w-full rounded-md border-[0.5px] border-gold/20 bg-panel-dim px-3 py-2 text-[13px] text-fg placeholder:text-faint focus:border-gold/60 focus:outline-none'

const LABEL = 'kr mb-1.5 block text-[12px] text-muted'

const SEXES = ['', '남성', '여성', '기타']

function Field({
  label,
  value,
  onChange,
  type = 'text',
  placeholder,
}: {
  label: string
  value: string
  onChange: (next: string) => void
  type?: string
  placeholder?: string
}) {
  return (
    <label className="block">
      <span className={LABEL}>{label}</span>
      <input
        className={FIELD}
        type={type}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  )
}

export function ProfileForm() {
  const { data, error, loading } = useGet<Profile>('/api/auth/profile')
  const [form, setForm] = useState<Profile | null>(null)
  const [saved, setSaved] = useState<Profile | null>(null)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  // 서버가 준 값이 도착하면 그때 양식을 채운다. 초기값을 빈 문자열로 먼저 그려 두면
  // 사용자가 타이핑하는 도중에 응답이 와서 입력이 덮인다.
  useEffect(() => {
    if (data) {
      setForm(data)
      setSaved(data)
    }
  }, [data])

  if (loading && !form) return <Panel>{<p className="kr text-[13px] text-faint">불러오는 중…</p>}</Panel>
  if (error && !form)
    return (
      <Panel className="border-alert/40">
        <p className="kr text-[12px] text-alert">{error}</p>
      </Panel>
    )

  const current = form ?? EMPTY
  const set = (key: keyof Profile) => (next: string) =>
    setForm({ ...current, [key]: next })

  const dirty =
    saved !== null &&
    (Object.keys(EMPTY) as (keyof Profile)[])
      .filter((k) => k !== 'updated_at')
      .some((k) => current[k] !== saved[k])

  const submit = async () => {
    setBusy(true)
    setFailure(null)
    try {
      const res = await fetch('/api/auth/profile', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(current),
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body?.detail ?? `${res.status} ${res.statusText}`)
      setForm(body as Profile)
      setSaved(body as Profile)
    } catch (e) {
      setFailure((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <Panel>
        <h2 className="kr mb-3.5 text-[12px] font-medium text-muted">기본 신원</h2>
        <div className="grid gap-3.5 sm:grid-cols-3">
          <Field label="이름" value={current.display_name} onChange={set('display_name')} />
          <Field
            label="생년월일"
            value={current.birthdate}
            onChange={set('birthdate')}
            placeholder="1950-03-21"
          />
          <label className="block">
            <span className={LABEL}>성별</span>
            <select
              className={FIELD}
              value={current.sex}
              onChange={(e) => set('sex')(e.target.value)}
            >
              {SEXES.map((s) => (
                <option key={s} value={s}>
                  {s || '선택 안 함'}
                </option>
              ))}
            </select>
          </label>
        </div>
      </Panel>

      <Panel>
        <h2 className="kr mb-3.5 text-[12px] font-medium text-muted">본인 연락처</h2>
        <div className="grid gap-3.5 sm:grid-cols-2">
          <Field label="전화" value={current.phone} onChange={set('phone')} type="tel" />
          <Field label="이메일" value={current.email} onChange={set('email')} type="email" />
        </div>
      </Panel>

      <Panel>
        <h2 className="kr mb-1 text-[12px] font-medium text-muted">보호자</h2>
        {/* 여기 적은 주소로 알림이 가지 않는다. 그렇게 읽힐 자리라 명시한다. */}
        <p className="kr mb-3.5 text-[11px] text-faint">
          기록용입니다. L4 알림 수신자는 기기 설정(TFV_GUARDIAN_EMAIL)이 정합니다
        </p>
        <div className="grid gap-3.5 sm:grid-cols-2">
          <Field label="이름" value={current.guardian_name} onChange={set('guardian_name')} />
          <Field
            label="이메일"
            value={current.guardian_email}
            onChange={set('guardian_email')}
            type="email"
          />
        </div>
      </Panel>

      <Panel>
        <h2 className="kr mb-1 text-[12px] font-medium text-muted">건강 특이사항</h2>
        <p className="kr mb-3.5 text-[11px] text-faint">
          병력·복용약 등. 이 기기에 그대로 저장되니 필요한 만큼만 적으십시오
        </p>
        <textarea
          className={`${FIELD} min-h-[110px] resize-y leading-relaxed`}
          value={current.notes}
          onChange={(e) => set('notes')(e.target.value)}
        />
      </Panel>

      {failure && (
        <Panel className="border-alert/40">
          <p className="kr text-[12px] text-alert">{failure}</p>
        </Panel>
      )}

      <div className="flex flex-wrap items-center justify-end gap-3">
        <span className="kr text-[12px] text-faint">
          {dirty
            ? '저장하지 않은 변경이 있습니다'
            : saved?.updated_at
              ? `마지막 저장 ${new Date(saved.updated_at).toLocaleString('ko-KR')}`
              : '아직 저장한 적이 없습니다'}
        </span>
        <button
          onClick={submit}
          disabled={busy || !dirty}
          className="kr flex items-center gap-1.5 rounded-md bg-gold px-3.5 py-1.5 text-[12px] font-medium text-ink transition-colors hover:bg-gold-soft disabled:opacity-40"
        >
          <Save className="h-3.5 w-3.5" />
          {busy ? '저장 중…' : '저장'}
        </button>
      </div>
    </div>
  )
}

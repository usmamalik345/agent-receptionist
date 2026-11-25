/**
 * Console auth. Asks the API who is signed in (GET /api/v1/auth/me) and picks a mode:
 *   authed - API with login (production server): real bookings, staff see only their tenant
 *   anon   - API with login, no session: show the sign-in page
 *   demo   - no API (static Vercel deploy) or API with auth off: open console on SAMPLE data,
 *            so every old public link keeps working. Demo mode never shows real data: real data
 *            only comes from the API, which enforces the session server-side.
 * The session lives in an httpOnly cookie; page JS never sees the token.
 */
import { LogOut } from 'lucide-react'
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { initialTheme } from './state'

import { modeFrom, type AuthMode, type SessionUser } from './authMode'

interface AuthCtx {
  mode: AuthMode
  login(email: string, password: string): Promise<string | null>
  logout(): Promise<void>
  /** null = every tenant (admin or demo) */
  allowedTenant: string | null
}
const C = createContext<AuthCtx | null>(null)

async function probe(): Promise<AuthMode> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), 4000)
  try {
    const r = await fetch('/api/v1/auth/me', { credentials: 'same-origin', headers: { accept: 'application/json' }, signal: ctl.signal })
    const ct = r.headers.get('content-type')
    const body = ct?.includes('application/json') ? await r.json().catch(() => null) : null
    return modeFrom(r.status, ct, body)
  } catch {
    return { status: 'demo' }
  } finally {
    clearTimeout(timer)
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<AuthMode>({ status: 'loading' })
  useEffect(() => { void probe().then(setMode) }, [])
  const login = useCallback(async (email: string, password: string) => {
    try {
      const r = await fetch('/api/v1/auth/login', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) })
      const j = (await r.json().catch(() => ({}))) as { ok?: boolean; user?: SessionUser; error?: string }
      if (r.ok && j.user) {
        setMode({ status: 'authed', user: j.user })
        return null
      }
      return r.status === 429 ? 'Too many attempts. Wait a few minutes and try again.' : j.error === 'invalid email or password' ? 'Email or password is incorrect.' : 'Sign-in failed. Try again.'
    } catch {
      return 'Cannot reach the server.'
    }
  }, [])
  const logout = useCallback(async () => {
    await fetch('/api/v1/auth/logout', { method: 'POST', credentials: 'same-origin' }).catch(() => {})
    setMode({ status: 'anon' })
  }, [])
  const allowedTenant = mode.status === 'authed' && mode.user.role === 'staff' ? mode.user.tenantId : null
  const v = useMemo(() => ({ mode, login, logout, allowedTenant }), [mode, login, logout, allowedTenant])
  return <C.Provider value={v}>{children}</C.Provider>
}

export function useAuth(): AuthCtx {
  const c = useContext(C)
  if (!c) throw new Error('AuthProvider missing')
  return c
}

/** Sign-in screen in the Switchboard style. `next` = where to go after signing in (same-site paths only). */
export function LoginView({ next }: { next?: string }) {
  const { mode, login } = useAuth()
  const nav = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const target = next && next.startsWith('/') && !next.startsWith('//') ? next : '/app'
  useEffect(() => { document.title = 'Sign in · Front Desk Ops' }, [])
  useEffect(() => { if (mode.status === 'authed' || mode.status === 'demo') nav(target, { replace: true }) }, [mode.status, nav, target])
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(await login(email.trim(), password))
    setBusy(false)
  }
  return (
    <div className="sb sb-login" data-theme={initialTheme()}>
      <form className="login-card" onSubmit={submit} aria-labelledby="login-h">
        <div className="sb-ws" style={{ padding: 0 }}><i>FD</i><span>Front Desk Ops</span></div>
        <h1 id="login-h">Sign in</h1>
        <p className="sub">Staff see their own business. Admins see every business.</p>
        <label>Email<input type="email" autoComplete="username" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} /></label>
        <label>Password<input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></label>
        {error && <div className="err" role="alert">{error}</div>}
        <button className="btn pri" type="submit" disabled={busy || mode.status === 'loading'}>{busy ? 'Signing in…' : 'Sign in'}</button>
      </form>
    </div>
  )
}

export function LoginPage() {
  const [q] = useSearchParams()
  return <LoginView next={q.get('next') ?? undefined} />
}

/** Sidebar footer: who is signed in, or the demo-mode note. */
export function SessionFoot() {
  const { mode, logout } = useAuth()
  if (mode.status === 'demo') return <div className="row" title="No login on this public demo: sample data only. The production API requires sign-in."><span className="sb-sample" style={{ color: 'var(--acc-t)', background: 'var(--acc-bg)' }}>DEMO MODE</span><span>no login · sample data</span></div>
  if (mode.status !== 'authed') return null
  return (
    <div className="row" style={{ minWidth: 0, flexWrap: 'nowrap' }}>
      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={mode.user.email}>{mode.user.email} · {mode.user.role}</span>
      <button className="ib" style={{ width: 24, height: 24 }} onClick={() => void logout()} aria-label="Sign out" title="Sign out"><LogOut size={13} /></button>
    </div>
  )
}

/** How the console runs, from the answer to GET /api/v1/auth/me (pure; tested in tests/console-auth-mode.test.ts). */
export type Role = 'admin' | 'staff'
export interface SessionUser { email: string; role: Role; tenantId: string | null }
export type AuthMode = { status: 'loading' } | { status: 'demo' } | { status: 'anon' } | { status: 'authed'; user: SessionUser }

/**
 * 401 -> sign-in page. A JSON 200 with a user -> signed in. Anything else (404 from a static host,
 * HTML from an SPA fallback, network error, auth disabled) -> demo mode on SAMPLE data.
 */
export function modeFrom(status: number, contentType: string | null, body: unknown): AuthMode {
  if (status === 401) return { status: 'anon' }
  if (status !== 200 || !contentType?.includes('application/json')) return { status: 'demo' }
  const b = body as { authEnabled?: boolean; user?: SessionUser | null } | null
  if (b?.authEnabled === true && b.user && (b.user.role === 'admin' || b.user.role === 'staff')) return { status: 'authed', user: b.user }
  return { status: 'demo' }
}

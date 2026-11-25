/** Console users: in-memory (tests / no database) or SQL. Emails are stored lower-cased. */
import type { Db, Row } from '../db/sql.ts'
import type { Role } from './token.ts'

export interface User {
  id: string
  email: string
  passwordHash: string
  role: Role
  tenantId: string | null
  disabled: boolean
}

export interface UserRepo {
  byEmail(email: string): Promise<User | null>
  byId(id: string): Promise<User | null>
  /** insert, or update password/role/tenant when the email exists */
  upsert(u: Omit<User, 'id' | 'disabled'> & { disabled?: boolean }): Promise<User>
  touchLogin(id: string, at: string): Promise<void>
  list(): Promise<User[]>
}

export const normEmail = (e: string) => String(e ?? '').trim().toLowerCase()
export const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/

function check(u: { role: Role; tenantId: string | null; email: string }) {
  if (!EMAIL.test(u.email)) throw new Error('invalid email')
  if (u.role === 'admin' && u.tenantId) throw new Error('admin users are not bound to a tenant')
  if (u.role === 'staff' && !u.tenantId) throw new Error('staff users need a tenant')
}

export class MemoryUserRepo implements UserRepo {
  private readonly rows = new Map<string, User>()
  async byEmail(email: string) {
    const u = this.rows.get(normEmail(email))
    return u ? { ...u } : null
  }
  async byId(id: string) {
    const u = [...this.rows.values()].find((x) => x.id === id)
    return u ? { ...u } : null
  }
  async upsert(u: Omit<User, 'id' | 'disabled'> & { disabled?: boolean }) {
    const email = normEmail(u.email)
    check({ ...u, email })
    const prev = this.rows.get(email)
    const row: User = { id: prev?.id ?? globalThis.crypto.randomUUID(), email, passwordHash: u.passwordHash, role: u.role, tenantId: u.role === 'admin' ? null : u.tenantId, disabled: u.disabled ?? false }
    this.rows.set(email, row)
    return { ...row }
  }
  async touchLogin() {}
  async list() {
    return [...this.rows.values()].map((u) => ({ ...u }))
  }
}

const toUser = (r: Row): User => ({ id: String(r.id), email: String(r.email), passwordHash: String(r.password_hash), role: r.role as Role, tenantId: (r.tenant_id as string | null) ?? null, disabled: Boolean(Number(r.disabled)) })

export class SqlUserRepo implements UserRepo {
  private readonly db: Db
  constructor(db: Db) {
    this.db = db
  }
  async byEmail(email: string) {
    const r = await this.db.query('SELECT * FROM users WHERE email = $1', [normEmail(email)])
    return r.length ? toUser(r[0]) : null
  }
  async byId(id: string) {
    const r = await this.db.query('SELECT * FROM users WHERE id = $1', [id])
    return r.length ? toUser(r[0]) : null
  }
  async upsert(u: Omit<User, 'id' | 'disabled'> & { disabled?: boolean }) {
    const email = normEmail(u.email)
    check({ ...u, email })
    const r = await this.db.query(
      `INSERT INTO users (id, email, password_hash, role, tenant_id, disabled, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, role = EXCLUDED.role, tenant_id = EXCLUDED.tenant_id, disabled = EXCLUDED.disabled
       RETURNING *`,
      [globalThis.crypto.randomUUID(), email, u.passwordHash, u.role, u.role === 'admin' ? null : u.tenantId, u.disabled ? 1 : 0, new Date().toISOString()],
    )
    return toUser(r[0])
  }
  async touchLogin(id: string, at: string) {
    await this.db.query('UPDATE users SET last_login_at = $2 WHERE id = $1', [id, at])
  }
  async list() {
    return (await this.db.query('SELECT * FROM users ORDER BY email')).map(toUser)
  }
}

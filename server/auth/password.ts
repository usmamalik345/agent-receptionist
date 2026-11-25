/**
 * Password hashing with scrypt (Node's built-in, memory-hard KDF; OWASP-recommended alongside
 * argon2id and bcrypt). Format: scrypt$N$r$p$salt(b64)$hash(b64), so parameters can be raised later
 * and old hashes still verify. Comparison is constant-time.
 */
import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'node:crypto'

const scrypt = (pw: string, salt: Buffer, len: number, o: ScryptOptions) =>
  new Promise<Buffer>((resolve, reject) => scryptCb(pw.normalize('NFKC'), salt, len, o, (e, k) => (e ? reject(e) : resolve(k))))

// N=2^15, r=8, p=1 (~32 MiB, ~50-100 ms per hash on a server core)
const DEFAULTS = { N: 1 << 15, r: 8, p: 1 }
const KEY_LEN = 32
export const MIN_PASSWORD_LENGTH = 10

export async function hashPassword(password: string, o: Partial<typeof DEFAULTS> = {}): Promise<string> {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) throw new Error(`password must be at least ${MIN_PASSWORD_LENGTH} characters`)
  const { N, r, p } = { ...DEFAULTS, ...o }
  const salt = randomBytes(16)
  const key = await scrypt(password, salt, KEY_LEN, { N, r, p, maxmem: 256 * N * r })
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${key.toString('base64')}`
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false
  const [N, r, p] = parts.slice(1, 4).map(Number)
  if (![N, r, p].every((x) => Number.isInteger(x) && x > 0) || N > 1 << 20) return false
  const salt = Buffer.from(parts[4], 'base64')
  const want = Buffer.from(parts[5], 'base64')
  const got = await scrypt(String(password ?? ''), salt, want.length, { N, r, p, maxmem: 256 * N * r })
  return got.length === want.length && timingSafeEqual(got, want)
}

/** Verified against when the email is unknown, so "no such user" and "wrong password" take the same time. */
let dummy: Promise<string> | null = null
export function dummyHash(): Promise<string> {
  return (dummy ??= hashPassword(randomBytes(18).toString('base64')))
}

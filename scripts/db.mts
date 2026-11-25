/**
 * Database admin (needs DATABASE_URL; never prints passwords from env or the connection password).
 *   npm run db:migrate                     apply pending migrations
 *   npm run db:seed                        migrate + upsert SEED_ADMIN_* / SEED_STAFF_* users
 *   npm run db:user -- --email a@b.co --role staff --tenant erth-abu-dhabi
 *       password from NEW_USER_PASSWORD, else a random one is generated and shown once
 */
import 'dotenv/config'
import { randomBytes } from 'node:crypto'
import { parseArgs } from 'node:util'
import { hashPassword } from '../server/auth/password.ts'
import { SqlUserRepo } from '../server/auth/users.ts'
import { migrate } from '../server/db/migrations.ts'
import { connect, redactUrl } from '../server/db/sql.ts'
import { seedUsersFromEnv } from '../server/platform/bootstrap.ts'
import { loadTenants } from '../server/platform/registry.ts'

const url = process.env.DATABASE_URL
if (!url) {
  console.error('DATABASE_URL is not set (postgres://… or sqlite:./data/app.db)')
  process.exit(1)
}
const cmd = process.argv[2]
const db = await connect(url)
try {
  const applied = await migrate(db)
  console.log(`db ${redactUrl(url)}: ${applied.length ? `applied ${applied.join(', ')}` : 'schema up to date'}`)
  const { tenants } = loadTenants(process.env.TENANTS_DIR || undefined)
  const users = new SqlUserRepo(db)
  if (cmd === 'seed') {
    const seeded = await seedUsersFromEnv(users, tenants)
    console.log(seeded.length ? `users: ${seeded.join(', ')}` : 'no SEED_ADMIN_* / SEED_STAFF_* env set: no users seeded')
  } else if (cmd === 'user') {
    const { values } = parseArgs({ args: process.argv.slice(3), options: { email: { type: 'string' }, role: { type: 'string' }, tenant: { type: 'string' } } })
    const role = values.role === 'admin' ? 'admin' : values.role === 'staff' ? 'staff' : null
    if (!values.email || !role) throw new Error('usage: --email <email> --role admin|staff [--tenant <tenant id>]')
    if (role === 'staff' && (!values.tenant || !tenants.has(values.tenant))) throw new Error('staff needs --tenant <known tenant id>')
    const generated = !process.env.NEW_USER_PASSWORD
    const password = process.env.NEW_USER_PASSWORD || randomBytes(15).toString('base64url')
    const u = await users.upsert({ email: values.email, passwordHash: await hashPassword(password), role, tenantId: role === 'staff' ? values.tenant! : null })
    console.log(`user ${u.email} (${u.role}${u.tenantId ? `: ${u.tenantId}` : ''}) saved${generated ? `; one-time password: ${password}` : ''}`)
  } else if (cmd !== 'migrate') {
    throw new Error('commands: migrate | seed | user')
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : e)
  process.exitCode = 1
} finally {
  await db.close()
}

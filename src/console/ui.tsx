import type { Span } from '../../server/tracingCore.ts'
import type { Tenant } from '../../server/platform/tenant.ts'
import { brand } from './engine'

export const initials = (t: Tenant) => brand(t).split(/\s+/).filter((w) => /^[A-Z]/.test(w)).slice(0, 2).map((w) => w[0]).join('')
export const fmtTime = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
export function Avatar({ t }: { t: Tenant }) {
  return <span className="cx-avatar" aria-hidden>{initials(t)}</span>
}

/** Per-agent / per-tool span timeline for one turn. Bars are relative to the slowest span in the turn. */
export function TraceTimeline({ spans }: { spans: Span[] }) {
  if (!spans.length) return <div className="cx-trace">No spans recorded.</div>
  const max = Math.max(...spans.map((s) => s.duration_ms), 0.01)
  return (
    <div className="cx-trace" role="table" aria-label="Agent trace">
      {spans.map((s, i) => {
        const tool = s.name.startsWith('tool:')
        const a = s.attrs ?? {}
        const detail = [a.decision && `decision: ${a.decision}`, a.rule && `rule: ${a.rule}`, Array.isArray(a.tools) && a.tools.length ? `tools: ${(a.tools as string[]).join(', ')}` : null, a.model ? `model: ${a.model}` : null, s.error ? `error: ${s.error}` : null].filter(Boolean).join(' · ')
        return (
          <div className="cx-span" role="row" key={i}>
            <span className="label" role="cell">{s.name}</span>
            <span role="cell"><span className={`bar${tool ? ' tool' : ''}${s.ok ? '' : ' err'}`} style={{ display: 'block', width: `${Math.max(2, (s.duration_ms / max) * 100)}%` }} /></span>
            <span className="ms" role="cell">{s.duration_ms < 1 ? s.duration_ms.toFixed(2) : Math.round(s.duration_ms)} ms</span>
            {detail && <span className="detail" role="cell">{detail}</span>}
          </div>
        )
      })}
    </div>
  )
}

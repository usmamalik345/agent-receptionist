import type { CallStatus } from '../lib/types'

const meta: Record<CallStatus, { label: string; color: string; pulse?: boolean }> = {
  idle: { label: 'Ready', color: '#9fd4cf' },
  ringing: { label: 'Ringing…', color: '#5eead4', pulse: true },
  in_call: { label: 'AI talking', color: '#6ee7b7', pulse: true },
  completed: { label: 'Done', color: '#93c5fd' },
}

export function CallStatusBadge({ status }: { status: CallStatus }) {
  const m = meta[status]
  return (
    <div className="flex items-center gap-2">
      <span
        className={`status-dot ${m.pulse ? 'animate-pulse-ring' : ''}`}
        style={{ background: m.color }}
      />
      <span className="text-sm font-medium" style={{ color: m.color }}>
        {m.label}
      </span>
    </div>
  )
}

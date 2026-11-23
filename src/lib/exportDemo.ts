import type { DemoStoreData } from './types'

function csvEscape(v: unknown): string {
  const s = String(v ?? '')
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`
  return s
}

function downloadBlob(filename: string, mime: string, body: string) {
  const blob = new Blob([body], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

export function exportDemoJson(data: DemoStoreData) {
  const payload = {
    exportedAt: new Date().toISOString(),
    property: 'Erth Abu Dhabi',
    note: 'DEMO export for IT review — sandbox only, no Opera writes',
    settings: data.settings,
    history: data.history,
    tickets: data.tickets,
    notifications: data.notifications,
    auditLog: data.auditLog,
    guestProfiles: data.guestProfiles,
    currentSession: {
      id: data.session.id,
      line: data.session.line,
      outcome: data.session.outcome,
      transcript: data.session.transcript,
      toolLogs: data.session.toolLogs,
      booking: data.session.booking,
    },
    sessions: data.sessions?.map((s) => ({
      id: s.id,
      line: s.line,
      status: s.status,
      outcome: s.outcome,
      guestName: s.booking.guestName,
      phone: s.booking.phone,
    })),
  }
  downloadBlob(
    `erth-ai-demo-export-${Date.now()}.json`,
    'application/json',
    JSON.stringify(payload, null, 2),
  )
}

export function exportDemoCsv(data: DemoStoreData) {
  const lines: string[] = []
  lines.push('section,id,timestamp,field_a,field_b,field_c,field_d')

  for (const h of data.history) {
    lines.push(
      [
        'history',
        h.id,
        new Date(h.timestamp).toISOString(),
        csvEscape(h.guestName),
        csvEscape(h.outcome),
        csvEscape(h.booking.phone),
        csvEscape(`${h.booking.checkIn}→${h.booking.checkOut}`),
      ].join(','),
    )
  }
  for (const t of data.tickets) {
    lines.push(
      [
        'ticket',
        t.id,
        new Date(t.timestamp).toISOString(),
        csvEscape(t.guestName),
        csvEscape(t.reason),
        csvEscape(t.status),
        csvEscape(t.priority),
      ].join(','),
    )
  }
  for (const e of data.auditLog) {
    lines.push(
      [
        'audit',
        e.id,
        new Date(e.timestamp).toISOString(),
        csvEscape(e.actor),
        csvEscape(e.action),
        csvEscape(e.detail),
        csvEscape(e.sessionId || ''),
      ].join(','),
    )
  }
  for (const row of data.session.toolLogs) {
    lines.push(
      [
        'tool',
        row.id,
        new Date(row.timestamp).toISOString(),
        csvEscape(row.tool),
        csvEscape(row.result),
        csvEscape(JSON.stringify(row.args).slice(0, 120)),
        '',
      ].join(','),
    )
  }

  downloadBlob(`erth-ai-demo-export-${Date.now()}.csv`, 'text/csv;charset=utf-8', lines.join('\n'))
}

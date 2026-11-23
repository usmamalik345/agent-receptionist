import { parseDate, parseStayDates, parseTime } from '../src/lib/stateMachine.ts'

const cases: Array<[string, string]> = [
  ['tomorrow', 'REL'],
  ['tmrw 5pm', 'REL'],
  ['in 2 days', 'REL'],
  ['after 3 days', 'REL'],
  ['2026-10-10', '2026-10-10'],
  ['10/10/2026', '2026-10-10'],
  ['10-10-26', '2026-10-10'],
  ['10-26-13', '2026-10-13'], // MM-YY-DD
  ['13-2026-10', '2026-10-13'], // DD-YYYY-MM
  ['26-10-13', '2026-10-13'], // YY-MM-DD
  ['13 Oct 2026', '2026-10-13'],
]

for (const [input, expect] of cases) {
  const got = parseDate(input)
  const ok =
    expect === 'REL' ? !!got && /^\d{4}-\d{2}-\d{2}$/.test(got) : got === expect
  console.log(ok ? 'OK' : 'FAIL', JSON.stringify(input), '→', got, expect === 'REL' ? '(relative)' : `expected ${expect}`)
}

console.log('time', parseTime('tomorrow 5pm'), 'expected 17:00')
console.log('stay', parseStayDates('check in tomorrow 5pm for 3 nights'))
console.log('stay2', parseStayDates('from 10/10/2026 to 13/10/2026'))

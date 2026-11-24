/**
 * Prompt-injection / abuse screen. Runs on the caller's words BEFORE triage and before
 * any tool. Rule-based (no model call) so it is fast and predictable; it is a first line,
 * not a guarantee - tools also enforce allow-lists, tenant scope and confirmation.
 */
const RULES: Array<[string, RegExp]> = [
  ['override_instructions', /\b(ignore|disregard|forget|override)\b.{0,40}\b(previous|prior|above|all|your|the)\b.{0,20}\b(instructions?|rules?|prompts?|guidelines?)\b/i],
  ['reveal_prompt', /\b(system|developer|hidden|secret)\s+(prompt|message|instructions?)\b|\bwhat (are|were) your instructions\b|\brepeat (the|your) (prompt|instructions)\b/i],
  ['role_hijack', /\b(you are now|act as|pretend to be|from now on you|jailbreak|developer mode|dan mode)\b/i],
  ['tool_forcing', /\b(call|run|execute|invoke)\s+(the\s+)?(tool|function|api)\b|\bbook_(appointment|room)\b|\bcheck_availability\b|\bhandoff_to_human\b/i],
  ['cross_tenant', /\b(other|another|different)\s+(hotel|clinic|practice|tenant|business|customer)'?s?\s+(data|bookings?|customers?|patients?|guests?|records?|phone|details)\b|\btenant[_\s-]?id\b/i],
  ['data_exfil', /\b(list|show|give|read|dump|export)\b.{0,30}\b(all|every|other)\b.{0,20}\b(bookings?|patients?|guests?|customers?|records?|phone numbers?)\b/i],
  ['markup', /<\s*\/?\s*(system|assistant|script)\b|\[\[.*?\]\]|```/i],
]

export interface InjectionResult {
  flagged: boolean
  rules: string[]
}

export function screenInjection(text: string): InjectionResult {
  const rules = RULES.filter(([, re]) => re.test(text)).map(([n]) => n)
  return { flagged: rules.length > 0, rules }
}

export const INJECTION_REPLY = "Sorry, I can't help with that. I can help with bookings, opening hours, prices or questions about us."

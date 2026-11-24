/** Shared filler / backchannel detection (hotel + dental engines, platform booking agent). */
/**
 * Fillers / acknowledgements that are never a name (English + common Urdu/Hindi
 * backchannels heard on UK calls). "hmm" used to be stored as the patient's name.
 */
export const FILLER_WORDS = new Set([
  'hmm', 'hm', 'mm', 'mmm', 'umm', 'um', 'uh', 'uhh', 'uhm', 'erm', 'er', 'err', 'ah', 'ahh', 'eh', 'oh', 'ooh',
  'haan', 'han', 'haa', 'ha', 'ji', 'jee', 'acha', 'achha', 'theek', 'hai', 'ok', 'okay', 'k', 'kk', 'yes', 'yeah',
  'yep', 'yup', 'no', 'nope', 'what', 'sorry', 'pardon', 'huh', 'hello', 'hi', 'hey', 'wait', 'well', 'so', 'like',
  'right', 'sure', 'alright', 'fine', 'thanks', 'thank', 'you', 'one', 'sec', 'second', 'moment', 'hold', 'on', 'hang', 'just', 'a', 'minute', 'uhuh', 'mhm', 'hmmm',
])
export const FILLER_SHAPE = /^(h+m+|m{2,}|u+m+|u+h+m*|e+r+m*|a+h+|o+h+)$/

/** True when the utterance is only fillers/backchannels ("hmm", "uh-huh", "haan ji", "sorry?") - never a name. */
export function isFillerUtterance(text: string): boolean {
  const words = text.toLowerCase().replace(/[^a-z\s']/g, ' ').split(/\s+/).filter(Boolean)
  if (words.length === 0) return true
  return words.every((w) => FILLER_WORDS.has(w) || FILLER_SHAPE.test(w))
}

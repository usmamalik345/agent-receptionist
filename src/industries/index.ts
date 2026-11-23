export { hotelPreset } from './hotel'
export { dentalPreset } from './dental'

import type { IndustryId, IndustryPreset } from '../config/businessTypes'
import { dentalPreset } from './dental'
import { hotelPreset } from './hotel'

const PRESETS: Record<IndustryId, IndustryPreset | undefined> = {
  hotel: hotelPreset,
  dental: dentalPreset,
  clinic: undefined,
  restaurant: undefined,
}

export function getIndustryPreset(id: IndustryId): IndustryPreset {
  const preset = PRESETS[id]
  if (!preset) {
    throw new Error(`Industry preset not implemented yet: ${id}`)
  }
  return preset
}

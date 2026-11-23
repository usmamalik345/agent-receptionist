/**
 * Module-level active business for the conversation engine (non-React).
 * React layers set this when ?biz= changes; smoke tests can set it explicitly.
 */

import type { BusinessConfig } from '../config/businessTypes'
import { DEFAULT_BUSINESS_SLUG, resolveBusiness } from '../businesses'

let active: BusinessConfig = resolveBusiness(DEFAULT_BUSINESS_SLUG)

export function getActiveBusiness(): BusinessConfig {
  return active
}

export function setActiveBusiness(biz: BusinessConfig | string): BusinessConfig {
  active = typeof biz === 'string' ? resolveBusiness(biz) : biz
  return active
}

export function isHotelIndustry(biz: BusinessConfig = active): boolean {
  return biz.industry === 'hotel'
}

export function isDentalIndustry(biz: BusinessConfig = active): boolean {
  return biz.industry === 'dental'
}

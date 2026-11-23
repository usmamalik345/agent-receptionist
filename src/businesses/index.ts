import type { BusinessConfig } from '../config/businessTypes'
import { getIndustryPreset } from '../industries'
import { erthBusiness } from './erth'
import { mmDentalBusiness } from './mm-dental'

export const DEFAULT_BUSINESS_SLUG = 'erth'

const BUSINESSES: Record<string, BusinessConfig> = {
  erth: erthBusiness,
  'mm-dental': mmDentalBusiness,
}

export function listBusinesses(): BusinessConfig[] {
  return Object.values(BUSINESSES)
}

export function getBusiness(slug: string | null | undefined): BusinessConfig | null {
  if (!slug) return BUSINESSES[DEFAULT_BUSINESS_SLUG]
  return BUSINESSES[slug] ?? null
}

export function resolveBusiness(slug: string | null | undefined): BusinessConfig {
  return getBusiness(slug) ?? BUSINESSES[DEFAULT_BUSINESS_SLUG]
}

export function getPresetForBusiness(biz: BusinessConfig) {
  return getIndustryPreset(biz.industry)
}

export { erthBusiness, mmDentalBusiness }

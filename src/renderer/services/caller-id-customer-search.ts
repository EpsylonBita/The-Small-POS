import {
  isSupportedCountry,
  parsePhoneNumberFromString,
  type CountryCode,
} from 'libphonenumber-js/min'

const COUNTRY_PREFIXES = [
  '351', '355', '357', '358', '359', '370', '371', '372', '373', '374',
  '375', '376', '377', '378', '380', '381', '382', '383', '385', '386',
  '387', '389', '420', '421', '423', '30', '31', '32', '33', '34', '36',
  '39', '40', '41', '43', '44', '45', '46', '47', '48', '49', '90',
]

export function normalizeCallerIdSearchPhone(phone: string): string {
  let normalized = phone.replace(/\D/g, '')
  if (normalized.startsWith('00')) normalized = normalized.slice(2)
  for (const prefix of COUNTRY_PREFIXES) {
    if (normalized.startsWith(prefix) && normalized.length > 10) {
      normalized = normalized.slice(prefix.length)
      break
    }
  }
  return normalized.startsWith('0') ? normalized.slice(1) : normalized
}

export function formatCallerIdDisplayPhone(
  phone: string,
  homeCountryCode?: string | null,
): string {
  const canonicalPhone = phone.trim()
  const countryCode = homeCountryCode?.trim().toUpperCase()
  if (
    !canonicalPhone ||
    !countryCode ||
    !/^[A-Z]{2}$/.test(countryCode) ||
    !isSupportedCountry(countryCode as CountryCode)
  ) {
    return canonicalPhone
  }

  const parseablePhone = canonicalPhone.startsWith('00')
    ? `+${canonicalPhone.slice(2)}`
    : canonicalPhone
  const parsed = parsePhoneNumberFromString(
    parseablePhone,
    countryCode as CountryCode,
  )
  if (!parsed?.isValid()) {
    return canonicalPhone
  }

  if (parsed.country !== countryCode) return parseablePhone

  return parsed.formatNational()
}

export function navigateToCallerIdCustomerSearch(phone: string): void {
  window.dispatchEvent(
    new CustomEvent('pos:navigate-view', {
      detail: {
        view: 'users',
        customerSearch: normalizeCallerIdSearchPhone(phone),
      },
    }),
  )
}

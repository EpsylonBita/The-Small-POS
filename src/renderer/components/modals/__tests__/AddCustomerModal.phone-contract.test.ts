import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

// Founder (05/09/2026): «δε θα ήθελα υποχρεωτικό το ISO χώρας — βασικά δε θα
// ήθελα να είναι καν πεδίο». The operator never sees a country field; an
// international number carries its own prefix.
//
// Founder (29/09/2026): a national number follows the STORE's country (the
// branch's phone_country_code, cached as restaurant.phone_country_code), and
// the field turns red with «must have N digits (you entered M)». Behaviour is
// pinned in AddCustomerModal.phone-validation.test.tsx; this file pins the
// wire contract the native command and the office rely on.
describe('AddCustomerModal phone identity payload', () => {
  const source = readFileSync(
    path.join(process.cwd(), 'src', 'renderer', 'components', 'modals', 'AddCustomerModal.tsx'),
    'utf8',
  )

  it('shows no phone-country field and asks the operator for nothing about it', () => {
    expect(source).not.toMatch(/modals\.addCustomer\.phoneCountryLabel/)
    expect(source).not.toMatch(/modals\.addCustomer\.phoneCountryRequired/)
    expect(source).not.toMatch(/value=\{formData\.phoneCountryCode\}/)
    expect(source).not.toMatch(/newErrors\.phoneCountryCode/)
  })

  it('reads national numbers in the store country, with GR only as the uncached fallback', () => {
    // Updated 29/09/2026: the hard-coded HOME_PHONE_COUNTRY is gone.
    expect(source).not.toMatch(/HOME_PHONE_COUNTRY/)
    expect(source).toMatch(/const STORE_PHONE_COUNTRY_FALLBACK: CountryCode = 'GR';/)
    expect(source).toMatch(/getSetting\('restaurant', 'phone_country_code'\)/)
    // One shared rule for both POS apps, imported from the repo-root shared/.
    expect(source).toMatch(
      /from '\.\.\/\.\.\/\.\.\/\.\.\/\.\.\/shared\/services\/phone-input-validation'/,
    )
    expect(source).toMatch(/validateCustomerPhoneInput\(/)
    expect(source).toMatch(/resolveCustomerPhoneEdit\(/)
    // The submitted country is the one the number was validated with;
    // international input stays self-contained.
    expect(source).toMatch(
      /const submittedPhoneCountryCode = isInternationalPhone\(submittedPhone\)\s*\?\s*null\s*:\s*submitPhoneAssessment\?\.country \?\? storeCountry;/,
    )
    expect(source.match(/phone_country_code:\s*submittedPhoneCountryCode/g)).toHaveLength(2)
  })

  it('sends the exact raw submitted phone without stripping its international prefix', () => {
    expect(source).toMatch(/const submittedPhone = formData\.phone;/)
    expect(source.match(/phone:\s*submittedPhone/g)).toHaveLength(2)
    expect(source).not.toMatch(/formData\.phone\.replace\(\/\\D/)
  })

  it('leaves an unchanged phone out of an edit', () => {
    expect(source).toMatch(
      /\.\.\.\(submitPhoneAssessment\?\.unchanged\s*\?\s*\{\}\s*:\s*\{ phone: submittedPhone, phone_country_code: submittedPhoneCountryCode \}\)/,
    )
  })
})

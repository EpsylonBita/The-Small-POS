import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

// Founder (05/09/2026): «δε θα ήθελα υποχρεωτικό το ISO χώρας — βασικά δε θα
// ήθελα να είναι καν πεδίο: το κατάστημα είναι στην Ελλάδα». The operator
// never sees a country field; a national number is a Greek number and an
// international one carries its own prefix.
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

  it('defaults national numbers to the home country and keeps international input self-contained', () => {
    expect(source).toMatch(/const HOME_PHONE_COUNTRY: CountryCode = 'GR';/)
    expect(source).toMatch(
      /const submittedPhoneCountryCode = isInternationalPhone\(submittedPhone\)\s*\?\s*null\s*:\s*normalizePhoneCountryCode\(formData\.phoneCountryCode\) \|\| HOME_PHONE_COUNTRY;/,
    )
    // A customer that already carries another valid ISO country keeps it.
    expect(source).toMatch(/isSupportedCountry/)
    expect(source.match(/phone_country_code:\s*submittedPhoneCountryCode/g)).toHaveLength(2)
  })

  it('sends the exact raw submitted phone without stripping its international prefix', () => {
    expect(source).toMatch(/const submittedPhone = formData\.phone;/)
    expect(source.match(/phone:\s*submittedPhone/g)).toHaveLength(2)
    expect(source).not.toMatch(/formData\.phone\.replace\(\/\\D/)
  })
})

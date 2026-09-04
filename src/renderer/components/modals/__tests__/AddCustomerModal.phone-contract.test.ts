import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

describe('AddCustomerModal phone identity payload', () => {
  const source = readFileSync(
    path.join(process.cwd(), 'src', 'renderer', 'components', 'modals', 'AddCustomerModal.tsx'),
    'utf8',
  )

  it('keeps an explicit ISO country in form state and create/update payloads', () => {
    expect(source).toMatch(/isSupportedCountry/)
    expect(source).not.toMatch(/phoneCountryCode:\s*'GR'/)
    expect(source).toMatch(/phoneCountryCode:\s*''/)
    expect(source.match(/phone_country_code:\s*submittedPhoneCountryCode/g)).toHaveLength(2)
    expect(source).toMatch(/value=\{formData\.phoneCountryCode\}/)
  })

  it('requires country only for national phones and keeps international input self-contained', () => {
    expect(source).toMatch(/isInternationalPhone/)
    expect(source).toMatch(/submittedPhoneCountryCode\s*=\s*isInternationalPhone/)
    expect(source).not.toMatch(/\|\|\s*'GR'/)
  })

  it('sends the exact raw submitted phone without stripping its international prefix', () => {
    expect(source).toMatch(/const submittedPhone = formData\.phone;/)
    expect(source.match(/phone:\s*submittedPhone/g)).toHaveLength(2)
    expect(source).toMatch(/const phoneForValidation = formData\.phone\.trim\(\)/)
    expect(source).not.toMatch(/formData\.phone\.replace\(\/\\D/)
  })
})

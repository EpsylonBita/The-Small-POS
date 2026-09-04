import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { NavigationModuleIcon } from '../NavigationSidebar'

describe('NavigationSidebar repair icon', () => {
  it('renders the canonical Wrench metadata as a wrench instead of the package fallback', () => {
    const { container } = render(<NavigationModuleIcon iconName="Wrench" />)

    expect(container.querySelector('.lucide-wrench')).not.toBeNull()
    expect(container.querySelector('.lucide-package')).toBeNull()
  })
})

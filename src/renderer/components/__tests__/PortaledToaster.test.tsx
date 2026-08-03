import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('react-hot-toast', () => ({
  Toaster: () => <div data-testid="toaster" />,
}))

import PortaledToaster from '../PortaledToaster'

describe('PortaledToaster', () => {
  afterEach(cleanup)

  it('escapes transformed app content so settings modals cannot cover diagnostics', () => {
    const { container } = render(
      <div style={{ transform: 'translateZ(0)' }}>
        <PortaledToaster />
      </div>,
    )

    const toaster = screen.getByTestId('toaster')
    expect(container).not.toContainElement(toaster)
    expect(toaster.parentElement).toBe(document.body)
  })
})

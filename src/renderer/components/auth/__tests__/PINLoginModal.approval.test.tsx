import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../ui/pos-glass-components', () => ({
  LiquidGlassModal: ({ isOpen, children }: any) => isOpen ? <div role="dialog">{children}</div> : null,
}))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: string | { defaultValue?: string }) =>
      typeof options === 'string' ? options : options?.defaultValue ?? key,
  }),
}))

import PINLoginModal from '../PINLoginModal'

afterEach(cleanup)

describe('approval PIN modal', () => {
  it.each(['Nobody in this store can approve', 'Approvals paused for 5 minutes'])(
    'keeps the dialog visible without a keypad or keyboard submission: %s', message => {
      const onSubmit = vi.fn()
      render(<PINLoginModal isOpen onClose={vi.fn()} onSubmit={onSubmit} blockedMessage={message} />)
      expect(screen.getByRole('dialog')).toBeInTheDocument()
      expect(screen.getByRole('status')).toHaveTextContent(message)
      expect(screen.queryByRole('button', { name: '1' })).not.toBeInTheDocument()
      fireEvent.keyDown(document, { key: '1' })
      fireEvent.keyDown(document, { key: 'Enter' })
      expect(onSubmit).not.toHaveBeenCalled()
    },
  )

  it('clears a refused PIN and shows the manager-specific explanation', async () => {
    const onSubmit = vi.fn().mockResolvedValue(false)
    render(<PINLoginModal isOpen onClose={vi.fn()} onSubmit={onSubmit} errorMessage="Use a manager's personal PIN" />)
    for (const digit of '123456') fireEvent.click(screen.getByRole('button', { name: digit }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Confirm' })).toBeDisabled())
    expect(onSubmit).toHaveBeenCalledWith('123456')
    expect(screen.getByRole('alert')).toHaveTextContent("Use a manager's personal PIN")
    expect(screen.getByLabelText('PIN entry')).not.toHaveTextContent('\u2022')
  })
})

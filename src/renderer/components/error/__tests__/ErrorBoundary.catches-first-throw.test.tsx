/**
 * The boundary used to set only `hasError` when a child threw, so its retry
 * rendered the children again, they threw again and the error escaped: a
 * crashing page took the whole register down — the incoming-order alert
 * beside the page included (Tomikro watchdog work, 30/09/2026).
 */
import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ErrorBoundary } from '../ErrorBoundary'

const Crash = () => {
  throw new Error('page failed to render')
}

describe('ErrorBoundary', () => {
  afterEach(() => cleanup())

  it('shows its fallback for the first throw instead of letting the error escape', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const fallback = vi.fn((error: { message: string }) => <p>fallback: {error.message}</p>)
    try {
      render(
        <div>
          <span>beside the page</span>
          <ErrorBoundary fallback={fallback}>
            <Crash />
          </ErrorBoundary>
        </div>,
      )

      expect(screen.getByText('fallback: page failed to render')).toBeInTheDocument()
      expect(screen.getByText('beside the page')).toBeInTheDocument()
    } finally {
      consoleError.mockRestore()
    }
  })

  it('a crashed boundary renders its children again when resetKey changes (the next route)', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const Page = ({ path }: { path: string }) => {
      if (path === '/crashing') throw new Error('page failed to render')
      return <p>page {path}</p>
    }
    const fallback = (error: { message: string }) => <p>fallback: {error.message}</p>
    try {
      const view = render(
        <ErrorBoundary fallback={fallback} resetKey="/crashing">
          <Page path="/crashing" />
        </ErrorBoundary>,
      )
      expect(screen.getByText('fallback: page failed to render')).toBeInTheDocument()

      view.rerender(
        <ErrorBoundary fallback={fallback} resetKey="/">
          <Page path="/" />
        </ErrorBoundary>,
      )
      expect(screen.getByText('page /')).toBeInTheDocument()
      expect(screen.queryByText(/fallback:/)).toBeNull()
    } finally {
      consoleError.mockRestore()
    }
  })

  it('a healthy boundary never remounts its children when resetKey changes', () => {
    let mounts = 0
    const Page = () => {
      React.useEffect(() => {
        mounts += 1
      }, [])
      return <p>page</p>
    }
    const view = render(
      <ErrorBoundary resetKey="/">
        <Page />
      </ErrorBoundary>,
    )
    view.rerender(
      <ErrorBoundary resetKey="/reservations">
        <Page />
      </ErrorBoundary>,
    )
    expect(screen.getByText('page')).toBeInTheDocument()
    expect(mounts).toBe(1)
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MODAL_ORIGIN_PRESS_WINDOW_MS,
  applyModalOrigin,
  notePressForTests,
  recentPress,
  registerOpenGlassModal,
  resetModalOriginForTests,
  takeOverBackdrop,
} from '../modal-origin'

function shellAt(
  left: number,
  top: number,
  width: number,
  height: number,
  layoutWidth = width,
  layoutHeight = height,
): HTMLElement {
  const shell = document.createElement('div')
  Object.defineProperty(shell, 'offsetWidth', { value: layoutWidth })
  Object.defineProperty(shell, 'offsetHeight', { value: layoutHeight })
  shell.getBoundingClientRect = () =>
    ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect
  return shell
}

describe('modal origin (founder 11/11/2026: windows open from the control that was pressed)', () => {
  beforeEach(() => resetModalOriginForTests())
  afterEach(() => vi.useRealTimers())

  it('points the shell at a recent press, relative to its own box', () => {
    notePressForTests(1700, 980)
    const shell = shellAt(600, 200, 720, 500)
    applyModalOrigin(shell)
    expect(shell.style.getPropertyValue('--modal-origin-x')).toBe('1100px')
    expect(shell.style.getPropertyValue('--modal-origin-y')).toBe('780px')
    // The enter animation is left to the stylesheet again after the measurement.
    expect(shell.style.animation).toBe('')
  })

  it('measures a shell that a motion library already scaled about its centre as its real box', () => {
    notePressForTests(100, 100)
    // Layout box 800x600 at (200,100); drawn at 0.82 about the centre.
    const shell = shellAt(272, 154, 656, 492, 800, 600)
    applyModalOrigin(shell)
    expect(shell.style.getPropertyValue('--modal-origin-x')).toBe('-100px')
    expect(shell.style.getPropertyValue('--modal-origin-y')).toBe('0px')
  })

  it('keeps the centre origin when no press is recent, and never applies twice', () => {
    const shell = shellAt(0, 0, 400, 300)
    applyModalOrigin(shell)
    expect(shell.style.getPropertyValue('--modal-origin-x')).toBe('')
    notePressForTests(10, 10)
    applyModalOrigin(shell)
    expect(shell.style.getPropertyValue('--modal-origin-x')).toBe('')
  })

  it('forgets a press that is too old to have opened the window', () => {
    vi.useFakeTimers()
    notePressForTests(50, 60)
    expect(recentPress()).toEqual({ x: 50, y: 60 })
    vi.advanceTimersByTime(MODAL_ORIGIN_PRESS_WINDOW_MS + 1)
    expect(recentPress()).toBeNull()
  })

  it('takes over the backdrop of a closing window only, never of one that stays open', () => {
    const closingBackdrop = document.createElement('div')
    const openBackdrop = document.createElement('div')
    const closing = { isOpen: () => false, backdrop: () => closingBackdrop }
    const stillOpen = { isOpen: () => true, backdrop: () => openBackdrop }
    const incoming = { isOpen: () => true, backdrop: () => document.createElement('div') }
    const releaseOpen = registerOpenGlassModal(stillOpen)
    registerOpenGlassModal(incoming)

    // Opened on top of a window that stays: not a replacement.
    expect(takeOverBackdrop(incoming)).toBe(false)
    expect(openBackdrop.style.opacity).toBe('')

    const releaseClosing = registerOpenGlassModal(closing)
    expect(takeOverBackdrop(incoming)).toBe(true)
    expect(closingBackdrop.style.opacity).toBe('0')
    expect(closingBackdrop.style.animation).toBe('none')
    expect(openBackdrop.style.opacity).toBe('')

    releaseClosing()
    releaseOpen()
    expect(takeOverBackdrop(incoming)).toBe(false)
  })
})

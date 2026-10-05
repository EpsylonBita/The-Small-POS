import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import translations from '../../../../locales/overlays/en.cafe-lan.json'

const mock = vi.hoisted(() => ({ invoke: vi.fn(), get: vi.fn(), copy: vi.fn(), running: false }))
vi.mock('../../../../lib', () => ({ getBridge: () => ({ invoke: mock.invoke, clipboard: { writeText: mock.copy } }) }))
vi.mock('../../../utils/api-helpers', () => ({ posApiGet: mock.get }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key.split('.').reduce((value: any, part) => value?.[part], translations) ?? key }) }))
vi.mock('../../ui/ConfirmDialog', () => ({ ConfirmDialog: ({ isOpen, message, onConfirm, onClose }: any) => isOpen ? <div role="dialog">
  <p>{message}</p><button onClick={onConfirm}>Confirm pairing action</button><button onClick={onClose}>Cancel pairing action</button>
</div> : null }))
import { CafeLanSettings } from '../CafeLanSettings'

const childId = '22222222-2222-4222-8222-222222222222'
const pair = { version: 1, organization_id: 'org', branch_id: 'branch', parent_terminal_id: 'parent', source_terminal_id: childId, secret_hex: 'a'.repeat(64), port: 8765 }
const copy = translations.settings.cafeLan
beforeEach(() => {
  vi.clearAllMocks(); mock.running = false
  mock.get.mockResolvedValue({ success: true, data: { success: true, children: [
    { terminal_id: childId, name: 'Waiter One', terminal_type: 'mobile_waiter' },
    { terminal_id: 'kitchen', name: 'Kitchen', terminal_type: 'kitchen_display' },
  ] } })
  mock.invoke.mockImplementation(async (command: string) => {
    if (command === 'lan_transport_status') return { running: mock.running, port: 8765 }
    if (command === 'lan_transport_start') mock.running = true
    if (command === 'lan_transport_stop') mock.running = false
    if (command === 'lan_transport_pair') return pair
    return { success: true }
  })
  mock.copy.mockResolvedValue(undefined)
})
afterEach(() => { cleanup(); vi.useRealTimers() })
async function selectWaiter() {
  await screen.findByRole('option', { name: 'Waiter One' })
  await waitFor(() => expect(screen.getByRole('combobox')).not.toBeDisabled())
  fireEvent.change(screen.getByRole('combobox'), { target: { value: childId } })
  fireEvent.change(screen.getByRole('textbox', { name: copy.host }), { target: { value: '192.168.1.10' } })
}
async function generate() {
  await selectWaiter()
  fireEvent.click(screen.getByRole('button', { name: copy.generate }))
  fireEvent.click(screen.getByRole('button', { name: 'Confirm pairing action' }))
  await screen.findByRole('textbox', { name: copy.code })
}

it('explains desktop main reception and Internet requirements without exposing a nonfunctional child importer', () => {
  render(<CafeLanSettings isMain={false} />)
  expect(screen.getByText(copy.desktopMainOnly)).toBeInTheDocument()
  expect(screen.getByText(copy.internetRequired)).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: copy.generate })).not.toBeInTheDocument()
  expect(mock.get).not.toHaveBeenCalled(); expect(mock.invoke).not.toHaveBeenCalled()
})
it('pairs only a listed waiter after an explicit rotation warning and sends no secret into native command arguments', async () => {
  render(<CafeLanSettings isMain />)
  await selectWaiter()
  expect(screen.queryByRole('option', { name: 'Kitchen' })).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: copy.generate }))
  expect(screen.getByText(copy.rotationHelp)).toBeInTheDocument()
  expect(mock.invoke).not.toHaveBeenCalledWith('lan_transport_pair', expect.anything())
  fireEvent.click(screen.getByRole('button', { name: 'Confirm pairing action' }))
  const code = await screen.findByRole('textbox', { name: copy.code })
  expect(mock.get).toHaveBeenCalledWith('/api/pos/lan/validate')
  expect(mock.invoke).toHaveBeenCalledWith('lan_transport_pair', { child_terminal_id: childId })
  expect(JSON.parse((code as HTMLTextAreaElement).value)).toEqual({ ...pair, parent_host: '192.168.1.10' })
  fireEvent.click(screen.getByRole('button', { name: copy.hide }))
  expect(screen.queryByRole('textbox', { name: copy.code })).not.toBeInTheDocument()
})
it('copies only on request and clears the transient enrollment code when the advertised address changes', async () => {
  render(<CafeLanSettings isMain />); await generate()
  expect(mock.copy).not.toHaveBeenCalled()
  const code = (screen.getByRole('textbox', { name: copy.code }) as HTMLTextAreaElement).value
  fireEvent.click(screen.getByRole('button', { name: copy.copy }))
  await waitFor(() => expect(mock.copy).toHaveBeenCalledWith(code))
  fireEvent.change(screen.getByRole('textbox', { name: copy.host }), { target: { value: '192.168.1.11' } })
  expect(screen.queryByRole('textbox', { name: copy.code })).not.toBeInTheDocument()
})
it('hides the enrollment secret after five minutes', async () => {
  render(<CafeLanSettings isMain />); await generate()
  vi.useFakeTimers()
  // Changing the host clears the first code; the second generation schedules its timeout under the fake clock.
  fireEvent.change(screen.getByRole('textbox', { name: copy.host }), { target: { value: '192.168.1.11' } })
  fireEvent.click(screen.getByRole('button', { name: copy.generate }))
  fireEvent.click(screen.getByRole('button', { name: 'Confirm pairing action' }))
  await act(async () => { await Promise.resolve() })
  expect(screen.getByRole('textbox', { name: copy.code })).toBeInTheDocument()
  act(() => vi.advanceTimersByTime(5 * 60 * 1000))
  expect(screen.queryByRole('textbox', { name: copy.code })).not.toBeInTheDocument()
})
it('starts and stops the fixed-port listener only after native acknowledgement', async () => {
  render(<CafeLanSettings isMain />)
  await waitFor(() => expect(screen.getByRole('button', { name: copy.start })).not.toBeDisabled())
  fireEvent.click(screen.getByRole('button', { name: copy.start }))
  await screen.findByRole('button', { name: copy.stop })
  expect(mock.invoke).toHaveBeenCalledWith('lan_transport_start')
  fireEvent.click(screen.getByRole('button', { name: copy.stop }))
  await screen.findByRole('button', { name: copy.start })
  expect(mock.invoke).toHaveBeenCalledWith('lan_transport_stop')
})
it('rejects an invalid native enrollment and displays a generic error without surfacing proof material', async () => {
  mock.invoke.mockImplementation(async (command: string) => command === 'lan_transport_pair' ? { ...pair, source_terminal_id: 'other' } : { running: false, port: 8765 })
  render(<CafeLanSettings isMain />); await selectWaiter()
  fireEvent.click(screen.getByRole('button', { name: copy.generate }))
  fireEvent.click(screen.getByRole('button', { name: 'Confirm pairing action' }))
  expect(await screen.findByRole('alert')).toHaveTextContent(copy.failed)
  expect(screen.queryByRole('textbox', { name: copy.code })).not.toBeInTheDocument()
  expect(screen.queryByText(pair.secret_hex)).not.toBeInTheDocument()
})
it('requires confirmation to revoke the selected pairing and clears the visible enrollment', async () => {
  render(<CafeLanSettings isMain />); await generate()
  await waitFor(() => expect(screen.getByRole('button', { name: copy.revoke })).not.toBeDisabled())
  fireEvent.click(screen.getByRole('button', { name: copy.revoke }))
  expect(mock.invoke).not.toHaveBeenCalledWith('lan_transport_revoke', expect.anything())
  fireEvent.click(screen.getByRole('button', { name: 'Confirm pairing action' }))
  await waitFor(() => expect(screen.queryByRole('textbox', { name: copy.code })).not.toBeInTheDocument())
  expect(mock.invoke).toHaveBeenCalledWith('lan_transport_revoke', { child_terminal_id: childId })
})

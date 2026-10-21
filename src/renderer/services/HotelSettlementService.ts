import { getBridge } from '../../lib';
import { posApiGet, posApiPost, type PosApiResult } from '../utils/api-helpers';
import { recordedFolioCurrency } from '../utils/folio-currency';
import { folioChargesEndpoint } from '../utils/guest-billing';
import { branchCalendarClock } from '../utils/room-workflow';

export const HOTEL_ERROR_CODES = ['FOLIO_SETTLEMENT_OPEN','NOTHING_TO_COLLECT','AMOUNT_EXCEEDS_COLLECTIBLE',
  'FOLIO_NOT_COLLECTIBLE','FOLIO_CURRENCY_MISMATCH','FOLIO_CURRENCY_UNAVAILABLE','SETTLEMENT_REQUEST_CONFLICT',
  'INVALID_INPUT','FOLIO_NOT_FOUND','SETTLEMENT_HAS_PAYMENTS','FOLIO_SETTLEMENT_REQUIRED','FOLIO_SETTLEMENT_IMMUTABLE',
  'CHARGE_REQUEST_CONFLICT','ROOM_CHECKOUT_REQUIRED','ROOM_RESERVATION_DATES_MISMATCH',
  'PAYMENT_MIRROR_PENDING','CONNECTION_REQUIRED'] as const;
export function hotelErrorCode(error: unknown): string {
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : JSON.stringify(error);
  return HOTEL_ERROR_CODES.find(code => raw?.includes(code)) ?? (/HTTP\s*400|Invalid request body/i.test(raw ?? '') ? 'INVALID_INPUT' : /HTTP\s*404/i.test(raw ?? '') ? 'FOLIO_NOT_FOUND' : 'ACTION_FAILED');
}
export const settlementEndpoint = (id: string) => `/pos/guest-billing/${encodeURIComponent(id)}/settlement`;
interface OpenSettlement { order_id: string; client_order_id: string; total_cents: number; paid_cents: number; remaining_cents: number }
interface Summary { success?: boolean; folio: { id: string; currency: string; balance_cents: number }; collectible_cents: number; open_settlement: OpenSettlement | null }
interface Prepared { success?: boolean; order: Record<string, any>; items: Record<string, any>[]; total_cents: number; revenue_cents: number; transfer_cents: number }
export interface HotelSettlement { folioId: string; orderId: string; serverId: string; currency: string; total: number; outstanding: number; items: any[]; payments: any[]; order: Record<string, any> }
function requireResult<T extends { success?: boolean }>(result: PosApiResult<T>): T {
  if (!result.success || result.stale || !result.data || result.data.success === false) {
    throw new Error(result.code ?? (result.status === 404 ? 'FOLIO_NOT_FOUND' : result.stale ? 'CONNECTION_REQUIRED' : result.error ?? 'ACTION_FAILED'));
  }
  return result.data;
}
// An unanswered request keeps its exact body across retries and restarts.
const requestKey = (id: string) => `hotel-settlement:${id}`;
export async function prepareHotelSettlement(folioId: string, amountCents?: number, attribution?: { staffId: string; staffShiftId: string }): Promise<HotelSettlement> {
  let summary = requireResult(await posApiGet<Summary>(settlementEndpoint(folioId)));
  const currency = recordedFolioCurrency(summary.folio.currency);
  if (!currency) throw new Error('FOLIO_CURRENCY_UNAVAILABLE');
  const open = summary.open_settlement;
  const key = requestKey(folioId);
  let body: { clientRequestId: string; currency: string; amountCents?: number; staffId?: string; staffShiftId?: string };
  if (open) {
    body = { clientRequestId: open.client_order_id, currency, amountCents: open.total_cents };
  } else {
    const saved = localStorage.getItem(key);
    body = saved ? JSON.parse(saved) : { clientRequestId: crypto.randomUUID(), currency, ...attribution, ...(amountCents ? { amountCents } : {}) };
    // Do not silently turn an unknown prepare outcome into another collection.
    if (saved && (body.currency !== currency || body.amountCents !== amountCents)) throw new Error('SETTLEMENT_REQUEST_CONFLICT');
    localStorage.setItem(key, JSON.stringify(body));
  }
  let result = await posApiPost<Prepared>(settlementEndpoint(folioId), body);
  if (!result.success && hotelErrorCode(result.code ?? result.error) === 'FOLIO_SETTLEMENT_OPEN') {
    summary = requireResult(await posApiGet<Summary>(settlementEndpoint(folioId)));
    const resumed = summary.open_settlement;
    if (!resumed) throw new Error('FOLIO_SETTLEMENT_OPEN');
    result = await posApiPost<Prepared>(settlementEndpoint(folioId), { clientRequestId: resumed.client_order_id, currency, amountCents: resumed.total_cents });
  }
  const prepared = requireResult(result);
  if (prepared.order.order_context !== 'folio_settlement' || prepared.order.folio_id !== folioId || prepared.order.currency !== currency) throw new Error('SETTLEMENT_REQUEST_CONFLICT');
  const bridge = getBridge();
  const imported = await bridge.orders.saveFromRemote({ orderData: { ...prepared.order, items: prepared.items }, suppressAutoPrint: true });
  const orderId = String((imported as any).orderId ?? (imported.data as any)?.orderId ?? '');
  if (!imported.success) throw new Error(imported.error ?? 'ACTION_FAILED');
  if (orderId !== prepared.order.client_order_id) throw new Error('SETTLEMENT_REQUEST_CONFLICT');
  if (prepared.order.status === 'cancelled' || prepared.order.status === 'canceled') {
    // A lost cancel acknowledgement may leave the old prepare key behind.
    // Mirror that cancellation too, so it cannot strand a local unpaid blocker.
    finishHotelSettlement(folioId);
    throw new Error('SETTLEMENT_REQUEST_CONFLICT');
  }
  // Pull canonical receipts before allowing a resumed collection. If unavailable,
  // local durable payments still count, but missing remote money fails closed.
  await bridge.sync.force().catch(() => undefined);
  const snapshot = await bridge.payments.getSettlementSnapshot(orderId);
  if (snapshot.success !== true || !Number.isFinite(snapshot.netPaid) || !Number.isFinite(snapshot.outstandingAmount)
      || Math.round(snapshot.orderTotal * 100) !== prepared.total_cents) throw new Error('PAYMENT_MIRROR_PENDING');
  const remotePaid = summary.open_settlement?.client_order_id === orderId ? summary.open_settlement.paid_cents : 0;
  if (Math.round(snapshot.netPaid * 100) < remotePaid) throw new Error('PAYMENT_MIRROR_PENDING');
  return { folioId, orderId, serverId: String(prepared.order.id), currency, total: snapshot.orderTotal,
    outstanding: snapshot.outstandingAmount, items: prepared.items, payments: snapshot.completedPayments, order: { ...prepared.order, items: prepared.items } };
}
export async function cancelHotelSettlement(settlement: HotelSettlement): Promise<void> {
  const bridge = getBridge();
  const snapshot = await bridge.payments.getSettlementSnapshot(settlement.orderId);
  // Ambiguous/unsaved terminal receipts cannot be abandoned and recollected.
  const unsaved = await bridge.payments.listUnsavedPayments(settlement.orderId);
  if (snapshot.success !== true || !Number.isFinite(snapshot.netPaid) || !unsaved.success || !Array.isArray(unsaved.payments)) throw new Error('PAYMENT_MIRROR_PENDING');
  if (snapshot.netPaid > 0 || snapshot.unresolvedDirectSale || (unsaved as any).payments?.length) throw new Error('SETTLEMENT_HAS_PAYMENTS');
  requireResult(await posApiPost(`${settlementEndpoint(settlement.folioId)}/${encodeURIComponent(settlement.serverId)}/cancel`, {}));
  // Mark only the exact server-cancelled original locally.
  const mirrored = await bridge.orders.saveFromRemote({ orderData: { ...settlement.order, status: 'cancelled' }, suppressAutoPrint: true });
  if (!mirrored.success) throw new Error(mirrored.error ?? 'ACTION_FAILED');
  localStorage.removeItem(requestKey(settlement.folioId));
}
export function finishHotelSettlement(folioId: string): void { localStorage.removeItem(requestKey(folioId)); }

export async function postHotelCharge<T>(folioId: string, body: Record<string, unknown>): Promise<PosApiResult<T>> {
  const key = `hotel-charge:${folioId}`;
  const saved = localStorage.getItem(key);
  const next = { ...body };
  if (saved) {
    const prior = JSON.parse(saved) as Record<string, unknown>;
    const { clientRequestId: ignoredPrior, ...priorFacts } = prior;
    const { clientRequestId: ignoredNext, ...nextFacts } = next;
    if (JSON.stringify(priorFacts) !== JSON.stringify(nextFacts)) throw new Error('CHARGE_REQUEST_CONFLICT');
    next.clientRequestId = prior.clientRequestId;
  }
  localStorage.setItem(key, JSON.stringify(next));
  const result = await posApiPost<T>(folioChargesEndpoint(folioId), next);
  if (result.success || (result.status && result.status < 500 && result.status >= 400 && result.code !== 'CHARGE_REQUEST_CONFLICT')) localStorage.removeItem(key);
  return result;
}
export interface StatementFolio { id: string; currency?: string | null; guestName: string; roomNumber: string; checkIn: string; checkOut: string | null }
export interface StatementCharge { id: string; charge_type: string; description: string; quantity: number; total: number; currency: string }
export function folioStatementDocument(folio: StatementFolio, charges: StatementCharge[], label: (key: string) => string, statementAt = new Date().toISOString()) {
  const currency = recordedFolioCurrency(folio.currency);
  if (!currency || charges.some(charge => charge.currency !== currency)) throw new Error('FOLIO_CURRENCY_MISMATCH');
  const debt = charges.filter(charge => charge.charge_type !== 'payment');
  const collections = charges.filter(charge => charge.charge_type === 'payment');
  const sumCents = (lines: StatementCharge[]) => lines.reduce((sum, line) => sum + Math.round(Number(line.total) * 100), 0);
  const debtCents = sumCents(debt), paymentCents = -sumCents(collections);
  return { order_id: folio.id, order_number: folio.roomNumber, order_type: '', currency,
    created_at: statementAt, customer_name: folio.guestName, status_label: label('hotelMoney.statement'),
    order_notes: [`${folio.checkIn} - ${folio.checkOut ?? label('guestBilling.ongoing')}`],
    items: debt.map(charge => ({ name: charge.description, quantity: charge.quantity, total: Number(charge.total) })),
    payments: collections.map(charge => {
      const returned = charge.description.startsWith('Refund: ');
      const method = returned ? charge.description.slice(8) : charge.description;
      const known = ({cash:'cash',card:'card',bank_transfer:'bankTransfer',other:'other'} as Record<string,string>)[method.toLowerCase()];
      const tender = known ? label(`guestBilling.paymentMethods.${known}`) : method;
      return { label: returned ? `${label('hotelMoney.refund')}: ${tender}` : tender, amount: -Number(charge.total) };
    }),
    totals: [{ label: label('guestBilling.totalCharges'), amount: debtCents / 100 },
      { label: label('guestBilling.totalPayments'), amount: paymentCents / 100 },
      { label: label('guestBilling.balance'), amount: (debtCents - paymentCents) / 100, emphasize: true }] };
}
export async function printHotelFolio(folio: StatementFolio, label: (key: string) => string): Promise<void> {
  const result = requireResult(await posApiGet<{ success: boolean; charges: StatementCharge[] }>(`/pos/guest-billing/${encodeURIComponent(folio.id)}/charges`));
  const bridge = getBridge();
  const branch = await bridge.terminalConfig.getBranchId();
  const [zoneBranch, zone] = await Promise.all([
    bridge.settings.get('terminal', 'hotel_timezone_branch_id'),
    bridge.settings.get('terminal', 'hotel_timezone'),
  ]);
  if (!branch || branch !== zoneBranch || typeof zone !== 'string') throw new Error('CONNECTION_REQUIRED');
  const clock = branchCalendarClock(zone);
  // A branch wall timestamp stays naive so the native receipt renderer cannot
  // reinterpret it through the PC timezone. Booking interval dates are unchanged.
  const document = folioStatementDocument(folio, result.charges, label, `${clock.date}T${clock.time}:00`);
  const print = await bridge.printer.submitJob({ entityType: 'folio_statement', entityId: folio.id, document });
  if (!print.success) throw new Error(print.error ?? 'ACTION_FAILED');
}

/** Back-out after a lost prepare/import answer still resolves the same server original. */
export async function cancelPreparedHotelSettlement(folioId: string): Promise<void> {
  const summary = requireResult(await posApiGet<Summary>(settlementEndpoint(folioId)));
  if (!summary.open_settlement) {
    const saved = localStorage.getItem(requestKey(folioId));
    if (!saved) return;
    // An earlier cancel may already be accepted remotely while its local
    // acknowledgement is missing. Resolve that same request before dropping it.
    try {
      const original = await prepareHotelSettlement(folioId, JSON.parse(saved).amountCents);
      await cancelHotelSettlement(original);
    } catch (error) {
      if (hotelErrorCode(error) !== 'SETTLEMENT_REQUEST_CONFLICT' || localStorage.getItem(requestKey(folioId))) throw error;
    }
    return;
  }
  if (summary.open_settlement.paid_cents > 0) throw new Error('SETTLEMENT_HAS_PAYMENTS');
  const original = await prepareHotelSettlement(folioId);
  await cancelHotelSettlement(original);
}

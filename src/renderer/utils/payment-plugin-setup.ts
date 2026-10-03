/** Public onboarding state only. This build has no certified payment transport. */
import { isTwintQrImageData } from '../../../../shared/payments/twint-qr';

export type PaymentPluginSetupState =
  | 'manual_ready'
  | 'not_configured'
  | 'pending_verification'
  | 'partner_setup_required'
  | 'unavailable';

export interface PaymentPluginSetupView {
  state: PaymentPluginSetupState;
  status: 'disconnected' | 'pending';
}

export const isPaymentSetupPlugin = (provider: string): boolean =>
  provider === 'twint' || provider === 'worldline_terminals';

export const PAYMENT_SETUP_COPY: Record<PaymentPluginSetupState, { label: string; detail: string }> = {
  manual_ready: { label: 'Manual confirmation', detail: 'The shop QR is ready. The cashier must confirm every TWINT payment received.' },
  not_configured: {
    label: 'Setup required',
    detail: 'Set up this payment connection in the Admin Dashboard. Payments are not available yet.',
  },
  pending_verification: {
    label: 'Awaiting verification',
    detail: 'The configuration is saved. Payments will be available after the connection is verified.',
  },
  partner_setup_required: {
    label: 'Partner setup required',
    detail: 'Provider onboarding is required before this connection can receive payments. Continue in the Admin Dashboard.',
  },
  unavailable: {
    label: 'Status unavailable',
    detail: 'Payment readiness could not be confirmed. Open the Admin Dashboard to check the setup.',
  },
};

/** Never infer payment readiness from purchase, saved credentials or generic plugin status. */
export function resolvePaymentPluginSetup(value: unknown): PaymentPluginSetupView {
  const unavailable: PaymentPluginSetupView = { state: 'unavailable', status: 'pending' };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return unavailable;
  const setup = value as Record<string, unknown>;
  // A claimed ready transport is unsupported in this build, including on older servers.
  if (setup.transport_ready !== false || setup.setup_href !== '/dashboard/plugins') return unavailable;
  if (setup.configuration_state === 'manual_ready' && setup.integration_mode === 'static_qr_manual'
    && setup.reason_code === 'TWINT_MANUAL_QR_READY' && setup.manual_confirmation_ready === true
    && setup.currency === 'CHF' && isTwintQrImageData(setup.qr_image_data)) {
    return { state: 'manual_ready', status: 'pending' };
  }
  if (setup.configuration_state === 'not_configured' && setup.integration_mode === null && setup.reason_code === 'CONFIGURATION_REQUIRED') {
    return { state: 'not_configured', status: 'disconnected' };
  }
  if (setup.configuration_state === 'pending_verification'
    && (setup.integration_mode === 'native_tim' || setup.integration_mode === 'worldline_terminal')
    && setup.reason_code === 'WORLDLINE_TIM_VERIFICATION_REQUIRED') {
    return { state: 'pending_verification', status: 'pending' };
  }
  if (setup.configuration_state === 'partner_setup_required' && setup.integration_mode === 'direct_qr' && setup.reason_code === 'TWINT_PARTNER_SETUP_REQUIRED') {
    return { state: 'partner_setup_required', status: 'pending' };
  }
  return unavailable;
}

import type { TFunction } from 'i18next';
import { branchWallTime } from '../../../utils/branch-time';
import type { AppointmentClaimOutcome } from '../../../services/appointment-checkout-claims';

/**
 * Why an appointment's checkout cannot go on, for the cashier. The holder's
 * lease end shows in branch time when the branch zone is known.
 */
export function appointmentClaimRefusalMessage(outcome: AppointmentClaimOutcome, t: TFunction, timeZone?: string | null): string {
  switch (outcome.kind) {
    case 'claimed_elsewhere': {
      let time: string | null = null;
      try {
        time = outcome.leaseExpiresAt && timeZone ? branchWallTime(outcome.leaseExpiresAt, timeZone).slice(11, 16) : null;
      } catch {
        time = null;
      }
      if (!outcome.terminal) return t('appointmentCheckoutClaim.claimedElsewhereUnknown', 'This appointment is being checked out at another till. Try again in a few minutes.');
      return time
        ? t('appointmentCheckoutClaim.claimedElsewhere', { terminal: outcome.terminal, time, defaultValue: 'This appointment is being checked out at another till ({{terminal}}) until {{time}}.' })
        : t('appointmentCheckoutClaim.claimedElsewhereNow', { terminal: outcome.terminal, defaultValue: 'This appointment is being checked out at another till ({{terminal}}).' });
    }
    case 'settled':
      return t('appointmentCheckoutClaim.settled', 'This appointment is already paid or closed.');
    case 'not_found':
      return t('appointmentCheckoutClaim.notFound', 'This appointment was not found. Refresh and try again.');
    case 'needs_connection':
      return t('appointmentCheckoutClaim.needsConnection', 'Checking out an appointment needs a connection. You can sell the services as a walk-in.');
    default:
      return t('appointmentCheckoutClaim.failed', 'The checkout could not start. Try again.');
  }
}

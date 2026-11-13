import { shiftSummaryCurrency } from '../../utils/shift-currency';
import { CashierRecovery } from '../../contexts/cashier-gate-context';
import { recordedFolioCurrency } from '../../utils/folio-currency';
import { submitSatelliteHandover } from '../../utils/satellite-handover';
import { readPendingWaiterReturns, type PendingWaiterReturn } from '../../utils/pending-waiter-returns';
import {
  REMOTE_HANDOVER_RETRY,
  isNonCashPhoneRole,
  phoneLastSeenIsStale,
  readReleasedPhoneTills,
  readUnitShiftReadinessRemembered,
  tillsToReceive,
  unitHasPhones,
  unitIsQuiet,
  unitShiftCashToReceive,
  unitShiftPhoneLabel,
  unitShiftPhoneState,
  unitShiftStaffLabel,
  type RememberedUnitReadiness,
  type UnitClosedShift,
  type UnitReadiness,
  type UnitReadinessResult,
  type UnitShift,
} from '../../utils/unit-shift-readiness';
import { satelliteHandoverMessage } from '../../utils/satelliteHandoverText';
import { SatelliteHandoverReleasePanel } from './SatelliteHandoverReleasePanel';
import {
  CloseWithoutHandoverPanel,
  type CloseWithoutHandoverOutcome,
} from './staff-shift/CloseWithoutHandoverPanel';
import React, { useState, useEffect, useRef } from 'react';
import { fromCents, roundMoney, toCents } from '@shared/utils/money';
import { toast } from 'react-hot-toast';
import { AnimatePresence, motion, useIsPresent, useReducedMotion } from 'framer-motion';
import { X, Clock, FileText, Plus, AlertCircle, User, ChevronLeft, ChevronRight, AlertTriangle, CheckCircle, XCircle, CreditCard, Star, Check, Trash2, Pencil, QrCode, Delete } from 'lucide-react';
import { CardsIcon, CashHandIcon, SplitReceiptIcon } from '../icons/PaymentMethodIcons';
import { formatGridOrderNumber } from '../../utils/gridOrderNumber';
import { useTranslation } from 'react-i18next';
import { useShift } from '../../contexts/shift-context';
import { ShiftExpense, StaffPayment } from '../../types';
import useTerminalSettings from '../../hooks/useTerminalSettings';
import { useWorkCardStatus, WorkCardLine } from '../../hooks/useWorkCardStatus';
import { LiquidGlassModal, POSGlassBadge, POSGlassCard } from '../ui/pos-glass-components';
import { VarianceBadge } from '../ui/VarianceBadge';
import { formatTime, formatCurrency as formatMoney } from '../../utils/format';
import { normalizeShiftRole, type StaffShiftRole } from '../../utils/shift-role';
import { parseMoneyInputValue } from '../../utils/moneyInput';
import { CentsMoneyInput } from '../ui/CentsMoneyInput';
import { calculateDriverReturn } from '../../utils/driver-checkout';
import { toLocalDateString } from '../../utils/date';
import { posApiGet } from '../../utils/api-helpers';
import { debugLog } from '../../utils/debugLog';
import { loadFiscalOrderReportingEntitlement } from '../../utils/fiscal-integration-entitlement';
import { ProgressStepper, Step, StepStatus } from '../ui/ProgressStepper';
import { ConfirmDialog, ConfirmVariant } from '../ui/ConfirmDialog';
import { ErrorAlert } from '../ui/ErrorAlert';
import { UnsettledPaymentBlockersPanel } from '../ui/UnsettledPaymentBlockersPanel';
import { useKeyboardShortcut } from '../../hooks/useKeyboardShortcut';
import { usePrivilegedActionConfirmation } from '../../hooks/usePrivilegedActionConfirmation';
import {
  useRecordPaymentBlocker,
  type RecordPaymentBlockerOutcome,
} from '../../hooks/useRecordPaymentBlocker';
import { StaffShiftCheckoutFooterActions } from './StaffShiftCheckoutFooterActions';
import {
  buildShiftCheckoutPrintSnapshot,
  canPrintShiftCheckoutSnapshot,
  queueShiftCheckoutPrint,
  resolveCashierCheckoutExpenseTotal,
} from '../../utils/staffShiftCheckoutPrint';
import { emitCompatEvent, getBridge } from '../../../lib';
import { GiftCardsApiService } from '../../services/GiftCardsApiService';
import {
  cachedGiftCardsStore,
  checkedOnTill,
  describeOfflineOpeningRefusal,
  giftCardOrdinaryOpeningMessage,
} from '../../services/offlineCheckIn';
import { getCachedTerminalCredentials } from '../../services/terminal-credentials';
import { financialOpening, openingMatchesScope, parseOpeningCents, type FinancialOpeningScope } from '../../lib/financial-opening';
import type {
  ShiftFinancialClosingRecoveryView,
  ShiftFinancialOpeningView,
  PaymentIntegrityErrorPayload,
  UnsettledPaymentBlocker,
} from '../../../lib/ipc-contracts';
import {
  GIFT_CLOSE_ORIGINAL_CODES,
  GIFT_CLOSE_REDISCOVER_CODES,
  GIFT_CLOSE_TERMS_CODES,
  GiftCloseAmount,
  GiftClosePendingList,
  GiftCloseRecoveryPanel,
  buildGiftClosePreview,
  buildGiftClosingRequest,
  giftCloseCodeText,
  giftCloseText,
  isGiftBoundCheckoutState,
  readCloseBlocker,
  readDrawer,
  readGiftCloseResult,
  readOpeningList,
  readPendingList,
  readRefusalCode,
  toSafeCents,
  type GiftCheckoutState,
  type GiftCloseApproval,
  type GiftClosePendingState,
  type GiftCloseRecoveryTarget,
  type GiftCloseText,
} from './StaffShiftGiftClose';
import {
  formatPaymentIntegrityError,
  extractPaymentIntegrityPayload,
} from '../../../lib/payment-integrity';

// IPC result shapes from bridge calls
interface SettingsResult {
  [key: string]: unknown;
  terminal?: { branch_id?: string; terminal_id?: string };
}

interface ShiftIpcResult extends PaymentIntegrityErrorPayload {
  success: boolean;
  shiftId?: string;
  expected?: number;
  closing?: number;
  variance?: number;
  currency?: string | null;
  error?: string;
  data?: { shiftId?: string; id?: string; expected?: number; closing?: number; variance?: number; currency?: string | null };
}

interface ShiftPrintCheckoutResult extends ShiftIpcResult {
  skipped?: boolean;
  queued?: boolean;
}

interface ShiftCheckInEligibility {
  requiresCashierFirst: boolean;
  hasCashierForBusinessDay?: boolean;
  businessDayStartAt?: string | null;
}

interface StaffShiftModalProps {
  isOpen: boolean;
  onClose: () => void;
  mode: 'checkin' | 'checkout';
  /** Hide cash drawer fields for mobile waiter terminals */
  hideCashDrawer?: boolean;
  /** Indicates if this is a mobile waiter terminal */
  isMobileWaiter?: boolean;
}

interface StaffRole {
  role_id: string;
  role_name: string;
  role_display_name: string;
  role_color: string;
  is_primary: boolean;
}

interface StaffMember {
  id: string;
  name: string;
  first_name: string;
  last_name: string;
  email: string;
  role_id: string;
  role_name: string;
  role_display_name: string;
  roles: StaffRole[]; // All roles for this staff member
  can_login_pos: boolean;
  is_active: boolean;
  // PIN hashes never reach the renderer: the native check-in holds them in
  // the OS credential store (staff_pin_vault.rs).
  has_pin?: boolean;
  hourly_rate?: number;
}

interface StaffAuthCachePayload {
  branch_id?: string;
  staff?: unknown[];
}

interface PosIntegrationPayload {
  id?: string;
  plugin_id?: string | null;
  provider?: string | null;
  is_purchased?: boolean;
  is_enabled?: boolean;
  is_active?: boolean;
}

// Written only by the native directory refresh (`staffAuth.refreshDirectory`);
// the renderer reads it for the instant staff list.
const STAFF_AUTH_CACHE_CATEGORY = 'staff_auth_cache';
const ERGANI_PLUGIN_ID = 'ergani_digital_schedule';

type CheckInStep = 'select-staff' | 'enter-pin' | 'select-role' | 'enter-cash';
type MotionDirection = 1 | -1;

interface RolePresentation {
  badgeFilled: string;
  badgeOutline: string;
  iconColor: string;
  accentText: string;
  accentSurface: string;
  accentBorder: string;
  buttonSurface: string;
}

const FALLBACK_ROLE_PRESENTATION: RolePresentation = {
  badgeFilled: 'liquid-glass-modal-text',
  badgeOutline: 'liquid-glass-modal-text',
  iconColor: 'liquid-glass-modal-text-muted',
  accentText: 'liquid-glass-modal-text',
  accentSurface: 'pos-glass-form-card',
  accentBorder: '',
  // Touch-first: no hover variants. Press feedback comes from getInteractiveMotion('card').
  buttonSurface: 'liquid-glass-modal-text',
};

const ROLE_PRESENTATIONS: Record<StaffShiftRole, RolePresentation> = {
  cashier: {
    badgeFilled: 'liquid-glass-modal-text',
    badgeOutline: 'liquid-glass-modal-text',
    iconColor: 'text-yellow-700 dark:text-yellow-300',
    accentText: 'text-yellow-800 dark:text-yellow-200',
    accentSurface: 'pos-glass-form-card',
    accentBorder: '',
    // Touch-first: no hover variants. Press feedback comes from getInteractiveMotion('card').
    buttonSurface: 'liquid-glass-modal-text',
  },
  // Non-cashier roles use the neutral grey presentation (palette: only the
  // money-handling cashier role keeps the yellow brand accent; role identity is carried
  // by the label + icon, not hue).
  driver: FALLBACK_ROLE_PRESENTATION,
  kitchen: FALLBACK_ROLE_PRESENTATION,
  server: FALLBACK_ROLE_PRESENTATION,
  manager: FALLBACK_ROLE_PRESENTATION,
};

const isErganiIntegration = (integration: PosIntegrationPayload): boolean =>
  [integration.plugin_id, integration.provider, integration.id].some(value => value === ERGANI_PLUGIN_ID);

const isActiveErganiIntegration = (integration: PosIntegrationPayload): boolean =>
  isErganiIntegration(integration) &&
  integration.is_purchased === true &&
  integration.is_enabled === true &&
  integration.is_active === true;

const CHECKIN_STEP_ORDER: Record<CheckInStep, number> = {
  'select-staff': 0,
  'enter-pin': 1,
  'select-role': 2,
  'enter-cash': 3,
};

const CHECKIN_MOTION_EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];
const CHECKIN_MOTION = {
  fast: 0.16,
  base: 0.22,
  slow: 0.28,
  press: {
    type: 'spring' as const,
    stiffness: 520,
    damping: 34,
    mass: 0.52,
  },
};

const INVALID_CONTEXT_VALUES = new Set([
  '',
  'default-organization',
  'default-org',
  'default-branch',
  'default-terminal',
]);

function normalizeContextId(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  if (INVALID_CONTEXT_VALUES.has(trimmed.toLowerCase())) {
    return undefined;
  }
  return trimmed;
}

function extractErrorMessage(error: unknown, fallback: string): string {
  const paymentIntegrityMessage = formatPaymentIntegrityError(error, '');
  if (paymentIntegrityMessage.trim()) {
    return paymentIntegrityMessage.trim();
  }

  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }

  if (typeof error === 'string' && error.trim()) {
    return error;
  }

  if (error && typeof error === 'object') {
    const candidate = error as Record<string, unknown>;
    const directMessage = candidate.message ?? candidate.error ?? candidate.reason;
    if (typeof directMessage === 'string' && directMessage.trim()) {
      return directMessage;
    }
  }

  return fallback;
}

function isUuidValue(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value.trim(),
    )
  );
}

function buildStaffAuthCacheKey(branchId: string): string {
  return `branch_${branchId.trim()}`;
}

function parseBoolean(value: unknown, fallback = false): boolean {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1') {
      return true;
    }
    if (normalized === 'false' || normalized === '0') {
      return false;
    }
  }
  return fallback;
}

function hasOwnKey(value: unknown, key: string): boolean {
  return !!value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, key);
}

function includesStaffAuthMetadata(members: unknown[]): boolean {
  return members.some((member) =>
    hasOwnKey(member, 'has_pin') ||
    hasOwnKey(member, 'hasPin') ||
    hasOwnKey(member, 'can_login_pos') ||
    hasOwnKey(member, 'canLoginPos') ||
    hasOwnKey(member, 'canLoginPOS'),
  );
}

function normalizeLegacyProbeError(error: string): string {
  return error.trim().toLowerCase();
}

function mapScheduledStaffToMember(member: any): StaffMember {
  // Map all roles from the API's roles array (new multi-role response)
  const apiRoles: StaffRole[] = Array.isArray(member?.roles)
    ? member.roles
        .map((r: any) => ({
          role_id: String(r?.id ?? r?.role_id ?? ''),
          role_name: String(r?.name ?? r?.role_name ?? 'staff'),
          role_display_name: String(
            r?.displayName ?? r?.display_name ?? r?.role_display_name ?? 'Staff',
          ),
          role_color: String(r?.color ?? r?.role_color ?? '#6B7280'),
          is_primary: Boolean(r?.isPrimary ?? r?.is_primary ?? false),
        }))
        .filter((r: StaffRole) => r.role_id)
    : [];

  // Fallback: if no roles array, use legacy single role field
  if (apiRoles.length === 0) {
    const roleRecord = member?.role || null;
    if (roleRecord) {
      apiRoles.push({
        role_id: String(roleRecord.id ?? roleRecord.role_id ?? member?.role_id ?? ''),
        role_name: String(roleRecord.name ?? roleRecord.role_name ?? member?.role_name ?? 'staff'),
        role_display_name: String(
          roleRecord.displayName ??
            roleRecord.display_name ??
            member?.role_display_name ??
            'Staff',
        ),
        role_color: String(roleRecord.color ?? roleRecord.role_color ?? member?.role_color ?? '#6B7280'),
        is_primary: true,
      });
    }
  }

  const primaryRole = apiRoles.find((r) => r.is_primary) || apiRoles[0];

  return {
    id: String(member?.id ?? '').trim(),
    name:
      String(member?.name ?? '').trim() ||
      `${member?.firstName ?? member?.first_name ?? ''} ${member?.lastName ?? member?.last_name ?? ''}`.trim() ||
      'Staff',
    first_name: String(member?.firstName ?? member?.first_name ?? ''),
    last_name: String(member?.lastName ?? member?.last_name ?? ''),
    email: String(member?.email ?? ''),
    role_id: primaryRole?.role_id ?? '',
    role_name: primaryRole?.role_name ?? 'staff',
    role_display_name: primaryRole?.role_display_name ?? 'Staff',
    roles: apiRoles,
    can_login_pos: parseBoolean(member?.can_login_pos ?? member?.canLoginPos ?? member?.canLoginPOS, true),
    is_active: parseBoolean(member?.is_active ?? member?.isActive, true),
    has_pin:
      typeof member?.has_pin === 'boolean'
        ? member.has_pin
        : typeof member?.hasPin === 'boolean'
          ? member.hasPin
          : undefined,
    hourly_rate: member?.hourly_rate,
  };
}

// Exiting shells may collapse, but their old controls/messages leave immediately.
// This preserves the existing condition's lifecycle and keeps outgoing panes out of touch/AT queries.
function ShiftRevealContent({ children }: { children: React.ReactNode }) {
  return useIsPresent() ? children : null;
}

interface ShiftNetCollections {
  version: 1;
  total: number;
  totalCents: number;
  received: number;
  receivedCents: number;
  refunded: number;
  refundedCents: number;
  tips: number;
  tipsCents: number;
  paymentCount: number;
  refundCount: number;
  tenders: Array<{
    tender: 'cash' | 'card' | 'twint' | 'other';
    received: number;
    receivedCents: number;
    refunded: number;
    refundedCents: number;
    kept: number;
    keptCents: number;
  }>;
}

export function StaffShiftModal({ isOpen, onClose, mode, hideCashDrawer = false, isMobileWaiter = false }: StaffShiftModalProps) {
  const bridge = getBridge();
  const { t } = useTranslation();
  const { staff, activeShift, refreshActiveShift, setStaff, setActiveShiftImmediate } = useShift();
  const keyboardDialogId = React.useId();
  const isOwnTopmostDialog = () => {
    const ownDialog = document.getElementById(keyboardDialogId);
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"]')).filter(dialog =>
      !dialog.closest('[inert]') && !dialog.closest('[aria-hidden="true"]'));
    return !!ownDialog && dialogs[dialogs.length - 1] === ownDialog;
  };

  // Turn an unknown role slug (e.g. "housekeeping_supervisor") into a readable
  // label ("Housekeeping Supervisor") so raw snake_case codes never reach the UI,
  // while preserving already-readable custom role names.
  const humanizeRoleSlug = (roleName: string): string => {
    const trimmed = roleName.trim();
    if (!/[_-]/.test(trimmed)) {
      return trimmed;
    }

    return trimmed
      .trim()
      .split(/[_\s-]+/)
      .filter(Boolean)
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
      .join(' ');
  };

  // Helper function to translate role names. Known role slugs resolve from
  // `common.roleNames.*`; unknown/custom roles fall back to a humanized label
  // instead of leaking the raw code.
  const translateRoleName = (roleName: string): string => {
    const normalized = (roleName || 'staff').trim() || 'staff';
    const key = `common.roleNames.${normalized.toLowerCase()}`;
    const translated = t(key);
    if (translated && translated !== key) {
      return translated;
    }
    return humanizeRoleSlug(normalized);
  };

  const getRolePresentation = (roleName?: string | null): RolePresentation => {
    const normalized = normalizeShiftRole(roleName);
    return normalized ? ROLE_PRESENTATIONS[normalized] : FALLBACK_ROLE_PRESENTATION;
  };

  const getStaffRoles = (member?: StaffMember | null): StaffRole[] => {
    if (!member) {
      return [];
    }

    if (member.roles?.length) {
      return [...member.roles].sort(
        (a, b) => Number(Boolean(b.is_primary)) - Number(Boolean(a.is_primary)),
      );
    }

    return [
      {
        role_id: member.role_id || member.role_name || 'role',
        role_name: member.role_name || 'staff',
        role_display_name: member.role_display_name || member.role_name || 'Staff',
        role_color: '#6B7280',
        is_primary: true,
      },
    ];
  };

  const getCheckInRoleHelper = (roleName: string): string => {
    switch (normalizeShiftRole(roleName)) {
      case 'cashier':
        return t('modals.staffShift.cashierRoleHelper');
      case 'driver':
        return t('modals.staffShift.driverRoleHelper');
      case 'server':
        return t('modals.staffShift.serverRoleHelper');
      case 'kitchen':
        return t('modals.staffShift.kitchenRoleHelper');
      case 'manager':
        return t('modals.staffShift.managerRoleHelper');
      default:
        return t('modals.staffShift.roleStepLabel', 'Role');
    }
  };

  const isNonFinancialShiftRole = (role?: string | null): role is StaffShiftRole =>
    (role || '').trim().toLowerCase() === 'kitchen';

  const { getSetting } = useTerminalSettings();

  // Check-in multi-step state
  const [checkInStep, setCheckInStep] = useState<CheckInStep>('select-staff');
  const [availableStaff, setAvailableStaff] = useState<StaffMember[]>([]);
  const [selectedStaff, setSelectedStaff] = useState<StaffMember | null>(null);
  const [enteredPin, setEnteredPin] = useState('');
  const [staffQrCode, setStaffQrCode] = useState('');
  const [resolvingStaffQr, setResolvingStaffQr] = useState(false);
  const [hasActiveErganiPlugin, setHasActiveErganiPlugin] = useState(false);
  const [roleType, setRoleType] = useState<StaffShiftRole>('cashier');
  const [staffAuthMetadataStatus, setStaffAuthMetadataStatus] = useState<'available' | 'missing'>('available');
  const [financialEntry, setFinancialEntry] = useState<{
    status: 'checking' | 'ordinary' | 'ready' | 'blocked';
    scope?: FinancialOpeningScope;
    currency?: string;
    original?: ShiftFinancialOpeningView;
    /** Ω7: an ordinary drawer where gift cards need the hosted opening; the server reviews it. */
    ordinaryOpeningOffline?: boolean;
  }>({ status: 'checking' });
  const financialAttempts = useRef(new Map<string, {
    openingKey: string; openingCents: number; currency: string; issuanceRefused?: boolean;
  }>());
  const financialBusy = useRef(false);
  const financialTouched = useRef(false);
  const financialCompleted = useRef(false);
  const financialClear = useRef<Promise<boolean>>(Promise.resolve(true));
  // The person whose PIN this till checked itself because the server could not
  // be reached (native `source: 'offline'`): any role opens (founder,
  // 15/10/2026), and a gift-card store's cashier opens an ordinary drawer the
  // server reviews (founder, 21/10/2026, Ω7).
  const offlineCheckInStaffId = useRef<string | null>(null);
  const checkInGeneration = useRef(0);
  const checkInMounted = useRef(true);
  const getCheckInIdentity = () => {
    const credentials = getCachedTerminalCredentials();
    return JSON.stringify([isOpen, mode, checkInStep, selectedStaff?.id, roleType,
      staff?.staffId, staff?.organizationId, staff?.branchId, staff?.terminalId,
      getSetting('terminal', 'organization_id'), getSetting('terminal', 'branch_id'),
      getSetting('terminal', 'terminal_id'), credentials.organizationId,
      credentials.branchId, credentials.terminalId]);
  };
  const currentCheckInIdentity = useRef(getCheckInIdentity);
  currentCheckInIdentity.current = getCheckInIdentity;
  const renderedCheckInIdentity = getCheckInIdentity();
  const previousCheckInIdentity = useRef(renderedCheckInIdentity);
  if (previousCheckInIdentity.current !== renderedCheckInIdentity) {
    previousCheckInIdentity.current = renderedCheckInIdentity;
    checkInGeneration.current += 1;
  }
  const captureCheckInGuard = () => {
    const generation = checkInGeneration.current;
    const identity = currentCheckInIdentity.current();
    return () => checkInMounted.current && isOpen &&
      generation === checkInGeneration.current && identity === currentCheckInIdentity.current();
  };
  const clearFinancialAuthorization = () => {
    checkInGeneration.current += 1;
    financialBusy.current = false;
    if (financialTouched.current && !financialCompleted.current) {
      financialTouched.current = false;
      financialClear.current = financialOpening.clearAuthorization().then(() => true, () => false);
    }
  };
  useEffect(() => {
    checkInMounted.current = true;
    financialCompleted.current = false;
    return () => {
      checkInMounted.current = false;
      clearFinancialAuthorization();
    };
  }, [isOpen, mode]);

  // The native discovery survives remount/restart. The small in-memory map only
  // keeps a possibly-sent key when an IPC reply itself was lost.
  useEffect(() => {
    // A replaced modal identity invalidates the old operation immediately;
    // release only its UI lock and revoke its dedicated native authorization.
    if (financialBusy.current) {
      clearFinancialAuthorization();
      setLoading(false);
      setEnteredPin('');
    }
    if (!isOpen || mode !== 'checkin' || checkInStep !== 'enter-cash' || roleType !== 'cashier' || !selectedStaff) return;
    const current = captureCheckInGuard();
    setFinancialEntry({ status: 'checking' });
    let cancelled = false;
    const valid = () => !cancelled && current();
    void (async () => {
      try {
        const [organizationId, branchId, terminalId] = await Promise.all([
          bridge.terminalConfig.getOrganizationId(), bridge.terminalConfig.getBranchId(), bridge.terminalConfig.getTerminalId(),
        ]);
        if (!valid()) return;
        if (!normalizeContextId(organizationId) || !normalizeContextId(branchId) || !normalizeContextId(terminalId)) throw new Error('scope');
        const scope: FinancialOpeningScope = { organizationId, branchId, terminalId, staffId: selectedStaff.id };
        const remembered = financialAttempts.current.get(JSON.stringify(scope));
        const result = await financialOpening.status(remembered?.openingKey);
        if (!valid()) return;
        const original = result.openings.find((entry) => openingMatchesScope(entry, scope) &&
          (!remembered || entry.openingKey === remembered.openingKey));
        if (original || remembered) {
          financialTouched.current = true;
          const frozen = original ?? remembered!;
          financialAttempts.current.set(JSON.stringify(scope), {
            openingKey: frozen.openingKey, openingCents: frozen.openingCents, currency: frozen.currency,
            ...(!original && remembered?.issuanceRefused ? { issuanceRefused: true } : {}),
          });
          setOpeningCash(`${Math.floor(frozen.openingCents / 100)},${String(frozen.openingCents % 100).padStart(2, '0')}`);
          setFinancialEntry({ status: 'ready', scope, currency: frozen.currency, original });
          return;
        }
        // A gift-card store's cashier opening is the hosted original opening,
        // which needs the server. Without it (a PIN this till checked, or a
        // gift-card status that can no longer be read) the cashier opens an
        // ordinary drawer, flagged `ordinary_opening_offline` for the
        // server's review (founder, 21/10/2026, Ω7; Android parity:
        // requiresOriginalFinancialOpening). Gift-card sales stay online-only.
        const giftCardsStore = await cachedGiftCardsStore(bridge);
        if (!valid()) return;
        const openOrdinaryForReview = () => setFinancialEntry({ status: 'ordinary', scope, ordinaryOpeningOffline: true });
        if (giftCardsStore && offlineCheckInStaffId.current === selectedStaff.id) {
          openOrdinaryForReview();
          return;
        }
        const capability = await new GiftCardsApiService(bridge).getStatus();
        if (!valid()) return;
        if (!capability.ok && giftCardsStore) {
          openOrdinaryForReview();
          return;
        }
        const optedIn = capability.ok && capability.data.enabled && capability.data.moduleEnabled &&
          capability.data.terminalEnabled && capability.data.configured && !capability.data.unavailable;
        if (!optedIn) {
          setFinancialEntry({ status: 'ordinary', scope });
          return;
        }
        const currency = capability.data.currency;
        if (!currency || !/^[A-Z]{3}$/.test(currency)) throw new Error('currency');
        setFinancialEntry({ status: 'ready', scope, currency });
      } catch {
        if (valid()) {
          setFinancialEntry({ status: 'blocked' });
          setError(t('modals.staffShift.financialOpeningUnavailable'));
        }
      }
    })();
    return () => { cancelled = true; };
  }, [renderedCheckInIdentity]);

  // Cross-terminal busy-state — populated by `bridge.staffAuth.refreshDirectory()`.
  // Keys are staff ids that are checked in on a DIFFERENT terminal than this one;
  // the value is the resolved terminal name + role for the subtitle on the
  // grayed-out card. Busy entries are not clickable on the check-in list. The
  // server-side unique partial index is still the ultimate guarantee — this map
  // exists to pre-empt the bad UX of "user types PIN, then sees rejection".
  const [busyElsewhereByStaffId, setBusyElsewhereByStaffId] = useState<
    Map<string, { terminalName: string; role: string }>
  >(new Map());

  // PIN Input reference for focus management
  const pinInputRef = useRef<HTMLInputElement>(null);

  // Force focus on PIN input when entering the step
  useEffect(() => {
    if (checkInStep === 'enter-pin' && pinInputRef.current) {
      // Small timeout to ensure render is complete and animation has started
      setTimeout(() => {
        pinInputRef.current?.focus();
      }, 100);
    }
  }, [checkInStep]);
  const [openingCash, setOpeningCash] = useState(''); // For cashiers: drawer count
  const [driverStartingAmount, setDriverStartingAmount] = useState(''); // For drivers: amount taken from cashier
  const [activeCashierExists, setActiveCashierExists] = useState<boolean>(true); // Default to true, updated on driver role select
  const [checkInEligibility, setCheckInEligibility] = useState<ShiftCheckInEligibility | null>(null);
  const [showZeroCashConfirm, setShowZeroCashConfirm] = useState(false); // Confirmation dialog for cashier zero opening cash

  // Check-out state
  const [closingCash, setClosingCash] = useState('');
  const [driverActualCash, setDriverActualCash] = useState('');
  const [staffPayment, setStaffPayment] = useState('');
  const [isPrintCheckoutLoading, setIsPrintCheckoutLoading] = useState(false);


  // Track active shifts per staff
  const [staffActiveShifts, setStaffActiveShifts] = useState<Map<string, any>>(new Map());
  const staffLoadGeneration = useRef(0);
  const staffLoadEnabled = useRef(false);
  // Unit oversight (founder 27/08): shifts running on THIS register's satellite
  // terminals (waiter phones) — shown among the checked-in staff with their
  // terminal and live totals. Closing them from here lands with the
  // remote-checkout flow; until then tapping explains where the shift runs.
  const [satelliteShiftsByStaffId, setSatelliteShiftsByStaffId] = useState<Map<string, any>>(new Map());
  // Phone shifts of this Main's unit (founder 13/10/2026: phones always hand
  // over to the Main). `null` until the server answers; `unsupported` (an old
  // server, or a till that is not a Main) keeps the legacy list and gate.
  const [unitReadiness, setUnitReadiness] = useState<UnitReadinessResult | null>(null);
  // The last good readiness read (coordinator review 14/10/2026): kept when a
  // later read fails, else the one this terminal remembers, so an offline
  // open or Refresh never replaces it with "unavailable".
  const [unitReadinessLastGood, setUnitReadinessLastGood] = useState<RememberedUnitReadiness | null>(null);
  // Phone tills whose only local claim a manager released: a manager settles
  // them, so they never hold the cashier's close and are not received here.
  const [releasedPhoneTillIds, setReleasedPhoneTillIds] = useState<ReadonlySet<string>>(() => new Set());
  const [pendingWaiterReturns, setPendingWaiterReturns] = useState<PendingWaiterReturn[]>([]);
  const [waiterReturnsError, setWaiterReturnsError] = useState(false);
  const waiterReturnsRequired = useRef<boolean | null>(null);
  const [waiterReturnsReload, setWaiterReturnsReload] = useState(0);
  // Satellite remote checkout (v1.4.84): pane state, server preview, entry.
  const [satelliteCheckout, setSatelliteCheckout] = useState<{
    shift: any;
    staff: StaffMember;
  } | null>(null);
  const [satellitePreview, setSatellitePreview] = useState<{
    loading: boolean;
    error: string | null;
    figures: {
      currency?: string | null;
      netCollections?: ShiftNetCollections;
      total_orders_count: number;
      total_sales_amount: number;
      total_cash_sales: number;
      total_card_sales: number;
      opening_cash_amount: number;
      expected_cash_amount: number;
    } | null;
    /**
     * A closed till's own recorded count (founder decision 15/10/2026: the
     * Main receives exactly that count, so it is shown, not typed); `null`
     * for an open shift, whose cash the cashier counts here.
     */
    recordedCount?: number | null;
  }>({ loading: false, error: null, figures: null });
  const [satelliteCountedCash, setSatelliteCountedCash] = useState('');
  const [satelliteSubmitting, setSatelliteSubmitting] = useState(false);
  const [satellitePending, setSatellitePending] = useState(false);
  // The open phone shift's preview or close was refused for good (not
  // REMOTE_HANDOVER_RETRY): the pane offers "Close without handover".
  const [satelliteRefusedForGood, setSatelliteRefusedForGood] = useState(false);
  const [satelliteResult, setSatelliteResult] = useState<{
    counted: number;
    expected: number;
    variance: number;
    staffName: string;
    currency: string;
  } | null>(null);
  // The cashier shift whose close a refused satellite handover holds: a
  // manager can release it there (fix review 06/10/2026).
  const [satelliteReleaseShiftId, setSatelliteReleaseShiftId] = useState<string | null>(null);

  const [checkoutPaymentBlockers, setCheckoutPaymentBlockers] = useState<
    UnsettledPaymentBlocker[]
  >([]);
  const [resolvingCheckoutBlockerKey, setResolvingCheckoutBlockerKey] = useState<string | null>(
    null,
  );

  // Expense state
  const [showExpenseForm, setShowExpenseForm] = useState(false);
  const [expenseType, setExpenseType] = useState<'supplies' | 'maintenance' | 'petty_cash' | 'refund' | 'other'>('supplies');
  const [expenseAmount, setExpenseAmount] = useState('');
  const [expenseDescription, setExpenseDescription] = useState('');
  const [expenseReceipt, setExpenseReceipt] = useState('');
  const [canUseExpenseReceiptReference, setCanUseExpenseReceiptReference] = useState(false);
  const [expenses, setExpenses] = useState<ShiftExpense[]>([]);
  const [deletingExpenseId, setDeletingExpenseId] = useState<string | null>(null);

  // Staff payment recording state (for cashiers)
  const [staffPaymentsList, setStaffPaymentsList] = useState<StaffPayment[]>([]);
  const [showStaffPaymentForm, setShowStaffPaymentForm] = useState(false);
  const [editingStaffPaymentId, setEditingStaffPaymentId] = useState<string | null>(null);
  const [deletingStaffPaymentId, setDeletingStaffPaymentId] = useState<string | null>(null);
  const [selectedStaffForPayment, setSelectedStaffForPayment] = useState<{ id: string; name: string; role: string } | null>(null);
  const [paymentAmount, setPaymentAmount] = useState('');
  const [paymentType, setPaymentType] = useState('wage');
  const [paymentNotes, setPaymentNotes] = useState('');
  const editingStaffPayment = staffPaymentsList.find((payment) => payment.id === editingStaffPaymentId) ?? null;

  // Enhanced payment state
  const [paymentHistory, setPaymentHistory] = useState<any[]>([]);
  const [dailyPaymentTotal, setDailyPaymentTotal] = useState(0);
  const [expectedPayment, setExpectedPayment] = useState<number | null>(null);
  const [showPaymentConfirm, setShowPaymentConfirm] = useState(false);
  const expenseFormRef = useRef<HTMLDivElement | null>(null);
  const staffPaymentFormRef = useRef<HTMLDivElement | null>(null);

  // Keyboard shortcuts for large payment confirmation
  useEffect(() => {
    if (isOpen && showPaymentConfirm) {
      const handleKeyDown = (e: KeyboardEvent) => {
        if (!isOwnTopmostDialog()) return;
        if (e.key === 'Escape') {
          handleCancelLargePayment();
          e.stopPropagation();
        }
        if (e.key === 'Enter') {
          handleConfirmLargePayment();
          e.stopPropagation();
        }
      };
      window.addEventListener('keydown', handleKeyDown, true); // Capture phase to prevent other handlers
      return () => window.removeEventListener('keydown', handleKeyDown, true);
    }
  }, [isOpen, showPaymentConfirm, keyboardDialogId]);

  // Bring opened inline closeout forms into view so they are immediately usable
  // above the sticky footer instead of opening hidden beneath it.
  useEffect(() => {
    if (showExpenseForm) {
      expenseFormRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [showExpenseForm]);

  useEffect(() => {
    if (showStaffPaymentForm) {
      staffPaymentFormRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [showStaffPaymentForm]);

  useEffect(() => {
    if (!isOpen) return;

    let cancelled = false;

    const refreshFiscalEntitlement = async () => {
      const hasFiscalEntitlement = await loadFiscalOrderReportingEntitlement().catch(() => false);
      if (cancelled) {
        return;
      }

      setCanUseExpenseReceiptReference(hasFiscalEntitlement);
      if (!hasFiscalEntitlement) {
        setExpenseReceipt('');
      }
    };

    setCanUseExpenseReceiptReference(false);
    void refreshFiscalEntitlement();

    return () => {
      cancelled = true;
    };
  }, [isOpen]);

  const [pendingPaymentAmount, setPendingPaymentAmount] = useState(0);
  const LARGE_PAYMENT_THRESHOLD = 200;

  // Confirm Dialog State
  const [confirmDialog, setConfirmDialog] = useState<{
    isOpen: boolean;
    title: string;
    message: string;
    variant: ConfirmVariant;
    onConfirm: () => void;
    confirmText?: string;
    cancelText?: string;
    requireCheckbox?: string;
    typeToConfirm?: string;
  }>({
    isOpen: false,
    title: '',
    message: '',
    variant: 'info',
    onConfirm: () => { },
  });

  const openConfirm = (config: Partial<typeof confirmDialog> & { onConfirm: () => void, title: string, message: string }) => {
    setConfirmDialog(prev => ({ ...prev, isOpen: true, variant: 'info', ...config }));
  };

  const closeConfirm = () => setConfirmDialog(prev => ({ ...prev, isOpen: false }));

  const getEffectiveOpeningAmount = (shift: any, summary?: any) =>
    Number(shift?.opening_cash_amount ?? summary?.shift?.opening_cash_amount ?? 0);

  const parseOptionalAmount = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) {
      return 0;
    }

    return parseMoneyInputValue(trimmed);
  };

  const hasManualCashInput = (value: string) => value.trim().length > 0;

  const getCurrentCashierIssuedFloat = (summary: any) => {
    const recordedGiven = Number(summary?.cashDrawer?.driver_cash_given || 0);
    if (summary?.cashDrawer?.driver_cash_given != null) return recordedGiven;

    const checkoutRows = Array.isArray(summary?.driverDeliveries) ? summary.driverDeliveries : [];
    const inheritedDrivers = Array.isArray(summary?.transferredDrivers) ? summary.transferredDrivers : [];
    const inheritedWaiters = Array.isArray(summary?.transferredWaiters) ? summary.transferredWaiters : [];

    const allStartingAmounts = checkoutRows.reduce(
      (sum: number, row: any) => sum + Number(row?.starting_amount || 0),
      0
    );
    const inheritedStartingAmounts =
      inheritedDrivers.reduce((sum: number, row: any) => sum + Number(row?.starting_amount || 0), 0) +
      inheritedWaiters.reduce((sum: number, row: any) => sum + Number(row?.starting_amount || 0), 0);

    return Math.max(0, allStartingAmounts - inheritedStartingAmounts);
  };

  const getCashierExpectedBreakdown = (
    summary: any,
    shift: any,
    opening: number,
    expensesTotal?: number,
  ) => {
    const calculationVersion = Number(shift?.calculation_version ?? 1);
    const sales = Number(summary?.cashierCash?.cashCollections ?? summary?.breakdown?.instore?.cashTotal ?? 0);
    const cashRefunds = Number(summary?.cashierCash?.cashRefunds ?? summary?.cashRefunds ?? 0);
    const expenses = expensesTotal ?? Number(summary?.totalExpenses || 0);
    const cashDrops = Number(summary?.cashDrawer?.cash_drops || 0);
    const driverGiven = getCurrentCashierIssuedFloat(summary);
    const driverReturned = Number(summary?.cashDrawer?.driver_cash_returned || 0);
    // An inherited wallet credits the drawer only when its return is recorded.
    const inheritedDriverExpectedReturns = 0;
    const staffPayments = Array.isArray(summary?.staffPayments) ? summary.staffPayments : [];
    const recordedStaffPayments = staffPayments.length > 0
      ? staffPayments.reduce((sum: number, payment: any) => sum + Number(payment?.amount || 0), 0)
      : Number(summary?.cashDrawer?.total_staff_payments || 0);
    const deductedStaffPayments = recordedStaffPayments;
    const expected = fromCents(
      toCents(opening) + toCents(sales) - toCents(cashRefunds) - toCents(expenses) -
      toCents(deductedStaffPayments) - toCents(cashDrops) - toCents(driverGiven) + toCents(driverReturned),
    );

    return {
      calculationVersion,
      opening,
      sales,
      cashRefunds,
      expenses,
      cashDrops,
      driverGiven,
      driverReturned,
      inheritedDriverExpectedReturns,
      recordedStaffPayments,
      deductedStaffPayments,
      expected,
    };
  };

  const getShiftHeaderMetrics = (summary: any, shift: any) => {
    const collectionsAmount = summary?.netCollections ? Number(summary.netCollections.totalCents) / 100 : undefined;
    const fallback = {
      totalAmount: Number(collectionsAmount ?? summary?.breakdown?.overall?.totalAmount ?? shift?.total_sales_amount ?? 0),
      totalCount: Number(summary?.breakdown?.overall?.totalCount ?? shift?.total_orders_count ?? 0),
    };

    if (!shift) {
      return fallback;
    }

    if (shift.role_type === 'driver') {
      const deliveries = Array.isArray(summary?.driverDeliveries) ? summary.driverDeliveries : [];
      const completedDeliveries = deliveries.filter((delivery: any) => {
        const status = String(delivery?.status || delivery?.order_status || '').toLowerCase();
        return status !== 'cancelled' && status !== 'canceled' && status !== 'refunded';
      });

      return {
        totalAmount: Number(collectionsAmount ?? completedDeliveries.reduce((sum: number, delivery: any) => sum + Number(delivery?.total_amount || 0), 0)),
        totalCount: completedDeliveries.length,
      };
    }

    if (shift.role_type === 'server') {
      const tables = Array.isArray(summary?.waiterTables) ? summary.waiterTables : [];
      return {
        totalAmount: Number(collectionsAmount ?? tables.reduce((sum: number, table: any) => sum + Number(table?.total_amount || 0), 0)),
        totalCount: tables.reduce((sum: number, table: any) => sum + Number(table?.order_count || 0), 0),
      };
    }

    return fallback;
  };

  // UI state
  const [loading, setLoading] = useState(false);
  // Local override to switch to checkout when selecting a staff with active shift
  const [localMode, setLocalMode] = useState<'checkin' | 'checkout' | null>(null);
  const [checkoutShift, setCheckoutShift] = useState<any | null>(null);
  const effectiveMode = (localMode ?? mode);
  const effectiveShift = (checkoutShift ?? activeShift);
  const workCard = useWorkCardStatus(isOpen, [
    ...availableStaff.map(member => member.id),
    ...(unitReadiness?.kind === 'ready'
      ? unitReadiness.readiness.openShifts.flatMap(shift => shift.staff_id ? [shift.staff_id] : [])
      : []),
    ...(effectiveShift?.staff_id ? [effectiveShift.staff_id] : []),
  ]);
  const isNonFinancialCheckoutRole = isNonFinancialShiftRole(effectiveShift?.role_type);
  const isCashierCheckoutRole = effectiveShift?.role_type === 'cashier' || effectiveShift?.role_type === 'manager';
  const canRecordInlineExpenses =
    effectiveShift?.role_type === 'cashier' || effectiveShift?.role_type === 'manager';
  const isDriverRole = effectiveShift?.role_type === 'driver';
  // (`isCheckoutAmountMissing` and the zero-expected-return short-circuit live
  // further below, after `shiftSummary` is initialized — see the matching block
  // declared right after the `shiftSummary` useState.)
  const prefersReducedMotion = useReducedMotion();
  // Founder 11/11/2026: reveal only blocks the existing conditions already show.
  // Overflow returns to visible at rest, so fields and focus rings are never clipped.
  const revealMotion = {
    initial: prefersReducedMotion ? false as const : { opacity: 0, height: 0, y: 12, overflow: 'hidden' },
    animate: { opacity: 1, height: 'auto', y: 0, overflow: 'visible' },
    exit: prefersReducedMotion ? { opacity: 0 } : { opacity: 0, height: 0, overflow: 'hidden', transition: { overflow: { delay: 0, duration: 0 } } },
    transition: { duration: prefersReducedMotion ? 0 : 0.24, ease: [0.2, 0.8, 0.2, 1] as const, overflow: { delay: prefersReducedMotion ? 0 : 0.24, duration: 0 } },
  };

  const [contentDirection, setContentDirection] = useState<MotionDirection>(1);
  const isModalCloseBlocked = (loading && !financialBusy.current) || showPaymentConfirm || confirmDialog.isOpen;
  const handleModalClose = () => {
    if (isModalCloseBlocked) {
      return;
    }
    giftEpoch.current += 1;
    clearFinancialAuthorization();
    setEnteredPin('');
    onClose();
  };

  // Progress Steps
  const progressSteps: Step[] = [
    {
      id: 'staff',
      label: t('common.actions.select'),
      status: (checkInStep === 'select-staff' ? 'active' : selectedStaff ? 'complete' : 'pending') as StepStatus
    },
    {
      id: 'pin',
      label: 'PIN',
      status: (checkInStep === 'enter-pin' ? 'active' : (selectedStaff && checkInStep !== 'select-staff') ? 'complete' : 'pending') as StepStatus
    },
    // Optional role step
    ...(checkInStep === 'select-role' || (selectedStaff && checkInStep === 'enter-cash' && effectiveMode === 'checkin')
      ? [{
        id: 'role',
        label: t('modals.staffShift.roleStepLabel', 'Role'),
        status: (checkInStep === 'select-role' ? 'active' : 'complete') as StepStatus
      }]
      : []),
    {
      id: 'action',
      label: effectiveMode === 'checkin' ? t('modals.staffShift.checkIn') : t('modals.staffShift.checkOut'),
      status: (checkInStep === 'enter-cash' || effectiveMode === 'checkout' ? 'active' : 'pending') as StepStatus
    }
  ];



  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [showDetailedView, setShowDetailedView] = useState(false);
  const [showOrderDetailsTable, setShowOrderDetailsTable] = useState(true);

  // Checkout UI state
  const [showTableDetailsTable, setShowTableDetailsTable] = useState(false);
  const [showDetailedTableView, setShowDetailedTableView] = useState(false);
  const sortedAvailableStaff = React.useMemo(() => {
    return [...availableStaff].sort((a, b) => {
      const aName = (a?.name || `${a?.first_name ?? ''} ${a?.last_name ?? ''}` || 'Staff').trim();
      const bName = (b?.name || `${b?.first_name ?? ''} ${b?.last_name ?? ''}` || 'Staff').trim();
      return aName.localeCompare(bName);
    });
  }, [availableStaff]);
  const activeCheckInStaff = React.useMemo(
    () =>
      sortedAvailableStaff.filter(
        (member) => staffActiveShifts.has(member.id) || satelliteShiftsByStaffId.has(member.id),
      ),
    [sortedAvailableStaff, staffActiveShifts, satelliteShiftsByStaffId],
  );
  const readyCheckInStaff = React.useMemo(
    () =>
      sortedAvailableStaff.filter(
        (member) => !staffActiveShifts.has(member.id) && !satelliteShiftsByStaffId.has(member.id),
      ),
    [sortedAvailableStaff, staffActiveShifts, satelliteShiftsByStaffId],
  );
  const selectedStaffRoles = React.useMemo(() => getStaffRoles(selectedStaff), [selectedStaff]);
  const selectedPrimaryRole = selectedStaffRoles[0];
  const cashierFirstGateActive = Boolean(checkInEligibility?.requiresCashierFirst);
  const selectedStaffHasCashierRole = React.useMemo(
    () =>
      selectedStaffRoles.some(
        (role) => (role.role_name || '').trim().toLowerCase() === 'cashier',
      ),
    [selectedStaffRoles],
  );
  const contentPaneKey =
    effectiveMode === 'checkin'
      ? `checkin-${checkInStep}`
      : `checkout-${effectiveShift?.id ?? localMode ?? mode}`;
  const checkInPaneVariants = {
    enter: prefersReducedMotion ? { opacity: 1, height: 'auto', y: 0 } : { opacity: 0, height: 0, y: 12, overflow: 'hidden' },
    center: { ...revealMotion.animate, transition: revealMotion.transition },
    exit: { ...revealMotion.exit, transition: { ...revealMotion.transition, overflow: { delay: 0, duration: 0 } } },
  };

  const navigateCheckInStep = React.useCallback(
    (nextStep: CheckInStep) => {
      setContentDirection(
        CHECKIN_STEP_ORDER[nextStep] >= CHECKIN_STEP_ORDER[checkInStep] ? 1 : -1,
      );
      setCheckInStep(nextStep);
    },
    [checkInStep],
  );

  const getInteractiveMotion = React.useCallback(
    // Press only: the tills are touch screens, so nothing lifts on hover (UI audit wave 6).
    (_kind: 'card' | 'button' | 'primary' = 'card', disabled = false) => {
      if (disabled) {
        return {};
      }

      const whileTap = prefersReducedMotion
        ? {
            opacity: 0.96,
            transition: { duration: CHECKIN_MOTION.fast, ease: CHECKIN_MOTION_EASE },
          }
        : {
            scale: 0.985,
            transition: CHECKIN_MOTION.press,
          };

      return { whileTap };
    },
    [prefersReducedMotion],
  );

  useEffect(() => {
    if (checkInStep === 'select-role' && selectedStaff) {
      console.log('[StaffShiftModal] Reached role selection step');
      console.log('[StaffShiftModal] selectedStaff:', selectedStaff);
      console.log('[StaffShiftModal] selectedStaff.roles:', selectedStaff.roles);
      console.log('[StaffShiftModal] selectedStaff.roles.length:', selectedStaff.roles?.length);
    }
  }, [checkInStep, selectedStaff]);
  const [shiftSummary, setShiftSummary] = useState<any | null>(null);
  const checkoutDisplayCurrency = shiftSummaryCurrency(shiftSummary, effectiveShift);
  const formatCurrency = (amount: number, currency?: string | null) => formatMoney(
    amount, currency !== undefined ? currency : effectiveMode === 'checkout' ? checkoutDisplayCurrency : undefined,
  );
  const cashierDrawerCurrency = shiftSummary?.cashierCash
    ? recordedFolioCurrency(shiftSummary.cashierCash.currency) : checkoutDisplayCurrency;
  const formatDrawerCurrency = (amount: number) => formatMoney(amount, cashierDrawerCurrency);
  const cashierCheckoutExpenseTotal = React.useMemo(
    () => resolveCashierCheckoutExpenseTotal(shiftSummary, expenses, effectiveShift?.id),
    [shiftSummary, expenses, effectiveShift?.id],
  );

  // Gift-bound cashier close. Native retains one original per shift; every
  // async step here is fenced by the open/terminal epoch and its own intent.
  const giftTerminalScope = (() => {
    const credentials = getCachedTerminalCredentials();
    return JSON.stringify([getSetting('terminal', 'organization_id'), getSetting('terminal', 'branch_id'),
      getSetting('terminal', 'terminal_id'), credentials.organizationId, credentials.branchId,
      credentials.terminalId]);
  })();
  const giftActorKey = staff?.databaseStaffId || staff?.staffId || '';
  const giftOpenKey = `${isOpen ? 'open' : 'closed'}:${giftTerminalScope}:${giftActorKey}`;
  const giftEpoch = useRef(0);
  const previousGiftOpenKey = useRef(giftOpenKey);
  if (previousGiftOpenKey.current !== giftOpenKey) {
    previousGiftOpenKey.current = giftOpenKey;
    giftEpoch.current += 1;
  }
  const giftMounted = useRef(true);
  const giftDiscoveryToken = useRef(0);
  const giftCloseToken = useRef(0);
  const giftPendingToken = useRef(0);
  const giftShiftId = useRef<string | null>(null);
  giftShiftId.current = effectiveShift?.id ? String(effectiveShift.id) : null;
  const giftExpenses = useRef(expenses);
  giftExpenses.current = expenses;
  const [giftCheckout, setGiftCheckout] = useState<GiftCheckoutState>({ kind: 'idle' });
  const [giftApproval, setGiftApproval] = useState<GiftCloseApproval | null>(null);
  const [giftBusy, setGiftBusy] = useState(false);
  const [giftRecoveryTarget, setGiftRecoveryTarget] = useState<GiftCloseRecoveryTarget | null>(null);
  const [giftPending, setGiftPending] = useState<GiftClosePendingState | null>(null);
  const [giftDiscoveryNonce, setGiftDiscoveryNonce] = useState(0);
  const giftCloseOwnsCheckout = isCashierCheckoutRole &&
    (giftRecoveryTarget !== null || isGiftBoundCheckoutState(giftCheckout, effectiveShift?.id));
  const giftCloseChecking = isCashierCheckoutRole && giftCheckout.kind === 'loading' &&
    giftCheckout.shiftId === String(effectiveShift?.id ?? '');
  const giftText = (entry: GiftCloseText) =>
    String(t(entry.key, { defaultValue: entry.defaultValue, ...(entry.values ?? {}) }));
  const captureGiftGuard = () => {
    const epoch = giftEpoch.current;
    return () => giftMounted.current && epoch === giftEpoch.current;
  };
  const rediscoverGiftClose = () => setGiftDiscoveryNonce((value) => value + 1);

  // Phone-shift readiness reads (coordinator review 14/10/2026): every read is
  // remembered per terminal when good; a failed one keeps the last good read.
  const unitReadinessTerminalId = (): string | null => {
    const configured = getSetting('terminal', 'terminal_id');
    if (typeof configured === 'string' && configured.trim()) return configured.trim();
    return getCachedTerminalCredentials().terminalId.trim() || null;
  };
  const invokeBridge = (channel: string, ...args: unknown[]): Promise<unknown> =>
    bridge.invoke(channel, ...args);
  const newerReadiness = (
    held: RememberedUnitReadiness | null,
    candidate: RememberedUnitReadiness | null,
  ): RememberedUnitReadiness | null => {
    if (!held) return candidate;
    if (!candidate) return held;
    return Date.parse(candidate.checkedAt) >= Date.parse(held.checkedAt) ? candidate : held;
  };
  /** The read the Main goes by: a fresh good one, else the last good one (stale). */
  const lastGoodAfter = (
    read: { result: UnitReadinessResult; lastGood: RememberedUnitReadiness | null },
  ): RememberedUnitReadiness | null => {
    if (read.result.kind === 'ready') return read.lastGood;
    if (read.result.kind === 'unsupported') return null;
    return newerReadiness(unitReadinessLastGood, read.lastGood);
  };
  const applyUnitReadinessRead = (
    read: { result: UnitReadinessResult; lastGood: RememberedUnitReadiness | null },
  ) => {
    setUnitReadiness(read.result);
    if (read.result.kind === 'ready') {
      setUnitReadinessLastGood(read.lastGood);
    } else if (read.result.kind === 'unsupported') {
      setUnitReadinessLastGood(null);
    } else {
      setUnitReadinessLastGood(held => newerReadiness(held, read.lastGood));
    }
  };

  // A new open or terminal scope starts from nothing; a Refresh keeps what is
  // shown until its answer arrives, so a failed Refresh never blanks it.
  useEffect(() => {
    waiterReturnsRequired.current = null;
    setPendingWaiterReturns([]);
    setWaiterReturnsError(false);
    setUnitReadiness(null);
    setUnitReadinessLastGood(null);
    setReleasedPhoneTillIds(new Set());
  }, [giftOpenKey, isMobileWaiter]);

  useEffect(() => {
    if (!isOpen || isMobileWaiter) return;
    let current = true;
    // Founder 13/10/2026: the Main's phone-shift list comes from the unit
    // readiness answer; only a server without it (or a non-Main till) keeps
    // the legacy remote-checkout list.
    void Promise.all([
      readUnitShiftReadinessRemembered(bridge.shifts, unitReadinessTerminalId()),
      readReleasedPhoneTills(invokeBridge),
    ]).then(([read, released]) => {
      if (!current) return;
      setReleasedPhoneTillIds(released);
      applyUnitReadinessRead(read);
      if (read.result.kind !== 'unsupported') return;
      return readPendingWaiterReturns(bridge.shifts).then(result => {
        if (!current) return;
        waiterReturnsRequired.current = result.required;
        setPendingWaiterReturns(result.returns);
        setWaiterReturnsError(false);
      });
    }).catch(() => { if (current) setWaiterReturnsError(true); });
    return () => { current = false; };
  }, [giftOpenKey, isMobileWaiter, waiterReturnsReload]);

  useEffect(() => {
    giftMounted.current = true;
    return () => {
      giftMounted.current = false;
    };
  }, []);

  // A closed modal or a changed terminal scope retires every gift-close UI effect.
  useEffect(() => {
    setGiftCheckout({ kind: 'idle' });
    setGiftApproval(null);
    setGiftBusy(false);
    setGiftRecoveryTarget(null);
    setGiftPending(null);
  }, [giftOpenKey]);

  useEffect(() => {
    setGiftApproval(null);
  }, [closingCash]);

  // Discovers whether this cashier shift closes with gift card cash and, if so,
  // prepares the exact terms. Anything unreadable blocks; nothing becomes zero.
  useEffect(() => {
    giftDiscoveryToken.current += 1;
    const shift = effectiveShift;
    const shiftId = shift?.id ? String(shift.id) : '';
    if (!isOpen || effectiveMode !== 'checkout' || !shift || !shiftId ||
        (shift.role_type !== 'cashier' && shift.role_type !== 'manager')) {
      setGiftCheckout((current) => (current.kind === 'idle' ? current : { kind: 'idle' }));
      return;
    }
    const token = giftDiscoveryToken.current;
    const guard = captureGiftGuard();
    const valid = () => guard() && token === giftDiscoveryToken.current && giftShiftId.current === shiftId;
    setGiftApproval(null);
    setGiftCheckout((current) => ('opening' in current && current.shiftId === shiftId
      ? { kind: 'preparing', shiftId, opening: current.opening }
      : { kind: 'loading', shiftId }));

    void (async () => {
      let openings: ShiftFinancialOpeningView[] | null;
      try {
        openings = readOpeningList(await bridge.shiftFinancialOpening.status());
      } catch {
        openings = null;
      }
      if (!valid()) return;
      if (!openings) {
        setGiftCheckout({ kind: 'unknown', shiftId });
        return;
      }
      // The persisted opening decides the gift binding, not the current entitlement.
      const opening = openings.find((entry) => entry.shiftId === shiftId);
      if (!opening) {
        setGiftCheckout({ kind: 'ordinary', shiftId });
        return;
      }
      const block = (code: string, count?: number) =>
        setGiftCheckout({ kind: 'blocked', shiftId, opening, code, count });
      setGiftCheckout({ kind: 'preparing', shiftId, opening });

      // A retained original always wins over a second close.
      let pending: ReturnType<typeof readPendingList>;
      try {
        pending = readPendingList(await bridge.shiftFinancialClosing.listPending({ staffId: opening.staffId }));
      } catch {
        pending = { ok: false, code: 'LOCAL_READ_FAILED' };
      }
      if (!valid()) return;
      if (!pending.ok) return block(pending.code);
      const retained = pending.closings.find((closing) => closing.shiftId === shiftId);
      if (retained) {
        if (!retained.closingKey) return block('GIFT_CLOSING_ORIGINAL_MISSING');
        const closingKey = retained.closingKey;
        const epoch = giftEpoch.current;
        setGiftCheckout({ kind: 'retained', shiftId, opening });
        setGiftRecoveryTarget((current) => (current && current.closingKey === closingKey && current.epoch === epoch
          ? current
          : {
            epoch,
            origin: 'checkout',
            staffId: opening.staffId,
            closingKey,
            shiftId,
            roleType: String(shift.role_type),
            currency: retained.currency ?? opening.currency,
            retainedCountedCents: retained.countedCents,
            initial: retained,
            approved: null,
          }));
        return;
      }
      if (opening.state !== 'confirmed_usable' || !opening.usable) {
        return block(opening.state === 'pending' ? 'FINANCIAL_OPENING_PENDING' : 'OPENING_UNUSABLE');
      }

      let blocker: ReturnType<typeof readCloseBlocker>;
      try {
        blocker = readCloseBlocker(await bridge.giftFunding.closeBlocker({ shiftId }));
      } catch {
        blocker = { ok: false, code: 'FUNDING_BLOCKER_UNAVAILABLE' };
      }
      if (!valid()) return;
      if (!blocker.ok) return block('FUNDING_BLOCKER_UNAVAILABLE');
      if (blocker.blocked || blocker.unresolved > 0) return block('GIFT_FUNDING_UNRESOLVED', blocker.unresolved);

      let drawer: ReturnType<typeof readDrawer>;
      try {
        drawer = readDrawer(await bridge.giftFunding.refreshDrawer({ staffId: opening.staffId }));
      } catch {
        drawer = { ok: false, code: 'GIFT_CLOSING_DRAWER_UNAVAILABLE' };
      }
      if (!valid()) return;
      if (!drawer.ok) return block('GIFT_CLOSING_DRAWER_UNAVAILABLE');

      let summary: any = null;
      try {
        const result = await bridge.shifts.getSummary(shiftId, { skipBackfill: true });
        summary = result?.data || result;
      } catch {
        summary = null;
      }
      if (!valid()) return;
      if (!summary || typeof summary !== 'object' || summary.success === false) {
        return block('ORDINARY_SUMMARY_UNAVAILABLE');
      }
      const ordinaryExpectedCents = toSafeCents(getCashierExpectedBreakdown(
        summary,
        shift,
        getEffectiveOpeningAmount(shift, summary),
        resolveCashierCheckoutExpenseTotal(summary, giftExpenses.current, shiftId),
      ).expected);
      const preview = ordinaryExpectedCents === null ? null : buildGiftClosePreview({
        epoch: token,
        opening,
        drawer: drawer.drawer,
        ordinaryExpectedCents,
      });
      if (!preview) {
        return block(ordinaryExpectedCents === null ? 'ORDINARY_SUMMARY_UNAVAILABLE' : 'GIFT_CLOSING_DRAWER_MISMATCH');
      }
      setGiftCheckout({ kind: 'ready', shiftId, opening, preview });
    })();
  }, [isOpen, effectiveMode, effectiveShift?.id, effectiveShift?.role_type, giftOpenKey, giftDiscoveryNonce]);

  // Retained originals of the selected cashier stay reachable from check-in.
  const loadGiftPending = (staffId: string) => {
    giftPendingToken.current += 1;
    const token = giftPendingToken.current;
    const guard = captureGiftGuard();
    setGiftPending({ staffId, kind: 'loading' });
    void (async () => {
      let parsed: ReturnType<typeof readPendingList>;
      try {
        parsed = readPendingList(await bridge.shiftFinancialClosing.listPending({ staffId }));
      } catch {
        parsed = { ok: false, code: 'LOCAL_READ_FAILED' };
      }
      if (!guard() || token !== giftPendingToken.current) return;
      setGiftPending(parsed.ok
        ? { staffId, kind: 'ready', closings: parsed.closings, truncated: parsed.truncated }
        : { staffId, kind: 'failed', code: parsed.code });
    })();
  };

  const openGiftRecoveryFromCheckIn = (staffId: string, closing: ShiftFinancialClosingRecoveryView) => {
    if (!closing.closingKey) return;
    setEnteredPin('');
    setError('');
    setGiftRecoveryTarget({
      epoch: giftEpoch.current,
      origin: 'checkin',
      staffId,
      closingKey: closing.closingKey,
      shiftId: closing.shiftId,
      roleType: 'cashier',
      currency: closing.currency,
      retainedCountedCents: closing.countedCents,
      initial: closing,
      approved: null,
    });
  };

  // True when the gift-bound close owns this checkout intent.
  const handleGiftCheckoutIntent = (): boolean => {
    if (giftRecoveryTarget) return true;
    const shiftId = giftShiftId.current;
    if (!shiftId || !('shiftId' in giftCheckout) || giftCheckout.shiftId !== shiftId) return false;
    switch (giftCheckout.kind) {
      case 'loading':
        setError(giftText(giftCloseText('checking', 'Checking whether this shift closes with gift card cash…')));
        return true;
      case 'preparing':
        setError(giftText(giftCloseText('preparing', 'Preparing the gift card close terms…')));
        return true;
      case 'blocked':
        setError(giftText(giftCloseCodeText(giftCheckout.code, giftCheckout.count)));
        return true;
      case 'retained':
        setError(giftText(giftCloseCodeText('GIFT_CLOSING_ORIGINAL_EXISTS')));
        return true;
      case 'ready': {
        if (giftBusy) return true;
        const countedCents = parseOpeningCents(closingCash);
        if (countedCents === null) {
          setError(giftText(giftCloseText('countInvalid', 'Enter the counted cash with at most two decimals.')));
          return true;
        }
        setError('');
        setGiftApproval({ epoch: giftCheckout.preview.epoch, countedCents });
        return true;
      }
      default:
        return false;
    }
  };

  // Expected cash to return for the active role at checkout. When this is
  // effectively zero (slow/empty shift), the operator shouldn't have to type
  // "0,00" to confirm — the Complete button stays enabled and `handleCheckOut`
  // auto-confirms 0 in the validation block.
  const expectedReturnAtCheckout = ((): number => {
    if (effectiveMode !== 'checkout' || !effectiveShift || !shiftSummary) {
      return 0;
    }
    const role = effectiveShift.role_type;
    const opening = getEffectiveOpeningAmount(effectiveShift, shiftSummary);
    const expensesTotal = shiftSummary?.totalExpenses || 0;
    const calculationVersion = effectiveShift.calculation_version || 1;

    if (role === 'driver') {
      const deliveries = Array.isArray(shiftSummary?.driverDeliveries) ? shiftSummary.driverDeliveries : [];
      const completed = deliveries.filter((d: any) => {
        const status = (d?.status || d?.order_status || '').toLowerCase();
        return status !== 'cancelled' && status !== 'canceled' && status !== 'refunded';
      });
      const collected = deliveries.reduce((sum: number, d: any) => sum + Number(d?.cash_collected || 0), 0);
      const driverPayment = parseMoneyInputValue(staffPayment) || 0;
      const tipsReceived = Number(shiftSummary?.tipsReceived || shiftSummary?.tips_received || 0);
      const returnBeforeLegacyPayment = calculateDriverReturn({
        openingAmount: opening,
        cashCollected: collected,
        expenses: expensesTotal,
        tipsReceived,
      });
      return calculationVersion >= 2
        ? returnBeforeLegacyPayment
        : returnBeforeLegacyPayment - driverPayment;
    }
    if (role === 'server') {
      const tables = Array.isArray(shiftSummary?.waiterTables) ? shiftSummary.waiterTables : [];
      const collected = tables.reduce((sum: number, t: any) => sum + Number(t?.cash_amount || 0), 0);
      return opening + collected - expensesTotal;
    }
    if (role === 'cashier' || role === 'manager') {
      return getCashierExpectedBreakdown(
        shiftSummary,
        effectiveShift,
        opening,
        cashierCheckoutExpenseTotal,
      ).expected;
    }
    return 0;
  })();
  const expectedReturnIsZero = Math.abs(expectedReturnAtCheckout) < 0.005;

  const isCheckoutAmountMissing = effectiveMode === 'checkout' && !expectedReturnIsZero && (
    (isCashierCheckoutRole && !hasManualCashInput(closingCash)) ||
    (effectiveShift?.role_type === 'driver' && !hasManualCashInput(driverActualCash)) ||
    (effectiveShift?.role_type === 'server' && !hasManualCashInput(closingCash))
  );

  const canPrintCheckoutSnapshot = React.useMemo(
    () =>
      effectiveMode === 'checkout' &&
      canPrintShiftCheckoutSnapshot({
        shift: effectiveShift,
        shiftSummary,
        closingCash,
        driverActualCash,
        isNonFinancialCheckoutRole,
      }),
    [
      effectiveMode,
      effectiveShift,
      shiftSummary,
      closingCash,
      driverActualCash,
      isNonFinancialCheckoutRole,
    ],
  );


  // Load staff when modal opens in checkin mode
  useEffect(() => {
    staffLoadEnabled.current = isOpen && mode === 'checkin';
    // The cancelled session cannot clear this shared flag in its finally block.
    // Reset it here so a direct checkout open cannot inherit a cancelled load.
    setLoading(false);
    console.log('[StaffShiftModal] useEffect triggered:', { isOpen, mode });
    if (isOpen && mode === 'checkin') {
      console.log('[StaffShiftModal] Calling loadStaff()...');
      loadStaff();
      setContentDirection(1);
      setCheckInStep('select-staff');
      setSelectedStaff(null);
      offlineCheckInStaffId.current = null;
      setEnteredPin('');
      setStaffQrCode('');
      setResolvingStaffQr(false);
      setHasActiveErganiPlugin(false);
      setRoleType('cashier');
      setOpeningCash('');
      setDriverStartingAmount(''); // Reset driver starting amount
      setCheckInEligibility(null);
      setShowZeroCashConfirm(false); // Reset zero cash confirmation
      // Reset any previous checkout override/session
      setLocalMode(null);
      setCheckoutShift(null);
      // Reset any previous satellite remote-checkout pane — without this the
      // modal reopens straight onto the last-tapped satellite card.
      setSatelliteCheckout(null);
      setSatellitePreview({ loading: false, error: null, figures: null });
      setSatelliteCountedCash('');
      setSatelliteSubmitting(false);
      setSatelliteResult(null);
      setSatelliteRefusedForGood(false);
      setShowExpenseForm(false);
      setClosingCash('');
      setDriverActualCash('');
      setStaffPayment('');
      setExpenses([]);
      setShiftSummary(null);
      setError('');
      setSuccess('');
    }
    // IPC cannot be aborted once dispatched. Invalidate every continuation,
    // including the cache and directory, before closing or opening a new session.
    return () => {
      staffLoadEnabled.current = false;
      staffLoadGeneration.current += 1;
    };
  }, [isOpen, mode]);

  useEffect(() => {
    let cancelled = false;

    const fetchErganiPluginEntitlement = async () => {
      setHasActiveErganiPlugin(false);

      if (!isOpen || mode !== 'checkin') {
        setStaffQrCode('');
        setResolvingStaffQr(false);
        return;
      }

      try {
        const response = await posApiGet<{ integrations?: PosIntegrationPayload[] }>(
          `/pos/integrations?provider=${ERGANI_PLUGIN_ID}`,
        );

        if (cancelled) {
          return;
        }

        if (!response.success) {
          setHasActiveErganiPlugin(false);
          setStaffQrCode('');
          setResolvingStaffQr(false);
          return;
        }

        const integrations = response.data?.integrations || [];
        const hasEntitlement = integrations.some(isActiveErganiIntegration);
        setHasActiveErganiPlugin(hasEntitlement);

        if (!hasEntitlement) {
          setStaffQrCode('');
          setResolvingStaffQr(false);
        }
      } catch {
        if (!cancelled) {
          setHasActiveErganiPlugin(false);
          setStaffQrCode('');
          setResolvingStaffQr(false);
        }
      }
    };

    void fetchErganiPluginEntitlement();

    return () => {
      cancelled = true;
    };
  }, [isOpen, mode]);

  // Load expenses and staff payments when in checkout mode (prop or local override)
  useEffect(() => {
    if (isOpen && effectiveMode === 'checkout' && effectiveShift) {
      const shiftId = effectiveShift.id;
      setExpenses([]);
      setStaffPaymentsList([]);
      setEditingStaffPaymentId(null);
      setDeletingStaffPaymentId(null);
      setClosingCash('');
      setDriverActualCash('');
      setStaffPayment('');
      setShiftSummary(null);

      loadExpenses(shiftId);
      // Load staff payments for cashiers
      if (effectiveShift.role_type === 'cashier') {
        loadStaffPayments(shiftId);
      }
      (async () => {
        try {
          // Skip driver earnings backfill on initial load - it's not critical for display
          // Backfill will run during actual checkout if needed
          const result = await bridge.shifts.getSummary(shiftId, { skipBackfill: true });
          // shifts.getSummary returns the summary directly (with breakdown, shift, cash_drawer)
          const summary = result?.data || result;
          setShiftSummary(summary);
        } catch (e) {
          console.warn('Failed to load shift summary:', e);
          setShiftSummary(null);
        }
      })();
    } else {
      setShiftSummary(null);
      setStaffPaymentsList([]);
      setEditingStaffPaymentId(null);
      setDeletingStaffPaymentId(null);
      setExpenses([]);
    }
  }, [isOpen, effectiveMode, effectiveShift?.id, effectiveShift?.role_type]);

  // Falling-edge cleanup: release heavy per-session state as the modal CLOSES
  // instead of holding it in renderer memory until the next open resets it.
  // shiftSummary / expenses / staffPaymentsList are already cleared by the
  // checkout-load effect above when `isOpen` drops. availableStaff,
  // staffActiveShifts and busyElsewhereByStaffId are deliberately KEPT: a
  // direct checkout open (mode="checkout") never calls loadStaff(), and the
  // cashier staff-payment form (openStaffPaymentForm and its paid-to dropdown)
  // reads them from the last check-in open of this same mounted instance.
  useEffect(() => {
    if (isOpen) {
      return;
    }
    setCheckoutPaymentBlockers([]);
    // Mirrors resetStaffPaymentForm() so the payment form cannot re-open
    // half-cleared with a stale staff selection over an emptied history.
    setShowStaffPaymentForm(false);
    setEditingStaffPaymentId(null);
    setSelectedStaffForPayment(null);
    setPaymentAmount('');
    setPaymentType('wage');
    setPaymentNotes('');
    setPaymentHistory([]);
    setDailyPaymentTotal(0);
    setExpectedPayment(null);
  }, [isOpen]);

  useEffect(() => {
    if (!canRecordInlineExpenses) {
      setShowExpenseForm(false);
    }
  }, [canRecordInlineExpenses]);

  // One local snapshot serves both cached and refreshed staff lists. Keep
  // cross-terminal rows so satellite shifts retain their existing behavior.
  const loadActiveShiftsForBranch = async (branchId: string, isCurrent: () => boolean) => {
    const result = await bridge.shifts.getActiveForBranch(branchId);
    if (!isCurrent()) return;
    const shifts = Array.isArray(result) ? result : [];
    const map = new Map<string, any>();
    for (const shift of shifts) {
      // The query sorts newest first, matching the previous per-staff LIMIT 1.
      if (shift?.status === 'active' && shift.staff_id && !map.has(shift.staff_id)) {
        map.set(shift.staff_id, shift);
      }
    }
    setStaffActiveShifts(map);
  };

  const loadCachedStaffAuth = async (branchId: string): Promise<StaffMember[]> => {
    const rawValue = await bridge.settings.get({
      category: STAFF_AUTH_CACHE_CATEGORY,
      key: buildStaffAuthCacheKey(branchId),
      defaultValue: '',
    });

    if (typeof rawValue !== 'string' || !rawValue.trim()) {
      return [];
    }

    try {
      const parsed = JSON.parse(rawValue) as StaffAuthCachePayload;
      const cachedBranchId = typeof parsed.branch_id === 'string' ? parsed.branch_id.trim() : '';
      if (cachedBranchId && cachedBranchId !== branchId.trim()) {
        return [];
      }

      return (Array.isArray(parsed.staff) ? parsed.staff : [])
        .map(mapScheduledStaffToMember)
        .filter((member) => !!member.id);
    } catch (error) {
      console.warn('[StaffShiftModal] Failed to parse cached staff auth directory:', error);
      return [];
    }
  };

  const loadStaff = async () => {
    if (!staffLoadEnabled.current) return;
    const generation = ++staffLoadGeneration.current;
    const isCurrent = () => staffLoadEnabled.current && generation === staffLoadGeneration.current;
    let releasedLoading = false;
    const releaseLoading = () => {
      // A background refresh must not clear a PIN/check-in action's loading flag.
      if (isCurrent() && !releasedLoading) {
        releasedLoading = true;
        setLoading(false);
      }
    };
    setLoading(true);
    setError('');
    setStaffAuthMetadataStatus('available');
    let branchId: string | undefined;
    let cachedStaff: StaffMember[] = [];
    let activeShiftsPromise: Promise<void> | undefined;
    try {
      // Determine branch for this terminal; prefer settings hook, then IPC
      // 1) Try hook-provided settings (fast path)
      branchId = getSetting?.('terminal', 'branch_id') as string | undefined;

      // 2) Try terminal config getter for a specific setting (existing, stable handler)
      if (!branchId && isCurrent()) {
        try {
          const val = await bridge.terminalConfig.getSetting('terminal', 'branch_id');
          if (!isCurrent()) return;
          if (val) branchId = val as string;
        } catch (e) {
          console.warn('[StaffShiftModal] terminalConfig.getSetting fallback failed:', e);
        }
      }

      // 2b) Try local settings store (legacy SettingsService)
      if (!branchId && isCurrent()) {
        try {
          const local = (await bridge.settings.get()) as unknown as SettingsResult;
          if (!isCurrent()) return;
          const flat = local?.['terminal.branch_id'] ?? local?.terminal?.branch_id;
          if (flat) branchId = flat as string;
        } catch (e) {
          console.warn('[StaffShiftModal] local get-settings fallback failed:', e);
        }
      }

      // 3) Try direct branch id getter
      if (!branchId && isCurrent()) {
        try {
          const bid = await bridge.terminalConfig.getBranchId();
          if (!isCurrent()) return;
          if (bid) branchId = bid as string;
        } catch (e) {
          console.warn('[StaffShiftModal] terminalConfig.getBranchId failed (non-fatal):', e);
        }
      }

      if (!isCurrent()) return;
      // Require branch scoping: if missing, abort with clear message
      if (!branchId) {
        console.warn('[StaffShiftModal] No branchId available; aborting staff fetch');
        throw new Error('This POS is not assigned to a branch. Configure terminal → branch in Admin or POS settings.');
      }

      console.log('[loadStaff] Using branchId:', branchId);
      activeShiftsPromise = loadActiveShiftsForBranch(branchId, isCurrent).catch((e) => {
        if (isCurrent()) console.warn('[StaffShiftModal] Active shifts load failed:', e);
      });

      // Offline-first: optimistic cache read renders the staff list
      // immediately from local SQLite (sub-100ms), then the network fetch
      // below refreshes with fresh data. This is the warm-path that makes
      // the modal feel instant — the network call still runs but doesn't
      // block the initial render. The native directory refresh
      // (`staffAuth.refreshDirectory`, below) populates the cache after every
      // successful fetch, so any returning user has a hot cache.
      try {
        cachedStaff = await loadCachedStaffAuth(branchId);
        if (!isCurrent()) return;
        if (cachedStaff.length > 0) {
          console.log('[loadStaff] Optimistic render from cache:', cachedStaff.length, 'staff');
          setAvailableStaff([...cachedStaff]);
          // Show the modal as ready while the network refresh runs.
          releaseLoading();
        }
      } catch (cacheError) {
        console.warn('[StaffShiftModal] Cached staff auth load failed (non-fatal):', cacheError);
      }
      if (!isCurrent()) return;

      const today = new Date();
      const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

      // Kick off the cross-terminal directory refresh in parallel with the
      // staff schedule fetch. The two calls are independent — directory
      // returns cross-terminal "busy" state, while schedule returns who is
      // assigned to today. Awaiting them sequentially used to add ~1s of
      // unnecessary latency to the modal cold-open. We attach the catch
      // here so an early-firing rejection doesn't surface as an unhandled
      // promise rejection while the await chain is still building.
      const refreshDirectoryPromise: Promise<any> = bridge.staffAuth
        .refreshDirectory()
        .catch((directoryErr) => {
          console.warn('[StaffShiftModal] refreshDirectory failed (non-fatal):', directoryErr);
          return null;
        });

      const result = await bridge.staffSchedule.list({
        start_date: dateStr,
        end_date: dateStr,
        branch_id: branchId,
      });
      if (!isCurrent()) return;

      if (!result?.success) {
        throw new Error(result?.error || 'Failed to fetch staff schedule');
      }

      const payload = (result.data ?? {}) as {
        success?: boolean;
        staff?: any[];
        error?: string;
      };

      if (payload.success === false) {
        throw new Error(payload.error || 'Failed to fetch staff schedule');
      }

      const rawStaffList = Array.isArray(payload.staff) ? payload.staff : [];
      const authMetadataAvailable = includesStaffAuthMetadata(rawStaffList);

      let cachedStaffAuthById = new Map<string, StaffMember>();
      if (!authMetadataAvailable) {
        setStaffAuthMetadataStatus('missing');
        cachedStaffAuthById = new Map(cachedStaff.map((member) => [member.id, member]));
      }

      const normalizedStaffList: StaffMember[] = rawStaffList
        .map(mapScheduledStaffToMember)
        .map((member) => {
          if (authMetadataAvailable) {
            return member;
          }

          const cachedMember = cachedStaffAuthById.get(member.id);
          if (!cachedMember) {
            return member;
          }

          return {
            ...member,
            can_login_pos: cachedMember.can_login_pos,
            has_pin: typeof cachedMember.has_pin === 'boolean' ? cachedMember.has_pin : member.has_pin,
          };
        })
        .filter((staff) => !!staff.id);

      if (!authMetadataAvailable) {
        console.warn('[StaffShiftModal] Admin staff-schedule response is missing POS auth metadata; preserving existing local auth cache');
      }
      if (!isCurrent()) return;
      console.log('[loadStaff] Final staff list:', normalizedStaffList.map(s => ({ name: s.name, rolesCount: s.roles?.length })));

      // Create a new array reference to trigger React re-render
      setAvailableStaff([...normalizedStaffList]);

      // Reuse the already-running local snapshot; the network staff refresh
      // does not change local shifts and must not repeat the same DB work.
      await Promise.all([
        activeShiftsPromise,
        // Fetch cross-terminal busy state so the "Ready to check in" list
        // can gray out staff who are already on a shift on another terminal.
        // Non-fatal — if the endpoint is unreachable (offline, old admin
        // build without the staff-directory route) we just show the list
        // without busy markers and rely on the server-side unique index to
        // reject duplicate check-ins. The promise was started above in
        // parallel with the staff-schedule fetch.
        refreshDirectoryPromise.then((directoryResult: any) => {
          if (!isCurrent()) return;
          if (directoryResult?.success && Array.isArray(directoryResult.staff)) {
            const myTerminalId = (directoryResult.currentTerminalId ?? '').trim();
            const busy = new Map<string, { terminalName: string; role: string }>();
            const satellites = new Map<string, any>();
            for (const entry of directoryResult.staff) {
              const cs = entry?.currentShift;
              if (!cs) continue;
              const shiftTerminal = (cs.terminalId ?? '').trim();
              if (!shiftTerminal) continue;
              // If we don't know our own terminal id, be conservative and
              // treat every open shift as "elsewhere" — mirrors the Rust
              // verify path's same-sided safe default.
              if (myTerminalId && shiftTerminal === myTerminalId) continue;
              const parentOfShiftTerminal = (cs.parentTerminalId ?? '').trim();
              if (myTerminalId && parentOfShiftTerminal === myTerminalId) {
                // One of OUR satellites: checked in on this unit, not "elsewhere".
                satellites.set(entry.id, {
                  id: cs.shiftId,
                  staff_id: entry.id,
                  status: 'active',
                  role_type: (cs.role ?? '').trim(),
                  terminal_id: shiftTerminal,
                  remote_terminal_name: (cs.terminalName ?? '').trim() || shiftTerminal,
                  remote: true,
                  check_in_time: cs.checkedInAt ?? null,
                  total_orders_count: cs.totalOrdersCount ?? null,
                  total_sales_amount: cs.totalSalesAmount ?? null,
                  opening_cash_amount: cs.openingCashAmount ?? null,
                });
                continue;
              }
              busy.set(entry.id, {
                terminalName: (cs.terminalName ?? '').trim(),
                role: (cs.role ?? '').trim(),
              });
            }
            setBusyElsewhereByStaffId(busy);
            setSatelliteShiftsByStaffId(satellites);
          }
        }),
      ]);
    } catch (err) {
      if (!isCurrent()) return;
      console.error('Failed to load staff:', err);
      // A parallel directory refresh may have filled an initially empty cache.
      // Retry only on this cold/error path; warm refreshes reuse their first read.
      if (cachedStaff.length === 0 && branchId) {
        try {
          cachedStaff = await loadCachedStaffAuth(branchId);
          if (!isCurrent()) return;
          if (cachedStaff.length > 0) setAvailableStaff(cachedStaff);
        } catch (cacheError) {
          console.warn('[StaffShiftModal] Staff cache fallback failed:', cacheError);
        }
      }
      if (!isCurrent()) return;
      if (cachedStaff.length > 0) {
        // The cached list is already visible; do not reload it or its shifts.
        await activeShiftsPromise;
        return;
      }
      setError(err instanceof Error ? err.message : t('modals.staffShift.failedToLoad'));
    } finally {
      releaseLoading();
    }
  };

  const loadExpenses = async (shiftId?: string) => {
    const sid = shiftId ?? effectiveShift?.id;
    if (!sid) return;
    try {
      const result = await bridge.shifts.getExpenses(sid);
      const shiftExpenses = Array.isArray(result) ? result : [];
      setExpenses(shiftExpenses);
    } catch (err) {
      console.error('Failed to load expenses:', err);
      setExpenses([]);
    }
  };

  // Load staff payments recorded by this cashier shift
  const loadStaffPayments = async (shiftId?: string) => {
    const sid = shiftId ?? effectiveShift?.id;
    if (!sid) return;
    try {
      const payments = await bridge.shifts.getStaffPayments(sid);
      setStaffPaymentsList(payments || []);
    } catch (err) {
      console.error('Failed to load staff payments:', err);
      setStaffPaymentsList([]);
    }
  };

  const clearStaffPaymentDraft = () => {
    setEditingStaffPaymentId(null);
    setPaymentAmount('');
    setPaymentType('wage');
    setPaymentNotes('');
    setShowPaymentConfirm(false);
    setPendingPaymentAmount(0);
  };

  const refreshStaffPaymentStateAfterMutation = async (shiftId: string) => {
    await loadStaffPayments(shiftId);

    const shiftDate = effectiveShift?.check_in_time
      ? toLocalDateString(effectiveShift.check_in_time)
      : undefined;

    if (selectedStaffForPayment?.id) {
      await loadPaymentHistoryForStaff(selectedStaffForPayment.id, shiftDate);
      const activeShiftForSelected = staffActiveShifts.get(selectedStaffForPayment.id);
      const selectedStaffMeta = availableStaff.find((member) => member.id === selectedStaffForPayment.id);
      await calculateExpectedPayment(activeShiftForSelected, selectedStaffMeta?.hourly_rate);
    }

    await refreshShiftSummaryAfterExpenseMutation(shiftId);
  };

  const beginEditStaffPayment = async (payment: StaffPayment) => {
    setShowStaffPaymentForm(true);
    setEditingStaffPaymentId(payment.id);
    setPaymentAmount(Number(payment.amount || 0).toFixed(2).replace('.', ','));
    setPaymentType(payment.payment_type);
    setPaymentNotes(payment.notes || '');

    const selectedMember = availableStaff.find((member) => member.id === payment.paid_to_staff_id);
    const selectedStaffId = payment.paid_to_staff_id || selectedMember?.id;
    if (!selectedStaffId) {
      return;
    }

    const selectedName = selectedMember?.name || payment.staff_name || t('common.unknown', 'Unknown');
    const selectedRole =
      selectedMember?.roles?.[0]?.role_name ||
      selectedMember?.role_name ||
      payment.role_type ||
      'staff';

    setSelectedStaffForPayment({
      id: selectedStaffId,
      name: selectedName,
      role: selectedRole,
    });

    const shiftDate = effectiveShift?.check_in_time
      ? toLocalDateString(effectiveShift.check_in_time)
      : undefined;

    await loadPaymentHistoryForStaff(selectedStaffId, shiftDate);
    const activeShiftForSelected = staffActiveShifts.get(selectedStaffId);
    const hourlyRate = selectedMember?.hourly_rate;
    await calculateExpectedPayment(activeShiftForSelected, hourlyRate);
  };

  /**
   * Load payment history for the staff member being paid
   */
  /**
   * Load payment history for the staff member being paid.
   * Scoped to a specific date (defaults to today). 
   * @param staffId - ID of the staff member
   * @param dateStr - Date string (YYYY-MM-DD). If provided, this date is used. Otherwise defaults to today.
   */
  const loadPaymentHistoryForStaff = async (staffId: string, dateStr?: string) => {
    try {
      const targetDate = dateStr || toLocalDateString();
      const payments = await bridge.shifts.getStaffPaymentsByStaff({
        staffId,
        dateFrom: targetDate,
        dateTo: targetDate
      });
      setPaymentHistory(payments || []);

      // Calculate daily total
      const total = await bridge.shifts.getStaffPaymentTotalForDate(staffId, targetDate);
      setDailyPaymentTotal(total || 0);
    } catch (error) {
      console.error('Failed to load payment history:', error);
      setPaymentHistory([]);
      setDailyPaymentTotal(0);
    }
  };

  /**
   * Calculate expected payment based on staff hourly rate and active shift hours
   */
  /**
   * Calculate expected payment based on staff hourly rate and specified shift context.
   * Checks out time uses shift.check_out_time if available, otherwise current time.
   */
  const calculateExpectedPayment = async (shift: any, hourlyRate?: number) => {
    if (!hourlyRate || !shift) {
      setExpectedPayment(null);
      return;
    }

    try {
      if (shift && shift.check_in_time) {
        const checkInTime = new Date(shift.check_in_time);
        const checkOutTime = shift.check_out_time ? new Date(shift.check_out_time) : new Date(); // Use shift checkout or current time
        const hoursWorked = (checkOutTime.getTime() - checkInTime.getTime()) / (1000 * 60 * 60);

        const expected = hourlyRate * hoursWorked;
        setExpectedPayment(roundMoney(expected));
      } else {
        setExpectedPayment(null);
      }
    } catch (e) {
      console.warn('Failed to calculate expected payment:', e);
      setExpectedPayment(null);
    }
  };

  // Handle recording a staff payment
  // Perform the actual IPC call to record payment
  const performRecordStaffPayment = async () => {
    if (!effectiveShift || !selectedStaffForPayment) return;

    setLoading(true);
    setError('');

    try {
      const amount = parseMoneyInputValue(paymentAmount);
      const result = editingStaffPaymentId
        ? await bridge.shifts.updateStaffPayment({
            paymentId: editingStaffPaymentId,
            cashierShiftId: effectiveShift.id,
            paidToStaffId: selectedStaffForPayment.id,
            amount,
            paymentType,
            notes: paymentNotes || undefined,
          })
        : await bridge.shifts.recordStaffPayment({
            cashierShiftId: effectiveShift.id,
            paidToStaffId: selectedStaffForPayment.id,
            amount,
            paymentType,
            notes: paymentNotes || undefined,
          });

      if (result.success) {
        clearStaffPaymentDraft();
        await refreshStaffPaymentStateAfterMutation(effectiveShift.id);

        setSuccess(
          t(
            editingStaffPaymentId ? 'modals.staffShift.paymentUpdated' : 'modals.staffShift.paymentRecorded',
            editingStaffPaymentId ? 'Payment updated successfully' : 'Payment recorded successfully',
          ),
        );
        setTimeout(() => setSuccess(''), 3000);
      } else {
        setError(
          result.error ||
            t(
              editingStaffPaymentId ? 'modals.staffShift.paymentUpdateFailed' : 'modals.staffShift.paymentFailed',
              editingStaffPaymentId ? 'Failed to update payment' : 'Failed to record payment',
            ),
        );
        setShowPaymentConfirm(false); // Reset confirmation state on error
      }
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : t(
              editingStaffPaymentId ? 'modals.staffShift.paymentUpdateFailed' : 'modals.staffShift.paymentFailed',
              editingStaffPaymentId ? 'Failed to update payment' : 'Failed to record payment',
            ),
      );
      setShowPaymentConfirm(false); // Reset confirmation state on error
    } finally {
      setLoading(false);
    }
  };

  // Handle recording a staff payment - Validator and Initiator
  const handleRecordStaffPayment = async () => {
    if (!effectiveShift || !staff || !selectedStaffForPayment) {
      setError(t('modals.staffShift.noStaffSelected'));
      return;
    }

    const amount = parseMoneyInputValue(paymentAmount);
    if (amount <= 0) {
      setError(t('modals.staffShift.invalidStaffPayment'));
      return;
    }

    // Check for large payment threshold
    if (amount > LARGE_PAYMENT_THRESHOLD && !showPaymentConfirm) {
      setPendingPaymentAmount(amount);
      setShowPaymentConfirm(true);
      return;
    }

    // If we're here, either it's a small payment or confirmed check is handled elsewhere (logic refactored)
    // Actually, confirm handler calls perform, so here we just call perform if not large.
    await performRecordStaffPayment();
  };

  const handleConfirmLargePayment = () => {
    setShowPaymentConfirm(false);
    performRecordStaffPayment();
  };

  const handleCancelLargePayment = () => {
    setShowPaymentConfirm(false);
    setPendingPaymentAmount(0);
  };

  const resetStaffPaymentForm = () => {
    setShowStaffPaymentForm(false);
    setEditingStaffPaymentId(null);
    setSelectedStaffForPayment(null);
    setPaymentAmount('');
    setPaymentType('wage');
    setPaymentNotes('');
    setPaymentHistory([]);
    setDailyPaymentTotal(0);
    setExpectedPayment(null);
  };

  const openStaffPaymentForm = async () => {
    setShowStaffPaymentForm(true);
    setEditingStaffPaymentId(null);

    if (!isCashierCheckoutRole || !effectiveShift) {
      return;
    }

    const currentCashierStaffId =
      effectiveShift.staff_id ||
      staff?.databaseStaffId ||
      staff?.staffId;
    const currentCashier = availableStaff.find((member) => member.id === currentCashierStaffId);

    if (!currentCashier) {
      return;
    }

    setSelectedStaffForPayment({
      id: currentCashier.id,
      name: currentCashier.name,
      role: currentCashier.roles?.[0]?.role_name || currentCashier.role_name || effectiveShift.role_type,
    });

    const shiftDate = effectiveShift.check_in_time
      ? toLocalDateString(effectiveShift.check_in_time)
      : undefined;

    await loadPaymentHistoryForStaff(currentCashier.id, shiftDate);
    const activeShiftForSelected = staffActiveShifts.get(currentCashier.id);
    await calculateExpectedPayment(activeShiftForSelected, currentCashier.hourly_rate);
  };

  const handleDeleteStaffPayment = async (payment: StaffPayment) => {
    if (!effectiveShift) {
      return;
    }

    setDeletingStaffPaymentId(payment.id);
    setError('');

    try {
      const result = await bridge.shifts.deleteStaffPayment({
        paymentId: payment.id,
        cashierShiftId: effectiveShift.id,
      });

      if (!result.success) {
        throw new Error(
          result.error ||
            t('modals.staffShift.paymentDeleteFailed', 'Failed to delete payment'),
        );
      }

      if (editingStaffPaymentId === payment.id) {
        clearStaffPaymentDraft();
      }

      await refreshStaffPaymentStateAfterMutation(effectiveShift.id);
      setSuccess(
        t(
          'modals.staffShift.paymentDeleted',
          'Payment deleted and checkout totals recalculated',
        ),
      );
      setTimeout(() => setSuccess(''), 3000);
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : t('modals.staffShift.paymentDeleteFailed', 'Failed to delete payment');
      if (message === 'Staff payment not found') {
        if (editingStaffPaymentId === payment.id) {
          clearStaffPaymentDraft();
        }
        await refreshStaffPaymentStateAfterMutation(effectiveShift.id);
      } else {
        setError(message);
      }
    } finally {
      setDeletingStaffPaymentId(null);
      closeConfirm();
    }
  };

  const handleStaffSelect = async (staffMember: StaffMember, phoneShift?: { id: string; [key: string]: unknown }) => {
    // Retire the previous selection before any asynchronous work for the new cashier.
    giftEpoch.current += 1;
    setGiftRecoveryTarget(null);
    setGiftApproval(null);
    clearFinancialAuthorization();
    setSelectedStaff(staffMember);
    offlineCheckInStaffId.current = null;
    setEnteredPin('');
    setError('');
    setCheckInEligibility(null);

    // Satellite shift: enter the remote-checkout pane — the main register
    // reviews the server-computed figures and receives the cash (v1.4.84).
    // `phoneShift` is a till from the awaiting-receipt or phone-shift lists,
    // already shaped for the pane (founder 13/10/2026).
    const satelliteShift = phoneShift ?? satelliteShiftsByStaffId.get(staffMember.id);
    if (satelliteShift) {
      setSatelliteCheckout({ shift: satelliteShift, staff: staffMember });
      setSatelliteCountedCash('');
      setSatelliteResult(null);
      setSatellitePending(false);
      setSatelliteRefusedForGood(false);
      setSatellitePreview({ loading: true, error: null, figures: null });
      void bridge.shifts
        .remoteCheckout({ shiftId: String(satelliteShift.id), action: 'preview' })
        .then((res: any) => {
          const payload = res?.data ?? res;
          if (payload?.success && payload.figures) {
            // A closed till is received at exactly its recorded count (the
            // receipt refuses any other), its float in `figures`, whatever its
            // role or float (founder decision 15/10/2026). The till's own close
            // in the preview wins over the list's copy.
            const recordedCount = satelliteShift.self_closed
              ? [payload.shift?.closing_cash_amount, (satelliteShift as Record<string, unknown>).closing_cash_amount]
                .map((value) => (value === null || value === undefined || value === '' ? Number.NaN : Number(value)))
                .find((value) => Number.isFinite(value) && value >= 0) ?? null
              : null;
            if (recordedCount !== null) setSatelliteCountedCash(recordedCount.toFixed(2));
            setSatellitePreview({ loading: false, error: null, figures: payload.figures, recordedCount });
          } else {
            setSatelliteRefusedForGood(previewRefusedForGood(payload));
            // The server's refusal in till language, never its raw code.
            setSatellitePreview({
              loading: false,
              error:
                satelliteHandoverMessage(payload?.error, t)?.text ||
                t('modals.staffShift.satelliteCheckout.previewFailed', {
                  defaultValue: 'Could not load the shift figures from the server.',
                }),
              figures: null,
            });
          }
        })
        .catch((previewError: unknown) => {
          setSatellitePreview({
            loading: false,
            error:
              satelliteHandoverMessage(previewError, t)?.text ||
              t('modals.staffShift.satelliteCheckout.previewFailed', {
                defaultValue: 'Could not load the shift figures from the server.',
              }),
            figures: null,
          });
        });
      return;
    }

    // If this staff already has an active shift, jump to checkout view for that shift
    const existingShift = staffActiveShifts.get(staffMember.id);
    if (existingShift) {
      setContentDirection(1);
      setLocalMode('checkout');
      setCheckoutShift(existingShift);
      setShowExpenseForm(false);
      setClosingCash('');
      await loadExpenses(existingShift.id);
      return;
    }

    // Otherwise continue the normal check-in flow
    loadGiftPending(staffMember.id);
    navigateCheckInStep('enter-pin');
  };

  const handleStaffQrResolve = async () => {
    const qrCode = staffQrCode.trim();
    if (!qrCode || resolvingStaffQr) {
      return;
    }

    if (!hasActiveErganiPlugin) {
      setError(t(
        'modals.staffShift.qrRequiresErgani',
        'Staff QR check-in requires an acquired and active ERGANI plugin.',
      ));
      setStaffQrCode('');
      return;
    }

    setResolvingStaffQr(true);
    setError('');
    try {
      const result = await bridge.staffAuth.resolveQr({ qrCode });
      if (!result?.success || !result.staff?.id) {
        throw new Error(result?.error || t('modals.staffShift.qrResolveFailed', 'Staff QR badge was not recognized.'));
      }

      const matchedStaff = availableStaff.find((member) => member.id === result.staff?.id);
      if (!matchedStaff) {
        throw new Error(t('modals.staffShift.qrStaffUnavailable', 'This staff member is not available for this terminal.'));
      }

      setStaffQrCode('');
      await handleStaffSelect(matchedStaff);
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : t('modals.staffShift.qrResolveFailed', 'Staff QR badge was not recognized.');
      setError(message);
    } finally {
      setResolvingStaffQr(false);
    }
  };

  const getCheckInPinErrorMessage = (
    result:
      | {
          reasonCode?: unknown;
          error?: unknown;
          source?: unknown;
          busyTerminalName?: unknown;
          busyRole?: unknown;
          busyCheckedInAt?: unknown;
        }
      | undefined,
  ): string => {
    const reasonCode = typeof result?.reasonCode === 'string' ? result.reasonCode : '';
    const checkedHere = checkedOnTill(result);
    switch (reasonCode) {
      case 'invalid_pin':
        return t('modals.staffShift.invalidPIN');
      case 'offline_pin_locked':
        return t(
          'modals.staffShift.offlineCheckIn.locked',
          'Too many wrong PINs. Try again in 15 minutes, or once the connection is back.',
        );
      case 'offline_waiter_terminal':
        return t(
          'modals.staffShift.offlineCheckIn.waiterPhone',
          'A waiter phone checks staff in through the server. Try again once the connection is back.',
        );
      case 'pin_locked':
        return t('modals.staffShift.pinLocked', 'This PIN is locked for now. Try again later.');
      case 'staff_not_found':
        return t('modals.staffShift.staffNotFound', 'This staff member was not found in this store.');
      case 'rate_limited':
        return t(
          'modals.staffShift.rateLimited',
          'Too many check-in attempts. Wait a moment and try again.',
        );
      case 'check_in_unavailable':
        return t(
          'modals.staffShift.checkInUnavailable',
          "This till cannot ask the server: its connection settings are incomplete.",
        );
      case 'pin_not_configured':
        return t(
          'modals.staffShift.pinNotConfigured',
          'No POS PIN is configured for this staff member. Please set it in Admin first.',
        );
      case 'pos_login_disabled':
        return t(
          'modals.staffShift.posLoginDisabled',
          'This staff member is not allowed to log in on POS.',
        );
      case 'staff_auth_unavailable':
      case 'staff_not_available_offline':
        // The server could not be reached and this till holds no PIN for
        // this person (Android: offlineCheckIn.noPinOnTill).
        if (checkedHere && reasonCode === 'staff_not_available_offline') {
          return t(
            'modals.staffShift.offlineCheckIn.noPinOnTill',
            "This till holds no PIN for this person, so they can't check in without a connection.",
          );
        }
        return t(
          'modals.staffShift.staffAuthUnavailable',
          'Staff auth data is not available offline yet. Open the staff list while online first.',
        );
      case 'staff_busy_elsewhere': {
        const terminalName =
          typeof result?.busyTerminalName === 'string' && result.busyTerminalName.trim()
            ? result.busyTerminalName.trim()
            : t('modals.staffShift.busyTerminalFallback', 'another terminal');
        const role =
          typeof result?.busyRole === 'string' && result.busyRole.trim()
            ? result.busyRole.trim()
            : '';
        // Say WHEN. `busyCheckedInAt` has always been on the payload
        // (auth.rs check_in_busy_elsewhere_failure) and this message threw it
        // away, so a shift stuck open for weeks read exactly like one opened
        // five minutes ago — one cashier was reported busy on the Test Terminal
        // for twenty days and nothing here let the operator tell. A business day
        // may legitimately run for days, so the date is SHOWN, never used to
        // hide the shift.
        const checkedInAt =
          typeof result?.busyCheckedInAt === 'string' ? new Date(result.busyCheckedInAt) : null;
        if (checkedInAt && !Number.isNaN(checkedInAt.getTime())) {
          return t('modals.staffShift.busyElsewhereSince', {
            defaultValue: 'Checked in at {{terminal}} as {{role}} since {{since}}',
            terminal: terminalName,
            role,
            since: checkedInAt.toLocaleString(),
          });
        }
        return t('modals.staffShift.busyElsewhere', {
          defaultValue: 'Checked in at {{terminal}} as {{role}}',
          terminal: terminalName,
          role,
        });
      }
      default:
        return String(result?.error || t('modals.staffShift.verifyPinFailed'));
    }
  };

  const verifyLegacyAdminStaffPinOnline = async (
    staffId: string,
    pin: string,
  ): Promise<{ success: boolean; reasonCode?: string; error?: string }> => {
    try {
      const statusResult = await bridge.adminApi.fetchFromAdmin(
        `/api/pos/staff-schedule/clock?staff_id=${encodeURIComponent(staffId)}`,
      );

      if (!statusResult?.success) {
        return {
          success: false,
          reasonCode: 'staff_auth_unavailable',
          error: String(statusResult?.error || 'Failed to read legacy staff clock status'),
        };
      }

      const statusPayload = statusResult.data as {
        success?: boolean;
        clockStatus?: { isClockedIn?: boolean | null } | null;
      } | undefined;

      if (statusPayload?.success === false) {
        return {
          success: false,
          reasonCode: 'staff_auth_unavailable',
          error: 'Failed to read legacy staff clock status',
        };
      }

      const isClockedIn = statusPayload?.clockStatus?.isClockedIn === true;
      const probeAction: 'clock_in' | 'clock_out' = isClockedIn ? 'clock_in' : 'clock_out';

      const probeResult = await bridge.staffSchedule.clock({
        staff_id: staffId,
        action: probeAction,
        pin,
        notes: 'legacy_auth_probe',
      });

      if (probeResult?.success) {
        console.warn('[StaffShiftModal] Legacy staff PIN probe unexpectedly succeeded with side effects', {
          staffId,
          probeAction,
        });
        return {
          success: false,
          reasonCode: 'staff_auth_unavailable',
          error: 'Legacy Admin PIN verification mutated remote shift state unexpectedly.',
        };
      }

      const errorText = typeof probeResult?.error === 'string' ? probeResult.error : '';
      const normalizedError = normalizeLegacyProbeError(errorText);

      if (
        (!isClockedIn && normalizedError.includes('no active shift found to clock out')) ||
        (isClockedIn && normalizedError.includes('already clocked in'))
      ) {
        return { success: true };
      }

      if (normalizedError.includes('invalid pin') || normalizedError.includes('pin is required')) {
        return {
          success: false,
          reasonCode: 'invalid_pin',
          error: errorText || 'Invalid PIN',
        };
      }

      if (normalizedError.includes('staff member not found')) {
        return {
          success: false,
          reasonCode: 'staff_not_available_offline',
          error: errorText || 'Staff member not found',
        };
      }

      return {
        success: false,
        reasonCode: 'staff_auth_unavailable',
        error: errorText || 'Legacy Admin PIN verification failed',
      };
    } catch (error) {
      return {
        success: false,
        reasonCode: 'staff_auth_unavailable',
        error: extractErrorMessage(error, 'Legacy Admin PIN verification failed'),
      };
    }
  };

  const loadCheckInEligibility = async (
    branchId?: string,
    terminalId?: string,
  ): Promise<ShiftCheckInEligibility | null> => {
    if (!branchId || !terminalId) {
      return null;
    }

    try {
      return await bridge.shifts.getCheckInEligibility(branchId, terminalId);
    } catch (eligibilityError) {
      console.warn('[StaffShiftModal] Failed to load check-in eligibility:', eligibilityError);
      return null;
    }
  };

  const finishPinVerification = async (
    branchId: string,
    terminalId: string,
    staffRole: string,
    current: () => boolean,
  ) => {
    const eligibility = await loadCheckInEligibility(branchId, terminalId);
    if (!current()) return;
    setCheckInEligibility(eligibility);
    const normalizedRole = normalizeShiftRole(staffRole);
    if (normalizedRole) setRoleType(normalizedRole);
    setLoading(false);
    navigateCheckInStep('select-role');
    setError('');
  };

  const handlePinSubmit = async () => {
    if (!selectedStaff) return;
    const current = captureCheckInGuard();

    setLoading(true);
    setError('');

    try {
      // Resolve terminal/branch from settings or bridge
      let branchId: string | undefined = getSetting?.('terminal', 'branch_id') as string | undefined;
      let terminalId: string | undefined = getSetting?.('terminal', 'terminal_id') as string | undefined;
      if (!branchId || !terminalId) {
        try {
          const local = (await bridge.settings.get()) as unknown as SettingsResult;
          if (!current()) return;
          branchId = branchId || ((local?.['terminal.branch_id'] as string | undefined) ?? local?.terminal?.branch_id);
          terminalId = terminalId || ((local?.['terminal.terminal_id'] as string | undefined) ?? local?.terminal?.terminal_id);
        } catch { }
      }
      if (!branchId) {
        try {
          const val = await bridge.terminalConfig.getSetting('terminal', 'branch_id');
          if (!current()) return;
          if (val) branchId = val as string;
        } catch { }
      }
      // Extra fallback: dedicated branch id getter
      if (!branchId) {
        try {
          const bid = await bridge.terminalConfig.getBranchId();
          if (!current()) return;
          if (bid) branchId = bid as string;
        } catch { }
      }
      if (!terminalId) {
        try {
          const val = await bridge.terminalConfig.getSetting('terminal', 'terminal_id');
          if (!current()) return;
          if (val) terminalId = val as string;
        } catch { }
      }

      if (!current()) return;
      // Validate branchId before attempting check-in
      if (!branchId || (typeof branchId === 'string' && branchId.trim() === '')) {
        console.error('[StaffShiftModal] Cannot check in: branchId is not configured');
        setError(t('modals.staffShift.errors.noBranchConfigured', 'Branch not configured. Please contact admin.'));
        setEnteredPin('');
        return;
      }
      if (!terminalId || (typeof terminalId === 'string' && !terminalId.trim())) {
        console.error('[StaffShiftModal] Cannot check in: terminalId is not configured');
        setError(t('modals.staffShift.errors.noTerminalConfigured', 'Terminal not configured. Please contact admin.'));
        setEnteredPin('');
        return;
      }

      if (staffAuthMetadataStatus === 'missing' && selectedStaff.has_pin !== true) {
        const legacyProbe = await verifyLegacyAdminStaffPinOnline(
          selectedStaff.id,
          enteredPin.trim(),
        );
        if (!current()) return;

        if (legacyProbe.success) {
          const staffRole = selectedStaff.role_name;
          await finishPinVerification(branchId, terminalId, staffRole, current);
          return;
        }

        const errorMessage =
          legacyProbe.reasonCode === 'staff_auth_unavailable'
            ? t(
                'modals.staffShift.staffAuthServerUpgradeRequired',
                'This POS is connected to an older Admin deployment that does not send staff PIN auth data yet. Deploy the latest Admin and reopen POS.',
              )
            : getCheckInPinErrorMessage(legacyProbe);

        setError(errorMessage);
        setEnteredPin('');
        return;
      }

      try {
        console.log('[StaffShiftModal] PIN submit - IPC call with', { staffId: selectedStaff?.id, branchId, terminalId });
        const authRes = await bridge.staffAuth.verifyCheckInPin({
          staffId: selectedStaff.id,
          branchId,
          pin: enteredPin.trim(),
        });
        if (!current()) return;
        const normalizedAuth = authRes;
        const authSucceeded = normalizedAuth?.success === true;

        console.log('[StaffShiftModal] PIN IPC normalized auth', {
          authSucceeded,
          reasonCode: normalizedAuth?.reasonCode,
          error: normalizedAuth?.error
        });

        if (authSucceeded) {
          offlineCheckInStaffId.current = checkedOnTill(normalizedAuth) ? selectedStaff.id : null;
          const staffRole = selectedStaff.role_name;
          await finishPinVerification(branchId, terminalId, staffRole, current);
          return; // done
        }

        if (normalizedAuth && normalizedAuth.success === false) {
          setError(getCheckInPinErrorMessage(normalizedAuth));
          setEnteredPin('');
          return;
        }

        console.log('IPC PIN auth returned unexpected payload:', authRes);
        setError(t('modals.staffShift.verifyPinFailed'));
        setEnteredPin('');
        return;
      } catch (e) {
        if (!current()) return;
        const errorMessage = extractErrorMessage(e, t('modals.staffShift.verifyPinFailed'));
        console.warn('IPC PIN auth error:', errorMessage);
        if (errorMessage.toLowerCase().includes('invalid pin') || errorMessage.toLowerCase().includes('pin is required')) {
          setError(t('modals.staffShift.invalidPIN'));
        } else {
          setError(errorMessage);
        }
        setEnteredPin('');
        return;
      }
    } catch (err) {
      if (!current()) return;
      console.error('PIN verification error:', err);
      setError(t('modals.staffShift.verifyPinFailed'));
      setEnteredPin('');
    } finally {
      if (current()) setLoading(false);
    }
  };

  const handleRoleSelect = async (roleName: string) => {
    const role = normalizeShiftRole(roleName);
    if (!role) {
      setError(t('modals.staffShift.unsupportedShiftRole', { defaultValue: 'This role cannot open a POS shift. Ask your manager to assign a supported POS role.' }));
      return;
    }
    if (cashierFirstGateActive && role !== 'cashier') {
      setError(
        t('modals.staffShift.cashierFirstCheckInRequired'),
      );
      return;
    }

    setRoleType(role);
    setError('');
    setSuccess('');
    setShowZeroCashConfirm(false);

    // For staff that return cash, pre-check if there's an active cashier.
    if (role === 'driver' || role === 'server') {
      try {
        const branchId = getSetting?.('terminal', 'branch_id') as string | undefined;
        const terminalId = getSetting?.('terminal', 'terminal_id') as string | undefined;
        if (branchId && terminalId) {
          const cashier = await bridge.shifts.getActiveCashierByTerminal(branchId, terminalId);
          setActiveCashierExists(!!cashier);
        }
      } catch (e) {
        console.warn('Failed to check active cashier:', e);
        setActiveCashierExists(true); // Default to true on error
      }
    }

    if (role === 'cashier' || role === 'driver' || role === 'server') {
      navigateCheckInStep('enter-cash');
    } else {
      // For other roles, proceed directly to check-in
      void handleCheckIn(false, role);
    }
  };

  const handleFinancialCheckIn = async (openingCents: number) => {
    if (financialBusy.current || !selectedStaff || !financialEntry.scope || !financialEntry.currency) return;
    financialBusy.current = true;
    const current = captureCheckInGuard();
    const scope = financialEntry.scope;
    const holder = JSON.stringify(scope);
    const cashier = selectedStaff;
    const pin = enteredPin;
    let capturedOriginal = financialEntry.original;
    const stale = new Error('STALE_FINANCIAL_OPENING');
    const guarded = async <T,>(operation: () => Promise<T>): Promise<T> => {
      if (!current()) throw stale;
      const result = await operation();
      if (!current()) throw stale;
      return result;
    };
    const validateOriginal = (opening: ShiftFinancialOpeningView) => {
      const remembered = financialAttempts.current.get(holder);
      if (!openingMatchesScope(opening, scope) || (remembered &&
          (opening.openingKey !== remembered.openingKey || opening.openingCents !== remembered.openingCents || opening.currency !== remembered.currency)) ||
          (capturedOriginal && (opening.shiftId !== capturedOriginal.shiftId || opening.drawerId !== capturedOriginal.drawerId ||
            opening.checkedInAt !== capturedOriginal.checkedInAt || opening.businessDate !== capturedOriginal.businessDate ||
            opening.isDayStart !== capturedOriginal.isDayStart || opening.calculationVersion !== capturedOriginal.calculationVersion))) {
        throw new Error(t('modals.staffShift.financialOpeningUnavailable'));
      }
      capturedOriginal = opening;
      financialAttempts.current.set(holder, { openingKey: opening.openingKey, openingCents: opening.openingCents, currency: opening.currency });
      setOpeningCash(`${Math.floor(opening.openingCents / 100)},${String(opening.openingCents % 100).padStart(2, '0')}`);
      setFinancialEntry({ status: 'ready', scope, currency: opening.currency, original: opening });
    };
    setLoading(true);
    setError('');
    setSuccess('');
    try {
      if (!await guarded(() => financialClear.current)) throw new Error(t('modals.staffShift.financialOpeningUnavailable'));
      const [organizationId, branchId, terminalId] = await guarded(() => Promise.all([
        bridge.terminalConfig.getOrganizationId(), bridge.terminalConfig.getBranchId(), bridge.terminalConfig.getTerminalId(),
      ]));
      if (organizationId !== scope.organizationId || branchId !== scope.branchId || terminalId !== scope.terminalId) {
        throw new Error(t('modals.staffShift.financialOpeningUnavailable'));
      }
      let remembered = financialAttempts.current.get(holder);
      const status = await guarded(() => financialOpening.status(remembered?.openingKey));
      let original = status.openings.find((entry) => openingMatchesScope(entry, scope) &&
        (!remembered || entry.openingKey === remembered.openingKey));
      let startedHere = false;
      if (!original && remembered && !remembered.issuanceRefused) {
        // A lost begin reply is unknown, never permission to issue another original.
        setError(t('modals.staffShift.financialOpeningUnknown'));
        return;
      }
      if (!original) {
        if (!/^\d{4,8}$/.test(pin)) {
          setError(t('modals.staffShift.financialOpeningReauthorize'));
          financialBusy.current = false;
          setLoading(false);
          navigateCheckInStep('enter-pin');
          return;
        }
        remembered = remembered ?? { openingKey: crypto.randomUUID(), openingCents, currency: financialEntry.currency };
        remembered.issuanceRefused = false;
        financialAttempts.current.set(holder, remembered);
        financialTouched.current = true;
        startedHere = true;
        const response = await guarded(() => financialOpening.begin({ openingKey: remembered!.openingKey,
          openingCents: remembered!.openingCents, currency: remembered!.currency, staffId: cashier.id, staffName: cashier.name, pin }));
        setEnteredPin('');
        // This exact native refusal happens before intent/queue creation. A
        // fresh user PIN may retry the same key/body; IPC loss never enables it.
        if (!response.success && response.code === 'HOSTED_CHECK_IN_REFUSED') {
          remembered.issuanceRefused = true;
          setError(t('modals.staffShift.financialOpeningReauthorize'));
          financialBusy.current = false;
          setLoading(false);
          navigateCheckInStep('enter-pin');
          return;
        }
        if (!response.success) throw new Error(response.error);
        original = response.opening;
      }
      validateOriginal(original);
      if (original.state === 'confirmed_unusable' || (original.state === 'confirmed_usable' && !original.usable)) {
        setError(t('modals.staffShift.financialOpeningUnusable'));
        return;
      }
      if (original.hostedAuthorization.state === 'required') {
        if (startedHere || !/^\d{4,8}$/.test(pin)) {
          setError(t('modals.staffShift.financialOpeningReauthorize'));
          financialBusy.current = false;
          setLoading(false);
          navigateCheckInStep('enter-pin');
          return;
        }
        financialTouched.current = true;
        const response = await guarded(() => financialOpening.authorize(original!.openingKey, pin));
        setEnteredPin('');
        if (!response.success) throw new Error(response.error);
        original = response.opening;
        validateOriginal(original);
      }
      if (original.state !== 'confirmed_usable' || !original.usable || original.hostedAuthorization.state !== 'authorized') {
        setError(t(original.state === 'confirmed_unusable' ? 'modals.staffShift.financialOpeningUnusable' : 'modals.staffShift.financialOpeningPending'));
        return;
      }
      const shift = await guarded(() => financialOpening.readConfirmedShift(original!));
      const latest = await guarded(() => financialOpening.status(original!.openingKey));
      const confirmed = latest.openings.find((entry) => entry.openingKey === original!.openingKey);
      if (!shift || !confirmed || !openingMatchesScope(confirmed, scope) || confirmed.shiftId !== shift.id ||
          confirmed.state !== 'confirmed_usable' || !confirmed.usable || confirmed.hostedAuthorization.state !== 'authorized') {
        setError(t('modals.staffShift.financialOpeningUnusable'));
        return;
      }
      validateOriginal(confirmed);
      if (!current()) return;
      // Publish the actual matching native row, never an optimistic view/stub.
      financialCompleted.current = true;
      financialTouched.current = false;
      setEnteredPin('');
      setStaff({ staffId: cashier.id, name: cashier.name, role: 'cashier', branchId, terminalId, organizationId });
      setActiveShiftImmediate(shift);
      onClose();
    } catch (failure) {
      if (current() && failure !== stale) {
        setEnteredPin('');
        setError(financialAttempts.current.has(holder)
          ? t('modals.staffShift.financialOpeningUnknown')
          : extractErrorMessage(failure, t('modals.staffShift.financialOpeningUnavailable')));
      }
    } finally {
      if (current()) {
        financialBusy.current = false;
        setLoading(false);
      }
    }
  };

  const handleCheckIn = async (bypassZeroConfirm = false, roleOverride?: StaffShiftRole) => {
    if (!selectedStaff || !staff) {
      setError(t('modals.staffShift.noStaffSelected'));
      return;
    }

    const selectedRoleType = roleOverride ?? roleType;

    if (selectedRoleType === 'cashier' && financialEntry.status !== 'ordinary') {
      if (financialEntry.status !== 'ready' || financialBusy.current) return;
      const openingCents = parseOpeningCents(openingCash);
      if (openingCents === null) {
        setError(t('modals.staffShift.invalidOpeningCash'));
        return;
      }
      const remembered = financialEntry.scope && financialAttempts.current.has(JSON.stringify(financialEntry.scope));
      if (!remembered && openingCents === 0 && !bypassZeroConfirm) {
        setShowZeroCashConfirm(true);
        return;
      }
      await handleFinancialCheckIn(openingCents);
      return;
    }

    // Driver-specific validation: cannot take starting cash without active cashier
    const driverAmount = parseMoneyInputValue(driverStartingAmount);
    if (selectedRoleType === 'driver' && driverAmount > 0 && !activeCashierExists) {
      setError(t('modals.staffShift.noCashierForDriverCash', 'No active cashier. You cannot take starting cash without a cashier present.'));
      return;
    }

    // Soft guard: cashiers starting with zero opening cash need confirmation
    if (selectedRoleType === 'cashier' && !bypassZeroConfirm) {
      const trimmedOpening = openingCash.trim();
      const parsedOpening = parseMoneyInputValue(trimmedOpening);
      if (!isNaN(parsedOpening) && parsedOpening === 0) {
        setShowZeroCashConfirm(true);
        return;
      }
    }

    setLoading(true);
    setError('');
    setSuccess('');

    try {
      // Resolve terminal + branch from TerminalConfig first (avoid stale 'local-branch')
      let resolvedTerminalId: string | undefined = staff.terminalId;
      let resolvedBranchId: string | undefined = staff.branchId;
      let resolvedOrganizationId = normalizeContextId(staff.organizationId);
      try { resolvedTerminalId = (await bridge.terminalConfig.getTerminalId()) || resolvedTerminalId; } catch { }
      try { resolvedBranchId = (await bridge.terminalConfig.getBranchId()) || resolvedBranchId; } catch { }
      try {
        resolvedOrganizationId = normalizeContextId(await bridge.terminalConfig.getOrganizationId()) || resolvedOrganizationId;
      } catch { }
      if (!resolvedOrganizationId) {
        try {
          resolvedOrganizationId =
            normalizeContextId(await bridge.terminalConfig.getSetting('terminal', 'organization_id')) ||
            resolvedOrganizationId;
        } catch { }
      }
      if (!resolvedOrganizationId) {
        resolvedOrganizationId = normalizeContextId(getSetting?.('terminal', 'organization_id'));
      }
      resolvedTerminalId = normalizeContextId(resolvedTerminalId);
      resolvedBranchId = normalizeContextId(resolvedBranchId) || '';

      // Cashiers must manually count and enter opening amount - no automatic comparison with previous day
      // Validate that cashiers have entered a valid opening cash amount
      if (selectedRoleType === 'cashier') {
        const trimmedOpening = openingCash.trim();
        const parsedOpening = parseMoneyInputValue(trimmedOpening);

        // Validation: must not be empty and must be a valid number >= 0
        // Allow explicit "0" as valid (differentiate from empty string)
        if (trimmedOpening === '' || isNaN(parsedOpening) || parsedOpening < 0) {
          setError(t('modals.staffShift.invalidOpeningCash'));
          setLoading(false);
          return;
        }
      }

      // For staff that return cash, validate starting amount if provided (optional, can be 0 or empty)
      if (selectedRoleType === 'driver' || selectedRoleType === 'server') {
        const trimmedStarting = driverStartingAmount.trim();
        if (trimmedStarting !== '') {
          const parsedStarting = parseMoneyInputValue(trimmedStarting);
          if (isNaN(parsedStarting) || parsedStarting < 0) {
            setError(t('modals.staffShift.invalidStartingAmount', 'Invalid starting amount'));
            setLoading(false);
            return;
          }
        }
      }

      if (!resolvedBranchId) {
        setError(t('modals.staffShift.errors.noBranchConfigured', 'Branch not configured. Please contact admin.'));
        setLoading(false);
        return;
      }
      if (!resolvedTerminalId) {
        setError(t('modals.staffShift.errors.noTerminalConfigured', 'Terminal not configured. Please contact admin.'));
        setLoading(false);
        return;
      }

      // Determine the opening/starting amount based on role type
      // Cashiers: openingCash represents drawer count
      // Drivers: startingAmount represents cash taken from cashier (separate field for clarity)
      // Other roles: no cash amount needed
      let usedOpeningCash = 0;
      let usedStartingAmount: number | undefined;

      if (selectedRoleType === 'cashier') {
        usedOpeningCash = parseMoneyInputValue(openingCash);
      } else if (selectedRoleType === 'driver' || selectedRoleType === 'server') {
        // Use dedicated startingAmount field for drivers
        usedStartingAmount = parseMoneyInputValue(driverStartingAmount);
      }
      // Other roles: both remain undefined

      const result = await bridge.shifts.open({
        staffId: selectedStaff.id,
        staffName: selectedStaff.name,
        branchId: resolvedBranchId,
        terminalId: resolvedTerminalId,
        roleType: selectedRoleType,
        // Send only the relevant cash field per role so the Rust or_else
        // chain doesn't short-circuit on openingCash:0 for drivers.
        ...(selectedRoleType === 'driver' || selectedRoleType === 'server'
          ? { startingAmount: usedStartingAmount }
          : { openingCash: usedOpeningCash }),
        // \u03a97: asks the native open to flag this ordinary drawer for the
        // server's review; a PIN this till checked is flagged natively anyway.
        ...(selectedRoleType === 'cashier' && financialEntry.ordinaryOpeningOffline
          ? { ordinaryOpeningOffline: true }
          : {}),
      }) as unknown as ShiftIpcResult;

      if (result.success) {
        const shiftId = result?.shiftId || result?.data?.shiftId || result?.data?.id;
        emitCompatEvent('shift-updated', { shiftId, status: 'active' });
        const offlineCheckIn = (result as { offlineCheckIn?: unknown }).offlineCheckIn === true;
        const ordinaryOpeningOffline = (result as { ordinaryOpeningOffline?: unknown }).ordinaryOpeningOffline === true;
        if (offlineCheckIn || ordinaryOpeningOffline) {
          // The queued open carries the offline_check_in marker the server
          // re-checks once the connection is back, and \u03a97's
          // ordinary_opening_offline flag it reviews.
          if (offlineCheckIn) offlineCheckInStaffId.current = null;
          const message = ordinaryOpeningOffline
            ? giftCardOrdinaryOpeningMessage(t)
            : t('modals.staffShift.offlineCheckIn.checkedInMessage', 'The server checks this check-in once the connection is back.');
          toast(
            offlineCheckIn
              ? `${t('modals.staffShift.offlineCheckIn.checkedInTitle', 'Checked in without a connection')}. ${message}`
              : message,
            { duration: 8000, icon: '\u2139\ufe0f' },
          );
        }
        // Z-17/08 forensics: when the typed opening float breaks the
        // terminal's close→open carry (drawer closed on one number, opened
        // on another with nothing in between), confront the cashier NOW —
        // at close time the same break surfaces as an unexplainable ±€
        // variance nobody can reconstruct.
        const continuity = (result as { drawerContinuityWarning?: { previousClosing?: number; opening?: number } })
          .drawerContinuityWarning;
        if (
          continuity
          && typeof continuity.previousClosing === 'number'
          && typeof continuity.opening === 'number'
        ) {
          toast(
            t('modals.staffShift.drawerContinuityWarning', {
              previous: formatCurrency(continuity.previousClosing),
              opening: formatCurrency(continuity.opening),
            }),
            { duration: 15000, icon: '⚠️' },
          );
        }
        // Other staff may check in without taking ownership of this drawer.
        let keepDrawerOwner = false;
        if (selectedRoleType !== 'cashier' && selectedRoleType !== 'manager') {
          const isDrawerOwner = (reply: any) => {
            const shift = reply?.data ?? reply;
            return reply?.success !== false && shift?.status === 'active' &&
              ['cashier', 'manager'].includes(shift.role_type);
          };
          try {
            keepDrawerOwner = isDrawerOwner(await bridge.shifts.getActiveCashierByTerminal(resolvedBranchId, resolvedTerminalId));
          } catch { }
          if (!keepDrawerOwner) {
            try {
              keepDrawerOwner = isDrawerOwner(await bridge.shifts.getActiveCashierByTerminalLoose(resolvedTerminalId));
            } catch { }
          }
        }
        if (!keepDrawerOwner) {
          setStaff({
            staffId: selectedStaff.id,
            name: selectedStaff.name,
            role: selectedRoleType,
            branchId: resolvedBranchId,
            terminalId: resolvedTerminalId,
            organizationId: resolvedOrganizationId,
          });
          // Optimistically mark shift active immediately with a minimal stub, so UI unlocks at once
          try {
            if (shiftId) {
              // opening_cash_amount: for cashiers this is the drawer count, for drivers this is their starting amount
              const effectiveOpeningAmount = selectedRoleType === 'driver' || selectedRoleType === 'server'
                ? (usedStartingAmount ?? 0)
                : usedOpeningCash;
              setActiveShiftImmediate({
                id: String(shiftId),
                staff_id: selectedStaff.id,
                branch_id: resolvedBranchId,
                terminal_id: resolvedTerminalId,
                role_type: selectedRoleType,
                check_in_time: new Date().toISOString(),
                opening_cash_amount: effectiveOpeningAmount,
                status: 'active',
                total_orders_count: 0,
                total_sales_amount: 0,
                total_cash_sales: 0,
                total_card_sales: 0,
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
              });
            }
          } catch { }
        }
        // Founder 02/11/2026: the window closes at once, with no success banner
        // flashing while the shift is read back. The shift set above has already
        // unlocked the till; without one, the read decides first. A check-in
        // that keeps the drawer owner leaves the shift context alone.
        const synced = keepDrawerOwner
          ? Promise.resolve()
          : refreshActiveShift(selectedStaff.id).catch((e) => {
            console.warn('[StaffShiftModal] refreshActiveShift failed:', e);
          });
        if (!shiftId) await synced;
        onClose();
      } else {
        const refusal = result.error || t('modals.staffShift.openShiftFailed');
        setError(describeOfflineOpeningRefusal(refusal, t) ?? refusal);
      }
    } catch (err) {
      const message = extractErrorMessage(err, t('modals.staffShift.openShiftFailed'));
      setError(message === 'UNSUPPORTED_SHIFT_ROLE'
        ? t('modals.staffShift.unsupportedShiftRole', { defaultValue: 'This role cannot open a POS shift. Ask your manager to assign a supported POS role.' })
        : describeOfflineOpeningRefusal(message, t) ?? message);
    } finally {
      setLoading(false);
    }
  };

  const handleCheckOut = async (bypassZeroConfirm = false) => {
    console.log('🔴 handleCheckOut called');
    console.log('effectiveShift:', effectiveShift);
    console.log('staff:', staff);
    console.log('closingCash:', closingCash);
    console.log('staffPayment:', staffPayment);

    if (!effectiveShift || !staff) {
      console.log('❌ No active shift or staff found');
      setError(t('modals.staffShift.noActiveShift'));
      return;
    }

    // Founder 13/10/2026: the Main cashier/manager cannot close while any
    // phone shift of the unit is open or a closed phone till still waits to
    // be received here. Asked fresh; a failed read is never "no phone shifts".
    // Coordinator review 14/10/2026: only a till this Main can receive now and
    // whose local claim a manager has not released waits; offline, the last
    // good read decides (no open phone shift and no till to receive passes).
    let legacyReturnsGate = isCashierCheckoutRole;
    if (isCashierCheckoutRole) {
      const guard = captureGiftGuard();
      const shiftId = String(effectiveShift.id);
      const [read, released] = await Promise.all([
        readUnitShiftReadinessRemembered(bridge.shifts, unitReadinessTerminalId()),
        readReleasedPhoneTills(invokeBridge),
      ]);
      if (!(guard() && giftShiftId.current === shiftId)) return;
      setReleasedPhoneTillIds(released);
      // A till the server called "not a Main" at open keeps the legacy gate
      // when the fresh read fails (offline), as it did before 13/10.
      const keepsLegacy = read.result.kind === 'unavailable' && unitReadiness?.kind === 'unsupported';
      if (!keepsLegacy) {
        applyUnitReadinessRead(read);
      }
      if (read.result.kind === 'ready') {
        legacyReturnsGate = false;
        const blocker = unitCloseBlocker(read.result.readiness, released);
        if (blocker) {
          setError(blocker);
          return;
        }
      } else if (read.result.kind === 'unavailable' && !keepsLegacy) {
        const lastGood = lastGoodAfter(read);
        if (!lastGood) {
          setError(t('phoneShifts.unavailable', {
            defaultValue: 'Phone shifts could not be checked. Check the connection and try again.',
          }));
          return;
        }
        legacyReturnsGate = false;
        const blocker = unitCloseBlocker(lastGood.readiness, released);
        if (blocker) {
          setError(t('modals.staffShift.phoneShifts.lastCheckedBlocker', {
            defaultValue: 'No connection. As last checked at {{time}}: {{reasons}}',
            time: readinessTime(lastGood.checkedAt),
            reasons: blocker,
          }));
          return;
        }
      }
    }

    if (legacyReturnsGate && (waiterReturnsRequired.current !== false || waiterReturnsError)) {
      const guard = captureGiftGuard();
      const shiftId = String(effectiveShift.id);
      const valid = () => guard() && giftShiftId.current === shiftId;
      try {
        const pending = await readPendingWaiterReturns(bridge.shifts);
        if (!valid()) return;
        setPendingWaiterReturns(pending.returns);
        setWaiterReturnsError(false);
        waiterReturnsRequired.current = pending.required;
        if (pending.returns.length || pending.active) {
          setError(t('modals.staffShift.satelliteCheckout.receiveBeforeClose'));
          return;
        }
      } catch {
        if (!valid()) return;
        setError(t('modals.staffShift.satelliteCheckout.pendingReadFailed'));
        return;
      }
    }

    if (isCashierCheckoutRole && handleGiftCheckoutIntent()) {
      return;
    }

    let closingAmount = 0;

    // For drivers: use calculated amount to return
    if (effectiveShift?.role_type === 'driver') {
      // Driver payments are now centralized at cashier checkout
      // Driver checkout simply returns all cash without payment deduction
      const driverPayment = 0;
      console.log('driverPayment (centralized at cashier):', driverPayment);

      // For driver checkout, refresh summary WITH backfill to ensure all earnings are recorded
      // This is critical for accurate variance calculation
      let freshSummary = shiftSummary;
      try {
        const summaryResult = await bridge.shifts.getSummary(effectiveShift.id, { skipBackfill: false });
        freshSummary = summaryResult?.data || summaryResult;
        setShiftSummary(freshSummary);
      } catch (e) {
        console.warn('Failed to refresh shift summary with backfill:', e);
        // Continue with existing summary if refresh fails
      }

      // Calculate cash to return using the specified formula:
      // cashToReturn = openingCash + totalCashCollected - totalExpenses - tips - driverPayment
      // Custody is net of recorded handbacks; status alone never moves cash.
      const openingCash = getEffectiveOpeningAmount(effectiveShift, freshSummary);
      const deliveries = freshSummary?.driverDeliveries || [];
      const completedDeliveries = deliveries.filter((d: any) => {
        const status = (d.status || d.order_status || '').toLowerCase();
        return status !== 'cancelled' && status !== 'canceled' && status !== 'refunded';
      });
      const totalCashCollected = deliveries.reduce((sum: number, d: any) => sum + (d.cash_collected || 0), 0);
      const totalExpenses = freshSummary?.totalExpenses || 0;
      const tipsReceived = Number(freshSummary?.tipsReceived || freshSummary?.tips_received || 0);
      const expectedReturn = calculateDriverReturn({
        openingAmount: openingCash,
        cashCollected: totalCashCollected,
        expenses: totalExpenses,
        tipsReceived,
      }) - driverPayment;

      // When the expected return is zero (slow shift, nothing collected, etc.),
      // auto-confirm 0 instead of requiring the operator to type "0,00" — the
      // input is redundant in that case and forces an extra step before close.
      let actual: number;
      if (!hasManualCashInput(driverActualCash)) {
        if (Math.abs(expectedReturn) < 0.005) {
          actual = 0;
        } else {
          setError(t('modals.staffShift.actualCashReturnedRequired', {
            defaultValue: 'Enter the cash actually handed to the cashier before checkout.',
          }));
          return;
        }
      } else {
        actual = parseMoneyInputValue(driverActualCash);
      }

      if (actual < 0) {
        setError(t('modals.staffShift.invalidClosingCash'));
        return;
      }
      closingAmount = actual;

      console.log('Driver closingAmount:', {
        totalDeliveries: deliveries.length,
        completedDeliveries: completedDeliveries.length,
        canceledDeliveries: deliveries.length - completedDeliveries.length,
        openingCash,
        totalCashCollected,
        totalExpenses,
        tipsReceived,
        driverPayment,
        expectedReturn,
        actualEntered: driverActualCash,
        closingAmount,
        variance: closingAmount - expectedReturn,
      });
    }
    // Cashier checkout
    else if (effectiveShift?.role_type === 'cashier' || effectiveShift?.role_type === 'manager') {
      // Cashier: Calculate Expected but use Actual from input
      const openingCash = getEffectiveOpeningAmount(effectiveShift, shiftSummary);
      const expectedAmount = getCashierExpectedBreakdown(
        shiftSummary,
        effectiveShift,
        openingCash,
        cashierCheckoutExpenseTotal,
      ).expected;

      // Skip the manual-entry requirement when the expected till total is zero —
      // operator doesn't need to type "0,00" to confirm an empty till.
      let actualAmount: number;
      if (!hasManualCashInput(closingCash)) {
        if (Math.abs(expectedAmount) < 0.005) {
          actualAmount = 0;
        } else {
          setError(t('modals.staffShift.countedCashRequired', {
            defaultValue: 'Enter the counted cash before checkout.',
          }));
          return;
        }
      } else {
        actualAmount = parseMoneyInputValue(closingCash);
      }

      if (actualAmount < 0) {
        setError(t('modals.staffShift.invalidClosingCash'));
        return;
      }

      closingAmount = actualAmount;
      console.log('Cashier Checkout:', { expected: expectedAmount, actual: closingAmount, variance: closingAmount - expectedAmount });
    }
    // Comment 1: Waiter Checkout Logic
    // Waiter payments are now centralized at cashier checkout
    else if (effectiveShift?.role_type === 'server') {
      // Waiter payments are handled at cashier checkout
      // Waiter checkout simply returns all cash without payment deduction
      const waiterPayment = 0;

      // Refresh summary to ensure latest data
      let freshSummary = shiftSummary;
      try {
        const sResult = await bridge.shifts.getSummary(effectiveShift.id, { skipBackfill: true });
        const s = sResult?.data || sResult;
        if (s) {
          freshSummary = s;
          setShiftSummary(s);
        }
      } catch (e) { console.warn('Refresh failed', e); }

      const openingCash = getEffectiveOpeningAmount(effectiveShift, freshSummary);
      const waiterTables = freshSummary?.waiterTables || [];
      const cashCollected = waiterTables.reduce((sum: number, t: any) => sum + (t.cash_amount || 0), 0);
      const totalExpenses = freshSummary?.totalExpenses || 0;

      // Formula: Cash to Return = Starting Amount + Cash Collected - Expenses - Payments
      const expectedReturn = openingCash + cashCollected - totalExpenses - waiterPayment;

      // Auto-confirm 0 when there's nothing to return — operator doesn't need
      // to type "0,00" to close out an empty/inactive shift.
      let actual: number;
      if (!hasManualCashInput(closingCash)) {
        if (Math.abs(expectedReturn) < 0.005) {
          actual = 0;
        } else {
          setError(t('modals.staffShift.actualCashReturnedRequired', {
            defaultValue: 'Enter the cash actually handed to the cashier before checkout.',
          }));
          return;
        }
      } else {
        actual = parseMoneyInputValue(closingCash);
      }

      if (actual < 0) {
        setError(t('modals.staffShift.invalidClosingCash'));
        return;
      }
      closingAmount = actual;

      console.log('Server closingAmount calculated:', {
        expectedReturn,
        actualEntered: closingCash,
        closingAmount,
        variance: closingAmount - expectedReturn,
      });
    }
    else if (isNonFinancialCheckoutRole) {
      closingAmount = 0;
      console.log('Non-financial role closingAmount (no cash drawer):', closingAmount);
    }
    // Other roles (fallback): use manually entered closing cash
    else {
      closingAmount = parseMoneyInputValue(closingCash);
      console.log('closingAmount:', closingAmount);
      if (closingAmount < 0) {
        console.log('❌ Invalid closing amount');
        setError(t('modals.staffShift.invalidClosingCash'));
        return;
      }
    }

    // Zero Amount Confirmation
    if (closingAmount === 0 && !bypassZeroConfirm && !isNonFinancialCheckoutRole) {
      openConfirm({
        title: t('modals.staffShift.confirmZeroTitle', 'Confirm Zero Closing Cash'),
        message: t('modals.staffShift.confirmZeroMessage', 'Are you sure you want to close the shift with zero closing cash?'),
        variant: 'warning',
        onConfirm: () => { closeConfirm(); handleCheckOut(true); }
      });
      return;
    }

    console.log('✅ All checks passed, calling closeShift via bridge...');
    setLoading(true);
    setError('');
    setSuccess('');
    setCheckoutPaymentBlockers([]);

    try {
      // For drivers, include the payment amount in the closeShift call
      const isDriver = effectiveShift.role_type === 'driver';
      const driverPaymentAmount = isDriver ? parseMoneyInputValue(staffPayment) : undefined;
      const closedBy =
        staff.databaseStaffId ||
        (isUuidValue(staff.staffId) ? staff.staffId.trim() : undefined);

      const result = await bridge.shifts.close({
        shiftId: effectiveShift.id,
        closingCash: closingAmount,
        closedBy,
        paymentAmount: isDriver ? driverPaymentAmount : undefined
      }) as unknown as ShiftIpcResult;
      console.log('closeShift result:', result);

      if (result.success && (result as unknown as Record<string, unknown>).giftFinancialClosing != null) {
        // A retained gift original is never a generic success or print.
        rediscoverGiftClose();
      } else if (result.success) {
        emitCompatEvent('shift-updated', { shiftId: effectiveShift.id, status: 'closed', branchId: effectiveShift.branch_id,
          terminalId: effectiveShift.terminal_id, roleType: effectiveShift.role_type });
        setCheckoutPaymentBlockers([]);
        // Founder 02/11/2026: the window closes at once. No success banner and no
        // variance summary flashing for seconds: the closed shift is the answer.
        // The shift is read back and the checkout slip prints behind it.
        onClose();
        try {
          await refreshActiveShift();
        } catch (refreshErr) {
          console.warn('[StaffShiftModal] refreshActiveShift after checkout failed:', refreshErr);
        }

        // Print staff check-out receipt (role-specific)
        try {
          console.log('[StaffShiftModal] Printing checkout for shift:', effectiveShift.id, 'role:', effectiveShift.role_type);
          const printResult = await queueShiftCheckoutPrint({
            bridge,
            shiftId: effectiveShift.id,
            roleType: effectiveShift.role_type,
          }) as ShiftPrintCheckoutResult;
          console.log('[StaffShiftModal] Print checkout result:', printResult);
          if (!printResult?.success) {
            console.warn('[StaffShiftModal] Checkout print failed:', printResult?.error);
          }
        } catch (printErr) {
          console.error('[StaffShiftModal] Staff checkout print error:', printErr);
        }
      } else {
        const paymentIntegrityPayload = extractPaymentIntegrityPayload(result);
        setCheckoutPaymentBlockers(paymentIntegrityPayload?.blockers || []);
        const handover = satelliteHandoverMessage(result.error, t);
        if (handover?.refused) setSatelliteReleaseShiftId(String(effectiveShift.id));
        setError(handover ? handover.text : result.error?.includes('SHIFT_CURRENCY_SETTLEMENT_REQUIRED') ? t('modals.staffShift.currencySettlementRequired') : result.error || t('modals.staffShift.closeShiftFailed'));
        if (readRefusalCode(result, '').startsWith('GIFT_CLOSING_')) {
          rediscoverGiftClose();
        }
      }
    } catch (err) {
      const paymentIntegrityPayload = extractPaymentIntegrityPayload(err);
      setCheckoutPaymentBlockers(paymentIntegrityPayload?.blockers || []);
      // A satellite handover holding this close: said in till language, and a
      // refused one offers the manager's release (fix review 06/10/2026).
      // Any other rejection keeps its raw IPC text.
      const handover = satelliteHandoverMessage(err, t);
      if (handover?.refused) setSatelliteReleaseShiftId(String(effectiveShift.id));
      if (handover) setError(handover.text);
      else setError(extractErrorMessage(err, t('modals.staffShift.closeShiftFailed')));
    } finally {
      setLoading(false);
    }
  };

  // Sends only the approved preview: hosted fingerprint, exact count and the
  // shown ordinary cents. A retained result is pending until canonical proof.
  const submitGiftClose = async () => {
    const approval = giftApproval;
    const state = giftCheckout;
    const shift = effectiveShift;
    if (!approval || !shift || !staff || giftBusy || state.kind !== 'ready' ||
        state.shiftId !== String(shift.id) || approval.epoch !== state.preview.epoch) {
      return;
    }
    const countedCents = parseOpeningCents(closingCash);
    if (countedCents === null || countedCents !== approval.countedCents) {
      setGiftApproval(null);
      setError(giftText(giftCloseText('countChanged', 'The count changed after review. Review it again.')));
      return;
    }
    const { preview, opening, shiftId } = state;
    const epoch = giftEpoch.current;
    const guard = captureGiftGuard();
    giftCloseToken.current += 1;
    const token = giftCloseToken.current;
    const closedBy =
      staff.databaseStaffId ||
      (isUuidValue(staff.staffId) ? staff.staffId.trim() : undefined);
    const payload = {
      shiftId,
      closingCash: countedCents / 100,
      closedBy,
      giftClosing: buildGiftClosingRequest(preview, countedCents),
    };

    setGiftBusy(true);
    setError('');
    setSuccess('');
    setCheckoutPaymentBlockers([]);
    let result: unknown;
    // A satellite cash handover holds this close before anything is captured
    // (fix review 06/10/2026): its own till text, never a gift close refusal.
    let handover: ReturnType<typeof satelliteHandoverMessage> = null;
    try {
      result = await bridge.shifts.close(payload);
    } catch (err) {
      handover = satelliteHandoverMessage(err, t);
      result = { success: false, code: readRefusalCode(err, 'LOCAL_STORE_FAILED') };
    }
    // The native close stays durable; a retired intent only drops its UI effects.
    if (!guard() || token !== giftCloseToken.current) return;
    setGiftBusy(false);
    setGiftApproval(null);
    // A published local close may already have cleared the active shift.
    if (giftShiftId.current !== null && giftShiftId.current !== shiftId) return;

    const outcome = readGiftCloseResult(result);
    if (outcome.kind === 'retained') {
      emitCompatEvent('shift-updated', { shiftId, status: 'closed', branchId: shift.branch_id,
        terminalId: shift.terminal_id, roleType: shift.role_type });
      setClosingCash('');
      setGiftCheckout({ kind: 'retained', shiftId, opening });
      setGiftRecoveryTarget({
        epoch,
        origin: 'checkout',
        staffId: preview.staffId,
        closingKey: outcome.closingKey,
        shiftId,
        roleType: String(shift.role_type),
        currency: preview.currency,
        retainedCountedCents: outcome.countedCents ?? countedCents,
        initial: null,
        approved: {
          ordinaryExpectedCents: preview.ordinaryExpectedCents,
          giftCashCents: preview.giftCashCents,
          expectedCents: preview.expectedCents,
          varianceCents: countedCents - preview.expectedCents,
          countedCents,
        },
      });
      try {
        await refreshActiveShift();
      } catch (err) {
        console.warn('[StaffShiftModal] Active shift refresh after gift close failed:', err);
      }
      return;
    }
    if (outcome.kind === 'refused') {
      const paymentIntegrityPayload = extractPaymentIntegrityPayload(result);
      setCheckoutPaymentBlockers(paymentIntegrityPayload?.blockers || []);
      handover ??= satelliteHandoverMessage(result, t);
      if (handover) {
        if (handover.refused) setSatelliteReleaseShiftId(shiftId);
        setError(handover.text);
        return;
      }
      if (GIFT_CLOSE_TERMS_CODES.has(outcome.code)) {
        setClosingCash('');
      }
      setError(giftText(giftCloseCodeText(outcome.code)));
      if (GIFT_CLOSE_TERMS_CODES.has(outcome.code) || GIFT_CLOSE_ORIGINAL_CODES.has(outcome.code) ||
          GIFT_CLOSE_REDISCOVER_CODES.has(outcome.code) || outcome.code === 'LOCAL_STORE_FAILED') {
        rediscoverGiftClose();
      }
      return;
    }
    setError(giftText(giftCloseCodeText('LOCAL_READ_FAILED')));
    rediscoverGiftClose();
  };

  const handlePrintCheckout = async () => {
    if (!effectiveShift) {
      setError(t('modals.staffShift.noActiveShift'));
      return;
    }

    if (giftCloseOwnsCheckout || giftCloseChecking) {
      // Only a canonically confirmed original prints, from native proof.
      await queueShiftCheckoutPrint({
        bridge,
        shiftId: effectiveShift.id,
        roleType: effectiveShift.role_type,
        giftClose: 'pending',
      });
      setError(giftText(giftCloseText('printPending', 'The checkout prints only after financial confirmation.')));
      return;
    }

    const snapshot = buildShiftCheckoutPrintSnapshot({
      shift: effectiveShift,
      shiftSummary,
      closingCash,
      driverActualCash,
      isNonFinancialCheckoutRole,
      snapshotCheckOutTime: new Date().toISOString(),
    });

    if (!snapshot) {
      setError(
        t('modals.staffShift.checkoutPrintUnavailable', {
          defaultValue: 'Complete the checkout inputs before printing.',
        }),
      );
      return;
    }

    setIsPrintCheckoutLoading(true);
    setError('');
    setSuccess('');

    try {
      const printResult = await queueShiftCheckoutPrint({
        bridge,
        shiftId: effectiveShift.id,
        roleType: effectiveShift.role_type,
        snapshot,
      }) as ShiftPrintCheckoutResult;

      if (printResult?.success) {
        setSuccess(
          printResult?.skipped
            ? t('modals.staffShift.checkoutPrintSkipped', {
                defaultValue: 'Checkout printing is disabled for this terminal.',
              })
            : t('modals.staffShift.checkoutPrintQueued', {
                defaultValue: 'Checkout print queued.',
              }),
        );
      } else {
        setError(
          printResult?.error ||
            t('modals.staffShift.checkoutPrintFailed', {
              defaultValue: 'Failed to print checkout summary.',
            }),
        );
      }
    } catch (err) {
      setError(
        extractErrorMessage(
          err,
          t('modals.staffShift.checkoutPrintFailed', {
            defaultValue: 'Failed to print checkout summary.',
          }),
        ),
      );
    } finally {
      setIsPrintCheckoutLoading(false);
    }
  };

  // "Record cash" / "Record card" on a checkout blocker (item F, 30/09/2026;
  // parity with Android's "Record the payment"): confirmed first, then
  // approved like the other money actions on this terminal (cashier or
  // manager shift + PIN). The till keys it `z-record:<order>:<cents>` and
  // audits who recorded it, with `charged: false`. Nothing is charged.
  const handleCheckoutRecordOutcome = (
    blocker: UnsettledPaymentBlocker,
    method: 'cash' | 'card',
    outcome: RecordPaymentBlockerOutcome,
  ) => {
    const methodLabel = t(
      method === 'cash' ? 'modals.zReport.cash' : 'modals.zReport.card',
    ).toLowerCase();
    switch (outcome.kind) {
      case 'cancelled':
        return;
      case 'shift_required':
        setError(
          t('modals.zReport.setAsideShiftRequired', {
            defaultValue:
              'A cashier or manager has to be checked in on this terminal to confirm it.',
          }),
        );
        return;
      case 'refused': {
        const paymentIntegrityPayload = extractPaymentIntegrityPayload(outcome.result);
        if (paymentIntegrityPayload?.blockers) {
          setCheckoutPaymentBlockers(paymentIntegrityPayload.blockers);
        }
        setError(
          formatPaymentIntegrityError(
            outcome.result,
            t('modals.staffShift.closeShiftFailed'),
            t,
          ),
        );
        return;
      }
      case 'failed': {
        const paymentIntegrityPayload = extractPaymentIntegrityPayload(outcome.error);
        if (paymentIntegrityPayload?.blockers) {
          setCheckoutPaymentBlockers(paymentIntegrityPayload.blockers);
        }
        setError(
          formatPaymentIntegrityError(
            outcome.error,
            t('modals.staffShift.closeShiftFailed'),
            t,
          ),
        );
        return;
      }
      case 'already_recorded':
      case 'recorded': {
        const remainingBlockers =
          extractPaymentIntegrityPayload({
            blockers: (outcome.result as { remainingBlockers?: unknown } | null)
              ?.remainingBlockers,
          })?.blockers ?? [];
        setCheckoutPaymentBlockers((current) => [
          ...current.filter((item) => item.orderId !== blocker.orderId),
          ...remainingBlockers,
        ]);
        setSuccess(
          outcome.kind === 'already_recorded'
            ? t('modals.zReport.recordAlreadyRecorded', {
                orderNumber: blocker.orderNumber,
                method: methodLabel,
                defaultValue:
                  'This {{method}} payment for {{orderNumber}} was already recorded. Nothing was added.',
              })
            : t('modals.staffShift.paymentRepairRecorded', {
                orderNumber: blocker.orderNumber,
                method: methodLabel,
                defaultValue:
                  'Recorded the missing {{method}} payment for {{orderNumber}}. Retry shift checkout.',
              }),
        );
      }
    }
  };

  const {
    runWithPrivilegedConfirmation: runCheckoutRecordApproval,
    confirmationModal: checkoutRecordApprovalModal,
  } = usePrivilegedActionConfirmation();
  const recordCheckoutBlocker = useRecordPaymentBlocker({
    runWithPrivilegedConfirmation: runCheckoutRecordApproval,
    record: (blocker, method, amountCents) => {
      setError('');
      setSuccess('');
      return bridge.reports.resolvePaymentBlocker({
        orderId: blocker.orderId,
        method,
        amountCents,
        staffShiftId: effectiveShift?.id,
        staffId:
          staff?.databaseStaffId ||
          (isUuidValue(staff?.staffId) ? staff.staffId.trim() : undefined),
      });
    },
    onOutcome: handleCheckoutRecordOutcome,
    setBusyKey: setResolvingCheckoutBlockerKey,
  });

  const handleRecordExpense = async () => {
    if (!effectiveShift || !staff) {
      setError(t('modals.staffShift.noActiveShift'));
      return;
    }

    if (!canRecordInlineExpenses) {
      setError(
        t('modals.staffShift.cashierExpenseOnly', {
          defaultValue: 'Expenses can only be recorded from cashier checkout',
        }),
      );
      return;
    }

    const amount = parseMoneyInputValue(expenseAmount);
    if (amount <= 0) {
      setError(t('modals.expense.invalidAmount'));
      return;
    }

    if (!expenseDescription.trim()) {
      setError(
        t('modals.expense.justificationRequired', {
          defaultValue: 'A clear justification is required before saving.',
        }),
      );
      return;
    }

    setLoading(true);
    setError('');

    try {
      const result = await bridge.shifts.recordExpense({
        shiftId: effectiveShift.id,
        expenseType,
        amount,
        description: expenseDescription,
        receiptNumber: canUseExpenseReceiptReference ? expenseReceipt || undefined : undefined
      });

      if (result.success) {
        setSuccess(
          t('modals.expense.expenseRecorded', {
            defaultValue: 'Expense charged to the active cashier drawer',
          }),
        );
        setExpenseAmount('');
        setExpenseDescription('');
        setExpenseReceipt('');
        setShowExpenseForm(false);
        await loadExpenses();
        await refreshShiftSummaryAfterExpenseMutation(effectiveShift.id);
        setTimeout(() => setSuccess(''), 2000);
      } else {
        setError(result.error || t('modals.staffShift.recordExpenseFailed'));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('modals.staffShift.recordExpenseFailed'));
    } finally {
      setLoading(false);
    }
  };

  const refreshShiftSummaryAfterExpenseMutation = async (shiftId: string) => {
    try {
      const summaryResult = await bridge.shifts.getSummary(shiftId, { skipBackfill: true });
      setShiftSummary(summaryResult?.data || summaryResult);
    } catch (error) {
      console.warn('Failed to refresh shift summary after expense mutation:', error);
    }
  };

  const handleDeleteExpense = async (expense: ShiftExpense) => {
    if (!effectiveShift?.id) {
      closeConfirm();
      setError(t('modals.staffShift.noActiveShift'));
      return;
    }

    setLoading(true);
    setDeletingExpenseId(expense.id);
    setError('');

    try {
      const result = await bridge.shifts.deleteExpense({
        expenseId: expense.id,
        shiftId: effectiveShift.id,
      });

      if (!result?.success) {
        throw new Error(
          result?.error ||
            t('modals.expense.expenseDeleteFailed', {
              defaultValue: 'Failed to delete expense',
            }),
        );
      }

      await loadExpenses(effectiveShift.id);
      await refreshShiftSummaryAfterExpenseMutation(effectiveShift.id);
      setSuccess(
        t('modals.expense.expenseDeleted', {
          defaultValue: 'Expense deleted',
        }),
      );
      setTimeout(() => setSuccess(''), 2000);
      closeConfirm();
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : t('modals.expense.expenseDeleteFailed', {
              defaultValue: 'Failed to delete expense',
            });

      if (message === 'Expense not found') {
        await loadExpenses(effectiveShift.id);
        await refreshShiftSummaryAfterExpenseMutation(effectiveShift.id);
        closeConfirm();
      } else {
        setError(message);
        closeConfirm();
      }
    } finally {
      setDeletingExpenseId(null);
      setLoading(false);
    }
  };

  const totalExpenses = expenses.reduce((sum, exp) => sum + exp.amount, 0);
  const expenseDescriptionPlaceholder = t('modals.expense.justificationPlaceholder', {
    defaultValue: 'Explain what left the drawer and why it was needed.',
  });
  const expenseReceiptPlaceholder = t('modals.expense.receiptPlaceholder', {
    defaultValue: 'Invoice, receipt, or reference number',
  });
  const recordExpenseLabel = t('modals.expense.recordExpense', {
    defaultValue: 'Record expense',
  });
  // Mirror ExpenseModal's contract: require a positive amount and a description
  // before the inline closeout expense can be recorded.
  const canRecordInlineExpense =
    !loading && parseMoneyInputValue(expenseAmount) > 0 && expenseDescription.trim().length > 0;
  const noExpensesLabel = t('modals.expense.noExpenses', {
    defaultValue: 'No expenses recorded yet',
  });
  const deleteExpenseLabel = t('modals.expense.deleteExpense', {
    defaultValue: 'Delete expense',
  });
  const getExpenseTypeLabel = (type: ShiftExpense['expense_type'] | string | null | undefined) => {
    const normalizedType =
      typeof type === 'string' && ['supplies', 'maintenance', 'petty_cash', 'refund', 'other'].includes(type)
        ? type
        : 'other';
    return t(`modals.expense.expenseTypes.${normalizedType}`, {
      defaultValue: t(`expense.categories.${normalizedType}`, {
        defaultValue: normalizedType,
      }),
    });
  };
  const getExpenseStatusLabel = (status: ShiftExpense['status']) =>
    t(`expense.status.${status}`, {
      defaultValue: status,
    });

  const getStatusSymbol = (delivery: any): React.ReactNode => {
    const rawStatus = delivery.status || delivery.order_status || '';
    const normalizedStatus = rawStatus.toLowerCase();
    const isCanceled = normalizedStatus === 'cancelled' || normalizedStatus === 'canceled' || normalizedStatus === 'refunded';
    return isCanceled
      ? <XCircle className="w-4 h-4 text-red-700 dark:text-red-400" />
      : <CheckCircle className="w-4 h-4 text-green-700 dark:text-green-400" />;
  };

  // The founder's payment glyphs (31/10: a hand with notes, two cards, a torn receipt), coloured as in the
  // payment window (payment-option-*-icon); their inner fill matches the card they sit on.
  const getPaymentSymbol = (paymentMethod: string): React.ReactNode => {
    const method = (paymentMethod || '').toLowerCase();
    const glyphStyle = { '--pay-icon-fill': 'var(--pos-s-surface)' } as React.CSSProperties;
    if (method === 'cash') return <span className="inline-flex" style={glyphStyle}><CashHandIcon className="h-5 w-5 payment-option-cash-icon" /></span>;
    if (method === 'mixed' || method === 'split') {
      return <span className="inline-flex" style={glyphStyle}><SplitReceiptIcon className="h-5 w-5 payment-option-split-icon" /></span>;
    }
    return <span className="inline-flex" style={glyphStyle}><CardsIcon className="h-5 w-5 payment-option-card-icon" /></span>;
  };

  const formatShiftWindow = (shift: any) => {
    if (!shift?.check_in_time) {
      return t('common.unknown', 'Unknown');
    }

    const start = formatTime(shift.check_in_time);
    const end = shift.check_out_time
      ? formatTime(shift.check_out_time)
      : t('shift.labels.active', 'Active');

    return `${start} - ${end}`;
  };

  const translateAuditOrderType = (orderType?: string | null) => {
    const normalized = (orderType || '')
      .trim()
      .toLowerCase()
      .replace(/^ordertype[.:_\s-]*/, '')
      .replace(/^order_type[.:_\s-]*/, '')
      .replace(/^type[.:_\s-]*/, '');

    switch (normalized) {
      case 'delivery':
        return t('modals.staffShift.auditOrderTypes.delivery');
      case 'pickup':
        return t('modals.staffShift.auditOrderTypes.pickup');
      case 'takeaway':
      case 'take_away':
        return t('modals.staffShift.auditOrderTypes.takeaway');
      case 'dine-in':
      case 'dinein':
      case 'dine_in':
      case 'in_store':
      case 'instore':
        return t('modals.staffShift.auditOrderTypes.dineIn');
      default:
        return t('modals.staffShift.auditOrderTypes.unknown');
    }
  };

  const translateAuditPaymentMethod = (paymentMethod?: string | null) => {
    switch ((paymentMethod || '').trim().toLowerCase()) {
      case 'cash':
      case 'cod':
        return t('modals.staffShift.cash');
      case 'card':
      case 'credit_card':
      case 'credit-card':
      case 'creditcard':
      case 'debit_card':
      case 'debit-card':
      case 'debitcard':
      case 'online':
      case 'digital':
        return t('modals.staffShift.card');
      case 'mixed':
      case 'split':
        return t('modals.staffShift.mixed');
      case 'pending':
      case 'unpaid':
        // Unpaid orders carry a "pending"/"unpaid" payment_method slug instead of a
        // real method; surface the existing localized pending label so the badge
        // never leaks a raw backend slug (e.g. "pending") in staff-facing UI.
        return t('modals.staffShift.orderStatuses.pending');
      default:
        return paymentMethod || t('common.unknown', 'Unknown');
    }
  };

  const translateAuditStatus = (status?: string | null) => {
    switch ((status || '').trim().toLowerCase()) {
      case 'completed':
      case 'delivered':
        return t('modals.staffShift.orderStatuses.completed');
      case 'cancelled':
      case 'canceled':
        return t('modals.staffShift.orderStatuses.cancelled');
      case 'refunded':
        return t('modals.staffShift.orderStatuses.refunded');
      case 'closed':
        return t('modals.staffShift.orderStatuses.closed');
      case 'active':
        return t('modals.staffShift.orderStatuses.active');
      case 'pending':
        return t('modals.staffShift.orderStatuses.pending');
      default:
        return status || t('common.unknown', 'Unknown');
    }
  };

  // Order status as coloured words, no wrapper (founder 01/11): done green, cancelled red, open warn.
  const getAuditStatusBadgeClass = (status?: string | null) => {
    switch ((status || '').trim().toLowerCase()) {
      case 'completed':
      case 'delivered':
      case 'closed':
        return 'text-(--pos-s-ok)';
      case 'cancelled':
      case 'canceled':
      case 'refunded':
        return 'text-(--pos-s-bad)';
      case 'active':
      case 'pending':
        return 'text-(--pos-s-warn)';
      default:
        return 'liquid-glass-modal-text';
    }
  };

  const checkoutHeaderData = (() => {
    if (effectiveMode !== 'checkout' || !effectiveShift) {
      return null;
    }

    const headerMetrics = getShiftHeaderMetrics(shiftSummary, effectiveShift);
    const openingAmount = getEffectiveOpeningAmount(effectiveShift, shiftSummary);
    const roleLabel = translateRoleName(effectiveShift.role_type);
    const shiftWindow = formatShiftWindow(effectiveShift);

    let primaryLabel = shiftSummary?.netCollections
      ? t('modals.staffShift.netCollections', 'Net collections')
      : t('modals.staffShift.totalSalesLabel', 'Total Sales');
    let primaryAmount = headerMetrics.totalAmount;
    let helper = t('modals.staffShift.reviewAndConfirm', 'Review and confirm');
    let variant: 'info' | 'warning' | 'success' | 'error' = 'info';
    let minimal = false;

    if (isCashierCheckoutRole && shiftSummary) {
      const breakdown = getCashierExpectedBreakdown(
        shiftSummary,
        effectiveShift,
        openingAmount,
        cashierCheckoutExpenseTotal,
      );
      primaryLabel = t('modals.staffShift.expectedInDrawer', { defaultValue: 'Expected In Drawer' });
      primaryAmount = breakdown.expected;
      helper = t('modals.staffShift.expectedInDrawerHelper', {
        defaultValue: 'Count the drawer and confirm the actual cash before closing.'
      });
      variant = 'warning';
    } else if (effectiveShift.role_type === 'driver' && shiftSummary) {
      const deliveries = Array.isArray(shiftSummary.driverDeliveries) ? shiftSummary.driverDeliveries : [];
      const completedDeliveries = deliveries.filter((d: any) => {
        const status = (d.status || d.order_status || '').toLowerCase();
        return status !== 'cancelled' && status !== 'canceled' && status !== 'refunded';
      });
      const cashCollected = deliveries.reduce((sum: number, d: any) => sum + (d.cash_collected || 0), 0);
      const tipsReceived = Number(shiftSummary?.tipsReceived || shiftSummary?.tips_received || 0);
      const amountToReturn = calculateDriverReturn({
        openingAmount,
        cashCollected,
        expenses: shiftSummary.totalExpenses || 0,
        tipsReceived,
      });
      primaryLabel = t('modals.staffShift.amountToReturn', {
        defaultValue: 'Return',
      });
      primaryAmount = Math.abs(amountToReturn);
      helper = t('modals.staffShift.cashReturnHelper', {
        defaultValue: 'Hand this cash to the cashier. Tips are recorded separately.',
      });
      variant = amountToReturn >= 0 ? 'info' : 'error';
    } else if (effectiveShift.role_type === 'server' && shiftSummary?.waiterTables) {
      const cashFromTables = shiftSummary.waiterTables.reduce((sum: number, table: any) => sum + (table.cash_amount || 0), 0);
      const calculationVersion = effectiveShift.calculation_version || 1;
      const paymentAmount = effectiveShift.payment_amount || 0;
      const cashToReturn = calculationVersion >= 2
        ? openingAmount + cashFromTables - (shiftSummary.totalExpenses || 0)
        : openingAmount + cashFromTables - (shiftSummary.totalExpenses || 0) - paymentAmount;

      primaryLabel = t('modals.staffShift.cashToHandToCashier', {
        defaultValue: 'Cash To Hand To Cashier',
      });
      primaryAmount = Math.abs(cashToReturn);
      helper = calculationVersion >= 2
        ? t('modals.staffShift.cashReturnHelper', {
          defaultValue: 'Hand this cash to the cashier. Tips are recorded separately.',
        })
        : t('modals.staffShift.paymentDeductedNote', {
          defaultValue: 'Payment already deducted from amount to return'
        });
      variant = cashToReturn >= 0 ? 'info' : 'error';
    } else if (isNonFinancialCheckoutRole) {
      primaryLabel = t('modals.staffShift.reviewAndConfirm', 'Review and confirm');
      primaryAmount = 0;
      helper = t('modals.staffShift.nonFinancialCheckoutHelper', {
        defaultValue: 'This role does not require cash reconciliation. Closing the shift will only record the checkout time.',
      });
      variant = 'success';
      minimal = true;
    }

    return {
      headerMetrics,
      openingAmount,
      roleLabel,
      shiftWindow,
      primaryLabel,
      primaryAmount,
      helper,
      variant,
      minimal,
    };
  })();

  const checkoutFooterData = (() => {
    if (effectiveMode !== 'checkout' || !effectiveShift) {
      return null;
    }

    if (isNonFinancialCheckoutRole) {
      return {
        label: t('modals.staffShift.readyToClose', { defaultValue: 'Ready To Close' }),
        amount: 0,
        note: t('modals.staffShift.nonFinancialFooterNote', {
          defaultValue: 'No sales, expenses, refunds, or cash amounts will be recorded for this role during checkout.',
        }),
        accentClass: 'text-emerald-800 dark:text-emerald-300',
        minimal: true,
      };
    }

    if (giftCloseOwnsCheckout) {
      return {
        label: giftText(giftCloseText('title', 'Gift card cash close')),
        amount: 0,
        note: giftText(giftCloseText('footerNote', 'Review the expected cash above.')),
        accentClass: 'text-yellow-800 dark:text-yellow-300',
        minimal: true,
      };
    }

    if (isCashierCheckoutRole && shiftSummary) {
      const opening = getEffectiveOpeningAmount(effectiveShift, shiftSummary);
      const breakdown = getCashierExpectedBreakdown(
        shiftSummary,
        effectiveShift,
        opening,
        cashierCheckoutExpenseTotal,
      );
      const actual = closingCash.trim() ? parseMoneyInputValue(closingCash) : null;
      const variance = actual === null ? null : actual - breakdown.expected;

      return {
        label: t('modals.staffShift.expectedInDrawer', { defaultValue: 'Expected In Drawer' }),
        amount: breakdown.expected,
        note: closingCash.trim()
          ? t('modals.staffShift.countedCashVariance', {
            defaultValue: 'Counted {{counted}} · Variance {{variance}}',
            counted: formatDrawerCurrency(actual ?? 0),
            variance: `${(variance ?? 0) >= 0 ? '+' : '-'}${formatDrawerCurrency(Math.abs(variance ?? 0))}`,
          })
          : t('modals.staffShift.countedCashPrompt', {
            defaultValue: 'Enter counted cash to confirm the final drawer amount.'
          }),
        // The expected cash in the kit green, as in the card above (founder 01/11/2026).
        accentClass: 'text-(--pos-s-ok)',
        minimal: false,
      };
    }

    if (effectiveShift.role_type === 'driver' && shiftSummary) {
      const deliveries = Array.isArray(shiftSummary.driverDeliveries) ? shiftSummary.driverDeliveries : [];
      const completedDeliveries = deliveries.filter((d: any) => {
        const status = (d.status || d.order_status || '').toLowerCase();
        return status !== 'cancelled' && status !== 'canceled' && status !== 'refunded';
      });
      const expected = getEffectiveOpeningAmount(effectiveShift, shiftSummary)
        + deliveries.reduce((sum: number, d: any) => sum + (d.cash_collected || 0), 0)
        - (shiftSummary.totalExpenses || 0);
      const actual = driverActualCash.trim() ? parseMoneyInputValue(driverActualCash) : null;
      const variance = actual === null ? null : actual - expected;

      return {
        label: t('modals.staffShift.cashToHandToCashier', {
          defaultValue: 'Cash To Hand To Cashier',
        }),
        amount: Math.abs(expected),
        note: driverActualCash.trim()
          ? t('modals.staffShift.countedCashVariance', {
            defaultValue: 'Returned {{counted}} · Variance {{variance}}',
            counted: formatCurrency(actual ?? 0),
            variance: `${(variance ?? 0) >= 0 ? '+' : '-'}${formatCurrency(Math.abs(variance ?? 0))}`,
          })
          : t('modals.staffShift.actualCashReturnedRequired', {
            defaultValue: 'Enter the cash actually handed to the cashier before checkout.',
          }),
        accentClass: expected >= 0 ? 'liquid-glass-modal-text-muted' : 'text-red-800 dark:text-red-300',
        minimal: false,
      };
    }

    if (effectiveShift.role_type === 'server' && shiftSummary?.waiterTables) {
      const opening = getEffectiveOpeningAmount(effectiveShift, shiftSummary);
      const cashFromTables = shiftSummary.waiterTables.reduce((sum: number, table: any) => sum + (table.cash_amount || 0), 0);
      const expensesTotal = shiftSummary.totalExpenses || 0;
      const calculationVersion = effectiveShift.calculation_version || 1;
      const paymentAmount = effectiveShift.payment_amount || 0;
      const expected = calculationVersion >= 2
        ? opening + cashFromTables - expensesTotal
        : opening + cashFromTables - expensesTotal - paymentAmount;
      const actual = closingCash.trim() ? parseMoneyInputValue(closingCash) : null;
      const variance = actual === null ? null : actual - expected;

      return {
        label: t('modals.staffShift.cashToHandToCashier', {
          defaultValue: 'Cash To Hand To Cashier',
        }),
        amount: Math.abs(expected),
        note: closingCash.trim()
          ? t('modals.staffShift.countedCashVariance', {
            defaultValue: 'Returned {{counted}} · Variance {{variance}}',
            counted: formatCurrency(actual ?? 0),
            variance: `${(variance ?? 0) >= 0 ? '+' : '-'}${formatCurrency(Math.abs(variance ?? 0))}`,
          })
          : t('modals.staffShift.actualCashReturnedRequired', {
            defaultValue: 'Enter the cash actually handed to the cashier before checkout.',
          }),
        accentClass: expected >= 0 ? 'liquid-glass-modal-text-muted' : 'text-red-800 dark:text-red-300',
        minimal: false,
      };
    }

    return {
      label: t('modals.staffShift.reviewAndConfirm', { defaultValue: 'Review and confirm' }),
      amount: 0,
      note: t('modals.staffShift.closeShiftHelper', {
        defaultValue: 'Confirm the checkout details and close the shift.',
      }),
      accentClass: 'text-emerald-800 dark:text-emerald-300',
      minimal: true,
    };
  })();

  // Phone shifts of this Main's unit (founder 13/10/2026): names for the close
  // gate and the lists, and the remote-checkout pane opened by shift id.
  const phoneShiftPhoneText = (shift: UnitShift) => {
    const phone = unitShiftPhoneLabel(shift);
    const state = unitShiftPhoneState(shift);
    if (state === 'deactivated') {
      return `${phone} · ${t('phoneShifts.phoneDeactivated', { defaultValue: 'phone deactivated' })}`;
    }
    if (state === 'removed') {
      return `${phone} · ${t('phoneShifts.phoneRemoved', { defaultValue: 'phone removed' })}`;
    }
    return phone;
  };
  const phoneTillAmount = (shift: UnitClosedShift) =>
    formatCurrency(unitShiftCashToReceive(shift), shift.currency ?? undefined);
  /** HH:MM of a readiness or heartbeat moment, in the till's language. */
  const readinessTime = (iso: string) => formatTime(iso, { hour: '2-digit', minute: '2-digit' });
  /**
   * What the phone sections show: the fresh read, else (it failed) the last
   * good one with its time; `null` while loading, for the legacy list
   * (`unsupported`) or when no good read exists.
   */
  const shownUnitReadiness = (): { readiness: UnitReadiness; staleSince: string | null } | null => {
    if (unitReadiness?.kind === 'ready') return { readiness: unitReadiness.readiness, staleSince: null };
    if (unitReadiness?.kind === 'unavailable' && unitReadinessLastGood) {
      return { readiness: unitReadinessLastGood.readiness, staleSince: unitReadinessLastGood.checkedAt };
    }
    return null;
  };

  const unitCloseBlocker = (readiness: UnitReadiness, released: ReadonlySet<string>): string | null => {
    const reasons: string[] = [];
    if (readiness.openShifts.length > 0) {
      reasons.push(t('modals.staffShift.phoneShifts.openBlocker', {
        defaultValue: 'Close the phone shifts before closing this shift: {{shifts}}. Close them on the phone, or here in staff selection.',
        shifts: readiness.openShifts.map(shift => t('modals.staffShift.phoneShifts.shiftEntry', {
          defaultValue: '{{name}} ({{role}}, {{phone}})',
          name: unitShiftStaffLabel(shift),
          role: translateRoleName(shift.role_type || 'staff'),
          phone: phoneShiftPhoneText(shift),
        })).join(', '),
      }));
    }
    // Only tills this Main can receive now and no manager released wait; any
    // other pending till is information (a manager settles it).
    const receivable = tillsToReceive(readiness.pendingReturns, released);
    if (receivable.length > 0) {
      reasons.push(t('modals.staffShift.phoneShifts.receiveBlocker', {
        defaultValue: 'Receive the cash from these phone tills in staff selection before closing this shift: {{tills}}.',
        tills: receivable.map(till => t('modals.staffShift.phoneShifts.tillEntry', {
          defaultValue: '{{name}} ({{phone}}, {{amount}})',
          name: unitShiftStaffLabel(till),
          phone: phoneShiftPhoneText(till),
          amount: phoneTillAmount(till),
        })).join(', '),
      }));
    }
    return reasons.length > 0 ? reasons.join(' ') : null;
  };

  // The pane needs a staff member; a phone shift of someone the directory
  // does not list (inactive staff) still gets one, from the server's answer.
  const phoneShiftStaff = (shift: UnitShift): StaffMember => {
    const member = availableStaff.find(person => person.id === shift.staff_id);
    if (member) return member;
    const name = unitShiftStaffLabel(shift);
    return {
      id: shift.staff_id || `phone-shift:${shift.id}`,
      name,
      first_name: name,
      last_name: '',
      email: '',
      role_id: '',
      role_name: shift.role_type || '',
      role_display_name: '',
      roles: [],
      can_login_pos: false,
      is_active: false,
    };
  };

  const receivePhoneTill = (till: UnitClosedShift) => {
    void handleStaffSelect(phoneShiftStaff(till), {
      ...till,
      self_closed: true,
      remote_terminal_name: unitShiftPhoneLabel(till),
    });
  };

  const closePhoneShiftFromMain = (shift: UnitShift) => {
    void handleStaffSelect(phoneShiftStaff(shift), {
      id: shift.id,
      staff_id: shift.staff_id,
      status: 'active',
      role_type: shift.role_type || '',
      terminal_id: shift.terminal_id,
      remote_terminal_name: unitShiftPhoneLabel(shift),
      remote: true,
      check_in_time: shift.check_in_time,
      opening_cash_amount: shift.opening_cash_amount,
    });
  };

  const closeSatelliteCheckout = () => {
    setSatelliteCheckout(null);
    setSatellitePreview({ loading: false, error: null, figures: null });
    setSatelliteCountedCash('');
    setSatelliteResult(null);
    setSatellitePending(false);
    setSatelliteRefusedForGood(false);
    setSelectedStaff(null);
  };

  // Coordinator review 14/10/2026: a preview the server refused for good (an
  // HTTP 403/409 with a code other than REMOTE_HANDOVER_RETRY) offers "Close
  // without handover". A till that is not this phone's Main is refused that
  // close too, so it is not offered there.
  const previewRefusedForGood = (payload: unknown): boolean => {
    if (!payload || typeof payload !== 'object') return false;
    const answer = payload as { status?: unknown; code?: unknown; error?: unknown };
    const status = typeof answer.status === 'number' ? answer.status : null;
    const code = typeof answer.code === 'string' && answer.code
      ? answer.code
      : typeof answer.error === 'string' ? answer.error.match(/\bREMOTE_[A-Z0-9_]*[A-Z0-9]/)?.[0] ?? null : null;
    return (status === 403 || status === 409) && closesWithoutHandoverAfter(code);
  };
  const closesWithoutHandoverAfter = (code: string | null): boolean =>
    code !== null && code !== REMOTE_HANDOVER_RETRY
      && code !== 'REMOTE_CHECKOUT_MAIN_ONLY' && code !== 'REMOTE_CHECKOUT_NOT_UNIT_CHILD';

  const handleClosedWithoutHandover = (outcome: CloseWithoutHandoverOutcome) => {
    const name = satelliteCheckout?.staff.name ?? '';
    closeSatelliteCheckout();
    setError('');
    setSuccess(outcome.alreadyClosed
      ? t('modals.staffShift.phoneShifts.closeWithoutHandover.alreadyClosed', {
        defaultValue: "{{name}}'s shift was already closed. Nothing was added to this drawer.",
        name,
      })
      : outcome.status === 'closed'
        ? t('modals.staffShift.phoneShifts.closeWithoutHandover.closed', {
          defaultValue: "{{name}}'s shift is closed without a handover. Nothing was added to this drawer.",
          name,
        })
        : t('modals.staffShift.phoneShifts.closeWithoutHandover.closedNotCounted', {
          defaultValue: "{{name}}'s shift is closed without a handover and its cash is marked not counted. Nothing was added to this drawer; a manager settles its money.",
          name,
        }));
    setWaiterReturnsReload(value => value + 1);
    void loadStaff();
  };

  const handleSatelliteRemoteCheckout = async () => {
    if (!satelliteCheckout || !satellitePreview.figures || satelliteSubmitting) return;
    const counted = Number(satelliteCountedCash.replace(',', '.'));
    const currency = recordedFolioCurrency(satellitePreview.figures.currency);
    if (!satelliteCountedCash.trim() || !Number.isFinite(counted) || counted < 0 || !currency) return;
    setSatelliteSubmitting(true);
    setError('');
    try {
      const local = (await bridge.settings.get()) as any;
      const outcome = await submitSatelliteHandover(bridge.shifts, {
        branchId: String(local?.['terminal.branch_id'] ?? local?.terminal?.branch_id ?? ''),
        terminalId: String(local?.['terminal.terminal_id'] ?? local?.terminal?.terminal_id ?? ''),
        satelliteShiftId: String(satelliteCheckout.shift.id),
        openingCash: Number(satellitePreview.figures.opening_cash_amount || 0),
        countedCash: counted, currency, closedBy: staff?.databaseStaffId ?? null,
      });
      if (outcome.status === 'pending') {
        setSatellitePending(true);
        return;
      }
      setSatellitePending(false);
      setSatelliteResult({ counted: outcome.counted, expected: outcome.expected, currency: outcome.currency,
        variance: outcome.variance, staffName: satelliteCheckout.staff.name });
      setWaiterReturnsReload(value => value + 1);
      void loadStaff();
    } catch (failure) {
      const message = satelliteHandoverMessage(failure, t);
      // Refused for good (never REMOTE_HANDOVER_RETRY): the open phone shift
      // can still close without a handover, with a manager's PIN.
      if (message?.refused && closesWithoutHandoverAfter(message.code ?? 'SATELLITE_HANDOVER_REFUSED')) {
        setSatelliteRefusedForGood(true);
      }
      setError(message?.text || String((failure as Error)?.message || failure));
    } finally {
      setSatelliteSubmitting(false);
    }
  };

  // Founder 13/10/2026: closed phone tills waiting for this Main, and every
  // open phone shift no staff card reaches (staff no longer active, a removed
  // phone). Each one holds the Z, so each one can be closed from here.
  const renderPhoneShiftSections = () => {
    if (isMobileWaiter) return null;
    if (!unitReadiness || unitReadiness.kind === 'unsupported') {
      if (pendingWaiterReturns.length === 0 && !waiterReturnsError) return null;
      return (
        <section className={`${checkInSurfaceClass} flex flex-col`}>
          <h4 className="pos-group__title">{t('modals.staffShift.satelliteCheckout.awaitingReceipt')}</h4>
          <AnimatePresence initial={false}>
          {waiterReturnsError && <motion.div key="reveal-1" {...revealMotion}><ShiftRevealContent><p role="alert" className="pos-notice pos-notice--bad mt-3 text-sm font-semibold">{t('modals.staffShift.satelliteCheckout.pendingReadFailed')}</p></ShiftRevealContent></motion.div>}
          </AnimatePresence>
          <div className="mt-3 flex flex-wrap items-stretch gap-3">
            {pendingWaiterReturns.map(row => {
              const member = availableStaff.find(person => person.id === row.staff_id);
              return <button key={row.id} type="button" disabled={!member}
                onClick={() => member && void handleStaffSelect(member, { ...row, self_closed: true, remote_terminal_name: row.terminal_id })}
                className="pos-glass-tap-card min-h-[56px] px-4 py-3 text-left font-semibold liquid-glass-modal-text">
                {row.staff_name || member?.name} · {formatCurrency(row.closing_cash_amount, row.currency)}
                <span className="block text-sm font-normal">{t('modals.staffShift.satelliteCheckout.receive')}</span>
              </button>;
            })}
            <button type="button" onClick={() => setWaiterReturnsReload(value => value + 1)} className="pos-solid-btn pos-solid-btn--sm self-center">{t('common.refresh')}</button>
          </div>
        </section>
      );
    }
    // Coordinator review 14/10/2026: a failed read keeps the last good one,
    // marked with its time; "unavailable" shows only without any good read.
    const shown = shownUnitReadiness();
    if (!shown) {
      return (
        <section className={`${checkInSurfaceClass} flex flex-col`} data-testid="phone-shifts-unavailable">
          <h4 className="pos-group__title">{t('phoneShifts.title', { defaultValue: 'Phone shifts' })}</h4>
          <p role="alert" className="pos-notice pos-notice--bad mt-3 text-sm font-semibold">
            {t('phoneShifts.unavailable', { defaultValue: 'Phone shifts could not be checked. Check the connection and try again.' })}
          </p>
          <button type="button" onClick={() => setWaiterReturnsReload(value => value + 1)} className="pos-solid-btn pos-solid-btn--sm mt-3">
            {t('phoneShifts.retry', { defaultValue: 'Retry' })}
          </button>
        </section>
      );
    }
    // A unit without phones that has nothing open or pending shows nothing.
    if (!unitHasPhones(shown.readiness) && unitIsQuiet(shown.readiness)) return null;
    const { pendingReturns, openShifts } = shown.readiness;
    const receiveHere = new Set(tillsToReceive(pendingReturns, releasedPhoneTillIds).map(till => till.id));
    const cardedShiftIds = new Set<string>();
    for (const member of activeCheckInStaff) {
      const satellite = satelliteShiftsByStaffId.get(member.id);
      if (satellite?.id) cardedShiftIds.add(String(satellite.id));
    }
    const uncardedShifts = openShifts.filter(shift => !cardedShiftIds.has(shift.id));
    if (!shown.staleSince && pendingReturns.length === 0 && uncardedShifts.length === 0) return null;
    return (
      <>
        <AnimatePresence initial={false}>
        {shown.staleSince && <motion.div key="reveal-2" {...revealMotion}><ShiftRevealContent>
          <section className={`${checkInSurfaceClass} flex flex-col`} data-testid="phone-shifts-last-checked">
            <h4 className="pos-group__title">{t('phoneShifts.title', { defaultValue: 'Phone shifts' })}</h4>
            <p role="status" className="pos-notice pos-notice--warn mt-3 text-sm font-semibold">
              {t('modals.staffShift.phoneShifts.lastChecked', {
                defaultValue: 'No connection. Phone shifts as last checked at {{time}}.',
                time: readinessTime(shown.staleSince),
              })}
            </p>
            <button type="button" onClick={() => setWaiterReturnsReload(value => value + 1)} className="pos-solid-btn pos-solid-btn--sm mt-3">
              {t('phoneShifts.retry', { defaultValue: 'Retry' })}
            </button>
          </section>
        </ShiftRevealContent></motion.div>}
        </AnimatePresence>
        <AnimatePresence initial={false}>
        {pendingReturns.length > 0 && <motion.div key="reveal-3" {...revealMotion}><ShiftRevealContent>
          <section className={`${checkInSurfaceClass} flex flex-col`} data-testid="phone-tills-awaiting">
            <h4 className="pos-group__title">{t('modals.staffShift.satelliteCheckout.awaitingReceipt')}</h4>
            <div className="mt-3 flex flex-wrap items-stretch gap-3">
              {pendingReturns.map(till => {
                const heading = `${unitShiftStaffLabel(till)} · ${phoneTillAmount(till)}`;
                // Only a till this Main can receive now, and whose local claim
                // no manager released, keeps the Receive button.
                if (!receiveHere.has(till.id)) {
                  return (
                    <div key={till.id} data-testid={`phone-till-info-${till.id}`}
                      className="pos-glass-form-card p-3! text-left">
                      <span className="block font-semibold liquid-glass-modal-text">{heading}</span>
                      <span className={`block ${checkInMutedTextClass}`}>{phoneShiftPhoneText(till)}</span>
                      <span className={`block ${checkInMutedTextClass}`}>
                        {/* Founder decision 15/10/2026: a till waiting for a
                            cashier is received here once one is checked in;
                            only what can never be received is a manager's. */}
                        {till.settle === 'needs_cashier' && !releasedPhoneTillIds.has(till.id)
                          ? t('modals.staffShift.phoneShifts.needsCashier', { defaultValue: 'Received here once a cashier is checked in.' })
                          : t('modals.staffShift.phoneShifts.managerSettles', { defaultValue: "This till can't be received here. A manager settles it." })}
                      </span>
                    </div>
                  );
                }
                return (
                  <button key={till.id} type="button" data-testid={`phone-till-receive-${till.id}`}
                    onClick={() => receivePhoneTill(till)}
                    className="pos-glass-tap-card min-h-[56px] px-4 py-3 text-left font-semibold liquid-glass-modal-text">
                    {heading}
                    <span className="block text-sm font-normal">{phoneShiftPhoneText(till)}</span>
                    <span className="block text-sm font-normal">{t('modals.staffShift.satelliteCheckout.receive')}</span>
                  </button>
                );
              })}
              <button type="button" onClick={() => setWaiterReturnsReload(value => value + 1)} className="pos-solid-btn pos-solid-btn--sm self-center">{t('common.refresh')}</button>
            </div>
          </section>
        </ShiftRevealContent></motion.div>}
        </AnimatePresence>
        <AnimatePresence initial={false}>
        {uncardedShifts.length > 0 && <motion.div key="reveal-4" {...revealMotion}><ShiftRevealContent>
          <section className={`${checkInSurfaceClass} flex flex-col`} data-testid="phone-shifts-open">
            <h4 className="pos-group__title">{t('phoneShifts.title', { defaultValue: 'Phone shifts' })}</h4>
            <p className={`mt-2 ${checkInMutedTextClass}`}>
              {t('modals.staffShift.phoneShifts.openHelper', { defaultValue: 'Still open on a phone. Each one holds the Z until it is closed.' })}
            </p>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              {uncardedShifts.map(shift => (
                <button key={shift.id} type="button" data-testid={`phone-shift-close-${shift.id}`}
                  onClick={() => closePhoneShiftFromMain(shift)}
                  className="pos-glass-tap-card min-h-[56px] w-full px-4 py-3 text-left">
                  <span className="block truncate text-base font-semibold liquid-glass-modal-text">{unitShiftStaffLabel(shift)}</span>
                  <WorkCardLine status={workCard} staffId={shift.staff_id} />
                  <span className="mt-2 flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold liquid-glass-modal-text">
                      {translateRoleName(shift.role_type || 'staff')}
                    </span>
                    <span className={`text-sm font-semibold ${unitShiftPhoneState(shift) === 'active' ? 'liquid-glass-modal-text-muted' : 'text-(--pos-s-warn)'}`}>
                      {t('modals.staffShift.satelliteTerminalChip', { defaultValue: 'on {{terminal}}', terminal: phoneShiftPhoneText(shift) })}
                    </span>
                    {shift.check_in_time ? (
                      <span className={`inline-flex items-center gap-1.5 text-sm ${checkInMutedTextClass}`}>
                        <Clock className="h-4 w-4 shrink-0" />
                        {t('phoneShifts.checkedInAt', { defaultValue: 'checked in {{time}}', time: formatTime(shift.check_in_time) })}
                      </span>
                    ) : null}
                  </span>
                  <span className="mt-3 inline-flex items-center gap-1 text-sm font-semibold liquid-glass-modal-text">
                    {t('modals.staffShift.phoneShifts.closeHere', { defaultValue: 'Close the shift here' })}
                    <ChevronRight className="h-4 w-4 shrink-0" />
                  </span>
                </button>
              ))}
            </div>
          </section>
        </ShiftRevealContent></motion.div>}
        </AnimatePresence>
      </>
    );
  };

  const renderSatelliteCheckoutView = () => {
    if (!satelliteCheckout) return null;
    const figures = satellitePreview.figures;
    const countedValue = Number(satelliteCountedCash.replace(',', '.'));
    const currency = recordedFolioCurrency(figures?.currency);
    const formatSatelliteMoney = (amount: number) => formatCurrency(amount, satelliteResult?.currency ?? currency);
    const varianceValue =
      figures && Number.isFinite(countedValue)
        ? countedValue - Number(figures.expected_cash_amount || 0)
        : null;
    // An OPEN phone shift (not a till the phone closed itself).
    const openPhoneShift = !satelliteCheckout.shift.self_closed;
    // Coordinator review 14/10/2026: a phone not heard from for over five
    // minutes may still hold orders or payments the figures do not have. Only
    // a shift in a readiness answer is checked (an old server sends none).
    const readinessShift = openPhoneShift
      ? shownUnitReadiness()?.readiness.openShifts.find(entry => entry.id === String(satelliteCheckout.shift.id)) ?? null
      : null;
    const staleLastSeen = readinessShift && phoneLastSeenIsStale(readinessShift.terminal_last_seen_at)
      ? {
        at: readinessShift.terminal_last_seen_at && Number.isFinite(Date.parse(readinessShift.terminal_last_seen_at))
          ? readinessShift.terminal_last_seen_at
          : null,
      }
      : null;
    const offerCloseWithoutHandover = openPhoneShift && !satelliteResult && !satelliteSubmitting
      && !satellitePreview.loading
      && (satelliteRefusedForGood || isNonCashPhoneRole(satelliteCheckout.shift.role_type as string | null | undefined));
    return (
      <div className="space-y-4" data-testid="satellite-checkout-section">
        <WorkCardLine status={workCard} staffId={satelliteCheckout.staff.id} />
        <div className={checkoutSurfaceClass}>
          <h3 className="text-lg font-black liquid-glass-modal-text">
            {t('modals.staffShift.satelliteCheckout.title', {
              defaultValue: 'Cash handover — {{name}}',
              name: satelliteCheckout.staff.name,
            })}
          </h3>
          <p className={checkInMutedTextClass}>
            {t('modals.staffShift.satelliteTerminalChip', {
              defaultValue: 'on {{terminal}}',
              terminal: satelliteCheckout.shift.remote_terminal_name,
            })}
            {satelliteCheckout.shift.check_in_time
              ? ` · ${formatTime(satelliteCheckout.shift.check_in_time)}`
              : ''}
          </p>

          <AnimatePresence initial={false}>
          {staleLastSeen && !satelliteResult && <motion.div key="reveal-5" {...revealMotion}><ShiftRevealContent>
            <p role="status" data-testid="phone-last-seen-warning"
              className="mt-4 rounded-2xl border border-(--pos-s-warn) bg-(--pos-s-warn-bg) px-4 py-3 text-sm font-semibold text-amber-800 dark:text-amber-200">
              {staleLastSeen.at
                ? t('modals.staffShift.phoneShifts.lastSeenStale', {
                  defaultValue: 'This phone was last online at {{time}}. Orders or payments it has not sent are not in these figures.',
                  time: readinessTime(staleLastSeen.at),
                })
                : t('modals.staffShift.phoneShifts.lastSeenUnknown', {
                  defaultValue: "This phone's last connection is unknown. Orders or payments it has not sent may be missing from these figures.",
                })}
            </p>
          </ShiftRevealContent></motion.div>}
          </AnimatePresence>

          <AnimatePresence initial={false}>
          {satellitePending && <motion.div key="reveal-6" {...revealMotion}><ShiftRevealContent><p role="status" className="mt-4 text-sm text-amber-700 dark:text-amber-300">{t('modals.staffShift.satelliteCheckout.pending')}</p></ShiftRevealContent></motion.div>}
          </AnimatePresence>
          <AnimatePresence initial={false}>
          {figures && !currency && <motion.div key="reveal-7" {...revealMotion}><ShiftRevealContent><p role="alert" className="mt-4 text-sm text-rose-500">{t('guestBilling.errors.shiftCurrency')}</p></ShiftRevealContent></motion.div>}
          </AnimatePresence>
          <AnimatePresence initial={false}>
          {satelliteResult ? (
            <motion.div key="reveal-8-yes" {...revealMotion} className={`mt-4 ${checkoutInsetSurfaceClass}`} data-testid="satellite-checkout-success"><ShiftRevealContent>
              <p className="text-base font-bold liquid-glass-modal-text">
                {t(satelliteCheckout.shift.self_closed ? 'modals.staffShift.satelliteCheckout.received' : 'modals.staffShift.satelliteCheckout.success', {
                  defaultValue:
                    'Shift closed. Expected {{expected}}, received {{counted}}.',
                  expected: formatSatelliteMoney(satelliteResult.expected),
                  counted: formatSatelliteMoney(satelliteResult.counted),
                })}
              </p>
              <div className="mt-2">
                <VarianceBadge variance={satelliteResult.variance} currency={satelliteResult.currency} />
              </div>
              <button
                type="button"
                onClick={closeSatelliteCheckout}
                className="min-h-[44px] pos-raised pos-raised--yellow mt-4 rounded-2xl bg-yellow-400 px-5 py-3 font-bold text-black"
              >
                {t('common.done', { defaultValue: 'Done' })}
              </button>
            </ShiftRevealContent></motion.div>
          ) : satellitePreview.loading ? <motion.div key="reveal-8-next-yes" {...revealMotion}><ShiftRevealContent>
            <p className={`mt-4 ${checkInMutedTextClass}`}>
              {t('modals.staffShift.satelliteCheckout.loading', {
                defaultValue: 'Loading shift figures from the server…',
              })}
            </p>
          </ShiftRevealContent></motion.div> : satellitePreview.error ? <motion.div key="reveal-8-next-next-yes" {...revealMotion}><ShiftRevealContent>
            <p className="mt-4 text-sm font-semibold text-rose-500">{satellitePreview.error}</p>
          </ShiftRevealContent></motion.div> : figures ? <motion.div key="reveal-8-next-next-next-yes" {...revealMotion}><ShiftRevealContent>
            <>
              {figures.netCollections && renderNetCollections(figures.netCollections, formatSatelliteMoney)}
              {/* A till the phone closed itself shows its orders and money like
                  a remote close (founder 13/10/2026). */}
              <div className={`mt-4 grid grid-cols-2 gap-3 ${checkoutInsetSurfaceClass}`}>
                {[
                  ['orders', t('modals.staffShift.satelliteCheckout.orders', { defaultValue: 'Orders' }), String(figures.total_orders_count)],
                  ...(figures.netCollections ? [] : [
                    ['sales', t('modals.staffShift.satelliteCheckout.sales', { defaultValue: 'Total sales' }), formatSatelliteMoney(figures.total_sales_amount)],
                  ]),
                  ['cash', t('modals.staffShift.satelliteCheckout.cashSales', { defaultValue: 'Cash sales' }), formatSatelliteMoney(figures.total_cash_sales)],
                  ['card', t('modals.staffShift.satelliteCheckout.cardSales', { defaultValue: 'Card sales' }), formatSatelliteMoney(figures.total_card_sales)],
                  ['float', t('modals.staffShift.satelliteCheckout.openingFloat', { defaultValue: 'Opening float' }), formatSatelliteMoney(figures.opening_cash_amount)],
                  ['expected', t('modals.staffShift.satelliteCheckout.expectedCash', { defaultValue: 'Expected cash' }), formatSatelliteMoney(figures.expected_cash_amount)],
                ].map(([key, label, value]) => (
                  <div key={key as string}>
                    <p className="text-[11px] font-semibold liquid-glass-modal-text-muted">
                      {label}
                    </p>
                    <p className="text-base font-bold liquid-glass-modal-text">{value}</p>
                  </div>
                ))}
              </div>

              <div className="mt-4">
                <label className="block text-xs font-semibold liquid-glass-modal-text-muted">
                  {t('modals.staffShift.satelliteCheckout.countedLabel', {
                    defaultValue: 'Cash received from {{name}}',
                    name: satelliteCheckout.staff.name,
                  })}
                </label>
                {typeof satellitePreview.recordedCount === 'number' ? (
                  // The till's own count: the receipt takes exactly this.
                  <p className="pos-glass-form-card mt-2 px-4! py-3! text-lg font-bold liquid-glass-modal-text"
                    data-testid="satellite-recorded-count">
                    {formatSatelliteMoney(satellitePreview.recordedCount)}
                  </p>
                ) : (
                <CentsMoneyInput
                  aria-label={t('modals.staffShift.satelliteCheckout.countedLabel', {
                    defaultValue: 'Cash received from {{name}}',
                    name: satelliteCheckout.staff.name,
                  })}
                  disabled={satellitePending || satelliteSubmitting}
                  value={satelliteCountedCash}
                  onValueChange={setSatelliteCountedCash}
                  placeholder={formatSatelliteMoney(figures.expected_cash_amount)}
                  className="pos-glass-field min-h-[44px] mt-2 w-full px-4 py-3 text-lg font-bold liquid-glass-modal-text"
                  data-testid="satellite-counted-cash"
                />
                )}
                <AnimatePresence initial={false}>
                {varianceValue !== null ? (
                  <motion.div key="reveal-9-yes" {...revealMotion} className="mt-2"><ShiftRevealContent>
                    <VarianceBadge variance={Math.round(varianceValue * 100) / 100} currency={currency} />
                  </ShiftRevealContent></motion.div>
                ) : null}
                </AnimatePresence>
              </div>

              <button
                type="button"
                onClick={() => void handleSatelliteRemoteCheckout()}
                disabled={satelliteSubmitting || !currency || !satelliteCountedCash.trim() || !Number.isFinite(countedValue) || countedValue < 0}
                className="min-h-[44px] pos-raised pos-raised--yellow mt-5 w-full rounded-2xl bg-yellow-400 px-5 py-4 text-base font-black text-black disabled:opacity-50"
                data-testid="satellite-checkout-confirm"
              >
                {satelliteSubmitting
                  ? t('modals.staffShift.satelliteCheckout.closing', { defaultValue: 'Closing…' })
                  : satellitePending ? t('modals.staffShift.satelliteCheckout.retry') : t(satelliteCheckout.shift.self_closed ? 'modals.staffShift.satelliteCheckout.receive' : 'modals.staffShift.satelliteCheckout.confirm', {
                      defaultValue: 'Close shift & receive cash',
                    })}
              </button>
            </>
          </ShiftRevealContent></motion.div> : null}
          </AnimatePresence>

          {/* Coordinator review 14/10/2026: an open phone shift refused for
              good, or one that counts no cash, closes without a handover. */}
          <AnimatePresence initial={false}>
          {offerCloseWithoutHandover && <motion.div key="reveal-10" {...revealMotion}><ShiftRevealContent>
            <CloseWithoutHandoverPanel
              key={String(satelliteCheckout.shift.id)}
              satelliteShiftId={String(satelliteCheckout.shift.id)}
              onClosed={handleClosedWithoutHandover}
            />
          </ShiftRevealContent></motion.div>}
          </AnimatePresence>
        </div>
      </div>
    );
  };

  // Founder 01/11 («και έλεγξε και τα checkout modal»): the checkout in the kit, like the check-in.
  const checkoutSurfaceClass = 'pos-glass-form-card';
  const checkoutInsetSurfaceClass = 'pos-glass-form-card';

  const renderNetCollections = (
    collections: ShiftNetCollections,
    formatCollectionMoney: (amount: number) => string = formatCurrency,
  ) => (
    <div className={checkoutInsetSurfaceClass} data-testid="shift-net-collections">
      <div className="text-sm font-semibold text-(--pos-s-muted)">
        {t('modals.staffShift.netCollections', 'Net collections')}
      </div>
      <div className="mt-2 text-3xl font-black liquid-glass-modal-text">
        {formatCollectionMoney(Number(collections.totalCents) / 100)}
      </div>
      <div className="mt-3 space-y-3 text-base">
        {collections.tenders.filter((line) => Number(line.receivedCents) !== 0).map((line) => (
          <div key={line.tender} className="flex justify-between gap-4">
            <span>{line.tender === 'twint' ? 'TWINT' : line.tender === 'cash'
              ? t('modals.staffShift.cash', 'Cash') : line.tender === 'card'
                ? t('modals.staffShift.card', 'Card') : t('payment.methods.other', 'Other')}</span>
            <strong>{formatCollectionMoney(Number(line.receivedCents) / 100)}</strong>
          </div>
        ))}
        <div className="flex justify-between gap-4">
          <span>{t('features.refunds', 'Refunds')}</span>
          <strong>{formatCollectionMoney(Number(collections.refundedCents) / 100)}</strong>
        </div>
        <div className="flex justify-between gap-4">
          <span>{t('modals.staffShift.ofWhichTips', 'of which tips')}</span>
          <strong>{formatCollectionMoney(Number(collections.tipsCents) / 100)}</strong>
        </div>
      </div>
    </div>
  );

  const checkoutActionButtonClass = 'pos-solid-btn pos-solid-btn--primary h-12 w-12 shrink-0 p-0';
  const checkoutMutedTextClass = 'text-sm liquid-glass-modal-text-muted';
  const checkoutFieldClass =
    'liquid-glass-modal-input pos-glass-field block min-h-[48px] w-full px-3 text-base font-semibold outline-hidden transition-colors focus:border-(--pos-s-yellow)';
  const checkoutLabelClass = 'mb-1 block text-xs font-semibold liquid-glass-modal-text-muted';
  // Founder 01/11 («δεν έχουμε διορθώσει αυτά τα modals»): the check-in steps in the kit, one column, each
  // fact said once (the step's title and help appear once; the chosen person is one compact line).
  const checkInSurfaceClass = 'pos-glass-form-card';
  const checkInInsetSurfaceClass = 'pos-glass-form-card p-3!';
  // Founder 02/11/2026: on glass a solid strip cut the raised buttons at its bottom edge. The footer is the
  // plain glass, with room for the buttons and their shadow (founder 11/11/2026).
  const checkInFooterClass = 'sticky bottom-0 z-10 mt-3 px-6 pb-5 pt-2';
  const checkInEyebrowClass = 'text-xs font-semibold liquid-glass-modal-text-muted';
  const checkInMutedTextClass = 'text-sm liquid-glass-modal-text-muted';
  const checkInStepColumnClass = 'mx-auto w-full max-w-xl space-y-3';
  const checkInKeyClass =
    'flex min-h-touch items-center justify-center pos-glass-field text-xl font-semibold transition';

  const renderTipsSummaryCard = () => {
    const tipsReceived = Number(shiftSummary?.tipsReceived || 0);
    const allocations = Array.isArray(shiftSummary?.tipAllocations)
      ? shiftSummary.tipAllocations
      : [];

    return (
      <div className={checkoutSurfaceClass} data-testid="staff-checkout-tips">
        <div className="text-sm text-yellow-700 dark:text-yellow-300 font-semibold">
          {t('modals.staffShift.tipsReceived', { defaultValue: 'Tips Received' })}
        </div>
        <div className="mt-2 text-3xl font-black tracking-tight text-yellow-700 dark:text-yellow-300">
          {formatCurrency(tipsReceived)}
        </div>
        <p className="mt-2 text-sm liquid-glass-modal-text-muted">
          {t('modals.staffShift.tipsSeparateFromCashReturn', {
            defaultValue: 'Tips are recorded separately and are not included in the cash to return.',
          })}
        </p>

        <AnimatePresence initial={false}>
        {allocations.length > 0 && <motion.div key="reveal-11" {...revealMotion}><ShiftRevealContent>
          <details className={`group mt-4 ${checkoutInsetSurfaceClass}`}>
            <summary className="min-h-[44px] flex cursor-pointer list-none items-center justify-between gap-3 [&::-webkit-details-marker]:hidden">
              <span className="text-sm font-semibold liquid-glass-modal-text">
                {t('modals.staffShift.tipAllocations', { defaultValue: 'Tip Allocations' })}
              </span>
              <span className="text-sm font-semibold liquid-glass-modal-text-muted">
                {allocations.length}
              </span>
            </summary>
            <div className="mt-3 space-y-2 pt-3">
              {allocations.map((allocation: any) => (
                <div
                  key={allocation.paymentId || allocation.orderId}
                  className="flex items-center justify-between gap-3 text-sm"
                >
                  <span className="truncate liquid-glass-modal-text-muted">
                    {t('modals.staffShift.tipOrder', { defaultValue: 'Order' })}{' '}
                    {formatGridOrderNumber({ order_number: allocation.orderNumber, order_id: allocation.orderId })}
                  </span>
                  <span className="font-black text-yellow-800 dark:text-yellow-200">
                    {formatCurrency(Number(allocation.amount || 0))}
                  </span>
                </div>
              ))}
            </div>
          </details>
        </ShiftRevealContent></motion.div>}
        </AnimatePresence>
      </div>
    );
  };

  const renderAuditSection = (content: React.ReactNode) => (
    <details className={`${checkoutSurfaceClass} group`}>
      <summary className="min-h-[44px] flex cursor-pointer list-none items-start justify-between gap-4 [&::-webkit-details-marker]:hidden">
        <div>
          <h3 className="text-xl font-semibold liquid-glass-modal-text">
            {t('modals.staffShift.auditDetails', 'Audit Details')}
          </h3>
          <p className="mt-2 text-sm liquid-glass-modal-text-muted">
            {t('modals.staffShift.auditDetailsHelper', 'Expand for order, transfer, and payment history.')}
          </p>
        </div>
        <div className="pos-glass-field flex min-h-[44px] min-w-[44px] items-center justify-center transition-transform group-open:rotate-90">
          <ChevronRight className="h-5 w-5" />
        </div>
      </summary>
      <div className="mt-5 space-y-5 pt-5">
        {content}
      </div>
    </details>
  );

  const renderAuditEmptyState = (message: string) => (
    <div className="pos-glass-form-card px-4! py-5! text-center text-sm liquid-glass-modal-text-muted">
      {message}
    </div>
  );

  const renderExpensesPanel = () => (
    <div className={checkoutSurfaceClass}>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1">
          <h3 className="text-xl font-semibold liquid-glass-modal-text">
            {t('modals.staffShift.expenses')}
          </h3>
          <p className="mt-2 text-sm liquid-glass-modal-text-muted">
            {canRecordInlineExpenses
              ? t('modals.staffShift.reviewAndConfirm')
              : t('modals.staffShift.expensesReadOnly', {
                defaultValue:
                  'Expenses are recorded from cashier checkout. Existing shift expenses are shown here for reference.',
              })}
          </p>
        </div>

        <div className="w-full sm:w-auto sm:text-right">
          <div className="text-sm liquid-glass-modal-text-muted font-semibold">
            {t('modals.staffShift.totalExpenses')}
          </div>
          <div className="mt-1 text-2xl font-black text-rose-500 dark:text-rose-300">
            {formatCurrency(totalExpenses)}
          </div>
          {canRecordInlineExpenses && (
            <button
              type="button"
              onClick={() => setShowExpenseForm(!showExpenseForm)}
              aria-label={t('modals.staffShift.addExpense')}
              className={`mt-3 ml-auto ${checkoutActionButtonClass}`}
            >
              <Plus className="h-6 w-6" strokeWidth={3} />
            </button>
          )}
        </div>
      </div>

      <AnimatePresence initial={false}>
      {canRecordInlineExpenses && showExpenseForm && (
        <motion.div key="reveal-12" {...revealMotion} ref={expenseFormRef} className={`mt-5 space-y-3 ${checkoutInsetSurfaceClass}`}><ShiftRevealContent>
          <label className={checkoutLabelClass} htmlFor="checkout-expense-type">
            {t('modals.expense.expenseType', 'Expense type')}
          </label>
          <select
            id="checkout-expense-type"
            value={expenseType}
            onChange={(e) => setExpenseType(e.target.value as 'supplies' | 'maintenance' | 'petty_cash' | 'refund' | 'other')}
            className={checkoutFieldClass}
          >
            <option value="supplies">{getExpenseTypeLabel('supplies')}</option>
            <option value="maintenance">{getExpenseTypeLabel('maintenance')}</option>
            <option value="petty_cash">{getExpenseTypeLabel('petty_cash')}</option>
            <option value="refund">{getExpenseTypeLabel('refund')}</option>
            <option value="other">{getExpenseTypeLabel('other')}</option>
          </select>

          <div>
            <span className={checkoutLabelClass}>{t('modals.staffShift.amountLabel', 'Amount')}</span>
            <CentsMoneyInput
              aria-label={t('modals.staffShift.amountLabel', 'Amount')}
              value={expenseAmount}
              onValueChange={setExpenseAmount}
              placeholder="0,00"
              className={`${checkoutFieldClass} text-lg font-bold`}
            />
          </div>

          <div>
            <label className={checkoutLabelClass} htmlFor="checkout-expense-description">
              {t('modals.expense.justification', 'Justification')}
            </label>
            <input
              id="checkout-expense-description"
              type="text"
              value={expenseDescription}
              onChange={(e) => setExpenseDescription(e.target.value)}
              placeholder={expenseDescriptionPlaceholder}
              className={checkoutFieldClass}
            />
          </div>

          {canUseExpenseReceiptReference && (
            <div>
              <label className={checkoutLabelClass} htmlFor="checkout-expense-receipt">
                {t('modals.expense.receiptReference', 'Receipt reference')}
              </label>
              <input
                id="checkout-expense-receipt"
                type="text"
                value={expenseReceipt}
                onChange={(e) => setExpenseReceipt(e.target.value)}
                placeholder={expenseReceiptPlaceholder}
                className={checkoutFieldClass}
              />
            </div>
          )}

          <button
            onClick={handleRecordExpense}
            disabled={!canRecordInlineExpense}
            className="pos-solid-btn pos-solid-btn--md pos-solid-btn--primary w-full"
          >
            {recordExpenseLabel}
          </button>
        </ShiftRevealContent></motion.div>
      )}
      </AnimatePresence>

      <div className="mt-5 space-y-2">
        <AnimatePresence initial={false}>
        {expenses.length > 0 ? <motion.div key="reveal-13-yes" {...revealMotion}><ShiftRevealContent>{(
          expenses.map((expense) => {
            const expenseTitle =
              expense.description ||
              t('modals.expense.untitledExpense', {
                defaultValue: 'Untitled expense',
              });
            const expenseMeta = [
              getExpenseTypeLabel(expense.expense_type),
              canUseExpenseReceiptReference ? expense.receipt_number?.trim() || '' : '',
            ]
              .filter(Boolean)
              .join(' · ');

            return (
              <div
                key={expense.id}
                className="pos-glass-form-card flex items-center justify-between p-3!"
              >
                <div className="min-w-0">
                  <div className="font-semibold liquid-glass-modal-text">{expenseTitle}</div>
                  {expenseMeta && (
                    <div className="mt-1 text-sm liquid-glass-modal-text-muted font-semibold">
                      {expenseMeta}
                    </div>
                  )}
                </div>
                <div className="flex shrink-0 flex-col items-end gap-2">
                  <div className="text-right font-black text-rose-500 dark:text-rose-300">
                    -{formatCurrency(expense.amount)}
                  </div>
                  <button
                    type="button"
                    disabled={deletingExpenseId === expense.id}
                    onClick={() =>
                      openConfirm({
                        title: t('modals.expense.deleteExpenseConfirmTitle', {
                          defaultValue: 'Delete expense',
                        }),
                        message: t(
                          'modals.expense.deleteExpenseConfirmMessage',
                          'Delete "{{description}}"? This will immediately remove it from the drawer totals.',
                          {
                            description: expenseTitle,
                          },
                        ),
                        variant: 'error',
                        confirmText: deleteExpenseLabel,
                        cancelText: t('common.actions.cancel', {
                          defaultValue: 'Cancel',
                        }),
                        onConfirm: () => {
                          void handleDeleteExpense(expense);
                        },
                      })
                    }
                    className="pos-solid-btn pos-solid-btn--sm pos-solid-btn--danger disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    {deleteExpenseLabel}
                  </button>
                </div>
              </div>
            );
          })
        )}</ShiftRevealContent></motion.div> : (
          <motion.div key="reveal-13-next" {...revealMotion} className="pos-glass-form-card px-4! py-5! text-center text-sm liquid-glass-modal-text-muted"><ShiftRevealContent>
            {t('modals.staffShift.noExpensesRecorded')}
          </ShiftRevealContent></motion.div>
        )}
        </AnimatePresence>
      </div>
    </div>
  );

  const renderStaffPaymentsPanel = () => {
    if (!isCashierCheckoutRole) {
      return null;
    }

    const sessionPaymentTotal = staffPaymentsList.reduce((sum, payment) => sum + payment.amount, 0);
    const allowCurrentCashierSelection = isCashierCheckoutRole;

    return (
      <div className={checkoutSurfaceClass}>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0 flex-1">
            <h3 className="text-xl font-semibold liquid-glass-modal-text">
              {t('modals.staffShift.recordStaffPayments', 'Record Staff Payments')}
            </h3>
            <p className="mt-2 text-sm liquid-glass-modal-text-muted">
              {t(
                'modals.staffShift.staffPaymentsReturnedViaCheckouts',
                'Recorded staff payouts are deducted from this cashier checkout immediately.',
              )}
            </p>
          </div>

          <button
            type="button"
            onClick={() => {
              if (showStaffPaymentForm) {
                resetStaffPaymentForm();
              } else {
                void openStaffPaymentForm();
              }
            }}
            aria-label={t('modals.staffShift.addPayment', 'Add Payment')}
            className={checkoutActionButtonClass}
          >
            <Plus className="h-6 w-6" strokeWidth={3} />
          </button>
        </div>

        <AnimatePresence initial={false}>
        {showStaffPaymentForm && (
          <motion.div key="reveal-14" {...revealMotion} ref={staffPaymentFormRef} className={`mt-5 space-y-3 ${checkoutInsetSurfaceClass}`}><ShiftRevealContent>
            <div>
              <label className={checkoutLabelClass}>
                {t('modals.staffShift.selectStaff', 'Select Staff')}
              </label>
              <select
                value={selectedStaffForPayment?.id || ''}
                onChange={async (e) => {
                  const staffId = e.target.value;
                  if (staffId) {
                    const selected = availableStaff.find(s => s.id === staffId);
                    if (selected) {
                      setSelectedStaffForPayment({
                        id: selected.id,
                        name: selected.name,
                        role: selected.roles?.[0]?.role_name || 'staff'
                      });
                      const shiftDate = effectiveShift?.check_in_time
                        ? toLocalDateString(effectiveShift.check_in_time)
                        : undefined;
                      await loadPaymentHistoryForStaff(selected.id, shiftDate);
                      const activeShiftForSelected = staffActiveShifts.get(selected.id);
                      await calculateExpectedPayment(activeShiftForSelected, selected.hourly_rate);
                    }
                  } else {
                    setSelectedStaffForPayment(null);
                    setPaymentHistory([]);
                    setDailyPaymentTotal(0);
                    setExpectedPayment(null);
                  }
                }}
                className={checkoutFieldClass}
              >
                <option value="">{t('modals.staffShift.selectStaffPlaceholder', '-- Select Staff --')}</option>
                {editingStaffPayment && selectedStaffForPayment?.id && !availableStaff.some((member) => member.id === (selectedStaffForPayment?.id ?? '')) && (
                  <option value={selectedStaffForPayment?.id ?? ''}>{selectedStaffForPayment?.name ?? t('common.unknown', 'Unknown')}</option>
                )}
                {availableStaff
                  .filter((member) => allowCurrentCashierSelection || member.id !== staff?.staffId)
                  .map(s => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
              </select>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className={checkoutLabelClass}>
                  {t('modals.staffShift.paymentType', 'Payment Type')}
                </label>
                <select
                  value={paymentType}
                  onChange={(e) => setPaymentType(e.target.value)}
                  className={checkoutFieldClass}
                >
                  <option value="wage">{t('modals.staffShift.paymentTypes.wage', 'Wage')}</option>
                  <option value="tip">{t('modals.staffShift.paymentTypes.tip', 'Tip')}</option>
                  <option value="bonus">{t('modals.staffShift.paymentTypes.bonus', 'Bonus')}</option>
                  <option value="advance">{t('modals.staffShift.paymentTypes.advance', 'Advance')}</option>
                  <option value="other">{t('modals.staffShift.paymentTypes.other', 'Other')}</option>
                </select>
              </div>

              <div>
                <label className={checkoutLabelClass}>
                  {t('modals.staffShift.amountLabel', 'Amount')}
                  {expectedPayment !== null && (
                    <span className="ml-2 font-normal liquid-glass-modal-text-muted">
                      ({t('modals.staffShift.expected', 'Expected')}: {formatCurrency(expectedPayment)})
                    </span>
                  )}
                </label>
                <CentsMoneyInput
                  aria-label={t('modals.staffShift.amountLabel', 'Amount')}
                  value={paymentAmount}
                  onValueChange={setPaymentAmount}
                  placeholder={expectedPayment ? formatCurrency(expectedPayment) : '0,00'}
                  className={`${checkoutFieldClass} text-lg font-bold`}
                />
              </div>
            </div>

            <div>
              <label className={checkoutLabelClass}>
                {t('modals.staffShift.notesOptional', 'Notes (optional)')}
              </label>
              <input
                type="text"
                value={paymentNotes}
                onChange={(e) => setPaymentNotes(e.target.value)}
                placeholder={t('modals.staffShift.paymentNotesPlaceholder', 'Add notes (optional)')}
                className={checkoutFieldClass}
              />
            </div>

            <div className="flex flex-wrap justify-end gap-3">
              <button
                onClick={resetStaffPaymentForm}
                className="pos-solid-btn pos-solid-btn--md"
              >
                {t('common.cancel', 'Cancel')}
              </button>
              <button
                onClick={handleRecordStaffPayment}
                disabled={loading || !selectedStaffForPayment || !paymentAmount}
                className="pos-solid-btn pos-solid-btn--md pos-solid-btn--primary"
              >
                {loading
                  ? t('common.saving', 'Saving...')
                  : t(
                      editingStaffPaymentId ? 'modals.staffShift.savePaymentChanges' : 'modals.staffShift.recordPayment',
                      editingStaffPaymentId ? 'Save Changes' : 'Record Payment',
                    )}
              </button>
            </div>
          </ShiftRevealContent></motion.div>
        )}
        </AnimatePresence>

        <div className="mt-5 space-y-2">
          <AnimatePresence initial={false}>
          {staffPaymentsList.length > 0 ? <motion.div key="reveal-15-yes" {...revealMotion}><ShiftRevealContent>
            <>
              <div className="flex items-center justify-between">
                <div className="text-sm liquid-glass-modal-text-muted font-semibold">
                  {t('modals.staffShift.recordedThisSession', 'Recorded This Session')}
                </div>
                <div className="text-sm font-bold text-rose-500 dark:text-rose-300">
                  -{formatCurrency(sessionPaymentTotal)}
                </div>
              </div>
              {staffPaymentsList.map((payment) => (
                <div
                  key={payment.id}
                  className="pos-glass-form-card flex items-center justify-between p-3!"
                >
                  <div>
                    <div className="font-semibold liquid-glass-modal-text">
                      {payment.staff_name || t('common.unknown', 'Unknown')}
                    </div>
                    <div className="text-xs liquid-glass-modal-text-muted">
                      {t(`modals.staffShift.paymentTypes.${payment.payment_type}`, payment.payment_type)}
                      {payment.notes ? ` · ${payment.notes}` : ''}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      disabled={loading}
                      onClick={() => { void beginEditStaffPayment(payment); }}
                      className="pos-glass-field min-h-[44px] inline-flex items-center gap-1 px-3 py-1.5 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                      {t('modals.staffShift.editPayment', 'Edit')}
                    </button>
                    <button
                      type="button"
                      disabled={deletingStaffPaymentId === payment.id}
                      onClick={() =>
                        openConfirm({
                          title: t('modals.staffShift.deleteStaffPaymentConfirmTitle', 'Delete staff payment'),
                          message: t(
                            'modals.staffShift.deleteStaffPaymentConfirmMessage',
                            'Delete the payment for "{{name}}"? Cashier checkout totals will be recalculated immediately.',
                            { name: payment.staff_name || t('common.unknown', 'Unknown') },
                          ),
                          variant: 'error',
                          confirmText: t('modals.staffShift.deletePayment', 'Delete Payment'),
                          onConfirm: () => { void handleDeleteStaffPayment(payment); },
                        })
                      }
                      className="pos-solid-btn pos-solid-btn--sm pos-solid-btn--danger disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      {t('modals.staffShift.deletePayment', 'Delete')}
                    </button>
                    <div className="font-bold text-rose-500 dark:text-rose-300">
                      -{formatCurrency(payment.amount)}
                    </div>
                  </div>
                </div>
              ))}
            </>
          </ShiftRevealContent></motion.div> : (
            <motion.div key="reveal-15-next" {...revealMotion} className="pos-glass-form-card px-4! py-5! text-center text-sm liquid-glass-modal-text-muted"><ShiftRevealContent>
              {t('modals.staffShift.staffPaymentsMade')}
            </ShiftRevealContent></motion.div>
          )}
          </AnimatePresence>
        </div>
      </div>
    );
  };

  const renderCheckoutBackButton = () => {
    if (localMode !== 'checkout') {
      return null;
    }

    return (
      <motion.button
        onClick={() => {
          setContentDirection(-1);
          setLocalMode(null);
          setCheckoutShift(null);
          setCheckInStep('select-staff');
          setSelectedStaff(null);
          setError('');
        }}
        className="pos-solid-btn pos-solid-btn--sm self-start"
        {...getInteractiveMotion('button')}
      >
        <ChevronLeft className="h-5 w-5" />
        {t('modals.staffShift.backToStaffSelection')}
      </motion.button>
    );
  };

  const renderGiftCheckoutView = () => {
    const state = giftCheckout;
    if (state.kind !== 'preparing' && state.kind !== 'blocked' && state.kind !== 'ready' && state.kind !== 'retained') {
      return null;
    }
    const preview = state.kind === 'ready' ? state.preview : null;
    const countedCents = preview ? parseOpeningCents(closingCash) : null;
    const varianceCents = preview && countedCents !== null ? countedCents - preview.expectedCents : null;
    const approval = preview && giftApproval?.epoch === preview.epoch ? giftApproval : null;
    const secondaryButtonClass = 'pos-solid-btn pos-solid-btn--sm disabled:cursor-not-allowed disabled:opacity-60';

    return (
      <div className="space-y-4" data-testid="gift-close-checkout" data-state={state.kind}>
        {renderCheckoutBackButton()}
        <section className={checkoutSurfaceClass}>
          <div className="text-sm text-yellow-700 dark:text-yellow-300 font-semibold">
            {giftText(giftCloseText('title', 'Gift card cash close'))}
          </div>
          <AnimatePresence initial={false}>
          {state.kind === 'preparing' && <motion.div key="reveal-16" {...revealMotion}><ShiftRevealContent>
            <p data-testid="gift-close-preparing" className="mt-3 text-sm liquid-glass-modal-text-muted">
              {giftText(giftCloseText('preparing', 'Preparing the gift card close terms…'))}
            </p>
          </ShiftRevealContent></motion.div>}
          </AnimatePresence>
          <AnimatePresence initial={false}>
          {state.kind === 'blocked' && (
            <motion.div key="reveal-17" {...revealMotion} className="mt-3 space-y-3"><ShiftRevealContent>
              <p data-testid="gift-close-blocked" data-code={state.code} className="text-sm font-semibold text-red-700 dark:text-red-300">
                {giftText(giftCloseCodeText(state.code, state.count))}
              </p>
              <button type="button" data-testid="gift-close-refresh" onClick={rediscoverGiftClose} className={secondaryButtonClass}>
                {giftText(giftCloseText('checkAgain', 'Check again'))}
              </button>
            </ShiftRevealContent></motion.div>
          )}
          </AnimatePresence>
          <AnimatePresence initial={false}>
          {state.kind === 'retained' && <motion.div key="reveal-18" {...revealMotion}><ShiftRevealContent>
            <p data-testid="gift-close-retained" className="mt-3 text-sm liquid-glass-modal-text-muted">
              {giftText(giftCloseCodeText('GIFT_CLOSING_ORIGINAL_EXISTS'))}
            </p>
          </ShiftRevealContent></motion.div>}
          </AnimatePresence>
          <AnimatePresence initial={false}>
          {preview && <motion.div key="reveal-19" {...revealMotion}><ShiftRevealContent>
            <>
              <dl className="mt-4 space-y-2">
                <GiftCloseAmount
                  testId="gift-close-ordinary"
                  label={giftText(giftCloseText('ordinaryExpected', 'Ordinary cash expected'))}
                  cents={preview.ordinaryExpectedCents}
                  currency={preview.currency}
                />
                <GiftCloseAmount
                  testId="gift-close-gift-cash"
                  label={giftText(giftCloseText('giftCash', 'Gift card cash'))}
                  cents={preview.giftCashCents}
                  currency={preview.currency}
                />
                <GiftCloseAmount
                  testId="gift-close-expected"
                  label={giftText(giftCloseText('expectedTotal', 'Expected in drawer'))}
                  cents={preview.expectedCents}
                  currency={preview.currency}
                  strong
                />
              </dl>
              <label className="mt-5 block text-xs font-semibold liquid-glass-modal-text-muted">
                {giftText(giftCloseText('countLabel', 'Counted cash in drawer'))}
                <CentsMoneyInput
                  data-testid="gift-close-count"
                  value={closingCash}
                  disabled={giftBusy || approval !== null}
                  onValueChange={setClosingCash}
                  className="liquid-glass-modal-input pos-glass-field min-h-[44px] mt-3 w-full text-3xl font-black text-center"
                />
              </label>
              <dl className="mt-3">
                <GiftCloseAmount
                  testId="gift-close-variance"
                  label={giftText(giftCloseText('variance', 'Variance'))}
                  cents={varianceCents}
                  currency={preview.currency}
                  signed
                />
              </dl>
            </>
          </ShiftRevealContent></motion.div>}
          </AnimatePresence>
        </section>
        <AnimatePresence initial={false}>
        {approval && <motion.div key="reveal-20" {...revealMotion}><ShiftRevealContent>
          <section data-testid="gift-close-approval" className={checkoutInsetSurfaceClass}>
            <h4 className="text-base font-bold liquid-glass-modal-text">
              {giftText(giftCloseText('approveTitle', 'Approve the gift card close'))}
            </h4>
            <p className="mt-1 text-sm liquid-glass-modal-text-muted">
              {giftText(giftCloseText('approveBody', 'Close this shift with the terms and count shown above?'))}
            </p>
            <div className="mt-4 flex flex-wrap gap-3">
              <button
                type="button"
                data-testid="gift-close-cancel"
                disabled={giftBusy}
                onClick={() => setGiftApproval(null)}
                className={secondaryButtonClass}
              >
                {giftText(giftCloseText('cancel', 'Cancel'))}
              </button>
              <button
                type="button"
                data-testid="gift-close-approve"
                disabled={giftBusy}
                onClick={() => { void submitGiftClose(); }}
                className="pos-solid-btn pos-solid-btn--sm pos-solid-btn--danger disabled:cursor-not-allowed disabled:opacity-60"
              >
                {giftText(giftCloseText('approve', 'Approve and close'))}
              </button>
            </div>
          </section>
        </ShiftRevealContent></motion.div>}
        </AnimatePresence>
      </div>
    );
  };

  const renderGiftRecovery = () => {
    const target = giftRecoveryTarget;
    if (!target) {
      return null;
    }

    return (
      <GiftCloseRecoveryPanel
        key={`${target.epoch}:${target.staffId}:${target.closingKey}`}
        bridge={bridge}
        target={target}
        isCurrent={() => giftMounted.current && target.epoch === giftEpoch.current}
        print={(shiftId, roleType, isCurrent) => queueShiftCheckoutPrint({ bridge, shiftId, roleType, giftClose: 'confirmed', isCurrent })}
        onDone={() => {
          giftEpoch.current += 1;
          setGiftRecoveryTarget(null);
          if (target.origin === 'checkout') {
            onClose();
          } else if (selectedStaff?.id === target.staffId) {
            loadGiftPending(target.staffId);
          }
        }}
      />
    );
  };

  const renderCashierCheckoutView = () => {
    if (giftCloseOwnsCheckout && !giftRecoveryTarget) {
      return renderGiftCheckoutView();
    }

    if (!effectiveShift || !shiftSummary) {
      return null;
    }

    const opening = getEffectiveOpeningAmount(effectiveShift, shiftSummary);
    const breakdown = getCashierExpectedBreakdown(
      shiftSummary,
      effectiveShift,
      opening,
      cashierCheckoutExpenseTotal,
    );
    const actual = closingCash.trim() ? parseMoneyInputValue(closingCash) : null;
    const variance = actual === null ? null : actual - breakdown.expected;
    const transferredDrivers = Array.isArray(shiftSummary.transferredDrivers) ? shiftSummary.transferredDrivers : [];
    const transferredWaiters = Array.isArray(shiftSummary.transferredWaiters) ? shiftSummary.transferredWaiters : [];
    const transferredStaff = [...transferredDrivers, ...transferredWaiters];
    const currentPeriodReturns = Array.isArray(shiftSummary.driverDeliveries) ? shiftSummary.driverDeliveries : [];
    const cashierOrders = Array.isArray(shiftSummary.cashierOrders) ? shiftSummary.cashierOrders : [];
    const headerMetrics = checkoutHeaderData?.headerMetrics ?? getShiftHeaderMetrics(shiftSummary, effectiveShift);
    const historicalStaffPayments = Array.isArray(shiftSummary.staffPayments) ? shiftSummary.staffPayments : [];
    const totalCashOrderCount =
      Number(shiftSummary?.breakdown?.instore?.cashCount ?? 0) +
      Number(shiftSummary?.breakdown?.delivery?.cashCount ?? 0);
    const hasAuditActivity =
      cashierOrders.length > 0 ||
      currentPeriodReturns.length > 0 ||
      transferredStaff.length > 0 ||
      historicalStaffPayments.length > 0;

    return (
      <div className="space-y-3" data-testid="staff-checkout-section">
        {renderCheckoutBackButton()}

        <div className="grid gap-3 xl:grid-cols-[minmax(0,1.35fr)_minmax(380px,0.95fr)]">
          <div className="space-y-3">
            <div className={checkoutSurfaceClass}>
              <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(280px,0.9fr)]">
                <div>
                  <div className="text-sm text-yellow-700 dark:text-yellow-300 font-semibold">
                    {t('modals.staffShift.expectedInDrawer', { defaultValue: 'Expected In Drawer' })}
                  </div>
                  {/* Founder 01/11/2026 («κανε το αναμενομενο πρασινο και στα 2»): the expected cash in the kit green. */}
                  <div data-expected-in-drawer className="mt-3 text-4xl font-black tracking-tight text-(--pos-s-ok)">
                    {formatDrawerCurrency(breakdown.expected)}
                  </div>
                  <p className="mt-3 text-sm liquid-glass-modal-text-muted">
                    {t('modals.staffShift.expectedInDrawerHelper', {
                      defaultValue: 'Count the drawer and confirm the actual cash before closing.',
                    })}
                  </p>
                </div>

                <div className={checkoutInsetSurfaceClass}>
                  <label className="block text-xs font-semibold liquid-glass-modal-text-muted">
                    {t('modals.staffShift.closingCashLabel')}
                  </label>
                  <CentsMoneyInput
                    aria-label={t('modals.staffShift.closingCashLabel')}
                    value={closingCash}
                    onValueChange={setClosingCash}
                    placeholder="0,00"
                    className="liquid-glass-modal-input pos-glass-field min-h-[44px] mt-3 w-full text-3xl font-black text-center"
                    autoFocus
                  />
                  <p className="mt-3 text-sm liquid-glass-modal-text-muted">
                    {t('modals.staffShift.closingCashHelper')}
                  </p>
                  <AnimatePresence initial={false}>
                  {variance !== null && (
                    <motion.div key="reveal-21" {...revealMotion} className="mt-4 flex justify-center"><ShiftRevealContent>
                      <VarianceBadge currency={cashierDrawerCurrency} variance={variance} size="lg" showIcon />
                    </ShiftRevealContent></motion.div>
                  )}
                  </AnimatePresence>
                </div>
              </div>
            </div>

            <div className={checkoutSurfaceClass}>
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h3 className="text-xl font-semibold liquid-glass-modal-text">
                    {t('modals.staffShift.varianceBreakdown', 'Cash Breakdown')}
                  </h3>
                </div>
                <div className="text-right">
                  <div className="text-sm liquid-glass-modal-text-muted font-semibold">
                    {t('modals.staffShift.actualLabel', 'Actual')}
                  </div>
                  {/* Founder 01/11/2026: «Not entered» in the kit amber until the counted cash is typed, so it is not missed;
                      then green when it matches the expected cash, the expenses' rose red when it does not («αυτο το
                      κοκκινο μου αρεσει»). */}
                  <div
                    data-actual-cash={actual === null ? 'not-entered' : Math.abs(actual - breakdown.expected) < 0.005 ? 'matches' : 'differs'}
                    className={`mt-1 text-2xl font-black ${actual === null ? 'text-(--pos-s-warn)' : Math.abs(actual - breakdown.expected) < 0.005 ? 'text-(--pos-s-ok)' : 'text-rose-500 dark:text-rose-300'}`}
                  >
                    {actual === null
                      ? t('common.notEntered', { defaultValue: 'Not entered' })
                      : formatDrawerCurrency(actual)}
                  </div>
                </div>
              </div>

              <div className="mt-5 space-y-2">
                {[
                  { label: t('modals.staffShift.openingCashLabel'), amount: breakdown.opening, tone: 'liquid-glass-modal-text-muted', prefix: '+' },
                  { label: t('modals.staffShift.cashOrdersLabel'), amount: breakdown.sales, tone: 'text-emerald-600 dark:text-emerald-300', prefix: '+' },
                  { label: t('modals.staffShift.cashRefundsLabel', 'Cash Refunds'), amount: breakdown.cashRefunds, tone: 'text-rose-600 dark:text-rose-300', prefix: '-' },
                  { label: t('modals.staffShift.expensesLabel'), amount: breakdown.expenses, tone: 'text-rose-600 dark:text-rose-300', prefix: '-' },
                  { label: t('modals.staffShift.cashDropsLabel', 'Cash Drops'), amount: breakdown.cashDrops, tone: 'text-rose-600 dark:text-rose-300', prefix: '-' },
                  { label: t('modals.staffShift.driverCashGivenLabel', 'Driver Cash Given'), amount: breakdown.driverGiven, tone: 'text-rose-600 dark:text-rose-300', prefix: '-' },
                  { label: t('modals.staffShift.driverCashReturnedLabel', 'Driver Cash Returned'), amount: breakdown.driverReturned, tone: 'text-emerald-600 dark:text-emerald-300', prefix: '+' },
                  { label: t('modals.staffShift.inheritedDriverReturnsLabel', 'Transferred Staff Returns'), amount: breakdown.inheritedDriverExpectedReturns, tone: 'liquid-glass-modal-text-muted', prefix: '+' },
                  { label: t('modals.staffShift.staffPaymentsDeductedLabel', 'Staff Payouts'), amount: breakdown.deductedStaffPayments, tone: 'text-yellow-700 dark:text-yellow-300', prefix: '-' },
                ]
                  .filter((row) => row.amount > 0 || row.label === t('modals.staffShift.openingCashLabel') || row.label === t('modals.staffShift.cashOrdersLabel'))
                  .map((row) => (
                    <div
                      key={row.label}
                      className="flex items-center justify-between px-1 py-3"
                    >
                      <span className="text-sm font-medium liquid-glass-modal-text-muted">{row.label}</span>
                      <span className={`text-lg font-black ${row.tone}`}>
                        {row.prefix}{formatDrawerCurrency(row.amount)}
                      </span>
                    </div>
                  ))}
              </div>
            </div>
          </div>

          <div className="space-y-3">
            {renderExpensesPanel()}
            {renderStaffPaymentsPanel()}
            {renderTipsSummaryCard()}
          </div>
        </div>

        {renderAuditSection(
          <div className="space-y-5">
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
              <div className={checkoutInsetSurfaceClass}>
                <div className="text-sm liquid-glass-modal-text-muted font-semibold">
                  {t('modals.staffShift.totalOrders')}
                </div>
                <div className="mt-2 text-2xl font-black liquid-glass-modal-text">{headerMetrics.totalCount}</div>
              </div>
              <div className={checkoutInsetSurfaceClass}>
                <div className="text-sm liquid-glass-modal-text-muted font-semibold">
                  {shiftSummary?.netCollections ? t('modals.staffShift.netCollections', 'Net collections') : t('modals.staffShift.totalSalesLabel', 'Total Sales')}
                </div>
                <div className={`mt-2 text-2xl font-black text-emerald-600 dark:text-emerald-300`}>
                  {formatCurrency(headerMetrics.totalAmount)}
                </div>
              </div>
              <div className={checkoutInsetSurfaceClass}>
                <div className="text-sm liquid-glass-modal-text-muted font-semibold">
                  {t('modals.staffShift.totalCashOrders')}
                </div>
                <div className="mt-2 text-2xl font-black liquid-glass-modal-text-muted">
                  {totalCashOrderCount}
                </div>
              </div>
              <div className={checkoutInsetSurfaceClass}>
                <div className="text-sm liquid-glass-modal-text-muted font-semibold">
                  {t('modals.staffShift.totalCashAmount', 'Total Cash Amount')}
                </div>
                <div className="mt-2 text-2xl font-black liquid-glass-modal-text">
                  {formatCurrency(breakdown.sales)}
                </div>
              </div>
            </div>

            <AnimatePresence initial={false}>
            {!hasAuditActivity && (
              <motion.div key="reveal-22" {...revealMotion} className="pos-glass-form-card px-4! py-5! text-center text-sm liquid-glass-modal-text-muted"><ShiftRevealContent>
                {t('modals.staffShift.auditNoActivity')}
              </ShiftRevealContent></motion.div>
            )}
            </AnimatePresence>

            <div className={checkoutInsetSurfaceClass}>
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h4 className="text-lg font-semibold liquid-glass-modal-text">
                    {t('modals.staffShift.auditOrderHistoryTitle')}
                  </h4>
                  <p className="mt-2 text-sm liquid-glass-modal-text-muted">
                    {t('modals.staffShift.auditOrderHistoryHelper')}
                  </p>
                </div>
                <span className="shrink-0 text-base font-semibold liquid-glass-modal-text-muted">
                  {cashierOrders.length}
                </span>
              </div>

              <div className="mt-4 grid gap-3 xl:grid-cols-2">
                <AnimatePresence initial={false}>
                {cashierOrders.length > 0 ? <motion.div key="reveal-23-yes" {...revealMotion}><ShiftRevealContent>{(
                  cashierOrders.map((order: any) => (
                    <div
                      key={order.order_id}
                      className="pos-glass-form-card p-4!"
                    >
                      <div className="flex items-start justify-between gap-4">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <div className="truncate text-base font-black liquid-glass-modal-text">
                              {formatGridOrderNumber(order)}
                            </div>
                            <span className={`inline-flex items-center text-[13px] font-semibold ${getAuditStatusBadgeClass(order.status)}`}>
                              {translateAuditStatus(order.status)}
                            </span>
                          </div>
                          <div className="mt-2 flex flex-wrap items-center gap-2 text-sm liquid-glass-modal-text-muted font-semibold">
                            <span>{formatTime(order.created_at)}</span>
                            <span>•</span>
                            <span>{translateAuditOrderType(order.order_type)}</span>
                            {order.table_number && (
                              <>
                                <span>•</span>
                                <span>{t('modals.staffShift.tableNumber')} {order.table_number}</span>
                              </>
                            )}
                            </div>
                            {typeof order.customer_name === 'string' && order.customer_name.trim() ? (
                              <div className="mt-1 text-sm liquid-glass-modal-text-muted">{order.customer_name.trim()}</div>
                            ) : null}
                          </div>

                        <div className="text-right">
                          <div className="text-xl font-black liquid-glass-modal-text">
                            {formatCurrency(Number(order.total_amount || 0))}
                          </div>
                          <div className="mt-1 inline-flex items-center gap-1.5 text-sm font-semibold liquid-glass-modal-text-muted">
                            {getPaymentSymbol(String(order.payment_method || 'cash'))}
                            <span>{translateAuditPaymentMethod(order.payment_method)}</span>
                          </div>
                        </div>
                      </div>

                      {Number(order.cash_amount || 0) > 0 && Number(order.card_amount || 0) > 0 ? (
                        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 pt-3 text-sm">
                          <span className="liquid-glass-modal-text-muted">
                            {t('modals.staffShift.cash')}{' '}
                            <span className="font-black text-emerald-600 dark:text-emerald-300">
                              {formatCurrency(Number(order.cash_amount || 0))}
                            </span>
                          </span>
                          <span className="liquid-glass-modal-text-muted">
                            {t('modals.staffShift.card')}{' '}
                            <span className="font-black liquid-glass-modal-text-muted">
                              {formatCurrency(Number(order.card_amount || 0))}
                            </span>
                          </span>
                        </div>
                      ) : null}
                    </div>
                  ))
                )}</ShiftRevealContent></motion.div> : (
                  <motion.div key="reveal-23-next" {...revealMotion} className="xl:col-span-2"><ShiftRevealContent>
                    {renderAuditEmptyState(t('modals.staffShift.noAuditOrderHistory'))}
                  </ShiftRevealContent></motion.div>
                )}
                </AnimatePresence>
              </div>
            </div>

            <div className={checkoutInsetSurfaceClass}>
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h4 className="text-lg font-semibold liquid-glass-modal-text">
                    {t('modals.staffShift.auditStaffReturnsTitle')}
                  </h4>
                  <p className="mt-2 text-sm liquid-glass-modal-text-muted">
                    {t('modals.staffShift.auditStaffReturnsHelper')}
                  </p>
                </div>
                <span className="shrink-0 text-base font-semibold liquid-glass-modal-text-muted">
                  {currentPeriodReturns.length + transferredStaff.length}
                </span>
              </div>

              <div className="mt-4 grid gap-4 xl:grid-cols-2">
                <div className="space-y-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-sm liquid-glass-modal-text-muted font-semibold">
                      {t('modals.staffShift.currentPeriodReturnsLabel')}
                    </div>
                    <span className="shrink-0 text-base font-semibold liquid-glass-modal-text-muted">
                      {currentPeriodReturns.length}
                    </span>
                  </div>

                  <AnimatePresence initial={false}>
                  {currentPeriodReturns.length > 0 ? <motion.div key="reveal-24-yes" {...revealMotion}><ShiftRevealContent>{(
                    currentPeriodReturns.map((item: any) => {
                      const amountToReturn = Number(item.amount_to_return || 0);
                      const isPositive = amountToReturn >= 0;

                      return (
                        <div
                          key={item.shift_id || item.driver_id || item.order_id}
                          className="pos-glass-form-card p-4!"
                        >
                          <div className="flex items-start justify-between gap-4">
                            <div>
                              <div className="font-semibold liquid-glass-modal-text">
                                {item.driver_name || item.staff_name || '—'}
                              </div>
                              <div className="mt-1 text-sm liquid-glass-modal-text-muted font-semibold">
                                {translateRoleName(item.role_type || 'driver')}
                              </div>
                              <div className="mt-2 text-xs liquid-glass-modal-text-muted">
                                {formatShiftWindow({
                                  check_in_time: item.check_in_time,
                                  check_out_time: item.check_out_time,
                                })}
                                {' · '}
                                {t('modals.staffShift.ordersCountValue', { count: Number(item.order_count || 0) })}
                              </div>
                            </div>

                            <div className={`text-right text-lg font-black ${isPositive ? 'text-emerald-600 dark:text-emerald-300' : 'text-rose-600 dark:text-rose-300'}`}>
                              {isPositive ? '+' : '-'}{formatCurrency(Math.abs(amountToReturn))}
                              <div className="mt-1 text-[11px] font-semibold liquid-glass-modal-text-muted">
                                {isPositive ? t('modals.staffShift.driverReturns') : t('modals.staffShift.driverTakes')}
                              </div>
                            </div>
                          </div>

                          <div className="mt-3 grid gap-3 pt-3 sm:grid-cols-3">
                            <div className="min-w-0">
                              <div className="text-[11px] liquid-glass-modal-text-muted font-semibold">
                                {t('modals.staffShift.driverStarting')}
                              </div>
                              <div className="mt-1 text-sm font-black liquid-glass-modal-text-muted">
                                {formatCurrency(Number(item.starting_amount || 0))}
                              </div>
                            </div>
                            <div className="min-w-0">
                              <div className="text-[11px] liquid-glass-modal-text-muted font-semibold">
                                {t('modals.staffShift.cashCollected', 'Cash Collected')}
                              </div>
                              <div className="mt-1 text-sm font-black text-emerald-600 dark:text-emerald-300">
                                {formatCurrency(Number(item.cash_collected || 0))}
                              </div>
                            </div>
                            <div className="min-w-0">
                              <div className="text-[11px] liquid-glass-modal-text-muted font-semibold">
                                {t('modals.staffShift.totalSalesLabel', 'Total Sales')}
                              </div>
                              <div className="mt-1 text-sm font-black liquid-glass-modal-text">
                                {formatCurrency(Number(item.total_amount || 0))}
                              </div>
                            </div>
                          </div>
                        </div>
                      );
                    })
                  )}</ShiftRevealContent></motion.div> : <motion.div key="reveal-24-next" {...revealMotion}><ShiftRevealContent>{(
                    renderAuditEmptyState(t('modals.staffShift.noCurrentPeriodReturns'))
                  )}</ShiftRevealContent></motion.div>}
                  </AnimatePresence>
                </div>

                <div className="space-y-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-sm liquid-glass-modal-text-muted font-semibold">
                      {t('modals.staffShift.inheritedReturnsLabel')}
                    </div>
                    <span className="shrink-0 text-base font-semibold liquid-glass-modal-text-muted">
                      {transferredStaff.length}
                    </span>
                  </div>

                  <AnimatePresence initial={false}>
                  {transferredStaff.length > 0 ? <motion.div key="reveal-25-yes" {...revealMotion}><ShiftRevealContent>{(
                    transferredStaff.map((item: any) => {
                      const inheritedReturn = Number(item.net_cash_amount || item.cash_to_return || item.starting_amount || 0);

                      return (
                        <div
                          key={item.shift_id || item.driver_id || item.waiter_id}
                          className="pos-glass-form-card p-4!"
                        >
                          <div className="flex items-start justify-between gap-4">
                            <div>
                              <div className="font-semibold liquid-glass-modal-text">
                                {item.driver_name || item.waiter_name || item.staff_name || '—'}
                              </div>
                              <div className="mt-1 text-sm liquid-glass-modal-text-muted font-semibold">
                                {translateRoleName(item.role_type || 'driver')}
                              </div>
                              <div className="mt-2 text-xs liquid-glass-modal-text-muted">
                                {formatShiftWindow({ check_in_time: item.check_in_time })}
                              </div>
                            </div>

                            <div className="text-right text-lg font-black liquid-glass-modal-text-muted">
                              +{formatCurrency(Math.abs(inheritedReturn))}
                              <div className="mt-1 text-[11px] font-semibold liquid-glass-modal-text-muted">
                                {t('modals.staffShift.driverReturns')}
                              </div>
                            </div>
                          </div>

                          <div className="mt-3 grid gap-3 pt-3 sm:grid-cols-3">
                            <div className="min-w-0">
                              <div className="text-[11px] liquid-glass-modal-text-muted font-semibold">
                                {t('modals.staffShift.driverStarting')}
                              </div>
                              <div className="mt-1 text-sm font-black liquid-glass-modal-text-muted">
                                {formatCurrency(Number(item.starting_amount || 0))}
                              </div>
                            </div>
                            <div className="min-w-0">
                              <div className="text-[11px] liquid-glass-modal-text-muted font-semibold">
                                {t('modals.staffShift.cashCollected', 'Cash Collected')}
                              </div>
                              <div className="mt-1 text-sm font-black text-emerald-600 dark:text-emerald-300">
                                {formatCurrency(Number(item.cash_collected || 0))}
                              </div>
                            </div>
                            <div className="min-w-0">
                              <div className="text-[11px] liquid-glass-modal-text-muted font-semibold">
                                {t('modals.staffShift.totalSalesLabel', 'Total Sales')}
                              </div>
                              <div className="mt-1 text-sm font-black liquid-glass-modal-text">
                                {formatCurrency(Number(item.total_amount || 0))}
                              </div>
                            </div>
                          </div>
                        </div>
                      );
                    })
                  )}</ShiftRevealContent></motion.div> : <motion.div key="reveal-25-next" {...revealMotion}><ShiftRevealContent>{(
                    renderAuditEmptyState(t('modals.staffShift.noInheritedReturns'))
                  )}</ShiftRevealContent></motion.div>}
                  </AnimatePresence>
                </div>
              </div>
            </div>

            <div className={checkoutInsetSurfaceClass}>
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="text-sm liquid-glass-modal-text-muted font-semibold">
                    {t('modals.staffShift.staffPaymentsTitle')}
                  </div>
                  <h4 className="text-lg font-semibold liquid-glass-modal-text">
                    {t('modals.staffShift.totalStaffPayments')}
                  </h4>
                  <p className="mt-2 text-sm liquid-glass-modal-text-muted">
                    {t('modals.staffShift.auditStaffPaymentsHelper')}
                  </p>
                </div>
                <span className="shrink-0 text-base font-semibold liquid-glass-modal-text-muted">
                  {historicalStaffPayments.length}
                </span>
              </div>

              <div className="mt-4 grid gap-3 xl:grid-cols-2">
                <AnimatePresence initial={false}>
                {historicalStaffPayments.length > 0 ? <motion.div key="reveal-26-yes" {...revealMotion}><ShiftRevealContent>{(
                  historicalStaffPayments.map((payment: any) => (
                    <div
                      key={payment.id}
                      className="pos-glass-form-card p-4!"
                    >
                      <div className="flex items-start justify-between gap-4">
                        <div className="min-w-0">
                          <div className="font-semibold liquid-glass-modal-text">
                            {payment.staff_name || '—'}
                          </div>
                          <div className="mt-1 text-sm liquid-glass-modal-text-muted font-semibold">
                            {payment.role_type ? translateRoleName(payment.role_type) : '—'}
                          </div>
                          <div className="mt-2 text-xs liquid-glass-modal-text-muted">
                            {payment.created_at ? formatTime(payment.created_at) : t('common.unknown', 'Unknown')}
                          </div>
                        </div>

                        <div className="text-right font-black text-rose-600 dark:text-rose-300">
                          -{formatCurrency(Number(payment.amount || 0))}
                        </div>
                      </div>
                    </div>
                  ))
                )}</ShiftRevealContent></motion.div> : (
                  <motion.div key="reveal-26-next" {...revealMotion} className="xl:col-span-2"><ShiftRevealContent>
                    {renderAuditEmptyState(t('modals.staffShift.noHistoricalStaffPayments'))}
                  </ShiftRevealContent></motion.div>
                )}
                </AnimatePresence>
              </div>
            </div>
          </div>,
        )}
      </div>
    );
  };

  const renderDriverCheckoutView = () => {
    if (!effectiveShift || !shiftSummary) {
      return null;
    }

    const deliveries = Array.isArray(shiftSummary.driverDeliveries) ? shiftSummary.driverDeliveries : [];
    const completedDeliveries = deliveries.filter((delivery: any) => {
      const status = (delivery.status || delivery.order_status || '').toLowerCase();
      return status !== 'cancelled' && status !== 'canceled' && status !== 'refunded';
    });
    const opening = getEffectiveOpeningAmount(effectiveShift, shiftSummary);
    const cashCollected = deliveries.reduce((sum: number, delivery: any) => sum + Number(delivery.cash_collected || 0), 0);
    const tipsReceived = Number(shiftSummary?.tipsReceived || shiftSummary?.tips_received || 0);
    const amountToReturn = calculateDriverReturn({
      openingAmount: opening,
      cashCollected,
      expenses: shiftSummary.totalExpenses || 0,
      tipsReceived,
    });
    const actualReturned = driverActualCash.trim() ? parseMoneyInputValue(driverActualCash) : null;
    const variance = actualReturned === null ? null : actualReturned - amountToReturn;

    return (
      <div className="space-y-3" data-testid="staff-checkout-section">
        {renderCheckoutBackButton()}

        <div className="grid gap-3 xl:grid-cols-[minmax(0,1.35fr)_minmax(360px,0.95fr)]">
          <div className="space-y-3">
            <div className={checkoutSurfaceClass}>
              <div className="text-sm liquid-glass-modal-text-muted font-semibold">
                {t('modals.staffShift.amountToReturn', {
                  defaultValue: 'Return',
                })}
              </div>
              <div className="mt-3 text-4xl font-black tracking-tight liquid-glass-modal-text">
                {formatCurrency(Math.abs(amountToReturn))}
              </div>
              <p className="mt-3 text-sm liquid-glass-modal-text-muted">
                {t('modals.staffShift.cashReturnHelper', {
                  defaultValue: 'Hand this cash to the cashier. Tips are recorded separately.',
                })}
              </p>

              <div className={`mt-5 ${checkoutInsetSurfaceClass}`}>
                <label className="block text-xs font-semibold liquid-glass-modal-text-muted">
                  {t('modals.staffShift.cashActuallyHandedOver', {
                    defaultValue: 'Cash Actually Handed Over',
                  })}
                </label>
                <CentsMoneyInput
                  aria-label={t('modals.staffShift.cashActuallyHandedOver', { defaultValue: 'Cash Actually Handed Over' })}
                  value={driverActualCash}
                  onValueChange={setDriverActualCash}
                  placeholder="0,00"
                  className="liquid-glass-modal-input pos-glass-field min-h-[44px] mt-3 w-full text-3xl font-black text-center"
                  autoFocus
                />
                <AnimatePresence initial={false}>
                {variance === null ? <motion.div key="reveal-27-yes" {...revealMotion}><ShiftRevealContent>
                  <p className="mt-4 text-center text-sm liquid-glass-modal-text-muted">
                    {t('modals.staffShift.actualCashReturnedRequired', {
                      defaultValue: 'Enter the cash actually handed to the cashier before checkout.',
                    })}
                  </p>
                </ShiftRevealContent></motion.div> : (
                  <motion.div key="reveal-27-next" {...revealMotion} className="mt-4 flex justify-center"><ShiftRevealContent>
                    <VarianceBadge currency={checkoutDisplayCurrency} variance={variance} size="lg" showIcon />
                  </ShiftRevealContent></motion.div>
                )}
                </AnimatePresence>
              </div>
            </div>

            <div className={checkoutSurfaceClass}>
              <h3 className="text-xl font-semibold liquid-glass-modal-text">
                {t('receipt.formula.label')}
              </h3>
              <div className="mt-5 space-y-2">
                {[
                  { label: t('modals.staffShift.startingAmount', 'Starting Amount'), amount: opening, tone: 'liquid-glass-modal-text-muted', prefix: '+' },
                  { label: t('modals.staffShift.cashCollected', 'Cash Collected'), amount: cashCollected, tone: 'text-emerald-600 dark:text-emerald-300', prefix: '+' },
                  { label: t('modals.staffShift.expenses', 'Expenses'), amount: shiftSummary.totalExpenses || 0, tone: 'text-rose-600 dark:text-rose-300', prefix: '-' },
                  { label: t('modals.staffShift.tipsReceived', 'Tips Received'), amount: tipsReceived, tone: 'text-rose-600 dark:text-rose-300', prefix: '-' },
                ].map((row) => (
                  <div
                    key={row.label}
                    className="flex items-center justify-between px-1 py-3"
                  >
                    <span className="text-sm font-medium liquid-glass-modal-text-muted">{row.label}</span>
                    <span className={`text-lg font-black ${row.tone}`}>
                      {row.prefix}{formatCurrency(row.amount)}
                    </span>
                  </div>
                ))}
                <div className="pos-glass-form-card flex items-center justify-between px-4! py-3!">
                  <span className="text-sm font-semibold liquid-glass-modal-text">
                    {t('modals.staffShift.amountToReturn', {
                      defaultValue: 'Return',
                    })}
                  </span>
                  <span className={`text-xl font-black ${amountToReturn >= 0 ? 'liquid-glass-modal-text' : 'text-rose-600 dark:text-rose-300'}`}>
                    {formatCurrency(Math.abs(amountToReturn))}
                  </span>
                </div>
              </div>
            </div>
          </div>

          <div className="space-y-3">
            {renderExpensesPanel()}
            {renderTipsSummaryCard()}

            <div className={checkoutSurfaceClass}>
              <div className="text-sm liquid-glass-modal-text-muted font-semibold">
                {t('modals.staffShift.informationOnlyTitle', 'Information Only')}
              </div>
              <h3 className="mt-2 text-xl font-semibold liquid-glass-modal-text">
                {t('modals.staffShift.reviewAndConfirm')}
              </h3>
              <div className="mt-5 grid gap-4 sm:grid-cols-2">
                <div className={checkoutInsetSurfaceClass}>
                  <div className="text-sm liquid-glass-modal-text-muted font-semibold">
                    {t('modals.staffShift.totalOrders')}
                  </div>
                  <div className="mt-2 text-2xl font-black liquid-glass-modal-text">{completedDeliveries.length}</div>
                </div>
                <div className={checkoutInsetSurfaceClass}>
                  <div className="text-sm liquid-glass-modal-text-muted font-semibold">
                    {t('modals.staffShift.cashCollected', 'Cash Collected')}
                  </div>
                  <div className={`mt-2 text-2xl font-black text-emerald-600 dark:text-emerald-300`}>
                    {formatCurrency(cashCollected)}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {renderAuditSection(
          <div className="space-y-3">
            <AnimatePresence initial={false}>
            {deliveries.length > 0 ? <motion.div key="reveal-28-yes" {...revealMotion}><ShiftRevealContent>{(
              deliveries.map((delivery: any) => (
                <div
                  key={delivery.id}
                  className="pos-glass-form-card p-4!"
                >
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <div className="font-semibold liquid-glass-modal-text">{formatGridOrderNumber(delivery)}</div>
                      <div className="mt-1 text-sm liquid-glass-modal-text-muted">
                        {delivery.customer_name || '—'}
                      </div>
                      {delivery.delivery_address && (
                        <div className="mt-1 text-xs liquid-glass-modal-text-muted">{delivery.delivery_address}</div>
                      )}
                    </div>
                    <div className="text-right">
                      <div className="font-black liquid-glass-modal-text">{formatCurrency(Number(delivery.total_amount || 0))}</div>
                      <div className="mt-1 text-sm liquid-glass-modal-text-muted font-semibold">
                        {(delivery.payment_method || 'card').toUpperCase()}
                      </div>
                    </div>
                  </div>
                </div>
              ))
            )}</ShiftRevealContent></motion.div> : (
              <motion.div key="reveal-28-next" {...revealMotion} className="pos-glass-form-card px-4! py-5! text-center text-sm liquid-glass-modal-text-muted"><ShiftRevealContent>
                {t('modals.staffShift.noOrdersYet')}
              </ShiftRevealContent></motion.div>
            )}
            </AnimatePresence>
          </div>,
        )}
      </div>
    );
  };

  const renderServerCheckoutView = () => {
    if (!effectiveShift || !shiftSummary?.waiterTables) {
      return null;
    }

    const waiterTables = Array.isArray(shiftSummary.waiterTables) ? shiftSummary.waiterTables : [];
    const opening = getEffectiveOpeningAmount(effectiveShift, shiftSummary);
    const cashFromTables = waiterTables.reduce((sum: number, table: any) => sum + Number(table.cash_amount || 0), 0);
    const cardTotal = waiterTables.reduce((sum: number, table: any) => sum + Number(table.card_amount || 0), 0);
    const totalOrders = waiterTables.reduce((sum: number, table: any) => sum + Number(table.order_count || 0), 0);
    const expensesTotal = shiftSummary.totalExpenses || 0;
    const calculationVersion = effectiveShift.calculation_version || 1;
    const paymentAmount = effectiveShift.payment_amount || 0;
    const cashToReturn = calculationVersion >= 2
      ? opening + cashFromTables - expensesTotal
      : opening + cashFromTables - expensesTotal - paymentAmount;
    const actualReturned = closingCash.trim() ? parseMoneyInputValue(closingCash) : null;
    const variance = actualReturned === null ? null : actualReturned - cashToReturn;

    return (
      <div className="space-y-3" data-testid="staff-checkout-section">
        {renderCheckoutBackButton()}

        <div className="grid gap-3 xl:grid-cols-[minmax(0,1.35fr)_minmax(360px,0.95fr)]">
          <div className="space-y-3">
            <div className={checkoutSurfaceClass}>
              <div className="text-sm liquid-glass-modal-text-muted font-semibold">
                {t('modals.staffShift.cashToHandToCashier', {
                  defaultValue: 'Cash To Hand To Cashier',
                })}
              </div>
              <div className="mt-3 text-4xl font-black tracking-tight liquid-glass-modal-text">
                {formatCurrency(Math.abs(cashToReturn))}
              </div>
              <p className="mt-3 text-sm liquid-glass-modal-text-muted">
                {calculationVersion >= 2
                  ? t('modals.staffShift.cashReturnHelper', {
                    defaultValue: 'Hand this cash to the cashier. Tips are recorded separately.',
                  })
                  : t('modals.staffShift.paymentDeductedNote', {
                    defaultValue: 'Payment already deducted from amount to return',
                  })}
              </p>

              <div className={`mt-5 ${checkoutInsetSurfaceClass}`}>
                <label className="block text-xs font-semibold liquid-glass-modal-text-muted">
                  {t('modals.staffShift.cashActuallyHandedOver', {
                    defaultValue: 'Cash Actually Handed Over',
                  })}
                </label>
                <CentsMoneyInput
                  aria-label={t('modals.staffShift.cashActuallyHandedOver', { defaultValue: 'Cash Actually Handed Over' })}
                  value={closingCash}
                  onValueChange={setClosingCash}
                  placeholder="0,00"
                  className="liquid-glass-modal-input pos-glass-field min-h-[44px] mt-3 w-full text-3xl font-black text-center"
                  autoFocus
                />
                <AnimatePresence initial={false}>
                {variance === null ? <motion.div key="reveal-29-yes" {...revealMotion}><ShiftRevealContent>
                  <p className="mt-4 text-center text-sm liquid-glass-modal-text-muted">
                    {t('modals.staffShift.actualCashReturnedRequired', {
                      defaultValue: 'Enter the cash actually handed to the cashier before checkout.',
                    })}
                  </p>
                </ShiftRevealContent></motion.div> : (
                  <motion.div key="reveal-29-next" {...revealMotion} className="mt-4 flex justify-center"><ShiftRevealContent>
                    <VarianceBadge currency={checkoutDisplayCurrency} variance={variance} size="lg" showIcon />
                  </ShiftRevealContent></motion.div>
                )}
                </AnimatePresence>
              </div>
            </div>

            <div className={checkoutSurfaceClass}>
              <h3 className="text-xl font-semibold liquid-glass-modal-text">
                {t('receipt.formula.label')}
              </h3>
              <div className="mt-5 space-y-2">
                {[
                  { label: t('modals.staffShift.startingAmount', 'Starting Amount'), amount: opening, tone: 'liquid-glass-modal-text-muted', prefix: '+' },
                  { label: t('modals.staffShift.cashCollected', 'Cash Collected'), amount: cashFromTables, tone: 'text-emerald-600 dark:text-emerald-300', prefix: '+' },
                  { label: t('modals.staffShift.expenses', 'Expenses'), amount: expensesTotal, tone: 'text-rose-600 dark:text-rose-300', prefix: '-' },
                  ...(calculationVersion < 2 && paymentAmount > 0
                    ? [{ label: t('modals.staffShift.payment', 'Payment'), amount: paymentAmount, tone: 'text-yellow-700 dark:text-yellow-300', prefix: '-' }]
                    : []),
                ].map((row) => (
                  <div
                    key={row.label}
                    className="flex items-center justify-between px-1 py-3"
                  >
                    <span className="text-sm font-medium liquid-glass-modal-text-muted">{row.label}</span>
                    <span className={`text-lg font-black ${row.tone}`}>
                      {row.prefix}{formatCurrency(row.amount)}
                    </span>
                  </div>
                ))}
                <div className="pos-glass-form-card flex items-center justify-between px-4! py-3!">
                  <span className="text-sm font-semibold liquid-glass-modal-text">
                    {t('modals.staffShift.cashToHandToCashier', {
                      defaultValue: 'Cash To Hand To Cashier',
                    })}
                  </span>
                  <span className={`text-xl font-black ${cashToReturn >= 0 ? 'liquid-glass-modal-text' : 'text-rose-600 dark:text-rose-300'}`}>
                    {formatCurrency(Math.abs(cashToReturn))}
                  </span>
                </div>
              </div>
            </div>
          </div>

          <div className="space-y-3">
            {renderExpensesPanel()}
            {renderTipsSummaryCard()}

            <div className={checkoutSurfaceClass}>
              <div className="text-sm liquid-glass-modal-text-muted font-semibold">
                {t('modals.staffShift.informationOnlyTitle', 'Information Only')}
              </div>
              <h3 className="mt-2 text-xl font-semibold liquid-glass-modal-text">
                {t('modals.staffShift.orderSummary', 'Order Summary')}
              </h3>
              <div className="mt-5 grid gap-4 sm:grid-cols-2">
                <div className={checkoutInsetSurfaceClass}>
                  <div className="text-sm liquid-glass-modal-text-muted font-semibold">
                    {t('modals.staffShift.tablesServed', 'Tables Served')}
                  </div>
                  <div className="mt-2 text-2xl font-black liquid-glass-modal-text">{waiterTables.length}</div>
                </div>
                <div className={checkoutInsetSurfaceClass}>
                  <div className="text-sm liquid-glass-modal-text-muted font-semibold">
                    {t('modals.staffShift.ordersCount', 'Orders')}
                  </div>
                  <div className="mt-2 text-2xl font-black liquid-glass-modal-text">{totalOrders}</div>
                </div>
                <div className={checkoutInsetSurfaceClass}>
                  <div className="text-sm liquid-glass-modal-text-muted font-semibold">
                    {t('modals.staffShift.cashOrders', 'Cash Orders')}
                  </div>
                  <div className={`mt-2 text-2xl font-black text-emerald-600 dark:text-emerald-300`}>
                    {formatCurrency(cashFromTables)}
                  </div>
                </div>
                <div className={checkoutInsetSurfaceClass}>
                  <div className="text-sm liquid-glass-modal-text-muted font-semibold">
                    {t('modals.staffShift.cardOrders', 'Card Orders')}
                  </div>
                  <div className="mt-2 text-2xl font-black liquid-glass-modal-text-muted">
                    {formatCurrency(cardTotal)}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {renderAuditSection(
          <div className="space-y-3">
            <AnimatePresence initial={false}>
            {waiterTables.length > 0 ? <motion.div key="reveal-30-yes" {...revealMotion}><ShiftRevealContent>{(
              waiterTables.map((table: any) => (
                <div
                  key={table.table_number}
                  className="pos-glass-form-card p-4!"
                >
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <div className="font-semibold liquid-glass-modal-text">
                        {t('modals.staffShift.tableNumber', 'Table')} {table.table_number}
                      </div>
                      <div className="mt-1 text-sm liquid-glass-modal-text-muted">
                        {t('modals.staffShift.ordersCountValue', { count: table.order_count || 0 })}
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="font-black liquid-glass-modal-text">{formatCurrency(Number(table.total_amount || 0))}</div>
                      <div className="mt-1 text-sm liquid-glass-modal-text-muted font-semibold">
                        {(table.payment_method || 'mixed').toUpperCase()}
                      </div>
                    </div>
                  </div>
                </div>
              ))
            )}</ShiftRevealContent></motion.div> : (
              <motion.div key="reveal-30-next" {...revealMotion} className="pos-glass-form-card px-4! py-5! text-center text-sm liquid-glass-modal-text-muted"><ShiftRevealContent>
                {t('modals.staffShift.noOrdersYet')}
              </ShiftRevealContent></motion.div>
            )}
            </AnimatePresence>
          </div>,
        )}
      </div>
    );
  };

  const renderNonFinancialCheckoutView = () => {
    if (!effectiveShift) {
      return null;
    }

    return (
      <div className="space-y-3" data-testid="staff-checkout-section">
        {renderCheckoutBackButton()}

        <div className="grid gap-3 xl:grid-cols-[minmax(0,1.15fr)_minmax(340px,0.85fr)]">
          <div className="space-y-3">
            <div className={checkoutSurfaceClass}>
              <div className="text-sm text-emerald-600 dark:text-emerald-300 font-semibold">
                {t('modals.staffShift.shiftSummary', 'Shift Summary')}
              </div>
              <h3 className="mt-2 text-xl font-semibold liquid-glass-modal-text">
                {t('modals.staffShift.nonFinancialRoleTitle', {
                  defaultValue: 'Operational shift only',
                })}
              </h3>
              <p className="mt-3 text-sm liquid-glass-modal-text-muted">
                {t('modals.staffShift.nonFinancialRoleNote', {
                  defaultValue: 'This role does not handle drawer cash, sales reconciliation, refunds, or expenses at checkout.',
                })}
              </p>

              <div className={`mt-5 grid gap-3 sm:grid-cols-2 ${checkoutInsetSurfaceClass}`}>
                <div>
                  <div className="text-sm liquid-glass-modal-text-muted font-semibold">
                    {t('modals.staffShift.staffMember', 'Staff')}
                  </div>
                  <div className="mt-2 text-lg font-black liquid-glass-modal-text">
                    {effectiveShift.staff_name || t('common.unknown', 'Unknown')}
                  </div>
                </div>
                <div>
                  <div className="text-sm liquid-glass-modal-text-muted font-semibold">
                    {t('modals.staffShift.roleStepLabel', 'Role')}
                  </div>
                  <div className="mt-2 text-lg font-black liquid-glass-modal-text">
                    {translateRoleName(effectiveShift.role_type)}
                  </div>
                </div>
                <div>
                  <div className="text-sm liquid-glass-modal-text-muted font-semibold">
                    {t('modals.staffShift.checkIn')}
                  </div>
                  <div className="mt-2 text-lg font-black liquid-glass-modal-text">
                    {formatTime(effectiveShift.check_in_time)}
                  </div>
                </div>
                <div>
                  <div className="text-sm liquid-glass-modal-text-muted font-semibold">
                    {t('modals.staffShift.checkOut')}
                  </div>
                  <div className="mt-2 text-sm font-semibold text-emerald-600 dark:text-emerald-300">
                    {t('modals.staffShift.checkoutTimeRecordedOnClose', {
                      defaultValue: 'Recorded automatically when you close the shift',
                    })}
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div className="space-y-3">
            <div className={checkoutSurfaceClass}>
              <div className="text-sm liquid-glass-modal-text-muted font-semibold">
                {t('modals.staffShift.reviewAndConfirm')}
              </div>
              <h3 className="mt-2 text-xl font-semibold liquid-glass-modal-text">
                {t('modals.staffShift.readyToClose', { defaultValue: 'Ready To Close' })}
              </h3>
              <p className="mt-3 text-sm liquid-glass-modal-text-muted">
                {t('modals.staffShift.nonFinancialCheckoutHelper', {
                  defaultValue: 'Closing this shift only records the staff member, role, and checkout time.',
                })}
              </p>
            </div>
          </div>
        </div>
      </div>
    );
  };

  const renderCheckoutContent = () => {
    if (effectiveMode !== 'checkout' || !effectiveShift) {
      return null;
    }

    if (isCashierCheckoutRole) {
      return renderCashierCheckoutView();
    }

    if (effectiveShift.role_type === 'driver') {
      return renderDriverCheckoutView();
    }

    if (effectiveShift.role_type === 'server') {
      return renderServerCheckoutView();
    }

    return renderNonFinancialCheckoutView();
  };

  const renderRoleBadge = (
    role: StaffRole,
    options: { emphasized?: boolean; highlighted?: boolean } = {},
  ) => {
    // Plain words, no wrapper (founder 01/11); the star marks the primary (or chosen) role.
    return (
      <span key={role.role_id} className="inline-flex items-center gap-1 text-sm font-semibold liquid-glass-modal-text">
        {(options.highlighted || role.is_primary) && <Star className="h-3.5 w-3.5" />}
        <span>{translateRoleName(role.role_name)}</span>
      </span>
    );
  };

  const renderCheckInBackButton = (targetStep: CheckInStep) => (
    <motion.button
      onClick={() => {
        clearFinancialAuthorization();
        setEnteredPin('');
        setLoading(false);
        setError('');
        navigateCheckInStep(targetStep);
      }}
      className="pos-solid-btn pos-solid-btn--md"
      {...getInteractiveMotion('button')}
    >
      <ChevronLeft className="h-5 w-5" />
      {t('common.actions.back')}
    </motion.button>
  );

  // The chosen person as one compact line: name, then their roles (or the role chosen for this shift).
  // The step's own title and help appear once, in the step, never repeated here.
  const renderSelectedStaffSummary = ({
    statusLabel,
    highlightedRoleName,
  }: {
    statusLabel?: string;
    highlightedRoleName?: string;
  } = {}) => {
    if (!selectedStaff) {
      return null;
    }

    const roleNames = highlightedRoleName
      ? [highlightedRoleName]
      : selectedStaffRoles.length > 0
        ? selectedStaffRoles.map((role) => role.role_name)
        : [selectedPrimaryRole?.role_name || selectedStaff.role_name];

    return (
      <div className="pos-glass-form-card flex items-center gap-3 px-4! py-3!" data-testid="checkin-selected-staff">
        <User className="h-7 w-7 shrink-0 liquid-glass-modal-text-muted" strokeWidth={1.8} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-lg font-semibold liquid-glass-modal-text">{selectedStaff.name}</div>
          <div className={`truncate ${checkInMutedTextClass}`}>
            <span className="sr-only">{t('modals.staffShift.currentRoleLabel')}: </span>
            {roleNames.map((roleName) => translateRoleName(roleName)).join(' · ')}
          </div>
        </div>
        {statusLabel && <span className="shrink-0 text-sm font-semibold liquid-glass-modal-text">{statusLabel}</span>}
      </div>
    );
  };

  const renderCheckInContent = () => {
    if (checkInStep === 'select-staff') {
      return (
        <div className="space-y-4" data-testid="staff-select-section">
          <div className="pos-pane-head">
            <h3 className="pos-pane-title">{t('modals.staffShift.selectStaff')}</h3>
            <p className="pos-pane-intro">{t('modals.staffShift.selectStaffStepHelper')}</p>
          </div>

          <AnimatePresence initial={false}>
          {hasActiveErganiPlugin && (
            <motion.div key="reveal-31" {...revealMotion} className="pos-glass-form-card p-4!"><ShiftRevealContent>
              <label className="block text-xs font-semibold liquid-glass-modal-text-muted">
                {t('modals.staffShift.staffQrBadge', 'Staff QR badge')}
              </label>
              <div className="mt-3 flex flex-col gap-3 sm:flex-row">
                <div className="relative flex-1">
                  <QrCode className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 liquid-glass-modal-text-muted" />
                  <input
                    value={staffQrCode}
                    onChange={(event) => setStaffQrCode(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        void handleStaffQrResolve();
                      }
                    }}
                    placeholder={t('modals.staffShift.staffQrPlaceholder', 'Scan or paste staff QR badge')}
                    className="pos-glass-field min-h-[48px] w-full py-3 pl-12 pr-4 text-base font-semibold liquid-glass-modal-text outline-hidden transition-colors focus:border-(--pos-s-yellow)"
                  />
                </div>
                <motion.button
                  type="button"
                  onClick={() => void handleStaffQrResolve()}
                  disabled={resolvingStaffQr || staffQrCode.trim().length === 0}
                  className="pos-solid-btn pos-solid-btn--md pos-solid-btn--primary"
                  {...getInteractiveMotion('primary', resolvingStaffQr || staffQrCode.trim().length === 0)}
                >
                  {resolvingStaffQr ? (
                    <div className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
                  ) : (
                    <QrCode className="h-4 w-4" />
                  )}
                  {t('modals.staffShift.resolveQr', 'Scan QR')}
                </motion.button>
              </div>
            </ShiftRevealContent></motion.div>
          )}
          </AnimatePresence>

          {/* Outside the staff grid: an open phone shift must stay reachable
              even when the directory lists nobody (founder 13/10/2026). */}
          {!loading && renderPhoneShiftSections()}

          <AnimatePresence initial={false}>
          {loading ? (
            <motion.div key="reveal-32-yes" {...revealMotion} className={`${checkInSurfaceClass} py-12 text-center`}><ShiftRevealContent>
              <div className="inline-block h-10 w-10 animate-spin rounded-full border-4 border-(--pos-s-border) border-t-(--pos-s-fg)" />
              <p className={`mt-4 ${checkInMutedTextClass}`}>{t('modals.staffShift.loadingStaff')}</p>
            </ShiftRevealContent></motion.div>
          ) : availableStaff.length === 0 ? (
            <motion.div key="reveal-32-next-yes" {...revealMotion} className={`${checkInSurfaceClass} py-12 text-center`}><ShiftRevealContent>
              <User className="mx-auto mb-3 h-12 w-12 liquid-glass-modal-text-muted" strokeWidth={1.6} />
              <p className="text-base font-semibold liquid-glass-modal-text">
                {t('modals.staffShift.noStaffAvailable')}
              </p>
            </ShiftRevealContent></motion.div>
          ) : (
            <motion.div key="reveal-32-next-next" {...revealMotion} className="space-y-4"><ShiftRevealContent>
              {/* On shift now: one row each; the row itself opens the shift. */}
              {/* Founder 01/11/2026 («η σκια της θα ηθελα να ειναι πρασινη»): staff on shift lift the card on a green shadow. */}
              <section className={`pos-glass-form-card space-y-3 ${activeCheckInStaff.length > 0 ? 'pos-group--ok' : ''}`} data-testid="checkin-active-shifts">
                <div className="flex items-center justify-between gap-3 pb-3">
                  <h4 className="pos-group__title">{t('modals.staffShift.checkedInNow')}</h4>
                  <span className={`text-base font-semibold ${activeCheckInStaff.length > 0 ? 'text-(--pos-s-ok)' : 'liquid-glass-modal-text-muted'}`}>{activeCheckInStaff.length}</span>
                </div>
                {activeCheckInStaff.length > 0 ? (
                  activeCheckInStaff.map((staffMember) => {
                    // The Rust getActive lookup is staff-wide, so a satellite
                    // shift usually ALSO appears in staffActiveShifts as a
                    // plain local row without remote metadata. Prefer the
                    // directory-enriched satellite entry (one-open-shift-per-
                    // staff guarantees they describe the same shift) so the
                    // terminal chip and live totals always render.
                    const activeShiftForMember =
                      satelliteShiftsByStaffId.get(staffMember.id) ||
                      staffActiveShifts.get(staffMember.id);
                    const activeRoleName = activeShiftForMember?.role_type || staffMember.role_name;
                    const satelliteTerminalName: string | null =
                      activeShiftForMember?.remote === true
                        ? String(activeShiftForMember?.remote_terminal_name || '')
                        : null;

                    return (
                      <motion.button
                        key={staffMember.id}
                        onClick={() => {
                          void handleStaffSelect(staffMember);
                        }}
                        className="pos-glass-tap-card flex min-h-[56px] w-full items-center justify-between gap-3 px-4 py-3 relative text-left"
                        {...getInteractiveMotion('card')}
                      >
                        {/* Founder 01/11: staff already checked in show in green (the kit ok colour). */}
                        <span className="flex min-w-0 items-center gap-3">
                          <User className="h-7 w-7 shrink-0 text-(--pos-s-ok)" strokeWidth={1.8} />
                          <span className="pos-row__label">
                            <span className="truncate text-base font-semibold text-(--pos-s-ok)">{staffMember.name}</span>
                            <WorkCardLine status={workCard} staffId={staffMember.id} />
                            <span className="liquid-glass-modal-text-muted flex flex-wrap items-center gap-x-2 gap-y-1">
                              <span className="inline-flex items-center gap-1 font-semibold text-(--pos-s-ok)">
                                <CheckCircle className="h-4 w-4 shrink-0" />
                                {translateRoleName(activeRoleName)}
                              </span>
                              <span className="inline-flex items-center gap-1">
                                <Clock className="h-4 w-4 shrink-0" />
                                {t('modals.staffShift.activeSince', {
                                  time: activeShiftForMember?.check_in_time
                                    ? formatTime(activeShiftForMember.check_in_time)
                                    : t('shift.labels.active', 'Active'),
                                })}
                              </span>
                              {satelliteTerminalName ? (
                                <span className="liquid-glass-modal-text-muted">
                                  {t('modals.staffShift.satelliteTerminalChip', {
                                    defaultValue: 'on {{terminal}}',
                                    terminal: satelliteTerminalName,
                                  })}
                                  {' · '}
                                  {t('modals.staffShift.satelliteTotalsChip', {
                                    defaultValue: '{{orders}} orders · {{sales}}',
                                    orders: activeShiftForMember?.total_orders_count ?? 0,
                                    sales: formatCurrency(
                                      Number(activeShiftForMember?.total_sales_amount ?? 0),
                                    ),
                                  })}
                                </span>
                              ) : null}
                            </span>
                          </span>
                        </span>
                        <span className="pos-row__control text-sm font-semibold liquid-glass-modal-text">
                          {t('modals.staffShift.manageActiveShift')}
                          <ChevronRight className="h-5 w-5 shrink-0" />
                        </span>
                      </motion.button>
                    );
                  })
                ) : (
                  <p className="py-3 text-sm liquid-glass-modal-text-muted">{t('modals.staffShift.noCheckedInStaff')}</p>
                )}
              </section>

              {/* Ready to start: a card each, two across; the card itself goes on to the PIN. */}
              <section className="pos-glass-form-card" data-testid="checkin-ready-staff">
                <div className="flex items-center justify-between gap-3 pb-3">
                  <h4 className="pos-group__title">{t('modals.staffShift.readyToStart')}</h4>
                  <span className="text-base font-semibold liquid-glass-modal-text-muted">{readyCheckInStaff.length}</span>
                </div>
                {readyCheckInStaff.length > 0 ? (
                  <div className="grid gap-3 sm:grid-cols-2">
                    {readyCheckInStaff.map((staffMember) => {
                      const roles = getStaffRoles(staffMember);
                      const busyInfo = busyElsewhereByStaffId.get(staffMember.id);

                      // Busy-elsewhere card: shown, not selectable, with where and as what.
                      if (busyInfo) {
                        const busyTerminal =
                          busyInfo.terminalName ||
                          t('modals.staffShift.busyTerminalFallback', 'another terminal');
                        const busyRole =
                          busyInfo.role || t('shift.labels.active', 'Active');
                        return (
                          <div
                            key={staffMember.id}
                            role="presentation"
                            aria-disabled="true"
                            className="pos-glass-form-card flex min-h-[56px] w-full items-center gap-3 p-3! cursor-not-allowed"
                          >
                            <User className="h-7 w-7 shrink-0 liquid-glass-modal-text-muted" strokeWidth={1.8} />
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-base font-semibold liquid-glass-modal-text-muted">
                                {staffMember.name}
                              </span>
                              <WorkCardLine status={workCard} staffId={staffMember.id} />
                              <span className="block text-sm liquid-glass-modal-text-muted">
                                {t('modals.staffShift.busyElsewhere', {
                                  defaultValue: 'Checked in at {{terminal}} as {{role}}',
                                  terminal: busyTerminal,
                                  role: busyRole,
                                })}
                              </span>
                            </span>
                            <span className="shrink-0 text-sm font-semibold liquid-glass-modal-text-muted">
                              {t('modals.staffShift.unavailable', 'Unavailable')}
                            </span>
                          </div>
                        );
                      }

                      return (
                        <motion.button
                          key={staffMember.id}
                          onClick={() => {
                            void handleStaffSelect(staffMember);
                          }}
                          aria-label={`${staffMember.name} · ${t('modals.staffShift.enterPinAction')}`}
                          className="pos-glass-tap-card flex min-h-[56px] w-full items-center justify-between gap-3 px-4 py-3"
                          {...getInteractiveMotion('card')}
                        >
                          <User className="h-7 w-7 shrink-0 liquid-glass-modal-text-muted" strokeWidth={1.8} />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-base font-semibold liquid-glass-modal-text">
                              {staffMember.name}
                            </span>
                            <WorkCardLine status={workCard} staffId={staffMember.id} />
                            <span className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
                              {roles.map((role) =>
                                renderRoleBadge(role, {
                                  emphasized: role.is_primary,
                                }),
                              )}
                            </span>
                          </span>
                          <ChevronRight className="h-5 w-5 shrink-0 liquid-glass-modal-text" />
                        </motion.button>
                      );
                    })}
                  </div>
                ) : (
                  <p className="py-3 text-sm liquid-glass-modal-text-muted">{t('modals.staffShift.noReadyStaff')}</p>
                )}
              </section>
            </ShiftRevealContent></motion.div>
          )}
          </AnimatePresence>
        </div>
      );
    }

    if (checkInStep === 'enter-pin' && selectedStaff) {
      return (
        <div className="space-y-3" data-testid="staff-pin-section">
          <AnimatePresence initial={false}>
          {giftPending?.staffId === selectedStaff.id && <motion.div key="reveal-33" {...revealMotion}><ShiftRevealContent>
            <GiftClosePendingList
              state={giftPending}
              onSelect={(closing) => openGiftRecoveryFromCheckIn(selectedStaff.id, closing)}
              onReload={() => loadGiftPending(selectedStaff.id)}
            />
          </ShiftRevealContent></motion.div>}
          </AnimatePresence>
          <div className={checkInStepColumnClass}>
            {renderSelectedStaffSummary()}

            <div className={checkInSurfaceClass}>
              {/* One PIN heading and its help, once. */}
              <h3 className="pos-pane-title">{t('modals.staffShift.enterPIN')}</h3>
              <p className={`mt-0.5 ${checkInMutedTextClass}`}>{t('modals.staffShift.enterPinHelper')}</p>

              <div className="mt-3">
                <div
                  className="relative p-2"
                  onClick={() => pinInputRef.current?.focus()}
                >
                  <input
                    ref={pinInputRef}
                    type="password"
                    inputMode="numeric"
                    pattern="[0-9]*"
                    maxLength={4}
                    value={enteredPin}
                    onChange={(e) => setEnteredPin(e.target.value.replace(/\D/g, ''))}
                    onKeyDown={(e) => e.key === 'Enter' && enteredPin.length === 4 && handlePinSubmit()}
                    aria-label={t('modals.staffShift.enterPIN')}
                    className="pos-glass-field min-h-[44px] w-full py-2.5 text-center text-3xl font-black tracking-[0.7em] liquid-glass-modal-text outline-hidden"
                    autoFocus
                    autoComplete="off"
                    style={{ paddingLeft: '0.7em' }}
                  />

                  {enteredPin.length === 0 && (
                    <div className="pointer-events-none absolute inset-0 flex items-center justify-center gap-3">
                      {[0, 1, 2, 3].map((slot) => (
                        <div key={slot} className="h-3 w-3 rounded-full border-2 border-(--pos-s-control)" />
                      ))}
                    </div>
                  )}
                </div>

                {/* Round 313: on-screen numeric keypad for touchscreen PIN entry. It updates the SAME
                    enteredPin state (append up to 4 digits / clear / backspace) and NEVER auto-submits --
                    the Continue button stays the only submit path; keyboard entry above is unchanged. */}
                <div data-testid="staff-pin-keypad" className="mt-3 grid grid-cols-3 gap-1.5">
                  {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((digit) => (
                    <button
                      key={digit}
                      type="button"
                      onClick={() => setEnteredPin((prev) => (prev.length >= 4 ? prev : prev + digit))}
                      aria-label={digit}
                      className={checkInKeyClass}
                    >
                      {digit}
                    </button>
                  ))}
                  <button
                    type="button"
                    onClick={() => setEnteredPin('')}
                    aria-label={t('login.clear', 'Clear')}
                    className={`${checkInKeyClass} liquid-glass-modal-text-muted`}
                  >
                    <X className="h-5 w-5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => setEnteredPin((prev) => (prev.length >= 4 ? prev : prev + '0'))}
                    aria-label="0"
                    className={checkInKeyClass}
                  >
                    0
                  </button>
                  <button
                    type="button"
                    onClick={() => setEnteredPin((prev) => prev.slice(0, -1))}
                    aria-label={t('login.backspace', 'Backspace')}
                    className={`${checkInKeyClass} liquid-glass-modal-text-muted`}
                  >
                    <Delete className="h-5 w-5" />
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      );
    }

    if (checkInStep === 'select-role' && selectedStaff) {
      return (
        <div className={checkInStepColumnClass} data-testid="staff-role-section">
          {renderSelectedStaffSummary()}

          <div className={checkInSurfaceClass}>
            <h3 className="pos-pane-title">{t('modals.staffShift.selectRoleForShift')}</h3>
            <p className={`mt-0.5 ${checkInMutedTextClass}`}>{t('modals.staffShift.roleSelectionHelper')}</p>

            <AnimatePresence initial={false}>
            {cashierFirstGateActive && (
              <motion.div key="reveal-34" {...revealMotion} className="pos-notice pos-notice--warn mt-4 text-sm"><ShiftRevealContent>
                <AlertTriangle className="pos-notice__icon h-5 w-5" />
                <div className="space-y-1">
                  <p className="font-semibold">
                    {t('modals.staffShift.cashierFirstCheckInRequired')}
                  </p>
                  <p>
                    {selectedStaffHasCashierRole
                      ? t('modals.staffShift.cashierFirstCheckInHelper')
                      : t('modals.staffShift.cashierFirstCheckInBlocked')}
                  </p>
                </div>
              </ShiftRevealContent></motion.div>
            )}
            </AnimatePresence>

            <div className="mt-4 space-y-3">
              {selectedStaffRoles.map((role) => {
                const isRoleLockedByCashierFirstGate =
                  cashierFirstGateActive &&
                  (role.role_name || '').trim().toLowerCase() !== 'cashier';
                const roleHelper = isRoleLockedByCashierFirstGate
                  ? t('modals.staffShift.cashierFirstRoleLockedHelper')
                  : getCheckInRoleHelper(role.role_name);

                return (
                  <motion.button
                    key={role.role_id}
                    disabled={isRoleLockedByCashierFirstGate}
                    onClick={() => {
                      void handleRoleSelect(role.role_name);
                    }}
                    className="pos-glass-tap-card flex min-h-[56px] w-full items-center justify-between gap-3 px-4 py-3"
                    {...getInteractiveMotion('card')}
                  >
                    <User className="h-7 w-7 shrink-0 liquid-glass-modal-text-muted" strokeWidth={1.8} />

                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="text-base font-semibold liquid-glass-modal-text">
                          {translateRoleName(role.role_name)}
                        </span>
                        <span className="text-sm liquid-glass-modal-text-muted">
                          {role.is_primary
                            ? t('modals.staffShift.primaryRole')
                            : t('modals.staffShift.secondaryRole')}
                        </span>
                        {isRoleLockedByCashierFirstGate && (
                          <span className="text-sm font-semibold text-(--pos-s-warn)">
                            {t('modals.staffShift.roleLockedUntilCashier')}
                          </span>
                        )}
                      </span>
                      <span className={`mt-1 block ${checkInMutedTextClass}`}>{roleHelper}</span>
                    </span>

                    <ChevronRight className="h-5 w-5 shrink-0 liquid-glass-modal-text" />
                  </motion.button>
                );
              })}
            </div>
          </div>
        </div>
      );
    }

    if (checkInStep === 'enter-cash' && selectedStaff) {
      const isStartingCashRole = roleType === 'driver' || roleType === 'server';
      const cashTitle = isStartingCashRole
        ? roleType === 'server'
          ? t('modals.staffShift.serverStartingCashTitle')
          : t('modals.staffShift.driverStartingCashTitle')
        : t('modals.staffShift.cashierOpeningCashTitle');
      const cashHelper = isStartingCashRole
        ? roleType === 'server'
          ? t('modals.staffShift.serverStartingCashHelper')
          : t('modals.staffShift.driverStartingCashHelper')
        : t('modals.staffShift.cashierOpeningCashHelper');
      const cashValue = isStartingCashRole
        ? (!activeCashierExists ? '0,00' : driverStartingAmount)
        : openingCash;
      const originalOpening = roleType === 'cashier' && financialEntry.scope
        ? financialAttempts.current.get(JSON.stringify(financialEntry.scope))
        : undefined;

      return (
        <div className={checkInStepColumnClass} data-testid="staff-cash-section">
          {renderSelectedStaffSummary({ highlightedRoleName: roleType })}

          <div className={checkInSurfaceClass}>
            <h3 className="pos-pane-title">{cashTitle}</h3>
            <p className={`mt-0.5 ${checkInMutedTextClass}`}>{cashHelper}</p>

            <AnimatePresence initial={false}>
            {(roleType === 'driver' || roleType === 'server') && !activeCashierExists && (
              <motion.div key="reveal-35" {...revealMotion} className="pos-notice pos-notice--warn mt-4"><ShiftRevealContent>
                <AlertCircle className="pos-notice__icon h-5 w-5" />
                <p className="text-sm font-medium">
                  {t('modals.staffShift.noCashierWarning')}
                </p>
              </ShiftRevealContent></motion.div>
            )}
            </AnimatePresence>

            <div className={`mt-4 flex items-center gap-4 ${checkInInsetSurfaceClass}`}>
              {roleType === 'cashier' && financialEntry.status !== 'ordinary' ? (
                <span data-testid="financial-opening-currency" className="text-xl font-bold">{financialEntry.currency ?? '—'}</span>
              ) : <CashHandIcon
                className="h-10 w-10 shrink-0 liquid-glass-modal-text-muted"
              />}

              <CentsMoneyInput
                aria-label={cashTitle}
                value={cashValue}
                onValueChange={(val) => {
                  if (isStartingCashRole) {
                    setDriverStartingAmount(val);
                  } else {
                    setOpeningCash(val);
                  }
                }}
                placeholder="0,00"
                className="liquid-glass-modal-input pos-glass-field min-h-[44px] flex-1 text-3xl font-black text-center"
                readOnly={!!originalOpening || financialBusy.current || (isStartingCashRole && !activeCashierExists)}
                autoFocus
              />
            </div>

            <AnimatePresence initial={false}>
            {originalOpening && <motion.div key="reveal-36" {...revealMotion}><ShiftRevealContent>
              <p role="status" className={`mt-4 ${checkInMutedTextClass}`}>
                {t(financialEntry.original?.state === 'confirmed_unusable' ||
                  (financialEntry.original?.state === 'confirmed_usable' && !financialEntry.original.usable)
                  ? 'modals.staffShift.financialOpeningUnusable'
                  : financialEntry.original?.hostedAuthorization.state === 'required'
                    ? 'modals.staffShift.financialOpeningReauthorize'
                    : 'modals.staffShift.financialOpeningPending')}
              </p>
            </ShiftRevealContent></motion.div>}
            </AnimatePresence>

            <AnimatePresence initial={false}>
            {showZeroCashConfirm && roleType === 'cashier' && (
              <motion.div key="reveal-37" {...revealMotion} className="pos-notice pos-notice--warn pos-notice--stack mt-4"><ShiftRevealContent>
                <div className="flex items-start gap-3">
                  <AlertTriangle className="pos-notice__icon h-5 w-5" />
                  <div>
                    <h4 className="font-semibold">
                      {t('modals.staffShift.zeroCashConfirmTitle')}
                    </h4>
                    <p className="mt-1 text-sm">
                      {t('modals.staffShift.zeroCashConfirmMessage')}
                    </p>
                  </div>
                </div>

                <div className="flex flex-col gap-3 sm:flex-row">
                  <motion.button
                    onClick={() => setShowZeroCashConfirm(false)}
                    className="pos-solid-btn pos-solid-btn--sm"
                    {...getInteractiveMotion('button')}
                  >
                    {t('common.actions.cancel')}
                  </motion.button>
                  <motion.button
                    onClick={() => {
                      setShowZeroCashConfirm(false);
                      void handleCheckIn(true);
                    }}
                    disabled={loading}
                    className="pos-solid-btn pos-solid-btn--sm pos-solid-btn--primary"
                    {...getInteractiveMotion('primary', loading)}
                  >
                    {t('modals.staffShift.confirmZeroCash')}
                  </motion.button>
                </div>
              </ShiftRevealContent></motion.div>
            )}
            </AnimatePresence>
          </div>
        </div>
      );
    }

    return null;
  };

  // Round 313 (3rd follow-up): the check-in action footer is rendered as a SIBLING of the animated step
  // pane (not inside it). framer-motion applies a transform to the pane, which created a containing block
  // that trapped the footer's `sticky bottom-0` inside the pane -- so Back + Continue could never pin to the
  // scroll viewport and fell below the fold. Hoisting the footer here makes its containing block the scroll
  // region, so it stays visible at the bottom on first open. Handlers/behavior are unchanged.
  const renderCheckInFooter = () => {
    if (effectiveMode !== 'checkin') {
      return null;
    }
    let inner: React.ReactNode = null;
    if (checkInStep === 'enter-pin' && selectedStaff) {
      inner = (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          {renderCheckInBackButton('select-staff')}

          <motion.button
            onClick={() => {
              void handlePinSubmit();
            }}
            disabled={loading || enteredPin.length !== 4}
            className="pos-solid-btn pos-solid-btn--md pos-solid-btn--primary sm:min-w-[220px]"
            {...getInteractiveMotion('primary', loading || enteredPin.length !== 4)}
          >
            {loading ? (
              <>
                <div className="h-5 w-5 animate-spin rounded-full border-2 border-current border-t-transparent" />
                {t('modals.staffShift.authenticating')}
              </>
            ) : (
              <>
                {t('modals.staffShift.continue')}
                <ChevronRight className="h-4 w-4" />
              </>
            )}
          </motion.button>
        </div>
      );
    } else if (checkInStep === 'select-role' && selectedStaff) {
      inner = renderCheckInBackButton('enter-pin');
    } else if (checkInStep === 'enter-cash' && selectedStaff) {
      const isStartingCashRole = roleType === 'driver' || roleType === 'server';
      const cashEntryRole = roleType === 'cashier' || roleType === 'driver' || roleType === 'server';
      inner = (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          {renderCheckInBackButton('select-role')}

          <div className="flex flex-col gap-3 sm:flex-row">
            {isStartingCashRole && (
              <motion.button
                onClick={() => {
                  setDriverStartingAmount('0,00');
                  setError('');
                  void handleCheckIn();
                }}
                disabled={loading}
                className="pos-solid-btn pos-solid-btn--md"
                {...getInteractiveMotion('button', loading)}
              >
                {t('modals.staffShift.skipCash')}
              </motion.button>
            )}

            <motion.button
              onClick={() => {
                setError('');
                void handleCheckIn();
              }}
              disabled={
                loading ||
                  (roleType === 'cashier' && (financialEntry.status === 'checking' || financialEntry.status === 'blocked')) ||
                  (cashEntryRole &&
                  (roleType === 'driver' || roleType === 'server') &&
                  !activeCashierExists &&
                  parseMoneyInputValue(driverStartingAmount || '0') > 0)
              }
              className="pos-solid-btn pos-solid-btn--md pos-solid-btn--primary sm:min-w-[220px]"
              {...getInteractiveMotion(
                'primary',
                loading ||
                  (cashEntryRole &&
                    (roleType === 'driver' || roleType === 'server') &&
                    !activeCashierExists &&
                    parseMoneyInputValue(driverStartingAmount || '0') > 0),
              )}
            >
              {loading ? (
                <>
                  <div className="h-5 w-5 animate-spin rounded-full border-2 border-current border-t-transparent" />
                  {t('modals.staffShift.openingShift')}
                </>
              ) : (
                <>
                  {t(roleType === 'cashier' && financialEntry.status === 'checking'
                    ? 'modals.staffShift.financialOpeningChecking'
                    : roleType === 'cashier' && financialEntry.scope && financialAttempts.current.has(JSON.stringify(financialEntry.scope))
                      ? 'modals.staffShift.financialOpeningResume'
                      : 'modals.staffShift.startShift')}
                  <Check className="h-4 w-4" />
                </>
              )}
            </motion.button>
          </div>
        </div>
      );
    }
    if (!inner) {
      return null;
    }
    return <div className={checkInFooterClass}>{inner}</div>;
  };

  // Keyboard Shortcuts
  useKeyboardShortcut('ctrl+s', (e) => {
    if (!isOpen || !isOwnTopmostDialog()) return;
    if (confirmDialog.isOpen && confirmDialog.onConfirm) {
      confirmDialog.onConfirm();
      return;
    }

    // Check constraints to avoid premature submission
    if (loading) return;

    if (effectiveMode === 'checkin') {
      if (checkInStep === 'enter-cash') handleCheckIn();
      else if (checkInStep === 'enter-pin' && enteredPin.length === 4) handlePinSubmit();
    } else if (effectiveMode === 'checkout') {
      handleCheckOut();
    }
  }, { enabled: isOpen });

  // Closed-state early return (same pattern as OrderDetailsModal). Without it,
  // the whole check-in/checkout vDOM below — including the eagerly evaluated
  // renderCheckInContent()/renderCheckoutContent() call — was rebuilt on every
  // context-driven parent render while the modal was CLOSED, because React
  // constructs children before LiquidGlassModal can decide to return null.
  // Every hook above still runs while closed, so no listener or reset effect
  // is lost. Trade-off, accepted: a parent-driven close (isOpen flipping
  // false, e.g. the post-checkout auto-close) unmounts instantly instead of
  // playing LiquidGlassModal's exit animation; user-driven closes (Escape /
  // header X) still animate, because LiquidGlassModal only invokes onClose
  // after its exit animation completes.
  if (!isOpen) {
    return null;
  }

  return (
    <CashierRecovery>
      <LiquidGlassModal
        modalId={keyboardDialogId}
        recoveryAccess
        // Founder 01/11/2026 («γιατι το checkin δεν ειναι σε γυαλι???»): check-in is glass like every other window
        // (founder 11/11/2026); its staff choices are frosted and raised on it.
        blur
        isOpen={isOpen}
        onClose={handleModalClose}
        title={effectiveMode === 'checkin' ? t('modals.staffShift.checkIn') : t('modals.staffShift.checkOut')}
        size="xl"
        className={
          effectiveMode === 'checkout'
            ? 'max-w-5xl! w-[92vw]! max-h-[90vh]! [&_.liquid-glass-modal-header]:border-b-0!'
            : 'max-w-4xl! w-[92vw]! max-h-[90vh]! [&_.liquid-glass-modal-header]:border-b-0!'
        }
        closeOnBackdrop={false}
        closeOnEscape={!isModalCloseBlocked}
      >
        {/* Content with Scroll - the checkout pane FILLS the modal content box (flex-1) so the reconciliation
            list scrolls beneath the floating expected-amount action bar. Internal bottom padding keeps the
            final controls reachable above the overlay. Check-in keeps its capped max-height behaviour. */}
        <div
          className={`pos-progressive-form relative flex ${effectiveMode === 'checkout' ? 'flex-1 min-h-0' : 'max-h-[84vh]'} flex-col`}
          data-testid={effectiveMode === 'checkout' ? 'staff-checkout-shell' : 'staff-checkin-shell'}
        >
          <div
            className={`pos-scroll-room flex-1 min-h-0 space-y-4 overflow-y-auto scrollbar-hide ${
              effectiveMode === 'checkout' && checkoutFooterData ? 'pb-36' : ''
            }`}
            data-testid="staff-shift-scroll-body"
          >
          {effectiveMode === 'checkout' && !satelliteCheckout && shiftSummary?.netCollections && renderNetCollections(shiftSummary.netCollections)}
          {/* Satellite handover: a real back button ABOVE the step circles
              (founder 30/08 — the old inline text link was invisible). */}
          {satelliteCheckout && (
            <button
              type="button"
              onClick={closeSatelliteCheckout}
              data-testid="satellite-checkout-back"
              className="pos-glass-field min-h-[44px] mb-2 inline-flex items-center gap-1.5 px-4 py-2 text-sm font-bold liquid-glass-modal-text transition-colors"
            >
              <ChevronLeft size={18} strokeWidth={2.5} />
              {t('modals.staffShift.satelliteCheckout.back', { defaultValue: 'Back' })}
            </button>
          )}

          {/* Progress Stepper used during Check In/Out */}
          {effectiveMode === 'checkin' && (
            <motion.div
              className="mb-2"
              initial={false}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: CHECKIN_MOTION.base, ease: CHECKIN_MOTION_EASE }}
            >
              <ProgressStepper steps={progressSteps} />
            </motion.div>
          )}

          {/* Error/Success Messages */}
          <AnimatePresence initial={false}>
          {error && <motion.div key="reveal-38" {...revealMotion}><ShiftRevealContent><ErrorAlert title={t('modals.error.title', 'Error')} message={error} onClose={() => setError('')} className="mb-4" /></ShiftRevealContent></motion.div>}
          </AnimatePresence>
          <AnimatePresence initial={false}>
          {success && <motion.div key="reveal-39" {...revealMotion}><ShiftRevealContent><ErrorAlert title={t('modals.success.title', 'Success')} message={success} severity="success" onClose={() => setSuccess('')} className="mb-4" /></ShiftRevealContent></motion.div>}
          </AnimatePresence>
          <AnimatePresence initial={false}>
          {satelliteReleaseShiftId && effectiveShift && String(effectiveShift.id) === satelliteReleaseShiftId && <motion.div key="reveal-40" {...revealMotion}><ShiftRevealContent>
            <SatelliteHandoverReleasePanel
              cashierShiftId={satelliteReleaseShiftId}
              onReleased={() => {
                setSatelliteReleaseShiftId(null);
                setError('');
                setSuccess(t('modals.staffShift.satelliteHandover.released', {
                  defaultValue: 'Released. The satellite cash was not added to this drawer. You can close the shift now.',
                }));
              }}
            />
          </ShiftRevealContent></motion.div>}
          </AnimatePresence>
          <AnimatePresence initial={false}>
          {checkoutPaymentBlockers.length > 0 && <motion.div key="reveal-41" {...revealMotion}><ShiftRevealContent>
            <UnsettledPaymentBlockersPanel
              blockers={checkoutPaymentBlockers}
              title={t('modals.staffShift.paymentIntegrityTitle', {
                defaultValue: 'Orders Blocking Shift Checkout',
              })}
              helperText={t('modals.staffShift.paymentIntegrityHelper', {
                defaultValue:
                  'These orders belong to the current business day. Record or confirm the missing payment row before the cashier can check out.',
              })}
              className="mb-4"
              onResolveBlocker={recordCheckoutBlocker.requestRecord}
              resolvingKey={resolvingCheckoutBlockerKey}
            />
          </ShiftRevealContent></motion.div>}
          </AnimatePresence>




          <AnimatePresence initial={false} custom={contentDirection}>
            <motion.div
              key={contentPaneKey}
              custom={contentDirection}
              variants={checkInPaneVariants}
              initial="enter"
              animate="center"
              exit="exit"
            ><ShiftRevealContent>
              {giftRecoveryTarget
                ? renderGiftRecovery()
                : satelliteCheckout
                  ? renderSatelliteCheckoutView()
                  : effectiveMode === 'checkin'
                    ? renderCheckInContent()
                    : renderCheckoutContent()}
            </ShiftRevealContent></motion.div>
          </AnimatePresence>

          {/* Round 313 (3rd follow-up): the check-in action footer lives here -- a sibling of the animated
              pane, so its `sticky bottom-0` pins to the scroll viewport (not trapped inside the pane's
              transform) and Back + Continue stay visible at the bottom on first open. */}
          {renderCheckInFooter()}

          {false && effectiveMode === 'checkout' && (
            // Check-out Form - SIMPLIFIED
            <div className="space-y-4" data-testid="staff-checkout-section">
              {/* Shift Summary */}
              {localMode === 'checkout' && (
                <button
                  onClick={() => {
                    setLocalMode(null);
                    setCheckoutShift(null);
                    setCheckInStep('select-staff');
                    setSelectedStaff(null);
                    setError('');
                  }}
                  className="pos-glass-field min-h-[44px] px-4 py-2 text-sm flex items-center gap-2 transition-transform duration-150 liquid-glass-modal-text"
                >
                  <ChevronRight className="w-4 h-4 rotate-180" />
                  {t('modals.staffShift.backToStaffSelection')}
                </button>
              )}

              <WorkCardLine status={workCard} staffId={effectiveShift?.staff_id} />
              {checkoutHeaderData && (
                checkoutHeaderData!.minimal ? (
                  <POSGlassCard
                    variant={checkoutHeaderData!.variant}
                    size="large"
                    className="pos-glass-form-card overflow-hidden"
                  >
                    <div className="space-y-4">
                      <div className="min-w-0">
                        <div className="text-sm liquid-glass-modal-text-muted font-semibold">
                          {checkoutHeaderData!.roleLabel}
                        </div>
                        <h3 className="mt-2 text-xl font-semibold liquid-glass-modal-text">
                          {effectiveShift?.staff_name || checkoutHeaderData!.roleLabel}
                        </h3>
                        <p className="mt-2 text-sm liquid-glass-modal-text-muted">
                          {checkoutHeaderData!.shiftWindow}
                        </p>
                      </div>

                      <div className="pos-glass-form-card p-4! md:p-5!">
                        <div className="text-sm liquid-glass-modal-text-muted font-semibold">
                          {checkoutHeaderData!.primaryLabel}
                        </div>
                        <p className="mt-3 text-sm liquid-glass-modal-text-muted">
                          {checkoutHeaderData!.helper}
                        </p>
                      </div>
                    </div>
                  </POSGlassCard>
                ) : (
                  <POSGlassCard
                    variant={checkoutHeaderData!.variant}
                    size="large"
                    className="pos-glass-form-card overflow-hidden"
                  >
                    <div className="space-y-4">
                      <div className="flex items-start justify-between gap-4">
                        <div className="min-w-0">
                          <div className="text-sm liquid-glass-modal-text-muted font-semibold">
                            {checkoutHeaderData!.roleLabel}
                          </div>
                          <h3 className="mt-2 text-xl font-semibold liquid-glass-modal-text">
                            {effectiveShift?.staff_name || checkoutHeaderData!.roleLabel}
                          </h3>
                          <p className="mt-2 text-sm liquid-glass-modal-text-muted">
                            {checkoutHeaderData!.shiftWindow}
                          </p>
                        </div>

                        <div className="pos-glass-form-card px-4! py-3! text-right">
                          <div className="text-sm liquid-glass-modal-text-muted font-semibold">
                            {t('modals.staffShift.ordersCount', 'Orders')}
                          </div>
                          <div className="mt-1 text-3xl font-black liquid-glass-modal-text">
                            {checkoutHeaderData!.headerMetrics.totalCount}
                          </div>
                        </div>
                      </div>

                      <div className="grid gap-3 md:grid-cols-[1.4fr_1fr]">
                        <div className="pos-glass-form-card p-4! md:p-5!">
                          <div className="text-sm liquid-glass-modal-text-muted font-semibold">
                            {checkoutHeaderData!.primaryLabel}
                          </div>
                          <div className="mt-2 text-4xl font-black tracking-tight liquid-glass-modal-text">
                            {formatCurrency(checkoutHeaderData!.primaryAmount)}
                          </div>
                          <p className="mt-3 text-sm liquid-glass-modal-text-muted">
                            {checkoutHeaderData!.helper}
                          </p>
                        </div>

                        <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-1">
                          <div className="pos-glass-form-card p-4!">
                            <div className="text-sm liquid-glass-modal-text-muted font-semibold">
                              {shiftSummary?.netCollections ? t('modals.staffShift.netCollections', 'Net collections') : t('modals.staffShift.totalSalesLabel', 'Total Sales')}
                            </div>
                            <div className="mt-1 text-2xl font-bold text-emerald-800 dark:text-emerald-300">
                              {formatCurrency(checkoutHeaderData!.headerMetrics.totalAmount)}
                            </div>
                          </div>
                          <div className="pos-glass-form-card p-4!">
                            <div className="text-sm liquid-glass-modal-text-muted font-semibold">
                              {effectiveShift?.role_type === 'cashier'
                                ? t('modals.staffShift.openingCashLabel')
                                : t('modals.staffShift.startingAmount', 'Starting Amount')}
                            </div>
                            <div className="mt-1 text-2xl font-bold liquid-glass-modal-text-muted">
                              {formatCurrency(checkoutHeaderData!.openingAmount)}
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  </POSGlassCard>
                )
              )}

              {/* CASH RECONCILIATION - Only for Cashier */}
              {shiftSummary && effectiveShift?.role_type === 'cashier' && (
                (() => {
                  const openingAmount = getEffectiveOpeningAmount(effectiveShift, shiftSummary);
                  const cashierBreakdown = getCashierExpectedBreakdown(
                    shiftSummary,
                    effectiveShift,
                    openingAmount,
                    cashierCheckoutExpenseTotal
                  );

                  return (
                  <div className="space-y-3">
                  {/* Header */}
                  <div className="pos-glass-form-card">
                    <h3 className="text-lg font-bold text-yellow-800 dark:text-yellow-300 mb-1">{t('modals.staffShift.cashReconciliation')}</h3>
                    <p className="text-xs text-yellow-800 dark:text-yellow-200">{t('modals.staffShift.reviewAndConfirm')}</p>
                  </div>

                  {/* Main Calculation Flow */}
                  <div className="space-y-2">
                    {/* Opening */}
                    <div className="pos-glass-form-card flex justify-between items-center p-3!">
                      <span className="text-sm liquid-glass-modal-text-muted">{t('modals.staffShift.openingCashLabel')}</span>
                      <span className="font-bold liquid-glass-modal-text-muted">{formatCurrency(openingAmount)}</span>
                    </div>

                    {/* Plus Cash Orders */}
                    <div className="pos-glass-form-card flex justify-between items-center p-3!">
                      <span className="text-sm text-green-800 dark:text-green-200">{t('modals.staffShift.cashOrdersLabel')}</span>
                      <span className="font-bold text-green-800 dark:text-green-300">{formatCurrency(cashierBreakdown.sales)}</span>
                    </div>

                    {/* Minus Canceled */}
                    {shiftSummary.canceledOrders?.cashTotal > 0 && (
                      <div className="pos-glass-form-card flex justify-between items-center p-3!">
                        <span className="text-sm text-red-800 dark:text-red-200">{t('modals.staffShift.canceledOrdersLabel')}</span>
                        <span className="font-bold text-red-800 dark:text-red-300">{formatCurrency(shiftSummary.canceledOrders?.cashTotal || 0)}</span>
                      </div>
                    )}

                    {/* Minus Expenses */}
                    {cashierCheckoutExpenseTotal > 0 && (
                      <div className="pos-glass-form-card flex justify-between items-center p-3!">
                        <span className="text-sm text-red-800 dark:text-red-200">{t('modals.staffShift.expensesLabel')}</span>
                        <span className="font-bold text-red-800 dark:text-red-300">{formatCurrency(cashierCheckoutExpenseTotal)}</span>
                      </div>
                    )}

                    {/* Minus Cash Drops */}
                    {(shiftSummary.cashDrawer?.cash_drops || 0) > 0 && (
                      <div className="pos-glass-form-card flex justify-between items-center p-3!">
                        <span className="text-sm text-red-800 dark:text-red-200">{t('modals.staffShift.cashDropsLabel')}</span>
                        <span className="font-bold text-red-800 dark:text-red-300">-{formatCurrency(shiftSummary.cashDrawer?.cash_drops || 0)}</span>
                      </div>
                    )}

                    {/* Minus Cash Refunds */}
                    {(shiftSummary.cashRefunds || 0) > 0 && (
                      <div className="pos-glass-form-card flex justify-between items-center p-3!">
                        <span className="text-sm text-red-800 dark:text-red-200">{t('modals.staffShift.cashRefundsLabel')}</span>
                        <span className="font-bold text-red-800 dark:text-red-300">-{formatCurrency(shiftSummary.cashRefunds || 0)}</span>
                      </div>
                    )}

                    {/* Minus Driver Cash Given */}
                    {(cashierBreakdown.driverGiven || 0) > 0 && (
                      <div className="pos-glass-form-card flex justify-between items-center p-3!">
                        <span className="text-sm text-red-800 dark:text-red-200">{t('modals.staffShift.driverCashGivenLabel', 'Starting Cash Given To Drivers/Waiters')}</span>
                        <span className="font-bold text-red-800 dark:text-red-300">-{formatCurrency(cashierBreakdown.driverGiven || 0)}</span>
                      </div>
                    )}

                    {/* Plus Driver Cash Returned */}
                    {(shiftSummary.cashDrawer?.driver_cash_returned || 0) > 0 && (
                      <div className="pos-glass-form-card flex justify-between items-center p-3!">
                        <span className="text-sm text-green-800 dark:text-green-200">{t('modals.staffShift.driverCashReturnedLabel')}</span>
                        <span className="font-bold text-green-800 dark:text-green-300">+{formatCurrency(shiftSummary.cashDrawer?.driver_cash_returned || 0)}</span>
                      </div>
                    )}

                    {(cashierBreakdown.deductedStaffPayments || 0) > 0 && (
                      <div className="pos-glass-form-card flex justify-between items-center p-3!">
                        <span className="text-sm text-red-800 dark:text-red-200">{t('modals.staffShift.staffPaymentsDeductedLabel', 'Staff Payouts')}</span>
                        <span className="font-bold text-red-800 dark:text-red-300">-{formatCurrency(cashierBreakdown.deductedStaffPayments || 0)}</span>
                      </div>
                    )}

                    {/* Individual Driver/Waiter Breakdown Cards */}
                    {shiftSummary.driverDeliveries && shiftSummary.driverDeliveries.length > 0 && (
                      <details className="pos-glass-form-card p-4!">
                        <summary className="min-h-[44px] flex cursor-pointer list-none items-center justify-between gap-3 text-sm font-semibold liquid-glass-modal-text transition-colors [&::-webkit-details-marker]:hidden">
                          <span>{t('modals.staffShift.inheritedDriverReturnsLabel', 'Transferred Staff Returns')}</span>
                          <span className="shrink-0 text-base font-semibold liquid-glass-modal-text-muted">
                            {shiftSummary.driverDeliveries.length}
                          </span>
                        </summary>
                        <div className="mt-4 space-y-2">
                          {(() => {
                          // Aggregate by driver_id to show one card per driver
                          const driverMap = new Map<string, { name: string; role: string; starting: number; earnings: number; expenses: number }>();
                          for (const d of shiftSummary.driverDeliveries) {
                            const id = d.driver_id || d.shift_id;
                            if (!driverMap.has(id)) {
                              driverMap.set(id, {
                                name: d.driver_name || 'Driver',
                                role: d.role_type || t('modals.staffShift.driverRole'),
                                starting: d.starting_amount || 0,
                                earnings: 0,
                                expenses: d.expenses || 0
                              });
                            }
                            // Sum up earnings (cash_collected) for each driver
                            const driver = driverMap.get(id)!;
                            driver.earnings += (d.cash_collected || 0);
                          }

                          return Array.from(driverMap.entries()).map(([id, driver]) => {
                            const returns = driver.starting + driver.earnings - driver.expenses;
                            const isPositive = returns >= 0;

                            return (
                              <div key={id} className={`pos-glass-form-card p-3! `}>
                                <div className="flex justify-between items-start mb-2">
                                  <div>
                                    <span className="text-sm liquid-glass-modal-text-muted">{driver.role}</span>
                                    <div className="font-semibold liquid-glass-modal-text">{driver.name}</div>
                                  </div>
                                </div>
                                <div className="space-y-1 text-sm">
                                  <div className="flex justify-between text-red-800 dark:text-red-300">
                                    <span>{t('modals.staffShift.driverStarting')}</span>
                                    <span>-{formatCurrency(driver.starting)}</span>
                                  </div>
                                  <div className="flex justify-between text-green-800 dark:text-green-300">
                                    <span>+ {t('modals.staffShift.driverEarnings')}</span>
                                    <span>+{formatCurrency(driver.earnings)}</span>
                                  </div>
                                  {driver.expenses > 0 && (
                                    <div className="flex justify-between text-red-800 dark:text-red-300">
                                      <span>- {t('modals.staffShift.expenses')}</span>
                                      <span>-{formatCurrency(driver.expenses)}</span>
                                    </div>
                                  )}
                                  <div className={`flex justify-between pt-1 font-bold ${isPositive ? 'text-green-500 dark:text-green-400' : 'text-red-500 dark:text-red-400'}`}>
                                    <span>= {isPositive ? t('modals.staffShift.driverReturns') : t('modals.staffShift.driverTakes')}</span>
                                    <span>{isPositive ? '+' : '-'}{formatCurrency(Math.abs(returns))}</span>
                                  </div>
                                </div>
                              </div>
                            );
                          });
                        })()}
                        </div>
                      </details>
                    )}

                    {/* Expected Amount */}
                    {(() => {
                      const opening = getEffectiveOpeningAmount(effectiveShift, shiftSummary);
                      const breakdown = getCashierExpectedBreakdown(
                        shiftSummary,
                        effectiveShift,
                        opening,
                        cashierCheckoutExpenseTotal
                      );
                      const expected = breakdown.expected;
                      return (
                        <>
                          <div className="pos-glass-form-card flex justify-between items-center p-3! font-semibold">
                            <span className="text-sm text-yellow-100">{t('modals.staffShift.expectedAmountLabel')}</span>
                            <span className="text-lg text-yellow-800 dark:text-yellow-300">{formatCurrency(expected)}</span>
                          </div>
                          {/* Formula Explanation */}
                          <div className="pos-glass-form-card p-3! mt-2">
                            <p className="text-xs liquid-glass-modal-text-muted text-center">
                              <span className="font-semibold liquid-glass-modal-text-muted">{t('receipt.formula.label')}</span>{' '}
                              {t('receipt.formula.cashier')}
                            </p>
                            <p className="text-xs liquid-glass-modal-text-muted text-center mt-1">
                              {t('receipt.formula.note.staffPayments')}
                            </p>
                          </div>
                        </>
                      );
                    })()}
                  </div>
                </div>
                  );
                })()
              )}

              {Number(shiftSummary?.tipsReceived || 0) > 0 && (
                <div className={'pos-glass-form-card' + ' p-4!'}>
                  <div className="flex items-center justify-between gap-4">
                    <div className="flex items-center gap-3">
                      <div className="pos-glass-form-card p-2! text-emerald-800 dark:text-emerald-200">
                        <Star className="h-5 w-5" />
                      </div>
                      <div>
                        <h3 className="font-bold liquid-glass-modal-text">
                          {t('modals.staffShift.tipsReceived', 'Tips received')}
                        </h3>
                        <p className="text-xs liquid-glass-modal-text-muted">
                          {t(
                            'modals.staffShift.tipAllocationHelp',
                            'Credited to this staff member for this shift.',
                          )}
                        </p>
                      </div>
                    </div>
                    <span className="text-xl font-black text-emerald-700 dark:text-emerald-400">
                      {formatCurrency(Number(shiftSummary.tipsReceived || 0))}
                    </span>
                  </div>

                  {Array.isArray(shiftSummary.tipAllocations) &&
                    shiftSummary.tipAllocations.length > 0 && (
                      <details className="pos-glass-form-card mt-3 px-3! py-2!">
                        <summary className="min-h-[44px] cursor-pointer text-sm font-semibold liquid-glass-modal-text">
                          {t('modals.staffShift.tipAllocations', 'Tip allocations')} ·{' '}
                          {shiftSummary.tipAllocations.length}
                        </summary>
                        <div className="mt-2">
                          {shiftSummary.tipAllocations.map((allocation: any) => (
                            <div
                              key={allocation.paymentId}
                              className="flex items-center justify-between gap-3 py-2 text-sm"
                            >
                              <span className="liquid-glass-modal-text-muted">
                                {t('modals.staffShift.tipOrder', 'Order')}{' '}
                                {formatGridOrderNumber({ order_number: allocation.orderNumber, order_id: allocation.orderId })}
                              </span>
                              <span className="font-bold text-emerald-700 dark:text-emerald-400">
                                {formatCurrency(Number(allocation.amount || 0))}
                              </span>
                            </div>
                          ))}
                        </div>
                      </details>
                    )}
                </div>
              )}

              {/* Expenses Section */}
              {!isNonFinancialCheckoutRole && (
                <div>
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="text-xl font-bold liquid-glass-modal-text mb-4">{t('modals.staffShift.expenses')}</h3>
                    {canRecordInlineExpenses && (
                      <button
                        type="button"
                        onClick={() => setShowExpenseForm(!showExpenseForm)}
                        aria-label={t('modals.staffShift.addExpense')}
                        className={`ml-auto ${checkoutActionButtonClass}`}
                      >
                        <Plus className="h-6 w-6" strokeWidth={3} />
                      </button>
                    )}
                  </div>

                  {!canRecordInlineExpenses && (
                    <p className="text-xs liquid-glass-modal-text-muted mb-4">
                      {t('modals.staffShift.expensesReadOnly', {
                        defaultValue:
                          'Expenses are recorded from cashier checkout. Existing shift expenses are shown here for reference.',
                      })}
                    </p>
                  )}

                  <AnimatePresence initial={false}>
                  {canRecordInlineExpenses && showExpenseForm && (
                    <motion.div key="reveal-42" {...revealMotion} ref={expenseFormRef} className={'pos-glass-form-card' + ' space-y-3 mb-4'}><ShiftRevealContent>
                      <select
                        value={expenseType}
                        onChange={(e) => setExpenseType(e.target.value as 'supplies' | 'maintenance' | 'petty_cash' | 'refund' | 'other')}
                        className="liquid-glass-modal-input pos-glass-field min-h-[44px] text-sm"
                      >
                        <option value="supplies">{getExpenseTypeLabel('supplies')}</option>
                        <option value="maintenance">{getExpenseTypeLabel('maintenance')}</option>
                        <option value="petty_cash">{getExpenseTypeLabel('petty_cash')}</option>
                        <option value="refund">{getExpenseTypeLabel('refund')}</option>
                        <option value="other">{getExpenseTypeLabel('other')}</option>
                      </select>

                      <CentsMoneyInput
                        aria-label={t('modals.staffShift.amountLabel', 'Amount')}
                        value={expenseAmount}
                        onValueChange={setExpenseAmount}
                        placeholder="0,00"
                        className="liquid-glass-modal-input pos-glass-field min-h-[44px] text-sm"
                      />

                      <input
                        type="text"
                        value={expenseDescription}
                        onChange={(e) => setExpenseDescription(e.target.value)}
                        placeholder={expenseDescriptionPlaceholder}
                        className="liquid-glass-modal-input pos-glass-field min-h-[44px] text-sm"
                      />

                      {canUseExpenseReceiptReference && (
                        <input
                          type="text"
                          value={expenseReceipt}
                          onChange={(e) => setExpenseReceipt(e.target.value)}
                          placeholder={expenseReceiptPlaceholder}
                          className="liquid-glass-modal-input pos-glass-field min-h-[44px] text-sm"
                        />
                      )}

                      <button
                        onClick={handleRecordExpense}
                        disabled={!canRecordInlineExpense}
                        className="min-h-[44px] pos-raised pos-raised--yellow w-full bg-(--pos-s-yellow) text-black font-medium py-2 px-4 rounded-lg text-sm transition-all duration-300 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {recordExpenseLabel}
                      </button>
                    </ShiftRevealContent></motion.div>
                  )}
                  </AnimatePresence>

                  <AnimatePresence initial={false}>
                  {expenses.length > 0 ? (
                    <motion.div key="reveal-43-yes" {...revealMotion} className="space-y-2"><ShiftRevealContent>
                      {expenses.map((expense) => (
                        <div key={expense.id} className="pos-glass-form-card flex items-center justify-between p-3! text-sm">
                          <div className="flex-1">
                            <div className="font-medium liquid-glass-modal-text">{expense.description}</div>
                            <div className="liquid-glass-modal-text-muted capitalize text-xs">{getExpenseTypeLabel(expense.expense_type)}</div>
                          </div>
                          <div className="flex shrink-0 flex-col items-end gap-2 text-right">
                            <div className="font-semibold liquid-glass-modal-text">{formatCurrency(expense.amount)}</div>
                            <div className={`text-xs ${expense.status === 'approved' ? 'text-green-700 dark:text-green-400' :
                              expense.status === 'rejected' ? 'text-red-700 dark:text-red-400' :
                                'text-yellow-700 dark:text-yellow-400'
                              }`}>
                              {getExpenseStatusLabel(expense.status)}
                            </div>
                            <button
                              type="button"
                              disabled={deletingExpenseId === expense.id}
                              onClick={() =>
                                openConfirm({
                                  title: t('modals.expense.deleteExpenseConfirmTitle', {
                                    defaultValue: 'Delete expense',
                                  }),
                                  message: t(
                                    'modals.expense.deleteExpenseConfirmMessage',
                                    'Delete "{{description}}"? This will immediately remove it from the drawer totals.',
                                    {
                                      description:
                                        expense.description ||
                                        t('modals.expense.untitledExpense', {
                                          defaultValue: 'Untitled expense',
                                        }),
                                    },
                                  ),
                                  variant: 'error',
                                  confirmText: deleteExpenseLabel,
                                  cancelText: t('common.actions.cancel', {
                                    defaultValue: 'Cancel',
                                  }),
                                  onConfirm: () => {
                                    void handleDeleteExpense(expense);
                                  },
                                })
                              }
                              className="pos-solid-btn pos-solid-btn--sm pos-solid-btn--danger disabled:cursor-not-allowed disabled:opacity-60"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                              {deleteExpenseLabel}
                            </button>
                          </div>
                        </div>
                      ))}
                      <div className="flex justify-between items-center pt-3">
                        <span className="font-semibold liquid-glass-modal-text">{t('modals.staffShift.totalExpenses')}:</span>
                        <span className="font-bold text-red-700 dark:text-red-400 text-lg">{formatCurrency(totalExpenses)}</span>
                      </div>
                    </ShiftRevealContent></motion.div>
                  ) : <motion.div key="reveal-43-next" {...revealMotion}><ShiftRevealContent>
                    <p className="text-sm liquid-glass-modal-text-muted text-center py-4">{noExpensesLabel}</p>
                  </ShiftRevealContent></motion.div>}
                  </AnimatePresence>
                </div>
              )}

              {/* Driver Deliveries Section */}
              {effectiveShift?.role_type === 'driver' && shiftSummary?.driverDeliveries && shiftSummary.driverDeliveries.length > 0 && (() => {
                const deliveries = shiftSummary.driverDeliveries;
                const totalOrders = deliveries.length;

                const cashOrders = deliveries.filter((d: any) => (d.payment_method || '').toLowerCase() === 'cash');
                const cashTotal = cashOrders.reduce((sum: number, d: any) => sum + (d.total_amount || 0), 0);
                const cashCount = cashOrders.length;

                const cardOrders = deliveries.filter((d: any) => (d.payment_method || '').toLowerCase() === 'card');
                const cardTotal = cardOrders.reduce((sum: number, d: any) => sum + (d.total_amount || 0), 0);
                const cardCount = cardOrders.length;

                const canceledOrders = deliveries.filter((d: any) => {
                  const s = (d.status || d.order_status || '').toLowerCase();
                  return s === 'cancelled' || s === 'canceled' || s === 'refunded';
                });
                const canceledCount = canceledOrders.length;

                return (
                  <div className="space-y-4">
                    {/* 1. Summary Statistics */}
                    <div className={'pos-glass-form-card' + " p-4!"}>
                      <div className="flex items-center justify-between mb-3">
                        <h3 className="text-lg font-bold liquid-glass-modal-text">{t('modals.staffShift.orderSummary', 'Order Summary')}</h3>
                        <div className="flex gap-2">
                          <POSGlassBadge variant="info">{totalOrders} {t('modals.staffShift.totalOrders', 'Total')}</POSGlassBadge>
                          {canceledCount > 0 && (
                            <POSGlassBadge variant="error">
                              <span className="inline-flex items-center gap-1">
                                <XCircle className="w-3 h-3" />
                                {canceledCount} {t('modals.staffShift.canceledOrders', 'Canceled')}
                              </span>
                            </POSGlassBadge>
                          )}
                        </div>
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        <div className="pos-glass-form-card p-3! flex justify-between items-center">
                          <div className="flex flex-col">
                            <span className="text-xs text-green-800 dark:text-green-200">{t('modals.staffShift.cashOrders', 'Cash Orders')}</span>
                            <span className="font-bold text-green-700 dark:text-green-400 text-lg">{cashCount}</span>
                          </div>
                          <div className="text-right">
                            <CashHandIcon className="w-5 h-5 text-green-800 dark:text-green-300 ml-auto" />
                            <div className="font-bold text-green-800 dark:text-green-300">{formatCurrency(cashTotal)}</div>
                          </div>
                        </div>
                        <div className="pos-glass-form-card p-3! flex justify-between items-center">
                          <div className="flex flex-col">
                            <span className="text-xs liquid-glass-modal-text-muted">{t('modals.staffShift.cardOrders', 'Card Orders')}</span>
                            <span className="font-bold liquid-glass-modal-text-muted text-lg">{cardCount}</span>
                          </div>
                          <div className="text-right">
                            <CreditCard className="w-5 h-5 liquid-glass-modal-text-muted ml-auto" />
                            <div className="font-bold liquid-glass-modal-text-muted">{formatCurrency(cardTotal)}</div>
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* 2. Compact Order Details Table */}
                    <div className={'pos-glass-form-card'}>
                      <div className="flex items-center justify-between mb-3 cursor-pointer" onClick={() => setShowOrderDetailsTable(!showOrderDetailsTable)}>
                        <h3 className="text-lg font-bold liquid-glass-modal-text">{t('modals.staffShift.orderDetails', 'Order Details')}</h3>
                        <button
                          className="pos-glass-field min-h-[44px] px-3 py-2 text-sm transition-colors"
                          aria-label={showOrderDetailsTable ? t('modals.staffShift.hideDetails', 'Hide Details') : t('modals.staffShift.showDetails', 'Show Details')}
                          aria-expanded={showOrderDetailsTable}
                        >
                          {showOrderDetailsTable ? t('modals.staffShift.hideDetails', 'Hide Details') : t('modals.staffShift.showDetails', 'Show Details')}
                        </button>
                      </div>

                      <AnimatePresence initial={false}>
                      {showOrderDetailsTable && (
                        <motion.div key="reveal-44" {...revealMotion} className="pos-glass-form-card overflow-x-auto max-h-64 overflow-y-auto scrollbar-hide"><ShiftRevealContent>
                          <table className="w-full text-sm text-left" role="table">
                            <thead className="text-sm liquid-glass-modal-text-muted sticky top-0">
                              <tr role="row">
                                <th scope="col" className="px-3 py-2 font-medium">{t('modals.staffShift.orderNoHeader', 'No.')}</th>
                                <th scope="col" className="px-3 py-2 font-medium">{t('modals.staffShift.orderAddressHeader', 'Address')}</th>
                                <th scope="col" className="px-3 py-2 font-medium text-right">{t('modals.staffShift.orderAmountHeader', 'Amount')}</th>
                                <th scope="col" className="px-3 py-2 font-medium text-center">{t('modals.staffShift.orderStatusHeader', 'Status')}</th>
                              </tr>
                            </thead>
                            <tbody className="" role="rowgroup">
                              {deliveries.map((delivery: any, index: number) => {
                                const orderLabel = delivery.order_number ? formatGridOrderNumber(delivery) : `#${index + 1}`;
                                return (
                                  <tr key={delivery.id} className="transition-colors" role="row">
                                    <td className="px-3 py-2 font-medium liquid-glass-modal-text" role="cell">{orderLabel}</td>
                                    <td className="px-3 py-2 liquid-glass-modal-text-muted truncate max-w-[150px]" role="cell">
                                      {delivery.delivery_address ? (delivery.delivery_address.length > 25 ? delivery.delivery_address.substring(0, 25) + '...' : delivery.delivery_address) : '-'}
                                    </td>
                                    <td className="px-3 py-2 text-right font-medium liquid-glass-modal-text-muted" role="cell">{formatCurrency(delivery.total_amount)}</td>
                                    <td className="px-3 py-2 text-center" role="cell">
                                      <span className="inline-flex ga items-center justify-center text-xs">
                                        <span>{getStatusSymbol(delivery)}</span>
                                        <span>{getPaymentSymbol(delivery.payment_method)}</span>
                                      </span>
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </ShiftRevealContent></motion.div>
                      )}
                      </AnimatePresence>
                    </div>

                    {/* 3. Detailed Delivery Cards (Existing) */}
                    <div className={'pos-glass-form-card'}>
                      <div className="flex items-center justify-between mb-4">
                        <div className="flex items-center gap-2">
                          <h3 className="text-xl font-bold liquid-glass-modal-text">Driver Deliveries</h3>
                          <POSGlassBadge variant="success">{deliveries.length - canceledCount} {t('modals.staffShift.completedOrdersLabel', 'Completed')}</POSGlassBadge>
                        </div>
                        <button
                          onClick={() => setShowDetailedView(!showDetailedView)}
                          className="pos-glass-field min-h-[44px] text-sm px-3 py-1.5 liquid-glass-modal-text transition-all duration-300"
                          aria-label={showDetailedView ? t('modals.staffShift.hideDetailedView', 'Hide Detailed View') : t('modals.staffShift.showDetailedView', 'Show Detailed View')}
                          aria-expanded={showDetailedView}
                        >
                          {showDetailedView ? t('modals.staffShift.hideDetailedView', 'Hide Detailed View') : t('modals.staffShift.showDetailedView', 'Show Detailed View')}
                        </button>
                      </div>

                      <AnimatePresence initial={false}>
                      {showDetailedView && (
                        <motion.div key="reveal-45" {...revealMotion} className="space-y-3 max-h-96 overflow-y-auto scrollbar-hide    duration-300"><ShiftRevealContent>
                          {deliveries.map((delivery: any) => (
                            <div key={delivery.id} className="pos-glass-form-card p-4! mb-3">
                              {/* Order Header */}
                              <div className="flex justify-between items-start mb-3">
                                <div>
                                  <div className="font-semibold liquid-glass-modal-text">{t('modals.staffShift.tipOrder', 'Order')} {formatGridOrderNumber(delivery)}</div>
                                  <div className="liquid-glass-modal-text-muted text-sm">{formatCurrency(delivery.total_amount)}</div>
                                </div>
                                <div className={`text-xs ${delivery.payment_method === 'cash' ? ' text-green-800 dark:text-green-300' :
                                  delivery.payment_method === 'card' ? ' liquid-glass-modal-text-muted' :
                                    ' liquid-glass-modal-text-muted'
                                  }`}>
                                  {delivery.payment_method.toUpperCase()}
                                </div>
                              </div>

                              {/* Customer Info */}
                              <div className="space-y-2 mb-3 pb-3">
                                <div className="text-sm">
                                  <span className="liquid-glass-modal-text-muted">Customer: </span>
                                  <span className="liquid-glass-modal-text">{delivery.customer_name}</span>
                                </div>
                                {delivery.customer_phone && (
                                  <div className="text-sm">
                                    <span className="liquid-glass-modal-text-muted">Phone: </span>
                                    <span className="liquid-glass-modal-text">{delivery.customer_phone}</span>
                                  </div>
                                )}
                                {delivery.customer_email && (
                                  <div className="text-sm">
                                    <span className="liquid-glass-modal-text-muted">Email: </span>
                                    <span className="liquid-glass-modal-text text-xs break-all">{delivery.customer_email}</span>
                                  </div>
                                )}
                              </div>

                              {/* Delivery Address */}
                              {delivery.delivery_address && (
                                <div className="mb-3 pb-3">
                                  <div className="liquid-glass-modal-text-muted text-xs mb-1">Delivery Address</div>
                                  <div className="liquid-glass-modal-text text-sm wrap-break-word">{delivery.delivery_address}</div>
                                </div>
                              )}

                              {/* Earnings Breakdown */}
                              <div className="grid grid-cols-2 gap-2 text-xs">
                                <div className="pos-glass-form-card p-2!">
                                  <div className="liquid-glass-modal-text-muted">Delivery Fee</div>
                                  <div className="font-semibold text-green-700 dark:text-green-400">{formatCurrency(delivery.delivery_fee)}</div>
                                </div>
                                <div className="pos-glass-form-card p-2!">
                                  <div className="liquid-glass-modal-text-muted">Tip</div>
                                  <div className="font-semibold text-green-700 dark:text-green-400">{formatCurrency(delivery.tip_amount)}</div>
                                </div>
                                <div className="pos-glass-form-card p-2!">
                                  <div className="liquid-glass-modal-text-muted">Cash Collected</div>
                                  <div className="font-semibold liquid-glass-modal-text">{formatCurrency(delivery.cash_collected)}</div>
                                </div>
                                <div className="pos-glass-form-card p-2!">
                                  <div className="liquid-glass-modal-text-muted">Cash to Return</div>
                                  <div className="font-semibold text-yellow-700 dark:text-yellow-400">{formatCurrency(delivery.cash_to_return)}</div>
                                </div>
                              </div>
                            </div>
                          ))}
                        </ShiftRevealContent></motion.div>
                      )}
                      </AnimatePresence>
                    </div>
                  </div>
                );
              })()}

              {/* Waiter Checkout Section */}
              {effectiveShift?.role_type === 'server' && shiftSummary?.waiterTables && (() => {
                const waiterTables = shiftSummary.waiterTables;
                const totalTables = waiterTables.length;
                const totalOrders = waiterTables.reduce((sum: number, t: any) => sum + t.order_count, 0);

                const cashTotal = waiterTables.reduce((sum: number, t: any) => sum + t.cash_amount, 0);
                const cardTotal = waiterTables.reduce((sum: number, t: any) => sum + t.card_amount, 0);

                // Calculate counts based on orders within tables for accurate summary
                let cashCount = 0;
                let cardCount = 0;
                let canceledCount = 0;

                waiterTables.forEach((t: any) => {
                  const safeOrders = Array.isArray(t.orders) ? t.orders : [];
                  safeOrders.forEach((o: any) => {
                    const status = (o.status || '').toLowerCase();
                    if (status === 'cancelled' || status === 'canceled') {
                      canceledCount++;
                    }
                    const pm = (o.payment_method || '').toLowerCase();
                    if (pm === 'cash') cashCount++;
                    else if (pm === 'card') cardCount++;
                  });
                });

                return (
                  <div className="space-y-4">
                    {/* 1. Summary Statistics */}
                    <div className={'pos-glass-form-card' + " p-4!"}>
                      <div className="flex items-center justify-between mb-3">
                        <h3 className="text-lg font-bold liquid-glass-modal-text">{t('modals.staffShift.orderSummary', 'Order Summary')}</h3>
                        <div className="flex gap-2">
                          <POSGlassBadge variant="info">{totalTables} {t('modals.staffShift.tablesServed', 'Tables Served')}</POSGlassBadge>
                          <POSGlassBadge variant="info">{totalOrders} {t('modals.staffShift.ordersCount', 'Orders')}</POSGlassBadge>
                        </div>
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        <div className="pos-glass-form-card p-3! flex justify-between items-center">
                          <div className="flex flex-col">
                            <span className="text-xs text-green-800 dark:text-green-200">{t('modals.staffShift.cashOrders', 'Cash Orders')}</span>
                            <span className="font-bold text-green-700 dark:text-green-400 text-lg">{cashCount}</span>
                          </div>
                          <div className="text-right">
                            <CashHandIcon className="w-5 h-5 text-green-800 dark:text-green-300 ml-auto" />
                            <div className="font-bold text-green-800 dark:text-green-300">{formatCurrency(cashTotal)}</div>
                          </div>
                        </div>
                        <div className="pos-glass-form-card p-3! flex justify-between items-center">
                          <div className="flex flex-col">
                            <span className="text-xs liquid-glass-modal-text-muted">{t('modals.staffShift.cardOrders', 'Card Orders')}</span>
                            <span className="font-bold liquid-glass-modal-text-muted text-lg">{cardCount}</span>
                          </div>
                          <div className="text-right">
                            <CreditCard className="w-5 h-5 liquid-glass-modal-text-muted ml-auto" />
                            <div className="font-bold liquid-glass-modal-text-muted">{formatCurrency(cardTotal)}</div>
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* 2. Compact Table Details Table */}
                    <div className={'pos-glass-form-card'}>
                      <div className="flex items-center justify-between mb-3 cursor-pointer" onClick={() => setShowTableDetailsTable(!showTableDetailsTable)}>
                        <h3 className="text-lg font-bold liquid-glass-modal-text">{t('modals.staffShift.tableDetails', 'Table Details')}</h3>
                        <button
                          className="pos-glass-field min-h-[44px] px-3 py-2 text-sm transition-colors"
                          aria-label={showTableDetailsTable ? t('modals.staffShift.hideDetails', 'Hide Details') : t('modals.staffShift.showDetails', 'Show Details')}
                          aria-expanded={showTableDetailsTable}
                        >
                          {showTableDetailsTable ? t('modals.staffShift.hideDetails', 'Hide Details') : t('modals.staffShift.showDetails', 'Show Details')}
                        </button>
                      </div>

                      <AnimatePresence initial={false}>
                      {showTableDetailsTable && (
                        <motion.div key="reveal-46" {...revealMotion} className="pos-glass-form-card overflow-x-auto max-h-64 overflow-y-auto scrollbar-hide"><ShiftRevealContent>
                          <table className="w-full text-sm text-left" role="table">
                            <thead className="text-sm liquid-glass-modal-text-muted sticky top-0">
                              <tr role="row">
                                <th scope="col" className="px-3 py-2 font-medium">{t('modals.staffShift.tableNumber', 'Table')}</th>
                                <th scope="col" className="px-3 py-2 font-medium">{t('modals.staffShift.ordersCount', 'Orders')}</th>
                                <th scope="col" className="px-3 py-2 font-medium text-right">{t('modals.staffShift.orderAmountHeader', 'Amount')}</th>
                                <th scope="col" className="px-3 py-2 font-medium text-center">{t('modals.staffShift.orderStatusHeader', 'Status')}</th>
                              </tr>
                            </thead>
                            <tbody className="" role="rowgroup">
                              {waiterTables.map((table: any) => {
                                const safeOrders = Array.isArray(table.orders) ? table.orders : [];
                                // Determine status symbol for table (if any active order checkmark, else X)
                                const hasActive = safeOrders.some((o: any) => {
                                  const s = (o.status || '').toLowerCase();
                                  return s !== 'cancelled' && s !== 'canceled';
                                });

                                return (
                                  <tr key={table.table_number} className="transition-colors" role="row">
                                    <td className="px-3 py-2 font-medium liquid-glass-modal-text" role="cell">{table.table_number}</td>
                                    <td className="px-3 py-2 liquid-glass-modal-text-muted" role="cell">{table.order_count}</td>
                                    <td className="px-3 py-2 text-right font-medium liquid-glass-modal-text-muted" role="cell">{formatCurrency(table.total_amount)}</td>
                                    <td className="px-3 py-2 text-center" role="cell">
                                      <span className="inline-flex ga items-center justify-center text-xs">
                                        {hasActive ? (
                                          <CheckCircle className="w-3 h-3 text-green-700 dark:text-green-400" />
                                        ) : (
                                          <XCircle className="w-3 h-3 text-red-700 dark:text-red-400" />
                                        )}
                                        <span className="inline-flex">{getPaymentSymbol(table.payment_method)}</span>
                                      </span>
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </ShiftRevealContent></motion.div>
                      )}
                      </AnimatePresence>
                    </div>

                    {/* 3. Detailed Table Consumption Cards */}
                    <div className={'pos-glass-form-card'}>
                      <div className="flex items-center justify-between mb-4">
                        <div className="flex items-center gap-2">
                          <h3 className="text-xl font-bold liquid-glass-modal-text">{t('modals.staffShift.tableConsumption', 'Table Consumption')}</h3>
                          <POSGlassBadge variant="success">{totalTables} {t('modals.staffShift.tablesServed', 'Tables')}</POSGlassBadge>
                        </div>
                        <button
                          onClick={() => setShowDetailedTableView(!showDetailedTableView)}
                          className="pos-glass-field min-h-[44px] text-sm px-3 py-1.5 liquid-glass-modal-text transition-all duration-300"
                          aria-label={showDetailedTableView ? t('modals.staffShift.hideDetailedView', 'Hide Detailed View') : t('modals.staffShift.showDetailedView', 'Show Detailed View')}
                          aria-expanded={showDetailedTableView}
                        >
                          {showDetailedTableView ? t('modals.staffShift.hideDetailedView', 'Hide Detailed View') : t('modals.staffShift.showDetailedView', 'Show Detailed View')}
                        </button>
                      </div>

                      <AnimatePresence initial={false}>
                      {showDetailedTableView && (
                        <motion.div key="reveal-47" {...revealMotion} className="space-y-3 max-h-96 overflow-y-auto scrollbar-hide    duration-300"><ShiftRevealContent>
                          {waiterTables.map((table: any) => (
                            <div key={table.table_number} className="pos-glass-form-card p-4! mb-3">
                              {/* Table Header */}
                              <div className="flex justify-between items-start mb-3">
                                <div>
                                  <div className="font-semibold liquid-glass-modal-text">
                                    {t('modals.staffShift.tableNumber')} {table.table_number}
                                  </div>
                                  <div className="liquid-glass-modal-text-muted text-sm">
                                    {t('modals.staffShift.ordersCountValue', { count: table.order_count })}
                                  </div>
                                </div>
                                <div className="text-right">
                                  <div className="font-bold text-green-700 dark:text-green-400">{formatCurrency(table.total_amount)}</div>
                                  <div className={`text-xs inline-block mt-1 ${table.payment_method === 'cash' ? ' text-green-800 dark:text-green-300' :
                                    table.payment_method === 'card' ? ' liquid-glass-modal-text-muted' :
                                      ' liquid-glass-modal-text-muted'
                                    }`}>
                                    {table.payment_method.toUpperCase()}
                                  </div>
                                </div>
                              </div>

                              {/* Order List */}
                              <div className="space-y-1 mb-3 pb-3">
                                {table.orders && Array.isArray(table.orders) ? table.orders.map((order: any) => (
                                  <div key={order.order_id} className="flex justify-between text-xs">
                                    <span className="liquid-glass-modal-text-muted">{formatGridOrderNumber(order)}</span>
                                    <span className="liquid-glass-modal-text">{formatCurrency(order.total_amount)} ({order.payment_method})</span>
                                  </div>
                                )) : null}
                              </div>

                              {/* Breakdown */}
                              <div className="grid grid-cols-2 gap-2 text-xs">
                                <div className="pos-glass-form-card p-2!">
                                  <div className="liquid-glass-modal-text-muted">Cash</div>
                                  <div className="font-semibold text-green-700 dark:text-green-400">{formatCurrency(table.cash_amount)}</div>
                                </div>
                                <div className="pos-glass-form-card p-2!">
                                  <div className="liquid-glass-modal-text-muted">Card</div>
                                  <div className="font-semibold liquid-glass-modal-text-muted">{formatCurrency(table.card_amount)}</div>
                                </div>
                              </div>
                            </div>
                          ))}
                        </ShiftRevealContent></motion.div>
                      )}
                      </AnimatePresence>
                    </div>
                    {/* Comment 2: UI indication of cash to return */}
                    {
                      (() => {
                        const opening = getEffectiveOpeningAmount(effectiveShift, shiftSummary);
                        const expensesTotal = shiftSummary.totalExpenses || 0;
                        // Calculate totals from waiterTables array
                        const cashFromTables = waiterTables.reduce((sum: number, t: any) => sum + (t.cash_amount || 0), 0);

                        // Read calculation_version from shift (default to 1 for legacy shifts)
                        const calculationVersion = effectiveShift.calculation_version || 1;
                        const paymentAmount = effectiveShift.payment_amount || 0;

                        // Version-aware formula:
                        // v1 (legacy): cashToReturn = starting + collected - expenses - payment
                        // v2 (current): cashToReturn = starting + collected - expenses (payment handled at cashier checkout)
                        const cashToReturn = calculationVersion >= 2
                          ? opening + cashFromTables - expensesTotal
                          : opening + cashFromTables - expensesTotal - paymentAmount;

                        const label = cashToReturn >= 0 ? t('modals.staffShift.amountToReturn', { defaultValue: 'Amount to collect from drawer' }) : t('modals.staffShift.shortage', 'Shortage');
                        const colorClass = cashToReturn >= 0 ? 'liquid-glass-modal-text-muted' : 'text-red-700 dark:text-red-400';

                        return (
                          <div className={'pos-glass-form-card' + " p-4! mt-2"}>
                            <h3 className="text-md font-bold liquid-glass-modal-text mb-3">{t('modals.staffShift.cashReconciliation', 'Cash Reconciliation')}</h3>
                            <div className="space-y-2 text-sm">
                              <div className="flex justify-between">
                                <span className="liquid-glass-modal-text-muted">{t('modals.staffShift.startingAmount', 'Starting Amount')}</span>
                                <span className="text-green-700 dark:text-green-400">+{formatCurrency(opening)}</span>
                              </div>
                              <div className="flex justify-between">
                                <span className="liquid-glass-modal-text-muted">{t('modals.staffShift.cashCollected', 'Cash Collected')}</span>
                                <span className="text-green-700 dark:text-green-400">+{formatCurrency(cashFromTables)}</span>
                              </div>
                              <div className={`flex justify-between ${calculationVersion >= 2 ? ' pb-2' : ''}`}>
                                <span className="liquid-glass-modal-text-muted">{t('modals.staffShift.expenses', 'Expenses')}</span>
                                <span className="text-red-700 dark:text-red-400">-{formatCurrency(expensesTotal)}</span>
                              </div>
                              {/* v1: Show payment as deduction in the breakdown */}
                              {calculationVersion < 2 && paymentAmount > 0 && (
                                <div className="flex justify-between pb-2">
                                  <span className="liquid-glass-modal-text-muted">{t('modals.staffShift.payment', 'Payment')}</span>
                                  <span className="text-red-700 dark:text-red-400">-{formatCurrency(paymentAmount)}</span>
                                </div>
                              )}
                              {/* v1: Add border after expenses if no payment */}
                              {calculationVersion < 2 && paymentAmount === 0 && (
                                <div className=""></div>
                              )}
                              <div className="flex justify-between pt-1 font-bold text-lg">
                                <span className="liquid-glass-modal-text-muted">{label}</span>
                                <span className={colorClass}>{formatCurrency(Math.abs(cashToReturn))}</span>
                              </div>
                              {/* Formula Explanation */}
                              <div className="mt-3 pt-2">
                                <p className="text-xs liquid-glass-modal-text-muted text-center">
                                  <span className="font-semibold liquid-glass-modal-text-muted">{t('receipt.formula.label')}</span>{' '}
                                  {calculationVersion >= 2 ? t('receipt.formula.waiter') : t('receipt.formula.waiterV1', 'Starting + Collected - Expenses - Payment')}
                                </p>
                              </div>
                              {/* Note: Waiter payments are handled at cashier checkout (v2 only) */}
                              {calculationVersion >= 2 && (
                                <div className="pos-glass-form-card p-2! mt-2">
                                  <p className="text-xs liquid-glass-modal-text-muted text-center">
                                    {t('modals.staffShift.waiterPaymentNote', 'Payment will be recorded when you return cash to the cashier')}
                                  </p>
                                </div>
                              )}
                              {/* Note: Payment already deducted (v1 only) */}
                              {calculationVersion < 2 && paymentAmount > 0 && (
                                <div className="pos-glass-form-card p-2! mt-2">
                                  <p className="text-xs text-yellow-800 dark:text-yellow-300 text-center">
                                    {t('modals.staffShift.paymentDeductedNote', 'Payment already deducted from amount to return')}
                                  </p>
                                </div>
                              )}
                            </div>
                          </div>
                        );
                      })()
                    }

                  </div>
                );
              })()}


              {/* Detailed Shift Breakdown */}
              {effectiveShift?.role_type === 'cashier' && shiftSummary && (() => {
                const instore = shiftSummary.breakdown?.instore || { cashTotal: 0, cardTotal: 0, cashCount: 0, cardCount: 0 };
                const delivery = shiftSummary.breakdown?.delivery || { cashTotal: 0, cardTotal: 0, cashCount: 0, cardCount: 0 };
                const overall = shiftSummary.breakdown?.overall || { cashTotal: 0, cardTotal: 0, totalCount: 0, totalAmount: 0 };
                const totalPickupOrders = (instore.cashCount || 0) + (instore.cardCount || 0);
                const totalDeliveryOrders = (delivery.cashCount || 0) + (delivery.cardCount || 0);
                const totalCashOrdersCount = (instore.cashCount || 0) + (delivery.cashCount || 0);

                return (
                  <div className={'pos-glass-form-card' + ' space-y-4'}>
                    <h3 className="text-xl font-bold liquid-glass-modal-text mb-4">{t('modals.staffShift.shiftBreakdown')}</h3>

                    {/* Totals */}
                    <div className="grid grid-cols-2 gap-3">
                      <div className="pos-glass-form-card p-3!">
                        <div className="text-xs font-medium liquid-glass-modal-text-muted mb-1">{t('modals.staffShift.totalOrders')}</div>
                        <div className="text-lg font-bold liquid-glass-modal-text">{overall.totalCount}</div>
                      </div>
                      <div className="pos-glass-form-card p-3!">
                        <div className="text-xs font-medium liquid-glass-modal-text-muted mb-1">{shiftSummary?.netCollections ? t('modals.staffShift.netCollections', 'Net collections') : t('modals.staffShift.totalSales')}</div>
                        <div className="text-xl font-bold text-green-500">{formatCurrency(shiftSummary?.netCollections ? Number(shiftSummary.netCollections.totalCents) / 100 : overall.totalAmount)}</div>
                      </div>
                    </div>

                    {/* Pickup / Delivery by method */}
                    <div className="grid grid-cols-2 gap-3">
                      <div className="pos-glass-form-card p-3!">
                        <div className="text-xs font-medium liquid-glass-modal-text-muted mb-1">{t('modals.staffShift.pickupCash')}</div>
                        <div className="flex justify-between text-sm">
                          <span className="liquid-glass-modal-text">{t('modals.staffShift.ordersCountValue', { count: instore.cashCount })}</span>
                          <span className="font-bold text-green-500">{formatCurrency(instore.cashTotal)}</span>
                        </div>
                      </div>
                      <div className="pos-glass-form-card p-3!">
                        <div className="text-xs font-medium liquid-glass-modal-text-muted mb-1">{t('modals.staffShift.pickupCard')}</div>
                        <div className="flex justify-between text-sm">
                          <span className="liquid-glass-modal-text">{t('modals.staffShift.ordersCountValue', { count: instore.cardCount })}</span>
                          <span className="font-bold liquid-glass-modal-text">{formatCurrency(instore.cardTotal)}</span>
                        </div>
                      </div>
                      <div className="pos-glass-form-card p-3!">
                        <div className="text-xs font-medium liquid-glass-modal-text-muted mb-1">{t('modals.staffShift.deliveryCash')}</div>
                        <div className="flex justify-between text-sm">
                          <span className="liquid-glass-modal-text">{t('modals.staffShift.ordersCountValue', { count: delivery.cashCount })}</span>
                          <span className="font-bold text-green-500">{formatCurrency(delivery.cashTotal)}</span>
                        </div>
                      </div>
                      <div className="pos-glass-form-card p-3!">
                        <div className="text-xs font-medium liquid-glass-modal-text-muted mb-1">{t('modals.staffShift.deliveryCard')}</div>
                        <div className="flex justify-between text-sm">
                          <span className="liquid-glass-modal-text">{t('modals.staffShift.ordersCountValue', { count: delivery.cardCount })}</span>
                          <span className="font-bold liquid-glass-modal-text">{formatCurrency(delivery.cardTotal)}</span>
                        </div>
                      </div>
                    </div>

                    {/* Totals by channel with cash amount */}
                    <div className="grid grid-cols-2 gap-3">
                      <div className="pos-glass-form-card p-3!">
                        <div className="text-xs font-medium liquid-glass-modal-text-muted mb-1">{t('modals.staffShift.totalPickupOrders')}</div>
                        <div className="flex justify-between text-sm">
                          <span className="liquid-glass-modal-text font-semibold">{t('modals.staffShift.ordersCountValue', { count: totalPickupOrders })}</span>
                          <span className="font-bold text-green-500">{formatCurrency(instore.cashTotal + instore.cardTotal)}</span>
                        </div>
                      </div>
                      <div className="pos-glass-form-card p-3!">
                        <div className="text-xs font-medium liquid-glass-modal-text-muted mb-1">{t('modals.staffShift.totalDeliveryOrders')}</div>
                        <div className="flex justify-between text-sm">
                          <span className="liquid-glass-modal-text font-semibold">{t('modals.staffShift.ordersCountValue', { count: totalDeliveryOrders })}</span>
                          <span className="font-bold text-green-500">{formatCurrency(delivery.cashTotal + delivery.cardTotal)}</span>
                        </div>
                      </div>
                      <div className="pos-glass-form-card p-3!">
                        <div className="text-xs font-medium liquid-glass-modal-text-muted mb-1">{t('modals.staffShift.totalOrders')}</div>
                        <div className="flex justify-between text-sm">
                          <span className="liquid-glass-modal-text font-semibold">{t('modals.staffShift.ordersCountValue', { count: overall.totalCount })}</span>
                          <span className="font-bold text-green-500">{formatCurrency(overall.totalAmount)}</span>
                        </div>
                      </div>
                      <div className="pos-glass-form-card p-3!">
                        <div className="text-xs font-medium liquid-glass-modal-text-muted mb-1">{t('modals.staffShift.totalCashOrders')}</div>


                        <div className="flex justify-between text-sm">
                          <span className="liquid-glass-modal-text font-semibold">{t('modals.staffShift.ordersCountValue', { count: totalCashOrdersCount })}</span>
                          <span className="font-bold text-green-500">{formatCurrency(overall.cashTotal)}</span>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })()}

              {/* DRIVER SUMMARY - For Cashier Checkout */}
              {effectiveShift?.role_type === 'cashier' && shiftSummary?.driverDeliveries && shiftSummary.driverDeliveries.length > 0 && (() => {
                const drivers = shiftSummary.driverDeliveries;

                return (
                  <div className={'pos-glass-form-card' + ' space-y-3'}>
                    <h3 className="text-xl font-bold liquid-glass-modal-text mb-3">
                      {t('modals.staffShift.driversCheckout', 'Staff Cash Returns')}
                    </h3>
                    <div className="space-y-2">
                      {drivers.map((driver: any) => {
                        const startingAmount = driver.starting_amount || 0;
                        const earnings = driver.cash_collected || 0;
                        const expenses = driver.expenses || 0;
                        const returns = driver.amount_to_return ?? (
                          driver.role_type === 'driver'
                            ? calculateDriverReturn({
                              openingAmount: startingAmount,
                              cashCollected: earnings,
                              expenses,
                              tipsReceived: Number(driver.tips_received || driver.tipsReceived || 0),
                            })
                            : startingAmount + earnings - expenses
                        );
                        const isPositive = returns >= 0;
                        const roleType = driver.role_type === 'server'
                          ? t('modals.staffShift.serverRole', 'Waiter')
                          : (driver.role_type || t('modals.staffShift.driverRole'));

                        return (
                          <div key={driver.shift_id || driver.driver_id} className={`pos-glass-form-card p-3! `}>
                            {/* Role and Name */}
                            <div className="mb-2">
                              <span className="text-sm liquid-glass-modal-text-muted">{roleType}</span>
                              <div className="font-semibold liquid-glass-modal-text">{driver.driver_name}</div>
                            </div>
                            {/* Grid: Starting, Earnings, Returns */}
                            <div className="grid grid-cols-3 gap-2 text-sm">
                              <div>
                                <div className="text-xs liquid-glass-modal-text-muted">{t('modals.staffShift.driverStarting', 'Starting Amount')}</div>
                                <div className="font-medium liquid-glass-modal-text">{formatCurrency(startingAmount)}</div>
                              </div>
                              <div>
                                <div className="text-xs liquid-glass-modal-text-muted">{t('modals.staffShift.driverEarnings')}</div>
                                <div className="font-medium liquid-glass-modal-text">{formatCurrency(earnings)}</div>
                              </div>
                              <div>
                                <div className="text-xs liquid-glass-modal-text-muted">{isPositive ? t('modals.staffShift.driverReturns') : t('modals.staffShift.driverTakes')}</div>
                                <div className={`font-bold ${isPositive ? 'text-green-700 dark:text-green-400' : 'text-red-700 dark:text-red-400'}`}>
                                  {formatCurrency(Math.abs(returns))}
                                </div>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })()}

              {/* Record Staff Payments Section - For Cashiers */}
              {effectiveShift?.role_type === 'cashier' && (
                <div className={'pos-glass-form-card' + ' space-y-3'}>
                  <div className="flex items-center justify-between">
                    <h3 className="text-lg font-bold liquid-glass-modal-text">{t('modals.staffShift.recordStaffPayments', 'Record Staff Payments')}</h3>
                    <button
                      type="button"
                      onClick={() => {
                        if (showStaffPaymentForm) {
                          resetStaffPaymentForm();
                        } else {
                          void openStaffPaymentForm();
                        }
                      }}
                      aria-label={t('modals.staffShift.addPayment', 'Add Payment')}
                      className={checkoutActionButtonClass}
                    >
                      <Plus className="h-6 w-6" strokeWidth={3} />
                    </button>
                  </div>

                  {/* Payment Form */}
                  <AnimatePresence initial={false}>
                  {showStaffPaymentForm && (
                    <motion.div key="reveal-48" {...revealMotion} ref={staffPaymentFormRef} className="pos-glass-form-card p-4! space-y-3 "><ShiftRevealContent>
                      {/* Staff Selection */}
                      <div>
                        <label className="block text-xs font-semibold liquid-glass-modal-text-muted mb-1">{t('modals.staffShift.selectStaff', 'Select Staff')}</label>
                        <select
                          value={selectedStaffForPayment?.id || ''}
                          onChange={async (e) => {
                            const staffId = e.target.value;
                            if (staffId) {
                              const selected = availableStaff.find(s => s.id === staffId);
                              if (selected) {
                                setSelectedStaffForPayment({
                                  id: selected.id,
                                  name: selected.name,
                                role: selected.roles?.[0]?.role_name || 'staff'
                              });
                                // Load history for this staff, using effective shift date context
                                const shiftDate = effectiveShift?.check_in_time
                                  ? toLocalDateString(effectiveShift.check_in_time)
                                  : undefined;
                                await loadPaymentHistoryForStaff(selected.id, shiftDate);

                                // Calculate expected payment based on their hourly rate and active shift
                                const activeShift = staffActiveShifts.get(selected.id);
                                // Or if they don't have an active shift but we're paying them, maybe we shouldn't calc expected?
                                // But logic says: "Use shift.check_in_time from the provided shift"
                                // We need to look up their active shift from the map or context.
                                // Assuming staffActiveShifts map has the shift info.
                                await calculateExpectedPayment(activeShift, selected.hourly_rate);
                              }
                            } else {
                              setSelectedStaffForPayment(null);
                              setPaymentHistory([]); // Clear history
                              setDailyPaymentTotal(0); // Clear summary
                              setExpectedPayment(null);
                            }
                          }}
                          className="liquid-glass-modal-input pos-glass-field min-h-[44px] w-full"
                        >
                          <option value="">{t('modals.staffShift.selectStaffPlaceholder', '-- Select Staff --')}</option>
                          {editingStaffPayment && selectedStaffForPayment?.id && !availableStaff.some((member) => member.id === (selectedStaffForPayment?.id ?? '')) && (
                            <option value={selectedStaffForPayment?.id ?? ''}>{selectedStaffForPayment?.name ?? t('common.unknown', 'Unknown')}</option>
                          )}
                          {availableStaff
                            .filter(s => s.id !== staff?.staffId) // Exclude current cashier
                            .map(s => (
                              <option key={s.id} value={s.id}>{s.name}</option>
                            ))}
                        </select>
                      </div>

                      {/* Payment History Section */}
                      <AnimatePresence initial={false}>
                      {paymentHistory.length > 0 && (
                        <motion.div key="reveal-49" {...revealMotion} className="mb-6"><ShiftRevealContent>
                          <div className="flex items-center justify-between mb-3">
                            <h4 className="font-semibold text-sm liquid-glass-modal-text-muted">
                              {t('modals.staffShift.paymentHistoryToday', "Today's Payments")}
                            </h4>
                            <POSGlassBadge variant="info" size="sm">
                              {t('modals.staffShift.todayTotal', { amount: formatCurrency(dailyPaymentTotal) })}
                            </POSGlassBadge>
                          </div>

                          <div className="space-y-2 max-h-48 overflow-y-auto mb-4 scrollbar-hide">
                            {paymentHistory.map((payment) => (
                              <div
                                key={payment.id}
                                className="pos-glass-form-card flex items-center justify-between p-3!"
                              >
                                <div className="flex-1">
                                  <div className="flex items-center gap-2">
                                    <span className="font-medium liquid-glass-modal-text">
                                      {formatCurrency(payment.amount)}
                                    </span>
                                    <POSGlassBadge variant="info" size="sm">
                                      {t(`modals.staffShift.paymentTypes.${payment.payment_type}`, payment.payment_type) as string}
                                    </POSGlassBadge>
                                  </div>
                                  {payment.notes && (
                                    <div className="text-xs liquid-glass-modal-text-muted mt-1">
                                      {payment.notes}
                                    </div>
                                  )}
                                  <div className="text-xs liquid-glass-modal-text-muted mt-1">
                                    {t('modals.staffShift.paidBy', {
                                      name: payment.cashier_name || t('common.unknown', 'Unknown'),
                                      time: formatTime(payment.created_at)
                                    })}
                                  </div>
                                </div>
                              </div>
                            ))}
                          </div>
                        </ShiftRevealContent></motion.div>
                      )}
                      </AnimatePresence>

                      {/* Payment Type */}
                      <div>
                        <label className="block text-xs font-semibold liquid-glass-modal-text-muted mb-1">{t('modals.staffShift.paymentType', 'Payment Type')}</label>
                        <select
                          value={paymentType}
                          onChange={(e) => setPaymentType(e.target.value)}
                          className="liquid-glass-modal-input pos-glass-field min-h-[44px] w-full"
                        >
                          <option value="wage">{t('modals.staffShift.paymentTypes.wage', 'Wage')}</option>
                          <option value="tip">{t('modals.staffShift.paymentTypes.tip', 'Tip')}</option>
                          <option value="bonus">{t('modals.staffShift.paymentTypes.bonus', 'Bonus')}</option>
                          <option value="advance">{t('modals.staffShift.paymentTypes.advance', 'Advance')}</option>
                          <option value="other">{t('modals.staffShift.paymentTypes.other', 'Other')}</option>
                        </select>
                      </div>

                      {/* Amount */}
                      <div>
                        <label className="block text-xs font-semibold liquid-glass-modal-text-muted mb-1">
                          {t('modals.staffShift.amountLabel', 'Amount')}
                          {expectedPayment !== null && (
                            <span className="ml-2 text-xs liquid-glass-modal-text-muted">
                              ({t('modals.staffShift.expected', 'Expected')}: {formatCurrency((expectedPayment ?? 0))})
                            </span>
                          )}
                        </label>
                        <div className="relative">
                          <CashHandIcon className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 liquid-glass-modal-text-muted" />
                          <CentsMoneyInput
                            aria-label={t('modals.staffShift.amountLabel', 'Amount')}
                            value={paymentAmount}
                            onValueChange={setPaymentAmount}
                            placeholder={expectedPayment ? formatCurrency(expectedPayment ?? 0) : '0,00'}
                            className="liquid-glass-modal-input pos-glass-field min-h-[44px] w-full pl-9"
                          />
                        </div>
                      </div>

                      {/* Notes */}
                      <div>
                        <label className="block text-xs font-semibold liquid-glass-modal-text-muted mb-1">{t('modals.staffShift.notesOptional', 'Notes (optional)')}</label>
                        <input
                          type="text"
                          value={paymentNotes}
                          onChange={(e) => setPaymentNotes(e.target.value)}
                          placeholder={t('modals.staffShift.paymentNotesPlaceholder', 'Add notes (optional)')}
                          className="liquid-glass-modal-input pos-glass-field min-h-[44px] w-full"
                        />
                      </div>

                      {/* Buttons */}
                      <div className="flex justify-end gap-2 pt-2">
                        <button
                          onClick={() => {
                            setShowStaffPaymentForm(false);
                            setSelectedStaffForPayment(null);
                            setPaymentAmount('');
                            setPaymentType('wage');
                            setPaymentNotes('');
                            setPaymentHistory([]);
                            setDailyPaymentTotal(0);
                          }}
                          className="pos-solid-btn pos-solid-btn--sm"
                        >
                          {t('common.cancel', 'Cancel')}
                        </button>
                        <button
                          onClick={handleRecordStaffPayment}
                          disabled={loading || !selectedStaffForPayment || !paymentAmount}
                          className="min-h-[44px] pos-raised pos-raised--yellow px-4 py-2 bg-(--pos-s-yellow) text-black rounded-lg disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          {loading
                            ? t('common.saving', 'Saving...')
                            : t(
                                editingStaffPaymentId ? 'modals.staffShift.savePaymentChanges' : 'modals.staffShift.recordPayment',
                                editingStaffPaymentId ? 'Save Changes' : 'Record Payment',
                              )}
                        </button>
                      </div>
                    </ShiftRevealContent></motion.div>
                  )}
                  </AnimatePresence>

                  {/* List of Recorded Payments from current session */}
                  <AnimatePresence initial={false}>
                  {staffPaymentsList.length > 0 && (
                    <motion.div key="reveal-50" {...revealMotion} className="space-y-2 max-h-48 overflow-auto pr-1 scrollbar-hide"><ShiftRevealContent>
                      <div className="text-sm liquid-glass-modal-text-muted mb-2">{t('modals.staffShift.recordedThisSession', 'Recorded This Session')}</div>
                      {staffPaymentsList.map((p) => (
                        <div key={p.id} className="pos-glass-form-card flex items-center justify-between p-3! text-sm">
                          <div className="flex-1">
                            <div className="font-semibold liquid-glass-modal-text">{p.staff_name || t('common.unknown', 'Unknown')}</div>
                            <div className="liquid-glass-modal-text-muted text-xs capitalize">
                              {t(`modals.staffShift.paymentTypes.${p.payment_type}`, p.payment_type)}
                              {p.notes ? ` • ${p.notes}` : ''}
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              disabled={loading}
                              onClick={() => { void beginEditStaffPayment(p); }}
                              className="pos-glass-field min-h-[44px] inline-flex items-center gap-1 px-3 py-1.5 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-60"
                            >
                              <Pencil className="h-3.5 w-3.5" />
                              {t('modals.staffShift.editPayment', 'Edit')}
                            </button>
                            <button
                              type="button"
                              disabled={deletingStaffPaymentId === p.id}
                              onClick={() =>
                                openConfirm({
                                  title: t('modals.staffShift.deleteStaffPaymentConfirmTitle', 'Delete staff payment'),
                                  message: t(
                                    'modals.staffShift.deleteStaffPaymentConfirmMessage',
                                    'Delete the payment for "{{name}}"? Cashier checkout totals will be recalculated immediately.',
                                    { name: p.staff_name || t('common.unknown', 'Unknown') },
                                  ),
                                  variant: 'error',
                                  confirmText: t('modals.staffShift.deletePayment', 'Delete Payment'),
                                  onConfirm: () => { void handleDeleteStaffPayment(p); },
                                })
                              }
                              className="pos-solid-btn pos-solid-btn--sm pos-solid-btn--danger disabled:cursor-not-allowed disabled:opacity-60"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                              {t('modals.staffShift.deletePayment', 'Delete')}
                            </button>
                            <div className="font-bold text-red-700 dark:text-red-400">-{formatCurrency(p.amount)}</div>
                          </div>
                        </div>
                      ))}
                      <div className="flex justify-between items-center pt-2">
                        <span className="text-sm font-semibold liquid-glass-modal-text">{t('modals.staffShift.sessionTotal', 'Session Total')}</span>
                        <span className="font-bold text-red-700 dark:text-red-400">
                          -{formatCurrency(staffPaymentsList.reduce((s, p) => s + p.amount, 0))}
                        </span>
                      </div>
                    </ShiftRevealContent></motion.div>
                  )}
                  </AnimatePresence>
                </div>
              )}

              {/* Staff Payments (details) - Historical from summary */}
              {effectiveShift?.role_type === 'cashier' && Array.isArray(shiftSummary?.staffPayments) && shiftSummary.staffPayments.length > 0 && (
                <details className={'pos-glass-form-card' + ' space-y-3'}>
                  <summary className="min-h-[44px] flex cursor-pointer list-none items-center justify-between gap-3 text-xl font-bold liquid-glass-modal-text [&::-webkit-details-marker]:hidden">
                    <span>{t('modals.staffShift.staffPaymentsTitle')}</span>
                    <POSGlassBadge variant="info" size="sm">
                      {shiftSummary.staffPayments.length}
                    </POSGlassBadge>
                  </summary>
                  <div className="mt-3 space-y-3">
                    <div className="space-y-2 max-h-52 overflow-auto pr-1 scrollbar-hide">
                      {shiftSummary.staffPayments.map((p: any) => {
                        const name = p.staff_name || '—';
                        const role = p.role_type || '—';
                        const amt = Number(p.amount || 0);
                        let hours = 0;
                        try {
                          const start = p.check_in_time ? new Date(p.check_in_time) : null;
                          const end = p.check_out_time ? new Date(p.check_out_time) : null;
                          const endEff = end || new Date();
                          if (start) {
                            const ms = Math.max(0, endEff.getTime() - start.getTime());
                            hours = ms / 3600000;
                          }
                        } catch { }
                        return (
                          <div key={p.id} className="pos-glass-form-card flex items-center justify-between p-3! text-sm">
                            <div className="flex-1">
                              <div className="font-semibold liquid-glass-modal-text">{name}</div>
                              <div className="liquid-glass-modal-text-muted text-xs">{role} • {hours.toFixed(2)} h</div>
                            </div>
                            <div className="font-bold text-red-700 dark:text-red-400">-{formatCurrency(amt)}</div>
                          </div>
                        );
                      })}
                    </div>
                    <div className="flex justify-between items-center pt-2">
                      <span className="font-semibold liquid-glass-modal-text">{t('modals.staffShift.totalStaffPayments')}</span>
                      <span className="font-bold text-red-700 dark:text-red-400">
                        -{formatCurrency(shiftSummary.staffPayments.reduce((s: number, p: any) => s + Number(p.amount || 0), 0))}
                      </span>
                    </div>
                  </div>
                </details>
              )}

              {/* CASHIER INPUT FIELDS - Redesigned */}
              {effectiveShift?.role_type === 'cashier' && (
                <div className="space-y-3">
                  {/* Cashier Payment */}
                  <div className="pos-glass-form-card p-4!">
                    <label className="block text-xs font-bold liquid-glass-modal-text-muted mb-2 flex items-center gap-2">
                      <CashHandIcon className="w-4 h-4 text-green-500" />
                      {t('modals.staffShift.cashierPaymentLabel')}
                    </label>
                    <div className="flex items-center gap-3">
                      <CentsMoneyInput
                        aria-label={t('modals.staffShift.cashierPaymentLabel')}
                        value={staffPayment}
                        onValueChange={setStaffPayment}
                        placeholder="0,00"
                        className="liquid-glass-modal-input pos-glass-field min-h-[44px] flex-1 text-2xl font-bold text-center"
                      />
                    </div>
                    <p className="text-xs font-medium liquid-glass-modal-text-muted mt-2">{t('modals.staffShift.cashierPaymentHelper')}</p>
                  </div>

                  {/* Closing Cash */}
                  <div className="pos-glass-form-card p-4!">
                    <label className="block text-xs font-bold liquid-glass-modal-text-muted mb-2 flex items-center gap-2">
                      <CashHandIcon className="w-4 h-4 text-green-500" />
                      {t('modals.staffShift.closingCashLabel')}
                    </label>
                    <div className="flex items-center gap-3">
                      <CentsMoneyInput
                        aria-label={t('modals.staffShift.closingCashLabel')}
                        value={closingCash}
                        onValueChange={setClosingCash}
                        placeholder="0,00"
                        className="liquid-glass-modal-input pos-glass-field min-h-[44px] flex-1 text-2xl font-bold text-center"
                        autoFocus
                      />
                    </div>
                    <p className="text-xs font-medium liquid-glass-modal-text-muted mt-2">{t('modals.staffShift.closingCashHelper')}</p>
                  </div>

                  {/* Live Variance Calculation */}
                  {(() => {
                    const opening = getEffectiveOpeningAmount(effectiveShift, shiftSummary);
                    const breakdown = getCashierExpectedBreakdown(
                      shiftSummary,
                      effectiveShift,
                      opening,
                      cashierCheckoutExpenseTotal,
                    );
                    const expected = breakdown.expected;

                    const actual = parseMoneyInputValue(closingCash);
                    const variance = actual - expected;

                    // Only show if user has started typing actual cash (optional, but good UX)
                    if (!closingCash) return null;

                    return (
                      <div className="flex flex-col items-center gap-2 mt-4   ">
                        <VarianceBadge currency={checkoutDisplayCurrency} variance={variance} size="lg" showIcon />
                        {/* Shown inline, not on hover: the tills are touch screens (UI audit wave 6). */}
                        <p data-variance-meaning className="text-xs font-medium text-center liquid-glass-modal-text-muted">
                          {t('modals.staffShift.varianceMeaning', 'The difference between the cash you counted and the cash expected')}
                        </p>
                      </div>
                    );
                  })()}
                </div>
              )}
              {/* DRIVER CHECKOUT - Earnings Calculation */}
              {effectiveShift?.role_type === 'driver' && shiftSummary && (() => {
                const startingAmount = getEffectiveOpeningAmount(effectiveShift, shiftSummary);

                // Filter out canceled orders and get actual cash collected from deliveries
                const deliveries = shiftSummary?.driverDeliveries || [];
                const completedDeliveries = deliveries.filter((d: any) => {
                  const status = (d.status || d.order_status || '').toLowerCase();
                  return status !== 'cancelled' && status !== 'canceled' && status !== 'refunded';
                });

                // Calculate cash collected from completed deliveries only
                const cashCollected = deliveries.reduce((sum: number, d: any) =>
                  sum + (d.cash_collected || 0), 0);

                // Get total expenses
                const totalExpenses = shiftSummary?.totalExpenses || 0;
                const tipsReceived = Number(shiftSummary?.tipsReceived || shiftSummary?.tips_received || 0);

                // Calculate amount to return to cashier
                // Formula: Starting Amount + Cash Collected - Expenses - Tips
                // Payment is not deducted here - it's handled at cashier checkout
                const amountToReturn = calculateDriverReturn({
                  openingAmount: startingAmount,
                  cashCollected,
                  expenses: totalExpenses,
                  tipsReceived,
                });

                return (
                  <div className="space-y-3">
                    {/* Header */}
                    <div className="pos-glass-form-card p-4!">
                      <h3 className="mb-1 text-lg font-bold liquid-glass-modal-text">{t('modals.staffShift.driverCheckout')}</h3>
                      <p className="text-xs liquid-glass-modal-text-muted">{t('modals.staffShift.driverEarnings')}</p>
                    </div>

                    {/* Earnings Summary */}
                    <div className="space-y-2">
                      {/* Starting Amount (cash taken from cashier) */}
                      <div className="pos-glass-form-card flex justify-between items-center p-3!">
                        <span className="text-sm liquid-glass-modal-text-muted">{t('modals.staffShift.startingAmount')}</span>
                        <span className="font-bold liquid-glass-modal-text-muted">+{formatCurrency(startingAmount)}</span>
                      </div>

                      {/* Cash Collected (from deliveries) */}
                      <div className="pos-glass-form-card flex justify-between items-center p-3!">
                        <span className="text-sm text-green-800 dark:text-green-200">
                          {t('modals.staffShift.cashCollected')} ({completedDeliveries.length} {t('modals.staffShift.completedOrdersLabel')})
                        </span>
                        <span className="font-bold text-green-800 dark:text-green-300">+{formatCurrency(cashCollected)}</span>
                      </div>

                      {/* Expenses (if any) */}
                      {totalExpenses > 0 && (
                        <div className="pos-glass-form-card flex justify-between items-center p-3!">
                          <span className="text-sm text-yellow-800 dark:text-yellow-200">{t('modals.staffShift.totalExpenses')}</span>
                          <span className="font-bold text-yellow-800 dark:text-yellow-300">-{formatCurrency(totalExpenses)}</span>
                        </div>
                      )}

                      {tipsReceived > 0 && (
                        <div className="pos-glass-form-card flex justify-between items-center p-3!">
                          <span className="text-sm text-yellow-800 dark:text-yellow-200">{t('modals.staffShift.tipsReceived', 'Tips Received')}</span>
                          <span className="font-bold text-yellow-800 dark:text-yellow-300">-{formatCurrency(tipsReceived)}</span>
                        </div>
                      )}

                      {/* Separator */}
                      <div className="my-2"></div>

                      {/* Amount to Return to Cashier */}
                      <div className={`pos-glass-form-card flex justify-between items-center p-4! font-semibold ${amountToReturn >= 0
                        ? ' '
                        : ' '
                        }`}>
                        <span className={`text-base ${amountToReturn >= 0 ? 'text-yellow-800 dark:text-yellow-200' : 'text-red-800 dark:text-red-200'}`}>
                          {t('modals.staffShift.amountToReturn', { defaultValue: 'Return' })}
                        </span>
                        <span className={amountToReturn >= 0 ? 'text-xl text-yellow-800 dark:text-yellow-300' : 'text-xl text-red-800 dark:text-red-300'}>
                          {formatCurrency(amountToReturn)}
                        </span>
                      </div>

                      {/* Actual Cash Returned Input */}
                      <div className="pos-glass-form-card mt-3 p-4!">
                        <label className="block text-xs font-semibold liquid-glass-modal-text-muted mb-2">
                          {t('modals.staffShift.actualCashReturned', 'Actual Cash Returned')}
                        </label>
                        <CentsMoneyInput
                          aria-label={t('modals.staffShift.actualCashReturned', 'Actual Cash Returned')}
                          value={driverActualCash}
                          onValueChange={setDriverActualCash}
                          placeholder={formatCurrency(amountToReturn)}
                          className="liquid-glass-modal-input pos-glass-field min-h-[44px] w-full text-2xl font-bold text-center"
                        />
                      </div>

                      {/* Variance Display */}
                      {driverActualCash !== '' && (() => {
                        const actual = parseMoneyInputValue(driverActualCash);
                        const variance = actual - amountToReturn;
                        const isOver = variance >= 0;
                        return (
                          <div className={`pos-glass-form-card flex justify-between items-center p-3! `}>
                            <span className={`text-sm font-medium ${isOver ? 'text-green-800 dark:text-green-200' : 'text-red-800 dark:text-red-200'}`}>
                              {isOver
                                ? t('modals.staffShift.driverOverage', 'Overage')
                                : t('modals.staffShift.driverShortage', 'Shortage')}
                            </span>
                            <span className={`text-lg font-bold ${isOver ? 'text-green-800 dark:text-green-300' : 'text-red-800 dark:text-red-300'}`}>
                              {isOver ? '+' : '-'}{formatCurrency(Math.abs(variance))}
                            </span>
                          </div>
                        );
                      })()}

                      {/* Formula Explanation */}
                      <div className="pos-glass-form-card mt-2 p-3!">
                        <p className="text-center text-xs liquid-glass-modal-text-muted">
                          <span className="font-semibold liquid-glass-modal-text">{t('receipt.formula.label')}</span>{' '}
                          {t('receipt.formula.driver')}
                        </p>
                      </div>

                      {/* Note: Driver payments are handled at cashier checkout */}
                      <div className="pos-glass-form-card mt-2 p-3!">
                        <p className="text-center text-xs liquid-glass-modal-text-muted">
                          {t('modals.staffShift.driverPaymentNote', 'Driver payment will be recorded when you return cash to the cashier')}
                        </p>
                      </div>
                    </div>
                  </div>
                );
              })()}
            </div>
          )
          }
          </div>

          {effectiveMode === 'checkout' && checkoutFooterData && (
            <div
              data-testid="staff-checkout-footer"
              className="absolute inset-x-0 bottom-0 z-20"
            >
              <div className="flex flex-col gap-3 px-6 pb-5 pt-2 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <div className="text-sm liquid-glass-modal-text-muted font-semibold">
                    {checkoutFooterData.label}
                  </div>
                  {!checkoutFooterData.minimal && (
                    <div className={`mt-1 text-2xl font-black ${checkoutFooterData.accentClass}`}>
                      {isCashierCheckoutRole ? formatDrawerCurrency(checkoutFooterData.amount) : formatCurrency(checkoutFooterData.amount)}
                    </div>
                  )}
                  <p className="mt-1 text-xs liquid-glass-modal-text-muted">
                    {checkoutFooterData.note}
                  </p>
                </div>

                <StaffShiftCheckoutFooterActions
                  onPrint={() => {
                    void handlePrintCheckout();
                  }}
                  onCheckout={() => {
                    console.log('🔴 BUTTON CLICKED!');
                    handleCheckOut();
                  }}
                  printLabel={t('common.actions.print', 'Print')}
                  checkoutLabel={
                    loading || giftBusy
                      ? t('modals.staffShift.closingShift')
                      : t('modals.staffShift.checkOut')
                  }
                  isPrinting={isPrintCheckoutLoading}
                  isPrintDisabled={loading || isPrintCheckoutLoading || !canPrintCheckoutSnapshot ||
                    giftCloseOwnsCheckout || giftCloseChecking}
                  isCheckoutLoading={loading || giftBusy}
                  isCheckoutDisabled={loading || isCheckoutAmountMissing || giftBusy || giftRecoveryTarget !== null ||
                    giftApproval !== null || (giftCloseOwnsCheckout && giftCheckout.kind !== 'ready')}
                />
              </div>
            </div>
          )}
        </div>
        {/* Large Payment Confirmation - Inline Replacement */}
        <AnimatePresence initial={false}>
        {(showPaymentConfirm) ? (
          <motion.div key="reveal-51-yes" {...revealMotion}
            className="pos-glass-form-card absolute inset-0 z-50 flex flex-col items-center justify-center p-6!"
            role="alertdialog"
            aria-labelledby="confirm-large-payment-title"
            aria-describedby="confirm-large-payment-desc"
          ><ShiftRevealContent>
            <div className="w-full max-w-md space-y-3 text-center">
              <AlertTriangle className="mx-auto h-12 w-12 text-yellow-500" />

              <div className="space-y-2">
                <h3 id="confirm-large-payment-title" className="text-2xl font-bold liquid-glass-modal-text">
                  {t('modals.staffShift.confirmLargePayment', 'Confirm Large Payment')}
                </h3>
                <p id="confirm-large-payment-desc" className="liquid-glass-modal-text-muted">
                  {t('modals.staffShift.largePaymentWarning', {
                    amount: formatCurrency(pendingPaymentAmount),
                    threshold: formatCurrency(LARGE_PAYMENT_THRESHOLD)
                  })}
                </p>
              </div>

              <div className="grid grid-cols-2 gap-4 pt-4">
                <button
                  onClick={handleCancelLargePayment}
                  className="pos-solid-btn pos-solid-btn--md"
                >
                  {t('common.cancel', 'Cancel')}
                </button>
                <button
                  onClick={handleConfirmLargePayment}
                  className="min-h-[44px] pos-raised pos-raised--yellow px-6 py-3 rounded-xl bg-yellow-400 font-bold text-black shadow-lg transition-all duration-200"
                  autoFocus
                >
                  {t('modals.staffShift.confirmPayment', 'Confirm Payment')}
                </button>
              </div>
            </div>
          </ShiftRevealContent></motion.div>
        ) : null}
        </AnimatePresence>
      </LiquidGlassModal >

      <ConfirmDialog
        {...confirmDialog}
        onClose={closeConfirm}
        isLoading={loading}
      />
      {recordCheckoutBlocker.confirmDialog}
      {checkoutRecordApprovalModal}
    </CashierRecovery>
  );
}

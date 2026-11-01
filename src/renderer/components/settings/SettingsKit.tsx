/**
 * Solid settings kit (UI audit wave 7, founder-approved 30/10/2026).
 *
 * One calm, opaque visual language for every settings screen: one solid yellow
 * primary action per screen, neutral secondary buttons with a 1px border, a
 * segmented control for 2-5 single choices, check rows for multi-select, a status
 * dot with a plain sentence, one "Settings for technicians" disclosure and a
 * footer that appears only when something changed. Touch only: no hover; press
 * feedback and focus rings come from the shared base-layer rule. Styles live in
 * styles/glassmorphism.css ("Solid settings kit").
 */
import React, { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '../../utils/cn';

// ---------- Buttons ----------
export type SolidButtonVariant = 'primary' | 'secondary' | 'danger';

/** Class names for a solid button: yellow primary, neutral secondary, red-text danger. */
export const solidButton = (variant: SolidButtonVariant = 'secondary', size: 'md' | 'sm' = 'md'): string =>
  cn(
    'pos-solid-btn',
    size === 'sm' ? 'pos-solid-btn--sm' : 'pos-solid-btn--md',
    variant === 'primary' && 'pos-solid-btn--primary',
    variant === 'danger' && 'pos-solid-btn--danger',
  );

// ---------- Groups and rows ----------
interface SettingsGroupProps {
  title?: React.ReactNode;
  description?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  id?: string;
  'data-testid'?: string;
}

export const SettingsGroup: React.FC<SettingsGroupProps> = ({ title, description, children, className, id, ...rest }) => (
  <section id={id} className={cn('pos-group', className)} data-testid={rest['data-testid']}>
    {(title || description) && (
      <header className="pos-group__head">
        {title && <h3 className="pos-group__title">{title}</h3>}
        {description && <p className="pos-group__desc">{description}</p>}
      </header>
    )}
    {children}
  </section>
);

interface SettingsRowProps {
  title: React.ReactNode;
  help?: React.ReactNode;
  control?: React.ReactNode;
  /** Id of the control the title labels (for inputs and selects). */
  htmlFor?: string;
  className?: string;
  'data-testid'?: string;
}

export const SettingsRow: React.FC<SettingsRowProps> = ({ title, help, control, htmlFor, className, ...rest }) => (
  <div className={cn('pos-row', className)} data-testid={rest['data-testid']}>
    <div className="pos-row__label">
      {htmlFor ? <label htmlFor={htmlFor} className="pos-row__title">{title}</label> : <span className="pos-row__title">{title}</span>}
      {help && <span className="pos-row__help">{help}</span>}
    </div>
    {control && <div className="pos-row__control">{control}</div>}
  </div>
);

// ---------- Segmented control (one choice of 2-5) ----------
export interface SegmentedOption<T extends string> {
  value: T;
  label: React.ReactNode;
  disabled?: boolean;
  /** Language of the label (a language shown in its own name). */
  lang?: string;
  /** Accessible name when the visible label alone is not enough. */
  ariaLabel?: string;
}

interface SegmentedControlProps<T extends string> {
  value: T | null | undefined;
  options: ReadonlyArray<SegmentedOption<T>>;
  onChange: (value: T) => void;
  ariaLabel: string;
  disabled?: boolean;
  /** Lay the options out in a grid of this many columns (for 6+ choices). */
  columns?: number;
  className?: string;
  'data-testid'?: string;
}

export function SegmentedControl<T extends string>({ value, options, onChange, ariaLabel, disabled, columns, className, ...rest }: SegmentedControlProps<T>) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const move = (from: number, step: number) => {
    for (let i = 1; i <= options.length; i++) {
      const next = (from + step * i + options.length) % options.length;
      if (!options[next].disabled) {
        refs.current[next]?.focus();
        onChange(options[next].value);
        return;
      }
    }
  };
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      aria-disabled={disabled || undefined}
      className={cn('pos-seg', columns ? 'pos-seg--grid' : undefined, className)}
      style={columns ? ({ '--pos-seg-cols': columns } as React.CSSProperties) : undefined}
      data-testid={rest['data-testid']}
    >
      {options.map((option, index) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            ref={el => { refs.current[index] = el; }}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={option.ariaLabel}
            lang={option.lang}
            tabIndex={selected || (value == null && index === 0) ? 0 : -1}
            disabled={disabled || option.disabled}
            className={cn('pos-seg__opt', selected && 'is-selected')}
            onClick={() => onChange(option.value)}
            onKeyDown={event => {
              if (event.key === 'ArrowRight' || event.key === 'ArrowDown') { event.preventDefault(); move(index, 1); }
              if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') { event.preventDefault(); move(index, -1); }
            }}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

// ---------- Check rows (several choices together) ----------
export interface CheckRowItem<T extends string> {
  value: T;
  label: React.ReactNode;
  hint?: React.ReactNode;
  disabled?: boolean;
}

interface CheckRowsProps<T extends string> {
  items: ReadonlyArray<CheckRowItem<T>>;
  selected: ReadonlyArray<T>;
  onToggle: (value: T, checked: boolean) => void;
  ariaLabel: string;
  className?: string;
  'data-testid'?: string;
}

export function CheckRows<T extends string>({ items, selected, onToggle, ariaLabel, className, ...rest }: CheckRowsProps<T>) {
  return (
    <div role="group" aria-label={ariaLabel} className={cn('pos-checks', className)} data-testid={rest['data-testid']}>
      {items.map(item => {
        const checked = selected.includes(item.value);
        return (
          <button
            key={item.value}
            type="button"
            role="checkbox"
            aria-checked={checked}
            disabled={item.disabled}
            className={cn('pos-check', checked && 'is-checked')}
            onClick={() => onToggle(item.value, !checked)}
          >
            <span className="pos-check__box" aria-hidden="true" />
            <span className="pos-check__label">{item.label}</span>
            {item.hint && <span className="pos-check__hint">{item.hint}</span>}
          </button>
        );
      })}
    </div>
  );
}

// ---------- Status line: a coloured dot and a plain sentence ----------
export type StatusTone = 'ok' | 'warn' | 'bad' | 'idle';

export const StatusLine: React.FC<{ tone: StatusTone; children: React.ReactNode; className?: string; role?: string }> = ({ tone, children, className, role }) => (
  <span className={cn('pos-status', `pos-status--${tone}`, className)} role={role}>
    <span className="pos-status__dot" aria-hidden="true" />
    <span>{children}</span>
  </span>
);

// ---------- One disclosure for technical settings ----------
interface TechDisclosureProps {
  title: React.ReactNode;
  children: React.ReactNode;
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  className?: string;
  'data-testid'?: string;
}

export const TechDisclosure: React.FC<TechDisclosureProps> = ({ title, children, defaultOpen = false, open, onOpenChange, className, ...rest }) => {
  const [innerOpen, setInnerOpen] = useState(defaultOpen);
  const isOpen = open ?? innerOpen;
  const regionId = useId();
  const toggle = () => {
    const next = !isOpen;
    if (open === undefined) setInnerOpen(next);
    onOpenChange?.(next);
  };
  return (
    <div className={cn('pos-disclosure', isOpen && 'is-open', className)} data-testid={rest['data-testid']}>
      <button type="button" className="pos-disclosure__toggle" aria-expanded={isOpen} aria-controls={regionId} onClick={toggle}>
        <span>{title}</span>
        <ChevronDown className="pos-disclosure__chevron" aria-hidden="true" />
      </button>
      {isOpen && <div id={regionId} className="pos-disclosure__body">{children}</div>}
    </div>
  );
};

// ---------- Footer that appears only when something changed ----------
interface DirtyFooterProps {
  visible: boolean;
  note?: React.ReactNode;
  saveLabel: React.ReactNode;
  cancelLabel: React.ReactNode;
  onSave: () => void;
  onCancel: () => void;
  saving?: boolean;
  saveDisabled?: boolean;
  /** Extra secondary actions placed before Cancel (for example a test print). */
  extra?: React.ReactNode;
  className?: string;
}

export const DirtyFooter: React.FC<DirtyFooterProps> = ({ visible, note, saveLabel, cancelLabel, onSave, onCancel, saving, saveDisabled, extra, className }) => {
  if (!visible) return null;
  return (
    <div className={cn('pos-dirty-foot', className)} data-dirty-footer>
      <span className="pos-dirty-foot__note">{note}</span>
      <div className="pos-dirty-foot__actions">
        {extra}
        <button type="button" className={solidButton('secondary')} onClick={onCancel} disabled={saving}>{cancelLabel}</button>
        <button type="button" className={solidButton('primary')} onClick={onSave} disabled={saving || saveDisabled} aria-busy={saving || undefined}>{saveLabel}</button>
      </div>
    </div>
  );
};

// ---------- Unsaved drafts: sections report, the settings shell guards closing ----------
type DirtyReporter = (key: string, dirty: boolean) => void;

const SettingsDirtyContext = createContext<DirtyReporter | null>(null);

/** Holds which settings drafts are unsaved, so the shell can ask before closing. */
export function useSettingsDirtyRegistry() {
  const [sources, setSources] = useState<Record<string, boolean>>({});
  const report = useCallback<DirtyReporter>((key, dirty) => {
    setSources(prev => (Boolean(prev[key]) === dirty ? prev : { ...prev, [key]: dirty }));
  }, []);
  const clear = useCallback(() => setSources({}), []);
  const anyDirty = useMemo(() => Object.values(sources).some(Boolean), [sources]);
  return { anyDirty, report, clear, sources };
}

export const SettingsDirtyProvider: React.FC<{ report: DirtyReporter; children: React.ReactNode }> = ({ report, children }) => (
  <SettingsDirtyContext.Provider value={report}>{children}</SettingsDirtyContext.Provider>
);

/** A settings section reports whether its draft is unsaved; it stops reporting when it unmounts. */
export function useReportSettingsDirty(key: string, dirty: boolean) {
  const report = useContext(SettingsDirtyContext);
  useEffect(() => {
    report?.(key, dirty);
  }, [report, key, dirty]);
  useEffect(() => () => report?.(key, false), [report, key]);
}

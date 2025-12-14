/**
 * Design System Utilities for POS System
 *
 * ⚠️ DEPRECATION NOTICE:
 * Modal structure functions (modalBackdrop, modalShell, modalHeaderBar, modalHeaderTitle, closeButton)
 * are deprecated and will be removed in a future version.
 *
 * Please use the new LiquidGlassModal component instead:
 * import { LiquidGlassModal } from '../components/ui/pos-glass-components';
 *
 * Migration Guide: See docs/development/POS_COMPONENT_LIBRARY.md
 *
 * Content-level utilities (sectionTitle, inputBase, liquidGlassModalButton, etc.) remain supported.
 */

// Centralized design tokens and helpers for consistent theming across the renderer
// Light/Dark decided by theme-context's resolvedTheme ('light' | 'dark')

export type ResolvedTheme = 'light' | 'dark' | string;

/**
 * @deprecated Use LiquidGlassModal component instead.
 * This function will be removed in v2.0.0.
 *
 * Migration:
 * ```tsx
 * // Old:
 * <div className={modalBackdrop}>...</div>
 *
 * // New:
 * <LiquidGlassModal isOpen={isOpen} onClose={onClose} title="Title">
 *   {children}
 * </LiquidGlassModal>
 * ```
 *
 * @see {@link ../components/ui/pos-glass-components.tsx#LiquidGlassModal}
 */
export const modalBackdrop = 'fixed inset-0 liquid-glass-modal-backdrop';

/**
 * @deprecated Use LiquidGlassModal component instead.
 * This function will be removed in v2.0.0.
 *
 * The new LiquidGlassModal component handles shell styling automatically
 * and provides enhanced features:
 * - Focus trap with keyboard navigation
 * - Smooth animations
 * - Automatic theme awareness
 * - Accessibility (ARIA attributes, role="dialog")
 * - Size variants: 'sm' | 'md' | 'lg' | 'xl' | 'full'
 *
 * Migration:
 * ```tsx
 * // Old:
 * <div className={modalShell(resolvedTheme, 'max-w-lg')}>...</div>
 *
 * // New:
 * <LiquidGlassModal size="md" className="max-w-lg">...</LiquidGlassModal>
 * ```
 *
 * @see {@link ../components/ui/pos-glass-components.tsx#LiquidGlassModal}
 */
export const modalShell = (
  theme: ResolvedTheme,
  extra = ''
) => `liquid-glass-modal-shell ${extra}`.trim();

/**
 * @deprecated Use LiquidGlassModal's built-in title prop instead.
 * This function will be removed in v2.0.0.
 *
 * Migration:
 * ```tsx
 * // Old:
 * <h2 className={modalHeaderTitle(resolvedTheme)}>Title</h2>
 *
 * // New:
 * <LiquidGlassModal title="Title">...</LiquidGlassModal>
 * ```
 *
 * The title prop automatically handles styling and accessibility (aria-labelledby).
 *
 * @see {@link ../components/ui/pos-glass-components.tsx#LiquidGlassModal}
 */
export const modalHeaderTitle = (theme: ResolvedTheme, extra = '') =>
  `text-xl font-bold liquid-glass-modal-text ${extra}`.trim();

/**
 * @deprecated Use LiquidGlassModal component instead.
 * This function will be removed in v2.0.0.
 *
 * The new LiquidGlassModal component automatically renders a header with title
 * and close button when the title prop is provided.
 *
 * Migration:
 * ```tsx
 * // Old:
 * <div className={modalHeaderBar}>
 *   <h2 className={modalHeaderTitle(theme)}>Title</h2>
 *   <button className={closeButton(theme)} onClick={onClose}>X</button>
 * </div>
 *
 * // New:
 * <LiquidGlassModal title="Title" onClose={onClose}>...</LiquidGlassModal>
 * ```
 *
 * @see {@link ../components/ui/pos-glass-components.tsx#LiquidGlassModal}
 */
export const modalHeaderBar = 'flex items-center justify-between p-6 border-b liquid-glass-modal-border';

/**
 * @deprecated Use LiquidGlassModal component instead.
 * This function will be removed in v2.0.0.
 *
 * The new LiquidGlassModal component automatically renders a close button
 * in the header when the title prop is provided.
 *
 * Migration:
 * ```tsx
 * // Old:
 * <button className={closeButton(resolvedTheme)} onClick={onClose}>
 *   <X size={18} />
 * </button>
 *
 * // New:
 * <LiquidGlassModal onClose={onClose}>...</LiquidGlassModal>
 * ```
 *
 * The close button is automatically styled, accessible (aria-label),
 * and supports keyboard navigation (Escape key).
 *
 * @see {@link ../components/ui/pos-glass-components.tsx#LiquidGlassModal}
 */
export const closeButton = (theme: ResolvedTheme, size: 'md' | 'lg' = 'md') => {
  const base = 'rounded-full flex items-center justify-center transition-all duration-200 hover:bg-white/10 dark:hover:bg-black/10 liquid-glass-modal-text';
  const dim = size === 'lg' ? 'w-10 h-10' : 'w-8 h-8';
  return `${base} ${dim}`;
};

// ============================================================================
// Content-Level Utilities (SUPPORTED)
// ============================================================================
// The following utilities are still supported and recommended for styling
// content within modals and other components.
// ============================================================================

/**
 * Section title styling for modal content.
 *
 * @param theme - Current theme ('light' | 'dark')
 * @returns CSS class string for section titles
 *
 * @example
 * ```tsx
 * <h3 className={sectionTitle(resolvedTheme)}>Customer Information</h3>
 * ```
 */
export const sectionTitle = (theme: ResolvedTheme) =>
  `text-lg font-semibold liquid-glass-modal-text`;

/**
 * Subtle text styling for descriptions and help text.
 *
 * @param theme - Current theme ('light' | 'dark')
 * @returns CSS class string for subtle text
 *
 * @example
 * ```tsx
 * <p className={sectionSubtle(resolvedTheme)}>Enter customer details below</p>
 * ```
 */
export const sectionSubtle = (theme: ResolvedTheme) =>
  `text-sm liquid-glass-modal-text-muted`;

/**
 * Base input styling with liquid glass effect.
 *
 * @param theme - Current theme ('light' | 'dark')
 * @returns CSS class string for input elements
 *
 * @example
 * ```tsx
 * <input
 *   type="text"
 *   className={inputBase(resolvedTheme)}
 *   placeholder="Enter name"
 * />
 * ```
 *
 * @see {@link ../components/ui/pos-glass-components.tsx#POSGlassInput} for a React component alternative
 */
export const inputBase = (theme: ResolvedTheme) =>
  `liquid-glass-modal-input w-full px-3 py-3 rounded-xl border focus:outline-none focus:ring-2 focus:ring-blue-500/40 transition-all`;

/**
 * Button styling with liquid glass effect.
 *
 * @param variant - Button style variant ('primary' | 'secondary')
 * @param size - Button size ('sm' | 'md' | 'lg')
 * @returns CSS class string for button elements
 *
 * @example
 * ```tsx
 * <button className={liquidGlassModalButton('primary', 'lg')}>
 *   Save Changes
 * </button>
 * ```
 *
 * @see {@link ../components/ui/pos-glass-components.tsx#POSGlassButton} for a React component alternative
 */
export const liquidGlassModalButton = (variant = 'primary', size: 'sm' | 'md' | 'lg' = 'md') => {
  const base = 'rounded-xl font-medium transition-all duration-200';
  let sizeCls = 'px-4 py-2'; // default md
  if (size === 'sm') sizeCls = 'px-3 py-1.5';
  else if (size === 'lg') sizeCls = 'px-6 py-3';
  const variantCls = variant === 'primary' ? 'bg-blue-500 hover:bg-blue-600 text-white' : 'bg-gray-500/20 hover:bg-gray-500/30 liquid-glass-modal-text';
  return `${base} ${sizeCls} ${variantCls}`;
};

/**
 * Card container styling with liquid glass effect.
 *
 * @returns CSS class string for card containers
 *
 * @example
 * ```tsx
 * <div className={liquidGlassModalCard()}>
 *   <h4>Card Title</h4>
 *   <p>Card content</p>
 * </div>
 * ```
 *
 * @see {@link ../components/ui/pos-glass-components.tsx#POSGlassCard} for a React component alternative
 */
export const liquidGlassModalCard = () => 'bg-white/10 dark:bg-gray-800/20 backdrop-blur-sm border liquid-glass-modal-border rounded-xl p-4';

/**
 * Badge styling with liquid glass effect.
 *
 * @param variant - Badge style variant ('default' | 'success')
 * @returns CSS class string for badge elements
 *
 * @example
 * ```tsx
 * <span className={liquidGlassModalBadge('success')}>Active</span>
 * ```
 *
 * @see {@link ../components/ui/pos-glass-components.tsx#POSGlassBadge} for a React component alternative
 */
export const liquidGlassModalBadge = (variant = 'default') => {
  const base = 'px-2 py-1 rounded-full text-xs font-medium';
  const variantCls = variant === 'success' ? 'bg-green-500/20 text-green-600 dark:text-green-400' : 'bg-gray-500/20 liquid-glass-modal-text';
  return `${base} ${variantCls}`;
};

// Export CSS class names for direct use

/**
 * Direct CSS class name for primary text in liquid glass modals.
 * Use this for consistent text styling across modal content.
 */
export const liquidGlassModalText = 'liquid-glass-modal-text';

/**
 * Direct CSS class name for muted/secondary text in liquid glass modals.
 * Use this for descriptions, help text, and less prominent content.
 */
export const liquidGlassModalTextMuted = 'liquid-glass-modal-text-muted';

/**
 * Direct CSS class name for borders in liquid glass modals.
 * Use this for consistent border styling across modal elements.
 */
export const liquidGlassModalBorder = 'liquid-glass-modal-border';

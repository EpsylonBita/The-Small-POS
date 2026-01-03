'use client'

import React from 'react'
import { cn } from '../../utils/cn'
import { useI18n } from '../../contexts/i18n-context'

// Import the glassmorphism CSS
import '../../styles/glassmorphism.css'

// Note: cn utility function is imported above

// POS Glass Card Component - Optimized for touch
interface POSGlassCardProps extends React.HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode
  variant?: 'primary' | 'secondary' | 'success' | 'warning' | 'error' | 'info' | 'pending' | 'preparing' | 'ready'
  size?: 'compact' | 'default' | 'large'
  className?: string
  onClick?: (e: React.MouseEvent<HTMLDivElement>) => void
  isSelected?: boolean
  isLoading?: boolean
}

export const POSGlassCard = React.forwardRef<HTMLDivElement, POSGlassCardProps>(
  ({
    children,
    variant = 'primary',
    size = 'default',
    className = '',
    onClick,
    isSelected = false,
    isLoading = false,
    ...props
  }, ref) => {
    const baseClasses = 'liquid-glass-modal-card'
    const variantClass = `liquid-glass-modal-${variant}`
    const interactiveClass = onClick ? 'pos-glass-interactive' : ''
    const selectedClass = isSelected ? 'ring-2 ring-blue-400 ring-opacity-50' : ''
    const loadingClass = isLoading ? 'animate-pulse' : ''
    const sizeClasses = {
      compact: 'p-3',
      default: 'p-4',
      large: 'p-6'
    }

    const combinedClasses = cn(
      baseClasses,
      variantClass,
      interactiveClass,
      selectedClass,
      loadingClass,
      sizeClasses[size],
      className
    )

    return (
      <div
        ref={ref}
        className={combinedClasses}
        onClick={onClick}
        role={onClick ? 'button' : undefined}
        tabIndex={onClick ? 0 : undefined}
        onKeyDown={
          onClick
            ? e => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                onClick(e as unknown as React.MouseEvent<HTMLDivElement>)
              }
            }
            : undefined
        }
        {...props}
      >
        {isLoading && (
          <div className="absolute inset-0 flex items-center justify-center bg-white bg-opacity-20 rounded-inherit">
            <div className="w-6 h-6 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
          </div>
        )}
        {children}
      </div>
    )
  }
)

POSGlassCard.displayName = 'POSGlassCard'

// POS Glass Button Component - Touch-optimized
interface POSGlassButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  children: React.ReactNode
  variant?: 'primary' | 'secondary' | 'success' | 'warning' | 'error' | 'info'
  size?: 'default' | 'large' | 'xl'
  loading?: boolean
  className?: string
  icon?: React.ReactNode
  fullWidth?: boolean
}

export const POSGlassButton = React.forwardRef<HTMLButtonElement, POSGlassButtonProps>(
  (
    {
      children,
      variant = 'primary',
      size = 'default',
      disabled = false,
      loading = false,
      className = '',
      icon,
      fullWidth = false,
      ...props
    },
    ref
  ) => {
    const baseClasses = 'liquid-glass-modal-button'
    const variantClass = variant !== 'primary' ? `liquid-glass-modal-${variant}` : ''
    const sizeClasses = {
      default: 'liquid-glass-modal-button',
      large: 'liquid-glass-modal-button-large',
      xl: 'liquid-glass-modal-button-xl'
    }
    const widthClass = fullWidth ? 'w-full' : ''

    const combinedClasses = cn(
      sizeClasses[size],
      variantClass,
      widthClass,
      className
    )

    return (
      <button
        ref={ref}
        className={combinedClasses}
        disabled={disabled || loading}
        aria-disabled={disabled || loading}
        {...props}
      >
        {loading && (
          <div className="w-5 h-5 border-2 border-current border-t-transparent rounded-full animate-spin"></div>
        )}
        {!loading && icon && <span className="flex-shrink-0">{icon}</span>}
        <span className={cn("flex-1", (icon && !loading) ? "ml-2" : undefined)}>{children}</span>
      </button>
    )
  }
)

POSGlassButton.displayName = 'POSGlassButton'

// POS Glass Input Component - Touch-friendly
interface POSGlassInputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  className?: string
  label?: string
  error?: string
  icon?: React.ReactNode
}

export const POSGlassInput = React.forwardRef<HTMLInputElement, POSGlassInputProps>(
  ({ className = '', label, error, icon, ...props }, ref) => {
    return (
      <div className="space-y-2">
        {label && (
          <label className="block text-sm font-medium pos-glass-text-primary">
            {label}
          </label>
        )}
        <div className="relative">
          {icon && (
            <div className="absolute left-3 top-1/2 transform -translate-y-1/2 pos-glass-text-muted">
              {icon}
            </div>
          )}
          <input
            ref={ref}
            className={cn(
              'liquid-glass-modal-input',
              icon ? 'pl-10' : undefined,
              error ? 'border-red-500 focus:border-red-500' : undefined,
              className
            )}
            {...props}
          />
        </div>
        {error && (
          <p className="text-sm text-red-600">{error}</p>
        )}
      </div>
    )
  }
)

POSGlassInput.displayName = 'POSGlassInput'

// POS Glass PIN Input Component - Specialized for PIN entry
interface POSGlassPINInputProps {
  value: string
  onChange: (value: string) => void
  length?: number
  className?: string
  disabled?: boolean
}

export const POSGlassPINInput: React.FC<POSGlassPINInputProps> = ({
  value,
  onChange,
  length = 4,
  className = '',
  disabled = false
}) => {
  const inputRefs = React.useRef<(HTMLInputElement | null)[]>([])

  const handleChange = (index: number, inputValue: string) => {
    if (inputValue.length > 1) return

    const newValue = value.split('')
    newValue[index] = inputValue

    const finalValue = newValue.join('').slice(0, length)
    onChange(finalValue)

    // Move to next input
    if (inputValue && index < length - 1) {
      inputRefs.current[index + 1]?.focus()
    }
  }

  const handleKeyDown = (index: number, e: React.KeyboardEvent) => {
    if (e.key === 'Backspace' && !value[index] && index > 0) {
      inputRefs.current[index - 1]?.focus()
    }
  }

  return (
    <div className={cn("flex gap-3 justify-center", className)}>
      {Array.from({ length }, (_, index) => (
        <input
          key={index}
          ref={el => { inputRefs.current[index] = el }}
          type="tel"
          maxLength={1}
          value={value[index] || ''}
          onChange={e => handleChange(index, e.target.value)}
          onKeyDown={e => handleKeyDown(index, e)}
          className="liquid-glass-modal-input text-center"
          disabled={disabled}
          inputMode="numeric"
          pattern="[0-9]*"
        />
      ))}
    </div>
  )
}

// POS Glass Modal Component - Touch-optimized
interface POSGlassModalProps {
  isOpen: boolean
  onClose: () => void
  title?: string
  children: React.ReactNode
  className?: string
  size?: 'sm' | 'md' | 'lg' | 'xl' | 'full'
  closeOnBackdrop?: boolean
}

export const POSGlassModal: React.FC<POSGlassModalProps> = ({
  isOpen,
  onClose,
  title,
  children,
  className = '',
  size = 'md',
  closeOnBackdrop = true
}) => {
  const { t } = useI18n();
  const previousOverflowRef = React.useRef<string>('');

  // Handle escape key
  React.useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        onClose()
      }
    }

    if (isOpen) {
      document.addEventListener('keydown', handleEscape)
      // Store previous overflow value and prevent body scroll when modal is open
      previousOverflowRef.current = document.body.style.overflow
      document.body.style.overflow = 'hidden'
    }

    return () => {
      document.removeEventListener('keydown', handleEscape)
      // Restore previous overflow value
      document.body.style.overflow = previousOverflowRef.current
    }
  }, [isOpen, onClose])

  if (!isOpen) return null

  const sizeClasses = {
    sm: 'max-w-lg', // Increased from md
    md: 'max-w-2xl', // Increased from lg
    lg: 'max-w-4xl', // Increased from 2xl
    xl: 'max-w-6xl', // Increased from 4xl
    full: 'max-w-[96vw] max-h-[92vh]' // Slightly larger
  }

  return (
    <>
      <div
        className="liquid-glass-modal-backdrop"
        onClick={closeOnBackdrop ? onClose : undefined}
        aria-hidden="true"
      />

      <div
        className={cn('liquid-glass-modal-shell p-6', sizeClasses[size], className)}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? 'modal-title' : undefined}
      >
        {title && (
          <div className="flex items-center justify-between mb-4">
            <h2 id="modal-title" className="text-2xl font-bold pos-glass-text-primary">
              {title}
            </h2>
            <button
              onClick={onClose}
              className="liquid-glass-modal-button p-2 min-h-0 min-w-0"
              aria-label={t('common.actions.close')}
            >
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        )}
        {children}
      </div>
    </>
  )
}

/**
 * LiquidGlassModal - Enhanced modal component with liquid glass effects and full accessibility
 * 
 * A modern modal component featuring:
 * - Liquid glassmorphism design with advanced blur and saturation effects
 * - Automatic focus trap with keyboard navigation (Tab/Shift+Tab, Escape)
 * - Smooth enter/exit animations
 * - Theme-aware styling (responds to light/dark theme automatically)
 * - Full accessibility support (ARIA attributes, role="dialog", focus management)
 * - Body scroll lock when open
 * - Configurable backdrop and escape key behavior
 * 
 * @component
 * @example
 * ```tsx
 * import { LiquidGlassModal } from './pos-glass-components';
 * 
 * function MyComponent() {
 *   const [isOpen, setIsOpen] = useState(false);
 * 
 *   return (
 *     <>
 *       <button onClick={() => setIsOpen(true)}>Open Modal</button>
 *       
 *       <LiquidGlassModal
 *         isOpen={isOpen}
 *         onClose={() => setIsOpen(false)}
 *         title={t('examples.customerDetails')}
 *         size="md"
 *         closeOnBackdrop={true}
 *         closeOnEscape={true}
 *       >
 *         <div className="space-y-4">
 *           <p>Modal content goes here</p>
 *           <button onClick={() => setIsOpen(false)}>Close</button>
 *         </div>
 *       </LiquidGlassModal>
 *     </>
 *   );
 * }
 * ```
 * 
 * @example
 * ```tsx
 * // Modal without title (custom header)
 * <LiquidGlassModal isOpen={isOpen} onClose={onClose}>
 *   <div className="mb-6">
 *     <h2 className="text-2xl font-bold">Custom Header</h2>
 *     <p className="text-sm text-gray-500">With subtitle</p>
 *   </div>
 *   <div>Content...</div>
 * </LiquidGlassModal>
 * ```
 * 
 * @example
 * ```tsx
 * // Large modal with custom styling
 * <LiquidGlassModal
 *   isOpen={isOpen}
 *   onClose={onClose}
 *   title={t('examples.orderDetails')}
 *   size="xl"
 *   className="max-h-[90vh]"
 *   closeOnBackdrop={false}
 * >
 *   <div className="overflow-y-auto">
 *     [Scrollable content]
 *   </div>
 * </LiquidGlassModal>
 * ```
 * 
 * @see {@link https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/} ARIA Dialog Pattern
 * @see {@link ../../styles/glassmorphism.css} Liquid Glass CSS Styles
 */
/**
 * Props for the LiquidGlassModal component
 */
interface LiquidGlassModalProps {
  /**
   * Controls the visibility of the modal
   * @required
   */
  isOpen: boolean;

  /**
   * Callback function called when the modal should close
   * Triggered by:
   * - Escape key press (if closeOnEscape is true)
   * - Backdrop click (if closeOnBackdrop is true)
   * - Close button click (if title is provided)
   * @required
   */
  onClose: () => void;

  /**
   * Modal title displayed in the header
   * When provided, automatically renders a header with title and close button
   * When omitted, no header is rendered (use for custom headers)
   * @optional
   */
  title?: string;

  /**
   * Modal content
   * @required
   */
  children: React.ReactNode;

  /**
   * Additional CSS classes applied to the modal shell
   * Useful for custom sizing, positioning, or styling
   * @optional
   * @example className="max-h-[90vh] overflow-y-auto"
   */
  className?: string;

  /**
   * Modal size variant
   * - 'sm': max-w-md (small forms, confirmations)
   * - 'md': max-w-lg (standard forms) [default]
   * - 'lg': max-w-2xl (complex forms, lists)
   * - 'xl': max-w-4xl (wide tables, grids)
   * - 'full': max-w-[95vw] max-h-[95vh] (full-screen experiences)
   * @optional
   * @default 'md'
   */
  size?: 'sm' | 'md' | 'lg' | 'xl' | 'full';

  /**
   * Whether clicking the backdrop (outside the modal) closes the modal
   * Set to false for critical flows (payments, data entry) to prevent accidental closes
   * @optional
   * @default true
   */
  closeOnBackdrop?: boolean;

  /**
   * Whether pressing the Escape key closes the modal
   * Set to false during processing states to prevent interruption
   * @optional
   * @default true
   */
  closeOnEscape?: boolean;
}

// Helper function to get focusable elements
const getFocusableElements = (container: HTMLElement): HTMLElement[] => {
  const selectors = [
    'button:not([disabled])',
    'a[href]',
    'input:not([disabled])',
    'textarea:not([disabled])',
    'select:not([disabled])',
    '[tabindex]:not([tabindex="-1"])'
  ]

  const elements = container.querySelectorAll(selectors.join(', '))

  // Filter to only visible elements
  return Array.from(elements).filter(
    (el) => (el as HTMLElement).offsetParent !== null
  ) as HTMLElement[]
}

export const LiquidGlassModal: React.FC<LiquidGlassModalProps> = ({
  isOpen,
  onClose,
  title,
  children,
  className = '',
  size = 'md',
  closeOnBackdrop = true,
  closeOnEscape = true
}) => {
  const { t } = useI18n()
  const containerRef = React.useRef<HTMLDivElement>(null)
  const backdropRef = React.useRef<HTMLDivElement>(null)
  const previousActiveElementRef = React.useRef<HTMLElement | null>(null)
  const previousOverflowRef = React.useRef<string>('')
  const externalClosingRef = React.useRef<boolean>(false)

  // Internal state for closing animation
  const [isClosing, setIsClosing] = React.useState(false)
  const [mounted, setMounted] = React.useState(false)

  // Handle close with animation
  const handleClose = React.useCallback(() => {
    setIsClosing(true)
  }, [])

  // Handle animation end
  const handleAnimationEnd = React.useCallback(() => {
    if (isClosing) {
      if (externalClosingRef.current) {
        // Parent-driven closure - don't call onClose
        externalClosingRef.current = false
        setIsClosing(false)
        setMounted(false)
      } else {
        // User-initiated close - call onClose after unmount
        setIsClosing(false)
        setMounted(false)
        onClose()
      }
    }
  }, [isClosing, onClose])

  // Sync mounted state with isOpen
  React.useEffect(() => {
    if (isOpen) {
      setMounted(true)
      setIsClosing(false)
    }
  }, [isOpen])

  // Handle external isOpen changes (parent-driven closure)
  React.useEffect(() => {
    if (!isOpen && mounted && !isClosing) {
      externalClosingRef.current = true
      setIsClosing(true)
    }
  }, [isOpen, mounted, isClosing])

  // Focus management and keyboard navigation
  React.useEffect(() => {
    if (mounted && !isClosing) {
      // Store currently focused element
      previousActiveElementRef.current = document.activeElement as HTMLElement

      // Store current overflow value
      previousOverflowRef.current = document.body.style.overflow

      // Focus first focusable element after a brief delay
      const focusTimer = setTimeout(() => {
        if (containerRef.current) {
          const focusableElements = getFocusableElements(containerRef.current)
          if (focusableElements.length > 0) {
            focusableElements[0]?.focus()
          } else {
            containerRef.current?.focus()
          }
        }
      }, 50)

      // Handle Escape key
      const handleEscape = (e: KeyboardEvent) => {
        if (e.key === 'Escape' && closeOnEscape) {
          handleClose()
        }
      }

      // Handle Tab key for focus trap on document
      const handleTabKey = (e: KeyboardEvent) => {
        if (e.key !== 'Tab') return

        if (!containerRef.current) return

        const focusableElements = getFocusableElements(containerRef.current)
        if (focusableElements.length === 0) return

        const firstElement = focusableElements[0]
        const lastElement = focusableElements[focusableElements.length - 1]
        const activeElement = document.activeElement

        // Shift+Tab on first element: focus last element
        if (e.shiftKey && activeElement === firstElement) {
          e.preventDefault()
          lastElement?.focus()
        }
        // Tab on last element: focus first element
        else if (!e.shiftKey && activeElement === lastElement) {
          e.preventDefault()
          firstElement?.focus()
        }
      }

      // Handle focusin to redirect focus back to modal if it escapes
      const handleFocusIn = (e: FocusEvent) => {
        const target = e.target as Node;

        // Don't trap focus if target is in another modal (nested modals)
        const isInAnotherModal = target instanceof Element &&
          target.closest('[role="dialog"]') &&
          !containerRef.current?.contains(target);

        if (isInAnotherModal) {
          return; // Let the nested modal handle its own focus
        }

        if (!containerRef.current?.contains(target)) {
          e.preventDefault();
          e.stopPropagation();

          const focusableElements = getFocusableElements(containerRef.current!)
          if (focusableElements.length > 0) {
            focusableElements[0]?.focus()
          } else {
            containerRef.current?.focus()
          }
        }
      }

      // Add event listeners
      document.addEventListener('keydown', handleEscape)
      document.addEventListener('keydown', handleTabKey)
      document.addEventListener('focusin', handleFocusIn)

      // Set body scroll lock
      document.body.style.overflow = 'hidden'

      return () => {
        clearTimeout(focusTimer)
        document.removeEventListener('keydown', handleEscape)
        document.removeEventListener('keydown', handleTabKey)
        document.removeEventListener('focusin', handleFocusIn)
        document.body.style.overflow = previousOverflowRef.current
      }
    } else if (!mounted) {
      // Restore focus to previous element
      previousActiveElementRef.current?.focus()
    }
  }, [mounted, isClosing, closeOnEscape, handleClose])

  // Early return if not mounted
  if (!mounted) return null

  // Size classes mapping - Larger modals for better UX
  const sizeClasses = {
    sm: 'max-w-lg', // Increased from md
    md: 'max-w-2xl', // Increased from lg
    lg: 'max-w-4xl', // Increased from 2xl
    xl: 'max-w-6xl', // Increased from 4xl
    full: 'max-w-[96vw] max-h-[92vh]' // Slightly larger
  }

  return (
    <>
      {/* Backdrop */}
      <div
        ref={backdropRef}
        className={cn('liquid-glass-modal-backdrop', isClosing && 'leaving')}
        onClick={closeOnBackdrop ? handleClose : undefined}
        onAnimationEnd={handleAnimationEnd}
        aria-hidden="true"
      />

      {/* Modal container */}
      <div
        ref={containerRef}
        className={cn('liquid-glass-modal-shell flex flex-col', sizeClasses[size], isClosing && 'leaving', className)}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? 'liquid-glass-modal-title' : undefined}
        tabIndex={-1}
        onAnimationEnd={handleAnimationEnd}
      >
        {/* Title section - fixed at top */}
        {/* Title section - fixed at top */}
        {title && (
          <div className="liquid-glass-modal-header">
            <h2
              id="liquid-glass-modal-title"
              className="liquid-glass-modal-title"
            >
              {title}
            </h2>
            <button
              onClick={handleClose}
              className="liquid-glass-modal-close"
              aria-label={t('common.actions.close')}
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        )}

        {/* Content wrapper with scroll - prevent horizontal overflow from button hover effects */}
        <div className={cn("liquid-glass-modal-content scrollbar-hide overflow-x-hidden", !title && "pt-8")}>
          {/* Children content */}
          {children}
        </div>
      </div>
    </>
  )
}

LiquidGlassModal.displayName = 'LiquidGlassModal'

/**
 * Implementation Notes:
 * 
 * Focus Management:
 * - Stores the previously focused element on mount
 * - Focuses the first focusable element in the modal after a 50ms delay
 * - Restores focus to the previous element on unmount
 * - Traps focus within the modal using Tab/Shift+Tab handlers
 * - Redirects escaped focus back to the modal using focusin listener
 * 
 * Keyboard Navigation:
 * - Escape key: Closes modal (if closeOnEscape is true)
 * - Tab: Cycles forward through focusable elements
 * - Shift+Tab: Cycles backward through focusable elements
 * - Focus wraps from last to first element and vice versa
 * 
 * Animations:
 * - Uses internal isClosing state for exit animations
 * - Animations defined in glassmorphism.css (.leaving class)
 * - onAnimationEnd triggers actual unmount after animation completes
 * 
 * Body Scroll Lock:
 * - Sets document.body.style.overflow = 'hidden' when modal opens
 * - Stores previous overflow value to restore on close
 * - Prevents background scrolling while modal is open
 * 
 * Theme Awareness:
 * - No manual theme handling required
 * - CSS variables in glassmorphism.css respond to .dark class on document root
 * - Theme changes are reflected immediately via CSS
 * 
 * Accessibility:
 * - role="dialog" and aria-modal="true" for screen readers
 * - aria-labelledby links to title element (if title provided)
 * - Focus trap prevents keyboard users from accessing background content
 * - Escape key provides standard close mechanism
 * - Close button has aria-label for screen readers
 */

// POS Glass Container - Generic container with glass effect
interface POSGlassContainerProps extends React.HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode
  variant?: 'primary' | 'secondary'
  className?: string
  padding?: 'none' | 'sm' | 'md' | 'lg'
}

export const POSGlassContainer = React.forwardRef<HTMLDivElement, POSGlassContainerProps>(
  ({ children, variant = 'primary', className = '', padding = 'md', ...props }, ref) => {
    const baseClasses = 'liquid-glass-modal-card'
    const variantClass = `liquid-glass-modal-${variant}`
    const paddingClasses = {
      none: '',
      sm: 'p-3',
      md: 'p-4',
      lg: 'p-6'
    }

    const combinedClasses = cn(
      baseClasses,
      variantClass,
      paddingClasses[padding],
      className
    )

    return (
      <div ref={ref} className={combinedClasses} {...props}>
        {children}
      </div>
    )
  }
)

POSGlassContainer.displayName = 'POSGlassContainer'

// POS Glass Toggle Switch - For settings and options
interface POSGlassToggleProps {
  checked: boolean
  onChange: (checked: boolean) => void
  label?: string
  description?: string
  disabled?: boolean
  className?: string
}

export const POSGlassToggle: React.FC<POSGlassToggleProps> = ({
  checked,
  onChange,
  label,
  description,
  disabled = false,
  className = ''
}) => {
  return (
    <div className={cn("flex items-center justify-between", className)}>
      <div className="flex-1">
        {label && (
          <div className="font-medium pos-glass-text-primary">{label}</div>
        )}
        {description && (
          <div className="text-sm pos-glass-text-secondary">{description}</div>
        )}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn(
          "relative inline-flex h-8 w-14 items-center rounded-full transition-colors",
          "liquid-glass-modal-button min-h-0 min-w-0",
          checked ? "liquid-glass-modal-success" : "liquid-glass-modal-secondary",
          disabled && "opacity-50 cursor-not-allowed"
        )}
      >
        <span
          className={cn(
            "inline-block h-6 w-6 transform rounded-full bg-white shadow-lg transition-transform",
            checked ? "translate-x-7" : "translate-x-1"
          )}
        />
      </button>
    </div>
  )
}

// POS Glass Badge - For status indicators
interface POSGlassBadgeProps {
  children: React.ReactNode
  variant?: 'success' | 'warning' | 'error' | 'info' | 'pending' | 'preparing' | 'ready'
  size?: 'sm' | 'md' | 'lg'
  className?: string
}

export const POSGlassBadge: React.FC<POSGlassBadgeProps> = ({
  children,
  variant = 'info',
  size = 'md',
  className = ''
}) => {
  const sizeClasses = {
    sm: 'text-xs px-2 py-1',
    md: 'text-sm px-3 py-1.5',
    lg: 'text-base px-4 py-2'
  }

  return (
    <span
      className={cn(
        'liquid-glass-modal-card',
        `liquid-glass-modal-${variant}`,
        'rounded-full font-medium inline-flex items-center',
        sizeClasses[size],
        className
      )}
    >
      {children}
    </span>
  )
}

// POS Glass Number Input - For quantities and prices
interface POSGlassNumberInputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'> {
  label?: string
  onIncrement?: () => void
  onDecrement?: () => void
  min?: number
  max?: number
  step?: number
  className?: string
}

export const POSGlassNumberInput = React.forwardRef<HTMLInputElement, POSGlassNumberInputProps>(
  ({
    label,
    onIncrement,
    onDecrement,
    min = 0,
    max,
    step = 1,
    className = '',
    value,
    onChange,
    ...props
  }, ref) => {
    const numValue = typeof value === 'string' ? parseInt(value) || 0 : (value as number) || 0

    const handleIncrement = () => {
      if (onIncrement) {
        onIncrement()
      } else if (onChange) {
        const newValue = Math.min(numValue + step, max || Infinity)
        onChange({ target: { value: newValue.toString() } } as React.ChangeEvent<HTMLInputElement>)
      }
    }

    const handleDecrement = () => {
      if (onDecrement) {
        onDecrement()
      } else if (onChange) {
        const newValue = Math.max(numValue - step, min)
        onChange({ target: { value: newValue.toString() } } as React.ChangeEvent<HTMLInputElement>)
      }
    }

    return (
      <div className={cn("space-y-2", className)}>
        {label && (
          <label className="block text-sm font-medium pos-glass-text-primary">
            {label}
          </label>
        )}
        <div className="flex items-center">
          <button
            type="button"
            onClick={handleDecrement}
            disabled={numValue <= min}
            className="liquid-glass-modal-button p-3 min-h-0 min-w-0 rounded-r-none border-r-0"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 12H4" />
            </svg>
          </button>
          <input
            ref={ref}
            type="number"
            min={min}
            max={max}
            step={step}
            value={value}
            onChange={onChange}
            className="liquid-glass-modal-input rounded-none border-x-0 text-center flex-1 min-w-0"
            {...props}
          />
          <button
            type="button"
            onClick={handleIncrement}
            disabled={max !== undefined && numValue >= max}
            className="liquid-glass-modal-button p-3 min-h-0 min-w-0 rounded-l-none border-l-0"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
            </svg>
          </button>
        </div>
      </div>
    )
  }
)

POSGlassNumberInput.displayName = 'POSGlassNumberInput'
# POS System Component Library

This document provides comprehensive documentation for all reusable components in the POS (Point of Sale) System.

## Table of Contents

- [Overview](#overview)
- [Modal Components](#modal-components)
- [Migration Guide](#migration-guide)
- [Remaining Files to Migrate](#remaining-files-to-migrate)
- [UI Components](#ui-components)
- [Design System Utilities](#design-system-utilities)
- [Best Practices](#best-practices)
- [Additional Resources](#additional-resources)

## Overview

### Component Philosophy

Our POS component library is built with a touch-first, accessibility-first approach optimized for restaurant environments:

- **Touch-Optimized**: Large touch targets, gesture-friendly interactions
- **Accessibility-First**: WCAG 2.1 AA compliance with screen reader support
- **Theme-Aware**: Automatic light/dark theme adaptation
- **Performance-Focused**: Optimized for low-latency POS operations
- **Consistent**: Unified design language across all POS interfaces

### Design System

**Liquid Glassmorphism:**
- Semi-transparent backgrounds with advanced backdrop blur
- Dynamic saturation effects that respond to content
- Layered depth with subtle shadows and borders
- Modern, professional aesthetic suitable for restaurant environments

**Technology Stack:**
- React with TypeScript for type safety
- Tailwind CSS for utility-first styling
- Custom glassmorphism CSS for advanced visual effects
- Radix UI primitives for accessibility foundations

## Modal Components

### LiquidGlassModal

**Location:** `pos-system/src/renderer/components/ui/pos-glass-components.tsx`

Enhanced modal component with liquid glass effects, focus trap, and full accessibility support.

#### Props

| Prop | Type | Required | Default | Description |
|------|------|----------|---------|-------------|
| `isOpen` | `boolean` | Yes | - | Modal visibility state |
| `onClose` | `() => void` | Yes | - | Close handler |
| `title` | `string` | No | - | Modal title (automatically renders header with close button) |
| `children` | `React.ReactNode` | Yes | - | Modal content |
| `className` | `string` | No | - | Additional CSS classes for modal shell |
| `size` | `'sm' \| 'md' \| 'lg' \| 'xl' \| 'full'` | No | `'md'` | Modal size variant |
| `closeOnBackdrop` | `boolean` | No | `true` | Whether clicking backdrop closes modal |
| `closeOnEscape` | `boolean` | No | `true` | Whether Escape key closes modal |

#### Size Variants

| Size | CSS Class | Use Case |
|------|-----------|----------|
| `sm` | `max-w-md` | Small forms, confirmations |
| `md` | `max-w-lg` | Standard forms |
| `lg` | `max-w-2xl` | Complex forms, lists |
| `xl` | `max-w-4xl` | Wide tables, grids |
| `full` | `max-w-[95vw] max-h-[95vh]` | Full-screen experiences |

#### Usage Examples

**Basic modal with title:**
```tsx
import { LiquidGlassModal } from '../components/ui/pos-glass-components';

function OrderConfirmation() {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <>
      <button onClick={() => setIsOpen(true)}>Confirm Order</button>
      
      <LiquidGlassModal
        isOpen={isOpen}
        onClose={() => setIsOpen(false)}
        title="Confirm Order"
      >
        <p>Are you sure you want to place this order?</p>
        <div className="flex gap-2 mt-4">
          <button onClick={() => setIsOpen(false)}>Cancel</button>
          <button onClick={handleConfirm}>Confirm</button>
        </div>
      </LiquidGlassModal>
    </>
  );
}
```

**Modal without title (custom header):**
```tsx
<LiquidGlassModal isOpen={isOpen} onClose={onClose}>
  <div className="mb-6">
    <h2 className="text-2xl font-bold">Custom Header</h2>
    <p className="text-sm text-gray-500">With subtitle</p>
  </div>
  <div>Content...</div>
</LiquidGlassModal>
```

**Large modal with scrollable content:**
```tsx
<LiquidGlassModal
  isOpen={isOpen}
  onClose={onClose}
  title="Order Details"
  size="xl"
  className="max-h-[90vh]"
>
  <div className="overflow-y-auto">
    {/* Large content that scrolls */}
  </div>
</LiquidGlassModal>
```

**Modal with custom size and className:**
```tsx
<LiquidGlassModal
  isOpen={isOpen}
  onClose={onClose}
  title="Custom Modal"
  size="lg"
  className="max-h-[80vh] overflow-hidden"
  closeOnBackdrop={false}
>
  <div>Content</div>
</LiquidGlassModal>
```

#### Features

- Automatic focus trap with Tab/Shift+Tab cycling
- Escape key to close (configurable)
- Backdrop click to close (configurable)
- Body scroll lock when open
- Smooth enter/exit animations
- Theme-aware styling (responds to light/dark theme)
- Accessibility: role="dialog", aria-modal="true", aria-labelledby

#### Accessibility Details

- **Focus Management:** Stores previous focus element, restores on close
- **Keyboard Navigation:** Tab, Shift+Tab, Escape key support
- **Screen Reader Support:** ARIA attributes, semantic HTML structure
- **Focus Trap:** Prevents focus from escaping modal boundaries

### POSGlassModal (Legacy)

**Location:** `pos-system/src/renderer/components/ui/pos-glass-components.tsx`

Simpler modal component without focus trap. Consider using LiquidGlassModal for new implementations.

See [LiquidGlassModal](#liquidglassmodal) for the recommended approach.

## Migration Guide

### Migrating from Old Modal Functions to LiquidGlassModal

This section guides you through migrating from the deprecated modal structure functions (`modalBackdrop`, `modalShell`, `modalHeaderBar`, `modalHeaderTitle`, `closeButton`) to the new LiquidGlassModal component.

#### Step-by-Step Migration Instructions

1. **Import LiquidGlassModal**
   ```tsx
   // Add this import
   import { LiquidGlassModal } from '../components/ui/pos-glass-components';
   ```

2. **Remove old design system imports**
   ```tsx
   // Remove these imports
   - import { modalBackdrop, modalShell, modalHeaderBar, modalHeaderTitle, closeButton } from '../../styles/designSystem';
   ```

3. **Replace modal structure with LiquidGlassModal wrapper**
   ```tsx
   // Old structure
   <div className={modalBackdrop} onClick={onClose}>
     <div className={modalShell(theme, 'max-w-lg')} onClick={e => e.stopPropagation()}>
       {/* content */}
     </div>
   </div>

   // New structure
   <LiquidGlassModal isOpen={isOpen} onClose={onClose} size="md">
     {/* content */}
   </LiquidGlassModal>
   ```

4. **Move title to title prop**
   ```tsx
   // Old
   <h2 className={modalHeaderTitle(theme)}>Title</h2>

   // New
   <LiquidGlassModal title="Title" ...>
   ```

5. **Remove manual header and close button**
   ```tsx
   // Remove this entire header section
   <div className={modalHeaderBar}>
     <h2 className={modalHeaderTitle(theme)}>Title</h2>
     <button className={closeButton(theme)} onClick={onClose}>X</button>
   </div>
   ```

6. **Remove manual body scroll lock**
   ```tsx
   // Remove this useEffect
   useEffect(() => {
     if (isOpen) {
       document.body.style.overflow = 'hidden';
     } else {
       document.body.style.overflow = '';
     }
     return () => {
       document.body.style.overflow = '';
     };
   }, [isOpen]);
   ```

7. **Update theme-dependent styling**
   ```tsx
   // Old
   className={resolvedTheme === 'dark' ? 'bg-gray-800' : 'bg-white'}

   // New
   className="bg-white dark:bg-gray-800"
   ```

#### Before/After Code Examples

**Example 1: Simple modal migration**
```tsx
// Before
import React from 'react';
import { modalBackdrop, modalShell, modalHeaderBar, modalHeaderTitle, closeButton } from '../../styles/designSystem';
import { useTheme } from '../../contexts/theme-context';

function SimpleModal({ isOpen, onClose }) {
  const { resolvedTheme } = useTheme();

  React.useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => document.body.style.overflow = '';
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <div className={modalBackdrop} onClick={onClose}>
      <div className={modalShell(resolvedTheme, 'max-w-md')} onClick={e => e.stopPropagation()}>
        <div className={modalHeaderBar}>
          <h2 className={modalHeaderTitle(resolvedTheme)}>Confirm Action</h2>
          <button className={closeButton(resolvedTheme)} onClick={onClose}>×</button>
        </div>
        <div className="p-6">
          <p>Are you sure?</p>
          <button onClick={onClose}>OK</button>
        </div>
      </div>
    </div>
  );
}

// After
import React from 'react';
import { LiquidGlassModal } from '../components/ui/pos-glass-components';

function SimpleModal({ isOpen, onClose }) {
  return (
    <LiquidGlassModal
      isOpen={isOpen}
      onClose={onClose}
      title="Confirm Action"
      size="sm"
    >
      <p>Are you sure?</p>
      <button onClick={onClose}>OK</button>
    </LiquidGlassModal>
  );
}
```

**Example 2: Modal with custom header content**
```tsx
// Before
<div className={modalHeaderBar}>
  <div>
    <h2 className={modalHeaderTitle(resolvedTheme)}>Order Details</h2>
    <p className="text-sm text-gray-500">Order #12345 - 2 items</p>
  </div>
  <button className={closeButton(resolvedTheme)} onClick={onClose}>×</button>
</div>

// After
<LiquidGlassModal isOpen={isOpen} onClose={onClose}>
  <div className="mb-6">
    <h2 className="text-2xl font-bold">Order Details</h2>
    <p className="text-sm text-gray-500">Order #12345 - 2 items</p>
  </div>
  {/* content */}
</LiquidGlassModal>
```

**Example 3: Modal with size and className**
```tsx
// Before
<div className={modalShell(resolvedTheme, 'max-w-4xl max-h-[90vh] overflow-y-auto')}>

// After
<LiquidGlassModal
  isOpen={isOpen}
  onClose={onClose}
  title="Large Modal"
  size="xl"
  className="max-h-[90vh] overflow-y-auto"
>
```

#### Common Patterns

- **Moving date selectors from header to content:** Place date pickers in the modal body instead of header
- **Moving customer info from header to content:** Customer details should be in the main content area
- **Handling nested modals:** Render as siblings in the DOM, not nested within each other
- **Preserving complex functionality:** Tabs, multi-step forms, and complex interactions remain in the content area

#### Troubleshooting

- **"Close button not working"** → Check that `onClose` prop is provided and calls the correct function
- **"Focus not trapped"** → Ensure at least one focusable element exists in the modal content
- **"Theme not updating"** → Remove manual theme handling and use Tailwind's `dark:` prefix

## Remaining Files to Migrate

### Files Still Using Deprecated Modal Functions

The following files still use the old modal structure functions and should be migrated when convenient. These files are fully functional and can be migrated on your own schedule. The deprecated functions will remain available until v2.0.0.

| File Path | Lines | Priority | Notes |
|-----------|-------|----------|-------|
| `OrderDetailsModal.tsx` | Lines 3, 35-42 | Medium | Complex grid layout |
| `EditOptionsModal.tsx` | Lines 4, 40-50 | Low | Simple two-option modal |
| `EditAddressModal.tsx` | Lines 6, 115-123 | Medium | Form with validation |
| `EditCustomerInfoModal.tsx` | Lines 8-12, 222-224 | Medium | Google Maps integration |
| `DriverAssignmentModal.tsx` | Lines 6-10, 113-115 | Medium | Async driver loading |
| `AddNewAddressModal.tsx` | Lines 6, 241-248 | Medium | Address autocomplete |
| `PINLoginModal.tsx` | Lines 4, 51-58 | High | Authentication flow |

## UI Components

This section provides a brief overview of other POS glass components. For detailed API documentation, see the source file at `pos-system/src/renderer/components/ui/pos-glass-components.tsx`.

### POSGlassCard
Touch-optimized card component with glassmorphism effects.

### POSGlassButton
Button component with liquid glass styling and touch-friendly sizing.

### POSGlassInput
Input field with glassmorphism design and built-in validation styling.

### POSGlassPINInput
Specialized PIN entry component with masked display.

### POSGlassContainer
Generic container with glass effects.

### POSGlassToggle
Toggle switch component for settings.

### POSGlassBadge
Badge component for status indicators.

### POSGlassNumberInput
Number input with increment/decrement buttons.

## Design System Utilities

### Content-Level Styling Utilities

These utilities from `designSystem.ts` remain supported for styling content within modals and other components. Consider using the React component alternatives (POSGlassButton, POSGlassInput, etc.) for better type safety and consistency.

#### Supported Utilities

- **`sectionTitle(theme)`** - Section headings
  ```tsx
  <h3 className={sectionTitle(resolvedTheme)}>Customer Information</h3>
  ```

- **`sectionSubtle(theme)`** - Descriptions and help text
  ```tsx
  <p className={sectionSubtle(resolvedTheme)}>Enter customer details below</p>
  ```

- **`inputBase(theme)`** - Input field styling
  ```tsx
  <input
    type="text"
    className={inputBase(resolvedTheme)}
    placeholder="Enter name"
  />
  ```

- **`liquidGlassModalButton(variant, size)`** - Button styling
  ```tsx
  <button className={liquidGlassModalButton('primary', 'lg')}>
    Save Changes
  </button>
  ```

- **`liquidGlassModalCard()`** - Card container styling
  ```tsx
  <div className={liquidGlassModalCard()}>
    <h4>Card Title</h4>
    <p>Card content</p>
  </div>
  ```

- **`liquidGlassModalBadge(variant)`** - Badge styling
  ```tsx
  <span className={liquidGlassModalBadge('success')}>Active</span>
  ```

- **CSS class exports:**
  - `liquidGlassModalText` - Primary text color
  - `liquidGlassModalTextMuted` - Muted/secondary text
  - `liquidGlassModalBorder` - Border styling

## Best Practices

### Modal Usage Guidelines

- **Use appropriate size variants:** Choose the smallest size that fits your content
- **Provide clear titles:** Use descriptive titles that explain the modal's purpose
- **Handle loading and error states:** Show appropriate feedback during async operations
- **Preserve user input on close:** Consider if users should lose unsaved changes
- **Test keyboard navigation:** Ensure Tab order is logical and complete
- **Test with screen readers:** Verify ARIA labels and announcements work correctly

### Accessibility Checklist

- [ ] All interactive elements are keyboard accessible
- [ ] Focus trap working correctly (LiquidGlassModal handles this)
- [ ] Escape key closes modal (configurable)
- [ ] Title provided or custom aria-label used
- [ ] Loading states announced to screen readers
- [ ] Color is not the only indicator of state
- [ ] Sufficient color contrast (4.5:1 minimum)
- [ ] Semantic HTML structure maintained

### Performance Tips

- **Lazy load modal content:** Use React.lazy for heavy modal content
- **Debounce search inputs:** Prevent excessive API calls during typing
- **Use React.memo:** For expensive content components
- **Avoid re-rendering:** On every keystroke in forms
- **Optimize images:** Use appropriate sizes for modal content
- **Virtualize lists:** For modals with many items

## Additional Resources

- [Glassmorphism CSS file](../../styles/glassmorphism.css)
- [Theme context documentation](../contexts/theme-context.tsx)
- [i18n context documentation](../contexts/i18n-context.tsx)
- [WCAG 2.1 Guidelines](https://www.w3.org/WAI/WCAG21/quickref/)
- [ARIA Authoring Practices](https://www.w3.org/WAI/ARIA/apg/)
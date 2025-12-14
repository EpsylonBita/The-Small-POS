# Modal Migration Guide

**Date:** January 2025
**Status:** Active Migration
**Target Completion:** Q1 2025

## Overview

This guide documents the migration from deprecated modal functions (`modalBackdrop`, `modalShell`, `modalHeaderBar`, etc.) to the new `LiquidGlassModal` component in the POS system.

### Why Migrate?

The new `LiquidGlassModal` component provides:
- **Automatic accessibility**: Built-in ARIA attributes, focus management, and keyboard navigation
- **Consistent UX**: Standardized animations, transitions, and behavior across all modals
- **Simplified code**: No manual backdrop/header/close button management
- **Better maintainability**: Single source of truth for modal behavior
- **Enhanced features**: Focus trap, body scroll lock, escape key handling, backdrop click handling

### Timeline

- **Phase 1 (Completed)**: Core modal components migrated (MenuModal, PaymentModal, etc.)
- **Phase 2 (In Progress)**: Remaining 7 modals requiring migration
- **Phase 3 (Planned)**: Deprecate old modal functions from designSystem.ts

---

## What's Changing

| Old Approach | New Approach |
|-------------|-------------|
| Manual backdrop div with `modalBackdrop` | `LiquidGlassModal` component with `isOpen` prop |
| Manual shell div with `modalShell(resolvedTheme, ...)` | `size` prop on `LiquidGlassModal` |
| Manual header with `modalHeaderBar`, `modalHeaderTitle` | `title` prop on `LiquidGlassModal` |
| Manual close button with `closeButton(resolvedTheme)` | Automatic close button in header |
| Manual body scroll lock with `useEffect` | Automatic scroll lock management |
| Manual escape key handler | Built-in `closeOnEscape` prop |
| Manual backdrop click handler | Built-in `closeOnBackdrop` prop |
| Theme-dependent classes via `resolvedTheme` | Tailwind `dark:` prefix |

---

## Step-by-Step Migration

### Step 1: Update Imports

**Remove these imports:**
```typescript
import { modalBackdrop, modalShell, modalHeaderBar, modalHeaderTitle, closeButton } from '../../styles/designSystem'
```

**Add this import:**
```typescript
import { LiquidGlassModal } from '../ui/pos-glass-components'
```

**Keep these if used for content styling:**
```typescript
import { sectionTitle, inputBase, liquidGlassModalButton } from '../../styles/designSystem'
```

### Step 2: Remove useTheme Hook (if only used for modal functions)

Check if `resolvedTheme` is only used for deprecated modal functions:

```typescript
// Remove if only used for modals:
import { useTheme } from '../../contexts/theme-context'
const { resolvedTheme } = useTheme()

// Keep if used elsewhere (e.g., content styling)
```

### Step 3: Remove Manual Body Scroll Lock

Delete any `useEffect` that manually manages body scroll:

```typescript
// Remove this:
React.useEffect(() => {
  if (isOpen) {
    document.body.style.overflow = 'hidden'
  } else {
    document.body.style.overflow = ''
  }
  return () => {
    document.body.style.overflow = ''
  }
}, [isOpen])
```

`LiquidGlassModal` handles this automatically.

### Step 4: Replace Modal Structure

**Remove the old structure:**
```tsx
<div className={modalBackdrop} onClick={onClose}>
  <div className={modalShell(resolvedTheme, 'max-w-lg')}>
    <div className={modalHeaderBar}>
      <h2 className={modalHeaderTitle(resolvedTheme)}>Title</h2>
      <button className={closeButton(resolvedTheme)} onClick={onClose}>X</button>
    </div>
    {/* content */}
  </div>
</div>
```

**Replace with:**
```tsx
<LiquidGlassModal
  isOpen={isOpen}
  onClose={onClose}
  title="Title"
  size="md"
>
  {/* content */}
</LiquidGlassModal>
```

### Step 5: Configure LiquidGlassModal Props

Set the required props:

```tsx
<LiquidGlassModal
  isOpen={isOpen}                    // Required: boolean
  onClose={onClose}                  // Required: () => void
  title={t('modal.title')}           // Optional: string (renders header)
  size="md"                          // Optional: 'sm'|'md'|'lg'|'xl'|'full'
  closeOnBackdrop={true}             // Optional: boolean (default: true)
  closeOnEscape={true}               // Optional: boolean (default: true)
  className="custom-classes"          // Optional: string
>
  {/* Your content */}
</LiquidGlassModal>
```

### Step 6: Update Theme-Dependent Styling

Replace manual theme checks with Tailwind's `dark:` prefix:

```tsx
// Old:
className={resolvedTheme === 'dark' ? 'text-white' : 'text-gray-900'}

// New:
className="text-gray-900 dark:text-white"
```

### Step 7: Handle Special Cases

- **Header content**: Move date selectors, filters, or customer info from header to modal body
- **Footer close buttons**: Remove them - `LiquidGlassModal` provides the header close button
- **Action buttons**: Preserve them in the footer
- **Nested modals**: Render as siblings, not children, for proper z-index layering

---

## Migration Examples

### Example 1: Simple Modal

**Before:**
```tsx
import React from 'react'
import { modalBackdrop, modalShell, modalHeaderBar, modalHeaderTitle, closeButton } from '../../styles/designSystem'
import { useTheme } from '../../contexts/theme-context'

const SimpleModal = ({ isOpen, onClose }) => {
  const { resolvedTheme } = useTheme()

  React.useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = 'hidden'
    } else {
      document.body.style.overflow = ''
    }
    return () => {
      document.body.style.overflow = ''
    }
  }, [isOpen])

  if (!isOpen) return null

  return (
    <div className={modalBackdrop} onClick={onClose}>
      <div className={modalShell(resolvedTheme, 'max-w-md')} onClick={(e) => e.stopPropagation()}>
        <div className={modalHeaderBar}>
          <h2 className={modalHeaderTitle(resolvedTheme)}>Confirm Action</h2>
          <button className={closeButton(resolvedTheme)} onClick={onClose}>×</button>
        </div>
        <div className="p-6">
          <p>Are you sure you want to proceed?</p>
          <div className="flex gap-3 mt-6">
            <button onClick={onClose} className="flex-1 px-4 py-2 bg-gray-200 rounded">Cancel</button>
            <button onClick={() => { /* action */ }} className="flex-1 px-4 py-2 bg-blue-500 text-white rounded">Confirm</button>
          </div>
        </div>
      </div>
    </div>
  )
}
```

**After:**
```tsx
import React from 'react'
import { LiquidGlassModal } from '../ui/pos-glass-components'

const SimpleModal = ({ isOpen, onClose }) => {
  return (
    <LiquidGlassModal
      isOpen={isOpen}
      onClose={onClose}
      title="Confirm Action"
      size="sm"
    >
      <p>Are you sure you want to proceed?</p>
      <div className="flex gap-3 mt-6">
        <button onClick={onClose} className="flex-1 px-4 py-2 bg-gray-200 dark:bg-gray-700 rounded">Cancel</button>
        <button onClick={() => { /* action */ }} className="flex-1 px-4 py-2 bg-blue-500 text-white rounded">Confirm</button>
      </div>
    </LiquidGlassModal>
  )
}
```

**What Changed:**
- Removed `useTheme` hook and `resolvedTheme`
- Removed manual body scroll lock
- Replaced backdrop/shell/header structure with `LiquidGlassModal`
- Updated button styling to use Tailwind `dark:` prefix
- Removed `onClick` propagation stop (handled automatically)

### Example 2: Modal with Custom Header Content

**Before:**
```tsx
// Modal with date selector in header
<div className={modalHeaderBar}>
  <div className="flex items-center gap-4">
    <h2 className={modalHeaderTitle(resolvedTheme)}>Sales Report</h2>
    <input type="date" className={inputBase(resolvedTheme)} />
  </div>
  <button className={closeButton(resolvedTheme)} onClick={onClose}>×</button>
</div>
```

**After:**
```tsx
<LiquidGlassModal
  isOpen={isOpen}
  onClose={onClose}
  title="Sales Report"
>
  {/* Date selector moved to content area */}
  <div className="mb-6 p-4 bg-blue-50 dark:bg-blue-900/20 rounded-lg">
    <label className="block text-sm font-medium mb-2">Select Date:</label>
    <input type="date" className="w-full px-3 py-2 border rounded" />
  </div>
  
  {/* Rest of content */}
</LiquidGlassModal>
```

### Example 3: Modal with Form and Validation

**Before:**
```tsx
const handleClose = () => {
  // Reset form
  setFormData(initialData)
  onClose()
}

// In JSX:
<button onClick={handleClose}>Cancel</button>
```

**After:**
```tsx
const handleClose = () => {
  // Reset form
  setFormData(initialData)
  onClose()
}

<LiquidGlassModal
  isOpen={isOpen}
  onClose={handleClose}  // Use handleClose instead of onClose directly
  title="Edit Form"
>
  {/* Form content */}
</LiquidGlassModal>
```

### Example 4: Large Modal with Tabs

**Before:**
```tsx
<div className={modalShell(resolvedTheme, 'max-w-4xl max-h-[90vh] overflow-y-auto')}>
  <div className={modalHeaderBar}>
    <h2 className={modalHeaderTitle(resolvedTheme)}>Settings</h2>
    <button className={closeButton(resolvedTheme)} onClick={onClose}>×</button>
  </div>
  <div className="p-6">
    {/* Tab navigation */}
    {/* Tab content */}
  </div>
</div>
```

**After:**
```tsx
<LiquidGlassModal
  isOpen={isOpen}
  onClose={onClose}
  title="Settings"
  size="xl"
  className="max-h-[90vh]"
>
  {/* Tab navigation */}
  {/* Tab content */}
</LiquidGlassModal>
```

### Example 5: Nested Modals

**Before:**
```tsx
{/* Parent modal */}
<div className={modalBackdrop}>
  <div className={modalShell(resolvedTheme)}>
    {/* Parent content */}
    {/* Child modal rendered inside parent - WRONG */}
    <ChildModal />
  </div>
</div>
```

**After:**
```tsx
{/* Parent modal */}
<LiquidGlassModal isOpen={parentOpen} onClose={closeParent} title="Parent">
  {/* Parent content */}
</LiquidGlassModal>

{/* Child modal as sibling - CORRECT */}
<LiquidGlassModal isOpen={childOpen} onClose={closeChild} title="Child">
  {/* Child content */}
</LiquidGlassModal>
```

## Common Patterns

### Pattern 1: Moving Header Content to Body

**When:** Header contains more than just title (date pickers, filters, customer info)  
**How:** Create a banner/card at top of modal content  
**Example:** ZReportModal date selector

```tsx
<LiquidGlassModal isOpen={isOpen} onClose={onClose} title="Report">
  {/* Move header content here */}
  <div className="mb-6 p-4 bg-blue-50 dark:bg-blue-900/20 rounded-lg border">
    <div className="flex items-center gap-4">
      <label className="font-medium">Date:</label>
      <input type="date" className="border rounded px-2 py-1" />
    </div>
  </div>
  
  {/* Main content */}
</LiquidGlassModal>
```

### Pattern 2: Preserving Form Reset Logic

**When:** Modal has form that should reset on close  
**How:** Create `handleClose` function that resets state then calls `onClose`  
**Example:** OrderCancellationModal

```tsx
const handleClose = () => {
  setFormData(initialFormData)
  setErrors({})
  onClose()
}

<LiquidGlassModal isOpen={isOpen} onClose={handleClose}>
  {/* Form content */}
</LiquidGlassModal>
```

### Pattern 3: Preventing Accidental Closes

**When:** Modal contains important data entry or payment processing  
**How:** Set `closeOnBackdrop={false}` and conditionally disable `closeOnEscape`  
**Example:** PaymentModal during processing

```tsx
<LiquidGlassModal
  isOpen={isOpen}
  onClose={onClose}
  title="Payment"
  closeOnBackdrop={!isProcessing}
  closeOnEscape={!isProcessing}
>
  {/* Payment form */}
</LiquidGlassModal>
```

### Pattern 4: Custom Modal Sizes

**When:** Standard sizes don't fit your content
**How:** Use `size` prop + `className` for additional constraints
**Example:** `size="xl" className="max-h-[90vh]"`

```tsx
<LiquidGlassModal
  isOpen={isOpen}
  onClose={onClose}
  title="Large Content"
  size="xl"
  className="max-h-[90vh] overflow-y-auto"
>
  {/* Large content */}
</LiquidGlassModal>
```

---

## Troubleshooting

### Common Issues and Solutions

#### Issue 1: Modal doesn't close when parent sets `isOpen=false`

**Symptom:** Modal remains visible even after parent component sets `isOpen={false}`

**Solution:** This was fixed in the latest version of `LiquidGlassModal`. The component now properly honors external `isOpen` changes via a `useEffect` that triggers the closing animation when `isOpen` becomes `false`.

#### Issue 2: Focus not trapped in modal

**Symptom:** Tab key allows focus to escape the modal

**Solution:** Ensure you're using the latest version of `LiquidGlassModal` which includes automatic focus trap. The component uses `getFocusableElements()` to manage tab navigation.

#### Issue 3: Body scroll not restored after modal closes

**Symptom:** Page remains unscrollable after closing modal

**Solution:** The latest version stores the previous `overflow` value in a ref and restores it on cleanup. If you're experiencing this, update to the latest version.

#### Issue 4: Nested modals have z-index issues

**Symptom:** Child modal appears behind parent modal

**Solution:** Render modals as siblings, not nested:

```tsx
{/* WRONG */}
<LiquidGlassModal isOpen={parentOpen}>
  <LiquidGlassModal isOpen={childOpen}>...</LiquidGlassModal>
</LiquidGlassModal>

{/* CORRECT */}
<LiquidGlassModal isOpen={parentOpen}>...</LiquidGlassModal>
<LiquidGlassModal isOpen={childOpen}>...</LiquidGlassModal>
```

#### Issue 5: Input fields using `inputBase(resolvedTheme)` not styled correctly

**Symptom:** Form inputs appear unstyled or have incorrect theme

**Solution:** Replace `inputBase(resolvedTheme)` with Tailwind classes:

```tsx
// Old:
className={inputBase(resolvedTheme)}

// New:
className="w-full px-4 py-2 rounded-lg border bg-white/50 dark:bg-gray-800/50 border-gray-300 dark:border-gray-600 text-gray-900 dark:text-gray-100 focus:ring-2 focus:ring-blue-500 focus:border-transparent"
```

---

## Files Requiring Migration

The following 7 files still need to be migrated to `LiquidGlassModal`:

### 1. `pos-system/src/renderer/components/modals/OrderDetailsModal.tsx`
- **Status:** ✅ Migrated
- **Notes:** Simple modal with table layout, straightforward migration

### 2. `pos-system/src/renderer/components/modals/EditOptionsModal.tsx`
- **Status:** ✅ Migrated
- **Notes:** Two-option selection modal, minimal changes needed

### 3. `pos-system/src/renderer/components/modals/EditAddressModal.tsx`
- **Status:** ✅ Migrated
- **Notes:** Form modal with multiple inputs, replaced `inputBase` calls

### 4. `pos-system/src/renderer/components/modals/EditCustomerInfoModal.tsx`
- **Status:** ✅ Migrated
- **Notes:** Complex form with Google Maps autocomplete, moved header content to body

### 5. `pos-system/src/renderer/components/modals/DriverAssignmentModal.tsx`
- **Status:** ✅ Migrated
- **Notes:** List selection modal, removed manual escape key handler

### 6. `pos-system/src/renderer/components/modals/AddNewAddressModal.tsx`
- **Status:** ✅ Migrated
- **Notes:** Form modal with address autocomplete, replaced all `inputBase` calls

### 7. `pos-system/src/renderer/components/auth/PINLoginModal.tsx`
- **Status:** ✅ Migrated
- **Notes:** PIN entry modal with number pad, simple structure

---

## Testing Checklist

After migrating a modal, verify the following:

- [ ] **Open/Close**: Modal opens when `isOpen={true}` and closes when `isOpen={false}`
- [ ] **Escape Key**: Pressing Escape closes the modal (unless `closeOnEscape={false}`)
- [ ] **Backdrop Click**: Clicking backdrop closes modal (unless `closeOnBackdrop={false}`)
- [ ] **Focus Trap**: Tab key cycles focus within modal, doesn't escape to page
- [ ] **Focus Restoration**: Focus returns to trigger element after modal closes
- [ ] **Body Scroll Lock**: Page body is not scrollable while modal is open
- [ ] **Scroll Restoration**: Page body scroll is restored after modal closes
- [ ] **Animations**: Modal has smooth enter/exit animations
- [ ] **Accessibility**: Screen reader announces modal correctly (check ARIA attributes)
- [ ] **Theme Support**: Modal displays correctly in both light and dark themes
- [ ] **Responsive**: Modal is usable on mobile, tablet, and desktop viewports
- [ ] **Form Reset**: If modal contains a form, it resets properly on close
- [ ] **Nested Modals**: If applicable, child modals render correctly as siblings

---

## Additional Resources

- **Component Source**: [`pos-system/src/renderer/components/ui/pos-glass-components.tsx`](../../src/renderer/components/ui/pos-glass-components.tsx) (lines 340-700)
- **Component Library Docs**: [`pos-system/docs/development/POS_COMPONENT_LIBRARY.md`](./POS_COMPONENT_LIBRARY.md)
- **ARIA Dialog Pattern**: [W3C WAI-ARIA Authoring Practices](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/)
- **Tailwind Dark Mode**: [Tailwind CSS Dark Mode Documentation](https://tailwindcss.com/docs/dark-mode)

---

## Questions or Issues?

If you encounter any issues during migration or have questions about the new component:

1. Check the [Troubleshooting](#troubleshooting) section above
2. Review the [Migration Examples](#migration-examples) for similar use cases
3. Consult the [POS Component Library documentation](./POS_COMPONENT_LIBRARY.md)
4. Check the `LiquidGlassModal` source code for implementation details

---

**Last Updated:** January 2025
**Maintained By:** POS Development Team
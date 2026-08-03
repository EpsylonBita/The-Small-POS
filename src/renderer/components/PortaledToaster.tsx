import React from 'react'
import { createPortal } from 'react-dom'
import { Toaster } from 'react-hot-toast'

type PortaledToasterProps = React.ComponentProps<typeof Toaster>

/**
 * Keeps app notifications outside transformed layout stacking contexts.
 * Settings modals are portaled to document.body, so their diagnostics must be
 * portaled to the same root in order for the configured z-index to take effect.
 */
export const PortaledToaster: React.FC<PortaledToasterProps> = (props) => {
  if (typeof document === 'undefined') return null
  return createPortal(<Toaster {...props} />, document.body)
}

export default PortaledToaster

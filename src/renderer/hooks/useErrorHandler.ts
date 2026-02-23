import { useCallback, useState } from 'react'
import { errorHandler, ErrorDetails, ErrorHandlerOptions } from '../../shared/services/ErrorHandlingService'
import { getBridge } from '../../lib'

const bridge = getBridge()

interface UseErrorHandlerReturn {
  handleError: (error: any, context: string, options?: ErrorHandlerOptions) => Promise<ErrorDetails>
  handleAsyncOperation: <T>(
    operation: () => Promise<T>,
    context: string,
    options?: ErrorHandlerOptions & { fallbackValue?: T }
  ) => Promise<T | undefined>
  isLoading: boolean
  lastError: ErrorDetails | null
  clearError: () => void
  retryLastOperation: () => Promise<void>
}

// POS-specific notification function (since we don't have react-hot-toast in Electron)
function showPOSNotification(message: string, type: 'info' | 'warning' | 'error' = 'info') {
  try {
    void bridge.notifications.show({
      title: type === 'error' ? 'Error' : type === 'warning' ? 'Warning' : 'Information',
      body: message,
      type
    })
  } catch {
    // Fallback to browser notification or console
    console.log(`[${type.toUpperCase()}] ${message}`)
    
    // Try browser notification if available
    if ('Notification' in window && Notification.permission === 'granted') {
      new Notification(type === 'error' ? 'Error' : 'Information', {
        body: message,
        icon: type === 'error' ? '/error-icon.png' : '/info-icon.png'
      })
    }
  } 
}

export function useErrorHandler(): UseErrorHandlerReturn {
  const [isLoading, setIsLoading] = useState(false)
  const [lastError, setLastError] = useState<ErrorDetails | null>(null)
  const [lastOperation, setLastOperation] = useState<{
    operation: () => Promise<any>
    context: string
    options?: ErrorHandlerOptions
  } | null>(null)

  const handleError = useCallback(async (
    error: any,
    context: string,
    options: ErrorHandlerOptions = {}
  ): Promise<ErrorDetails> => {
    // Use POS-specific error handling
    const errorDetails = await errorHandler.handleApiError(error, context, {
      showToast: false, // We'll handle notifications ourselves
      logToConsole: true,
      ...options
    })

    setLastError(errorDetails)

    // Show appropriate notification based on severity
    if (options.showToast !== false) {
      switch (errorDetails.severity) {
        case 'low':
          showPOSNotification(errorDetails.userMessage, 'info')
          break
        case 'medium':
          showPOSNotification(errorDetails.userMessage, 'warning')
          break
        case 'high':
        case 'critical':
          showPOSNotification(errorDetails.userMessage, 'error')
          break
      }
    }

    return errorDetails
  }, [])

  const handleAsyncOperation = useCallback(async <T>(
    operation: () => Promise<T>,
    context: string,
    options: ErrorHandlerOptions & { fallbackValue?: T } = {}
  ): Promise<T | undefined> => {
    setIsLoading(true)
    setLastOperation({ operation, context, options })

    try {
      const result = await operation()
      setLastError(null) // Clear error on success
      return result
    } catch (error) {
      const errorDetails = await handleError(error, context, options)
      
      // Return fallback value if provided
      if (options.fallbackValue !== undefined) {
        return options.fallbackValue
      }
      
      // If retryable and retry callback provided, don't return undefined
      if (errorDetails.retryable && options.retryCallback) {
        return undefined
      }
      
      return undefined
    } finally {
      setIsLoading(false)
    }
  }, [handleError])

  const clearError = useCallback(() => {
    setLastError(null)
  }, [])

  const retryLastOperation = useCallback(async () => {
    if (!lastOperation) {
      showPOSNotification('No operation to retry', 'warning')
      return
    }

    const { operation, context, options } = lastOperation
    await handleAsyncOperation(operation, context, options)
  }, [lastOperation, handleAsyncOperation])

  return {
    handleError,
    handleAsyncOperation,
    isLoading,
    lastError,
    clearError,
    retryLastOperation
  }
}

// Specialized hooks for POS operations

export function useApiCall() {
  const { handleAsyncOperation, isLoading, lastError, clearError } = useErrorHandler()

  const apiCall = useCallback(async <T>(
    url: string,
    options: RequestInit = {},
    context: string = 'API Call'
  ): Promise<T | undefined> => {
    return handleAsyncOperation(
      async () => {
        const response = await fetch(url, {
          headers: {
            'Content-Type': 'application/json',
            ...options.headers
          },
          ...options
        })

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}))
          const error = new Error(errorData.message || `HTTP ${response.status}`)
          ;(error as any).status = response.status
          ;(error as any).statusText = response.statusText
          ;(error as any).response = response
          throw error
        }

        return response.json()
      },
      context,
      {
        maxRetries: 3,
        retryCallback: () => apiCall(url, options, context)
      }
    )
  }, [handleAsyncOperation])

  return {
    apiCall,
    isLoading,
    lastError,
    clearError
  }
}

export function usePOSOperation() {
  const { handleAsyncOperation, isLoading, lastError, clearError } = useErrorHandler()

  const posOperation = useCallback(async <T>(
    operation: () => Promise<T>,
    context: string = 'POS Operation',
    fallbackValue?: T
  ): Promise<T | undefined> => {
    return handleAsyncOperation(
      operation,
      context,
      {
        fallbackValue,
        maxRetries: 2,
        retryCallback: () => posOperation(operation, context, fallbackValue)
      }
    )
  }, [handleAsyncOperation])

  return {
    posOperation,
    isLoading,
    lastError,
    clearError
  }
}

// Network status hook for POS
export function useNetworkStatus() {
  const [isOnline, setIsOnline] = useState(navigator.onLine)
  const { handleError } = useErrorHandler()

  const checkNetworkStatus = useCallback(() => {
    const online = navigator.onLine
    setIsOnline(online)
    
    if (!online) {
      handleError(
        new Error('Network connection lost'),
        'Network Status Check',
        {
          showToast: true,
          logToConsole: true
        }
      )
    }
    
    return online
  }, [handleError])

  // Set up event listeners
  if (typeof window !== 'undefined') {
    window.addEventListener('online', () => {
      setIsOnline(true)
      showPOSNotification('Connection restored', 'info')
    })
    
    window.addEventListener('offline', () => {
      setIsOnline(false)
      checkNetworkStatus()
    })
  }

  return {
    isOnline,
    checkNetworkStatus
  }
}

// POS-specific error recovery hook
export function usePOSErrorRecovery() {
  const { handleError } = useErrorHandler()

  const handleOrderError = useCallback(async (error: any, orderData: any) => {
    const errorDetails = await handleError(error, 'Order Processing', {
      showToast: true,
      logToConsole: true
    })

    // POS-specific error recovery logic
    if (errorDetails.retryable) {
      // Save order to local storage for retry
      try {
        await bridge.orders.saveForRetry(orderData)
      } catch {
        localStorage.setItem('pendingOrder', JSON.stringify(orderData))
      }
      
      showPOSNotification(
        'Order saved locally. Will retry when connection is restored.',
        'info'
      )
    }

    return errorDetails
  }, [handleError])

  const handlePaymentError = useCallback(async (error: any, paymentData: any) => {
    const errorDetails = await handleError(error, 'Payment Processing', {
      showToast: true,
      logToConsole: true
    })

    // Payment-specific error handling
    if (errorDetails.code === 'NETWORK_ERROR') {
      showPOSNotification(
        'Payment failed due to network issues. Please try again or use cash.',
        'warning'
      )
    }

    return errorDetails
  }, [handleError])

  const recoverPendingOrders = useCallback(async () => {
    try {
      let pendingOrders = []

      try {
        pendingOrders = await bridge.orders.getRetryQueue()
      } catch {
        // Fallback to localStorage
        const stored = localStorage.getItem('pendingOrder')
        if (stored) {
          pendingOrders = [JSON.parse(stored)]
        }
      }

      if (pendingOrders.length > 0) {
        showPOSNotification(
          `Found ${pendingOrders.length} pending order(s). Attempting to process...`,
          'info'
        )
        
        // Process pending orders
        for (const order of pendingOrders) {
          try {
            // Attempt to resubmit order
            // This would call your order submission API
            console.log('Resubmitting order:', order)
          } catch (retryError) {
            console.error('Failed to resubmit order:', retryError)
          }
        }
      }
    } catch (error) {
      console.error('Error recovering pending orders:', error)
    }
  }, [])

  return {
    handleOrderError,
    handlePaymentError,
    recoverPendingOrders
  }
}

import { createContext, useCallback, useContext, useRef, useState } from 'react'

export type ToastVariant = 'success' | 'error' | 'info'

export interface ToastItem {
  id: number
  message: string
  variant: ToastVariant
}

interface ToastContextValue {
  toasts: ToastItem[]
  toast: (message: string, variant?: ToastVariant) => void
}

export const ToastContext = createContext<ToastContextValue>({
  toasts: [],
  toast: () => undefined,
})

export function useToastState(): ToastContextValue {
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const counter = useRef(0)

  const toast = useCallback((message: string, variant: ToastVariant = 'info') => {
    const id = ++counter.current
    setToasts((prev) => [...prev, { id, message, variant }])
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id))
    }, 3500)
  }, [])

  return { toasts, toast }
}

export function useToast(): Pick<ToastContextValue, 'toast'> {
  const { toast } = useContext(ToastContext)
  return { toast }
}

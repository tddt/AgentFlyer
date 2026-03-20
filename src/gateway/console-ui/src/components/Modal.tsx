import { createPortal } from 'react-dom'
import { Button } from './Button.js'

interface Props {
  title: string
  message: string
  confirmLabel?: string
  cancelLabel?: string
  onConfirm: () => void
  onCancel: () => void
}

export function Modal({ title, message, confirmLabel = 'Confirm', cancelLabel = 'Cancel', onConfirm, onCancel }: Props) {
  return createPortal(
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.65)', backdropFilter: 'blur(8px)' }}
      onClick={(e) => { if (e.target === e.currentTarget) onCancel() }}
    >
      <div
        className="w-full max-w-sm mx-4 p-6 flex flex-col gap-5 af-scale-in"
        style={{
          background: 'linear-gradient(160deg, rgba(20,23,37,0.98) 0%, rgba(12,14,22,0.98) 100%)',
          border: '1px solid rgba(255,255,255,0.08)',
          borderRadius: '16px',
          boxShadow: '0 24px 64px rgba(0,0,0,0.6), 0 0 0 1px rgba(99,102,241,0.1)',
        }}
      >
        <div className="flex flex-col gap-1.5">
          <h3 className="text-[15px] font-semibold text-slate-100">{title}</h3>
          <p className="text-sm text-slate-400 leading-relaxed">{message}</p>
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onCancel}>{cancelLabel}</Button>
          <Button variant="danger" size="sm" onClick={onConfirm}>{confirmLabel}</Button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

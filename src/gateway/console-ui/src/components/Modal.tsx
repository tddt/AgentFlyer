import { createPortal } from 'react-dom';
import { Button } from './Button.js';

interface Props {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function Modal({
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  onConfirm,
  onCancel,
}: Props) {
  return createPortal(
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.65)', backdropFilter: 'blur(8px)' }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        className="w-full max-w-sm mx-4 p-6 flex flex-col gap-5 af-scale-in"
        style={{
          background: 'var(--af-overlay-bg)',
          border: '1px solid var(--af-overlay-border)',
          borderRadius: '16px',
          boxShadow: '0 24px 64px rgba(0,0,0,0.45), 0 0 0 1px var(--af-border)',
        }}
      >
        <div className="flex flex-col gap-1.5">
          <h3 style={{ color: 'var(--af-text-heading)' }} className="text-[15px] font-semibold">{title}</h3>
          <p style={{ color: 'var(--af-text-muted)' }} className="text-sm leading-relaxed">{message}</p>
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onCancel}>
            {cancelLabel}
          </Button>
          <Button variant="danger" size="sm" onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

import { createPortal } from 'react-dom';
import { Button } from './Button.js';
import { DeliverableDetailView } from './DeliverableDetailView.js';
import { useLocale } from '../context/i18n.js';
import { rpc, useQuery } from '../hooks/useRpc.js';
import type { DeliverableRecord } from '../types.js';

export function DeliverableModal({
  deliverableId,
  onClose,
}: {
  deliverableId: string;
  onClose: () => void;
}) {
  const { t } = useLocale();
  const { data, loading, refetch } = useQuery<DeliverableRecord>(
    () => rpc<DeliverableRecord>('deliverable.get', { deliverableId }),
    [deliverableId],
  );

  return createPortal(
    <div
      className="fixed inset-0 z-[230] flex items-center justify-center bg-black/70 p-4 backdrop-blur-md"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex max-h-[92vh] w-full max-w-6xl flex-col rounded-[32px] border border-white/10 bg-slate-950/92 shadow-[0_40px_120px_rgba(2,6,23,0.8)]">
        <div className="flex items-center justify-between border-b border-white/8 px-6 py-4">
          <div>
            <div className="text-[11px] uppercase tracking-[0.24em] text-slate-500">
              {t('deliverables.modal.title')}
            </div>
            <div className="mt-1 text-sm text-slate-300">{deliverableId}</div>
          </div>
          <Button size="sm" variant="ghost" onClick={onClose}>
            {t('common.close')}
          </Button>
        </div>
        <div className="flex-1 overflow-auto p-6">
          <DeliverableDetailView deliverable={data ?? null} loading={loading} onPublished={refetch} />
        </div>
      </div>
    </div>,
    document.body,
  );
}
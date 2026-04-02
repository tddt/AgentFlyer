import type { Channel } from '../channels/types.js';
import type { AgentId, ThreadKey } from '../core/types.js';
import type {
  ArtifactRef,
  DeliverablePublicationTarget,
  DeliverableRecord,
  DeliverableStore,
} from './deliverables.js';

export interface DeliverablePublicationDeps {
  deliverableStore: DeliverableStore;
  channels: Map<string, Channel>;
}

export interface PublishDeliverableResult {
  ok: boolean;
  deliverable: DeliverableRecord;
  publication: DeliverablePublicationTarget;
  detail: string;
}

function resolveTargetAgentId(
  deliverable: DeliverableRecord,
  publication: DeliverablePublicationTarget,
): AgentId {
  return (publication.agentId ??
    (deliverable.source.kind === 'scheduler_task_run' ? deliverable.source.agentId : undefined) ??
    'main') as AgentId;
}

function selectFileArtifact(deliverable: DeliverableRecord): ArtifactRef | undefined {
  return deliverable.artifacts.find(
    (artifact) => artifact.role === 'file' && artifact.filePath && artifact.mimeType,
  );
}

async function persistPublicationUpdate(
  deps: DeliverablePublicationDeps,
  deliverableId: string,
  publicationId: string,
  updates: Partial<Pick<DeliverablePublicationTarget, 'status' | 'detail' | 'lastAttemptAt'>>,
): Promise<DeliverableRecord> {
  const updated = await deps.deliverableStore.updatePublication(
    deliverableId,
    publicationId,
    updates,
  );
  if (!updated) {
    throw new Error(`Deliverable not found while updating publication: ${deliverableId}`);
  }
  return updated;
}

export async function publishDeliverableToTarget(
  deps: DeliverablePublicationDeps,
  deliverable: DeliverableRecord,
  publicationId: string,
): Promise<PublishDeliverableResult> {
  const publication = deliverable.publications?.find((item) => item.id === publicationId);
  if (!publication) {
    throw new Error(`Publication target not found: ${publicationId}`);
  }
  if (publication.kind !== 'channel') {
    throw new Error('Only channel publications can be sent');
  }
  if (!publication.threadKey) {
    const updatedDeliverable = await persistPublicationUpdate(
      deps,
      deliverable.id,
      publication.id,
      {
        status: 'failed',
        detail: 'Missing threadKey; configure a concrete publication target before sending.',
        lastAttemptAt: Date.now(),
      },
    );
    const updatedPublication = updatedDeliverable.publications?.find(
      (item) => item.id === publication.id,
    );
    throw new Error(updatedPublication?.detail ?? 'Publication target is missing threadKey');
  }

  const channel = deps.channels.get(publication.targetId);
  if (!channel) {
    const detail = `Channel not available: ${publication.targetId}`;
    await persistPublicationUpdate(deps, deliverable.id, publication.id, {
      status: 'failed',
      detail,
      lastAttemptAt: Date.now(),
    });
    throw new Error(detail);
  }

  const target = {
    agentId: resolveTargetAgentId(deliverable, publication),
    threadKey: publication.threadKey as ThreadKey,
  };
  const fileArtifact =
    publication.mode === 'artifact' ? selectFileArtifact(deliverable) : undefined;

  try {
    let detail = `Sent summary to ${publication.threadKey}.`;
    if (publication.mode === 'artifact') {
      if (!fileArtifact?.filePath || !fileArtifact.mimeType) {
        throw new Error('No file artifact is available for attachment delivery');
      }
      if (!channel.sendAttachment) {
        throw new Error('Attachment upload is not supported by this channel');
      }
      await channel.sendAttachment(target, {
        filePath: fileArtifact.filePath,
        mimeType: fileArtifact.mimeType,
        name: fileArtifact.name,
      });
      detail = `Sent ${fileArtifact.name} to ${publication.threadKey}.`;
    } else {
      const text = deliverable.previewText || deliverable.summary || deliverable.title;
      await channel.send(target, text);
    }

    const updatedDeliverable = await persistPublicationUpdate(
      deps,
      deliverable.id,
      publication.id,
      {
        status: 'sent',
        detail,
        lastAttemptAt: Date.now(),
      },
    );
    const updatedPublication = updatedDeliverable.publications?.find(
      (item) => item.id === publication.id,
    );
    if (!updatedPublication) {
      throw new Error(`Publication target disappeared after send: ${publication.id}`);
    }
    return {
      ok: true,
      deliverable: updatedDeliverable,
      publication: updatedPublication,
      detail,
    };
  } catch (publishErr) {
    const detail = publishErr instanceof Error ? publishErr.message : String(publishErr);
    const updatedDeliverable = await persistPublicationUpdate(
      deps,
      deliverable.id,
      publication.id,
      {
        status: 'failed',
        detail,
        lastAttemptAt: Date.now(),
      },
    );
    const updatedPublication = updatedDeliverable.publications?.find(
      (item) => item.id === publication.id,
    );
    return {
      ok: false,
      deliverable: updatedDeliverable,
      publication: updatedPublication ?? {
        ...publication,
        status: 'failed',
        detail,
        lastAttemptAt: Date.now(),
      },
      detail,
    };
  }
}

export async function publishDeliverableTargets(
  deps: DeliverablePublicationDeps,
  deliverable: DeliverableRecord,
  publicationIds?: string[],
): Promise<PublishDeliverableResult[]> {
  const requestedIds = publicationIds ? new Set(publicationIds) : null;
  const candidates = (deliverable.publications ?? []).filter((publication) => {
    if (publication.kind !== 'channel' || !publication.threadKey) return false;
    if (requestedIds && !requestedIds.has(publication.id)) return false;
    return (
      publication.status === 'planned' || publication.status === 'failed' || requestedIds !== null
    );
  });

  const results: PublishDeliverableResult[] = [];
  let currentDeliverable = deliverable;
  for (const publication of candidates) {
    const result = await publishDeliverableToTarget(deps, currentDeliverable, publication.id);
    currentDeliverable = result.deliverable;
    results.push(result);
  }
  return results;
}

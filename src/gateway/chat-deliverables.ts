import type { Channel } from '../channels/types.js';
import type { AgentId, ThreadKey } from '../core/types.js';
import { publishDeliverableTargets } from './deliverable-publication.js';
import {
  type DeliverablePublicationTarget,
  type DeliverableRecord,
  buildChatTurnDeliverable,
  findRecentArtifacts,
} from './deliverables.js';
import type { RpcContext } from './rpc.js';

interface CaptureChatTurnDeliverableOptions {
  agentId: string;
  threadKey: string;
  channelId: string;
  replyText: string;
  startedAt: number;
  finishedAt?: number;
}

function buildChatTurnPublications(
  channel: Channel | undefined,
  options: CaptureChatTurnDeliverableOptions,
  hasFileArtifacts: boolean,
): DeliverablePublicationTarget[] {
  if (!channel || !options.threadKey.trim() || !hasFileArtifacts) {
    return [];
  }

  const supportsAttachments = typeof channel.sendAttachment === 'function';
  return [
    {
      id: `channel:${channel.id}:${options.threadKey}:chat-turn`,
      kind: 'channel',
      targetId: channel.id,
      label: `${channel.name} · ${options.threadKey}`,
      mode: supportsAttachments ? 'artifact' : 'summary',
      status: supportsAttachments ? 'planned' : 'available',
      threadKey: options.threadKey,
      agentId: options.agentId,
      detail: supportsAttachments
        ? `Planned to send generated artifacts back to ${options.threadKey}.`
        : 'This channel does not support attachment upload; artifacts remain available in Deliverables.',
    },
  ];
}

export async function captureChatTurnDeliverable(
  ctx: Pick<RpcContext, 'contentStore' | 'deliverableStore' | 'channels' | 'inboxBroadcaster'>,
  options: CaptureChatTurnDeliverableOptions,
): Promise<DeliverableRecord | null> {
  const finishedAt = options.finishedAt ?? Date.now();
  const contentItems = await ctx.contentStore.list();
  const fileArtifacts = findRecentArtifacts(
    contentItems,
    [options.agentId],
    options.startedAt,
    finishedAt,
  );
  if (fileArtifacts.length === 0) {
    return null;
  }

  const channel = ctx.channels.get(options.channelId);
  const publications = buildChatTurnPublications(channel, options, fileArtifacts.length > 0);
  const deliverable = await ctx.deliverableStore.upsert(
    buildChatTurnDeliverable({
      agentId: options.agentId,
      threadKey: options.threadKey,
      channelId: options.channelId,
      startedAt: options.startedAt,
      finishedAt,
      replyText: options.replyText,
      fileArtifacts,
      publications,
    }),
  );
  await publishDeliverableTargets(ctx, deliverable);
  const latest = (await ctx.deliverableStore.get(deliverable.id)) ?? deliverable;

  ctx.inboxBroadcaster?.publish({
    kind: 'deliverable',
    agentId: options.agentId as AgentId,
    threadKey: options.threadKey as ThreadKey,
    channelId: options.channelId,
    title: `${options.agentId} deliverable ready`,
    text: latest.summary || latest.previewText || latest.title,
    deliverableId: latest.id,
    publicationSummary: latest.publications
      ?.map((item) => `${item.label}:${item.status}`)
      .join(' · '),
  });

  return latest;
}

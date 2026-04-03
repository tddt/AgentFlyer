import type { ServerResponse } from 'node:http';

export type InboxEventKind = 'agent_reply' | 'deliverable';

export interface InboxEvent {
  id: number;
  ts: number;
  kind: InboxEventKind;
  agentId?: string;
  threadKey?: string;
  channelId?: string;
  title: string;
  text: string;
  deliverableId?: string;
  publicationSummary?: string;
}

const MAX_EVENTS = 200;

export class InboxBroadcaster {
  private readonly subscribers = new Set<ServerResponse>();
  private readonly events: InboxEvent[] = [];
  private nextId = 1;

  private write(res: ServerResponse, event: InboxEvent): void {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }

  listRecent(limit = 40): InboxEvent[] {
    return this.events.slice(-limit).reverse();
  }

  subscribe(res: ServerResponse): void {
    for (const event of this.listRecent()) {
      this.write(res, event);
    }
    this.subscribers.add(res);
    res.on('close', () => {
      this.subscribers.delete(res);
    });
  }

  publish(event: Omit<InboxEvent, 'id' | 'ts'>): InboxEvent {
    const entry: InboxEvent = {
      id: this.nextId++,
      ts: Date.now(),
      ...event,
    };
    this.events.push(entry);
    if (this.events.length > MAX_EVENTS) {
      this.events.splice(0, this.events.length - MAX_EVENTS);
    }
    for (const subscriber of this.subscribers) {
      this.write(subscriber, entry);
    }
    return entry;
  }
}

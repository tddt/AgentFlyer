export class SchedulerActivityBroadcaster {
  private readonly listeners = new Set<() => void>();

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  publish(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

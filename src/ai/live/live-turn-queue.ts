export const LIVE_MAX_QUEUED_TURNS = 8; // Includes the running turn, per conversation.
type Task = {
  signal: AbortSignal;
  run: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  abort: () => void;
};
type Lane = { active?: Task; waiting: Task[]; latest: number };

// Shared by the singleton Live adapter, not a global application lock. A lane
// remains occupied until the actual job settles, including after a timeout.
export class LiveTurnQueue {
  private readonly lanes = new Map<string, Lane>();

  enqueue<T>(
    conversationId: string,
    signal: AbortSignal,
    run: (isLatest: () => boolean, depth: () => number) => Promise<T>,
    queued?: (depth: number) => void,
  ): Promise<T> {
    if (signal.aborted) return Promise.reject(signal.reason);
    const lane = this.lanes.get(conversationId) ?? { waiting: [], latest: 0 };
    const depth = () => lane.waiting.length + (lane.active ? 1 : 0);
    if (depth() >= LIVE_MAX_QUEUED_TURNS)
      return Promise.reject(new Error('Live conversation queue full'));
    this.lanes.set(conversationId, lane);
    const ticket = ++lane.latest;
    return new Promise<T>((resolve, reject) => {
      const task: Task = {
        signal,
        run: () => run(() => ticket === lane.latest, depth),
        resolve: (value) => resolve(value as T),
        reject,
        abort: () => {
          const index = lane.waiting.indexOf(task);
          if (index < 0) return;
          lane.waiting.splice(index, 1);
          signal.removeEventListener('abort', task.abort);
          reject(signal.reason);
          if (!depth()) this.lanes.delete(conversationId);
        },
      };
      lane.waiting.push(task);
      signal.addEventListener('abort', task.abort, { once: true });
      queued?.(depth());
      this.pump(conversationId, lane);
    });
  }

  private pump(conversationId: string, lane: Lane) {
    if (lane.active) return;
    const task = lane.waiting.shift();
    if (!task) {
      this.lanes.delete(conversationId);
      return;
    }
    task.signal.removeEventListener('abort', task.abort);
    lane.active = task;
    void Promise.resolve()
      .then(() => {
        task.signal.throwIfAborted();
        return task.run();
      })
      .then(task.resolve, task.reject)
      .finally(() => {
        lane.active = undefined;
        this.pump(conversationId, lane);
      });
  }
}

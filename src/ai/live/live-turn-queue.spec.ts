import { LiveTurnQueue, LIVE_MAX_QUEUED_TURNS } from './live-turn-queue.js';

describe('bounded conversation-scoped Live FIFO', () => {
  const signal = () => new AbortController().signal;
  it('bounds waiting work and releases the lane after a failed turn', async () => {
    const queue = new LiveTurnQueue();
    let release!: () => void;
    const first = queue.enqueue(
      'a',
      signal(),
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const running: Promise<unknown>[] = [first];
    for (let i = 1; i < LIVE_MAX_QUEUED_TURNS; i++)
      running.push(queue.enqueue('a', signal(), async () => i));
    await expect(queue.enqueue('a', signal(), async () => 99)).rejects.toThrow(
      'full',
    );
    await Promise.resolve();
    release();
    await Promise.all(running);
    await expect(
      queue.enqueue('a', signal(), async () => {
        throw new Error('failed');
      }),
    ).rejects.toThrow('failed');
    await expect(queue.enqueue('a', signal(), async () => 10)).resolves.toBe(
      10,
    );
  });
  it('does not serialize unrelated conversations', async () => {
    const queue = new LiveTurnQueue();
    let release!: () => void;
    const slow = queue.enqueue(
      'a',
      signal(),
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    await expect(queue.enqueue('b', signal(), async () => 2)).resolves.toBe(2);
    release();
    await slow;
  });
  it('removes an aborted waiting item without executing it', async () => {
    const queue = new LiveTurnQueue();
    let release!: () => void;
    const first = queue.enqueue(
      'a',
      signal(),
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const abort = new AbortController(),
      run = vi.fn();
    const second = queue.enqueue('a', abort.signal, run);
    const rejected = expect(second).rejects.toThrow();
    abort.abort();
    await rejected;
    await Promise.resolve();
    release();
    await first;
    expect(run).not.toHaveBeenCalled();
  });
});

import { randomUUID } from 'node:crypto';
import type {
  ConnectServerEvent,
  ConnectClientEvent,
} from 'openai/resources/live/sideband/sideband';
import type { FinanceTurnResult } from '../financial-read.js';
import type { LiveFinanceAdapter } from './live-finance.adapter.js';
import type { LiveOperation } from './live-turn-control.js';
import { LIVE_MAX_QUEUED_TURNS } from './live-turn-queue.js';

// SDK transcripts have no done marker. A boundary is application-owned: wait for
// quiet delivery, correlate the delegation's media offset, then freeze a turn.
// New input invalidates replies/final saves; pending-only updates finish in FIFO order.
export const LIVE_TURN_SETTLE_MS = 1500;
type Turn = {
  text: string;
  start: number;
  end: number;
  revision: number;
  settled: boolean;
  used: boolean;
  confirmationAllowed: boolean;
};
type Pending = {
  id: string;
  offset: number;
  deadline: ReturnType<typeof setTimeout>;
};
type Options = {
  sessionId: string;
  conversationId: string;
  finance: LiveFinanceAdapter;
  send(event: ConnectClientEvent): void;
  log(event: string, fields: Record<string, unknown>): void;
  work(active: boolean): void;
};

// Byte budgets are conservative token upper bounds (UTF-8 bytes >= tokens).
// Large results stay in the backend; these bounded, lossless parts are quiet
// context. Only the final correlated completion asks Live to speak.
export function resultEvents(
  id: string,
  result: FinanceTurnResult,
): ConnectClientEvent[] {
  const text = JSON.stringify(result);
  if (Buffer.byteLength(text) > 12000)
    return [
      {
        type: 'session.commentary.append',
        delegation_id: id,
        event_id: randomUUID(),
        content: JSON.stringify({
          type: 'RESULT_TOO_LARGE',
          narrowQueryRequired: true,
          balanceDisclosureAllowed: false,
        }),
      },
    ];
  if (Buffer.byteLength(text) <= 450)
    return [
      {
        type: 'session.commentary.append',
        delegation_id: id,
        event_id: randomUUID(),
        content: text,
      },
    ];
  const parts: string[] = [];
  let part = '';
  for (const character of text) {
    if (
      Buffer.byteLength(JSON.stringify({ fragment: part + character })) > 300
    ) {
      parts.push(part);
      part = '';
    }
    part += character;
  }
  if (part) parts.push(part);
  return [
    ...parts.map((fragment, index): ConnectClientEvent => ({
      type: 'session.thinking.append',
      delegation_id: id,
      event_id: randomUUID(),
      content: JSON.stringify({
        type: 'RESULT_PART',
        part: index + 1,
        parts: parts.length,
        fragment,
      }),
    })),
    {
      type: 'session.commentary.append',
      delegation_id: id,
      event_id: randomUUID(),
      content: JSON.stringify({
        type: result.type,
        complete: true,
        parts: parts.length,
        balanceDisclosureAllowed: result.balanceDisclosureAllowed,
      }),
    },
  ];
}

export class LiveDelegation {
  private turn?: Turn;
  private revision = 0;
  private quiet?: ReturnType<typeof setTimeout>;
  private readonly pending = new Map<string, Pending>();
  private readonly seen = new Set<string>();
  private readonly events = new Set<string>();
  private readonly jobs = new Map<
    string,
    { controller: AbortController; operation: LiveOperation }
  >();
  private closed = false;

  constructor(private readonly options: Options) {}
  private log(event: string, id: string, fields: Record<string, unknown> = {}) {
    this.options.log(event, {
      conversationId: this.options.conversationId,
      delegationId: id,
      ...fields,
    });
  }
  accept(event: ConnectServerEvent) {
    if (this.closed || this.events.has(event.event_id)) return;
    this.events.add(event.event_id);
    if (this.events.size > 500)
      this.events.delete(this.events.values().next().value!);
    if (event.type === 'session.input_transcript.delta') {
      if (
        !event.delta ||
        !Number.isFinite(event.start_ms) ||
        !Number.isFinite(event.end_ms) ||
        event.start_ms < 0 ||
        event.end_ms < event.start_ms
      )
        return;
      const last = this.turn;
      if (!event.delta.trim()) {
        if (last && !last.settled) last.text += event.delta;
        return;
      }
      // Delayed older transcripts must not become the current intent.
      if (last && event.end_ms < last.start) return;
      for (const job of this.jobs.values()) {
        if (job.operation === 'READ' || job.operation === 'COMMIT')
          job.controller.abort();
      }
      ++this.revision;
      if (!last || last.settled)
        this.turn = {
          text: '',
          start: event.start_ms,
          end: event.end_ms,
          revision: this.revision,
          settled: false,
          used: false,
          confirmationAllowed: this.jobs.size === 0,
        };
      const turn = this.turn!;
      turn.text += event.delta;
      turn.end = Math.max(turn.end, event.end_ms);
      turn.revision = this.revision;
      clearTimeout(this.quiet);
      this.quiet = setTimeout(() => {
        turn.settled = true;
        this.drain();
      }, LIVE_TURN_SETTLE_MS);
      this.quiet.unref();
    } else if (
      event.type === 'session.delegation.created' &&
      event.delegation.target === 'client'
    ) {
      const id = event.delegation.id;
      if (this.seen.has(id)) return;
      this.seen.add(id);
      if (this.seen.size > 100 || !Number.isFinite(event.offset_ms)) {
        this.failure(id, 'DELEGATION_LIMIT');
        return;
      }
      this.log('delegation_created', id);
      const deadline = setTimeout(() => {
        this.pending.delete(id);
        if (!this.turn || event.offset_ms >= this.turn.start)
          this.failure(id, 'TURN_UNAVAILABLE');
      }, 6000);
      deadline.unref();
      this.pending.set(id, { id, offset: event.offset_ms, deadline });
      this.drain();
    }
  }
  private drain() {
    const turn = this.turn;
    if (this.closed || !turn?.settled) return;
    for (const pending of this.pending.values()) {
      if (pending.offset < turn.start) {
        clearTimeout(pending.deadline);
        this.pending.delete(pending.id);
        this.log('delegation_error', pending.id, {
          reason: 'STALE_DELEGATION',
        });
        continue;
      }
      // An offset well beyond this utterance belongs to speech not received yet.
      if (pending.offset > turn.end + LIVE_TURN_SETTLE_MS) continue;
      clearTimeout(pending.deadline);
      this.pending.delete(pending.id);
      if (turn.used) {
        this.log('delegation_error', pending.id, { reason: 'DUPLICATE_TURN' });
        continue;
      }
      turn.used = true;
      this.log('delegation_correlated', pending.id, {
        revision: turn.revision,
      });
      if (this.jobs.size >= LIVE_MAX_QUEUED_TURNS) {
        this.failure(pending.id, 'QUEUE_FULL');
        continue;
      }
      void this.execute(pending.id, turn).catch(() => {
        if (turn.revision === this.revision)
          this.failure(pending.id, 'DELEGATION_FAILED');
      });
    }
  }
  private async execute(id: string, turn: Turn) {
    if (this.closed) return;
    const controller = new AbortController();
    const jobState = { controller, operation: 'READ' as LiveOperation };
    this.jobs.set(id, jobState);
    const timeoutController = new AbortController();
    const timeout = setTimeout(
      () => timeoutController.abort(new Error('Finance delegation timeout')),
      35000,
    );
    timeout.unref();
    const signal = AbortSignal.any([
      controller.signal,
      timeoutController.signal,
    ]);
    let abortWait: (() => void) | undefined;
    const started = Date.now();
    this.options.work(true);
    this.log('finance_start', id);
    try {
      const job = this.options.finance.execute(
        {
          sessionId: this.options.sessionId,
          conversationId: this.options.conversationId,
          delegationId: id,
          userTurn: turn.text.trim(),
        },
        signal,
        {
          isCurrent: () => !this.closed && turn.revision === this.revision,
          confirmationAllowed: turn.confirmationAllowed,
          onOperation: (operation) => {
            jobState.operation = operation;
            if (
              (operation === 'READ' || operation === 'COMMIT') &&
              turn.revision !== this.revision
            )
              controller.abort();
          },
          log: (event, fields) => this.log(event, id, fields),
        },
      );
      // Reads in progress cannot always cancel a DB query. Stop waiting at the
      // budget; the agent checks signal again before persisting/sending results.
      const result = await Promise.race([
        job,
        new Promise<never>((_resolve, reject) => {
          abortWait = () => reject(signal.reason);
          signal.addEventListener('abort', abortWait, { once: true });
          if (signal.aborted) abortWait();
        }),
      ]);
      if (
        this.closed ||
        controller.signal.aborted ||
        turn.revision !== this.revision
      )
        return;
      signal.throwIfAborted();
      if (result.conversationId !== this.options.conversationId)
        throw new Error('Conversation mismatch');
      this.log('finance_end', id, {
        durationMs: Date.now() - started,
        resultType: result.type,
      });
      for (const event of resultEvents(id, result)) this.options.send(event);
      this.log('result_sent', id, {
        durationMs: Date.now() - started,
        resultType: result.type,
      });
    } catch (error) {
      const superseded =
        controller.signal.aborted ||
        (error instanceof DOMException && error.name === 'AbortError');
      this.log('delegation_error', id, {
        durationMs: Date.now() - started,
        reason: superseded ? 'SUPERSEDED' : 'FINANCE_FAILED',
      });
      if (!this.closed && !superseded && turn.revision === this.revision)
        this.failure(id, 'FINANCE_UNAVAILABLE');
    } finally {
      clearTimeout(timeout);
      if (abortWait) signal.removeEventListener('abort', abortWait);
      this.jobs.delete(id);
      this.options.work(this.jobs.size > 0);
    }
  }
  private failure(id: string, reason: string) {
    if (this.closed) return;
    try {
      this.options.send({
        type: 'session.commentary.append',
        delegation_id: id,
        event_id: randomUUID(),
        content: JSON.stringify({
          type: 'FINANCIAL_READ_UNAVAILABLE',
          reason,
          balanceDisclosureAllowed: false,
          retryRequiresNewRequest: true,
        }),
      });
    } catch {
      this.log('delegation_error', id, { reason: 'RESULT_SEND_FAILED' });
    }
  }
  close() {
    this.closed = true;
    for (const job of this.jobs.values()) job.controller.abort();
    this.jobs.clear();
    clearTimeout(this.quiet);
    for (const pending of this.pending.values()) clearTimeout(pending.deadline);
    this.pending.clear();
    this.turn = undefined;
    this.events.clear();
    this.seen.clear();
  }
}

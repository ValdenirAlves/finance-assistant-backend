import { randomUUID } from 'node:crypto';
import type {
  ConnectClientEvent,
  ConnectServerEvent,
} from 'openai/resources/live/sideband/sideband';
import type { PocSpendingService } from './poc-spending.service.js';
import { pocLog } from './poc.config.js';

type ResponseState = {
  delegationId: string;
  calls: Set<string>;
  pending: number;
  complete: boolean;
  continued: boolean;
  failed: boolean;
};
const object = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

// Structured SDK events only. No user transcripts, local turn IDs or silence timers.
export class PocProtocol {
  private readonly delegations = new Map<string, string | undefined>();
  private readonly responses = new Map<string, ResponseState>();
  private readonly calls = new Set<string>();
  private closed = false;
  constructor(
    private readonly sessionId: string,
    private readonly spending: PocSpendingService,
    private readonly send: (event: ConnectClientEvent) => void,
  ) {}

  accept(event: ConnectServerEvent) {
    if (this.closed) return;
    if (event.type === 'session.delegation.created') {
      if (
        event.delegation.target !== 'responses' ||
        this.delegations.has(event.delegation.id)
      )
        return;
      if (this.delegations.size >= 32) throw new Error('POC delegation limit');
      this.delegations.set(event.delegation.id, event.delegation.response_id);
      this.log('delegation_created', event.delegation.id);
      return;
    }
    if (
      event.type !== 'response.event' ||
      !event.delegation_id ||
      !this.delegations.has(event.delegation_id)
    )
      return;
    const inner = event.event,
      snapshot = object(inner.response);
    // ResponseOutputItemDoneEvent in SDK 7.30.0 has NO response_id field.
    // Its response is the structurally announced response.created for this delegation.
    const responseId =
      typeof inner.response_id === 'string'
        ? inner.response_id
        : typeof snapshot?.id === 'string'
          ? snapshot.id
          : this.delegations.get(event.delegation_id);
    if (!responseId) return;
    if (inner.type === 'response.created') {
      const previousId = this.delegations.get(event.delegation_id);
      const previous = previousId ? this.responses.get(previousId) : undefined;
      if (
        previousId !== responseId &&
        previous &&
        !previous.complete &&
        !previous.failed
      )
        throw new Error('Overlapping POC backend responses');
      this.delegations.set(event.delegation_id, responseId);
    }
    let state = this.responses.get(responseId);
    if (!state) {
      // response_id in delegation.created identifies the initial response only.
      // Continuations can emit new response.created IDs for the same delegation.
      if (
        inner.type !== 'response.created' &&
        this.delegations.get(event.delegation_id) !== responseId
      )
        return;
      if (this.responses.size >= 64) throw new Error('POC response limit');
      state = {
        delegationId: event.delegation_id,
        calls: new Set(),
        pending: 0,
        complete: false,
        continued: false,
        failed: false,
      };
      this.responses.set(responseId, state);
    }
    if (state.delegationId !== event.delegation_id)
      throw new Error('POC delegation mismatch');
    if (inner.type === 'response.completed') {
      state.complete = true;
      this.resume(state);
      return;
    }
    if (
      inner.type === 'response.failed' ||
      inner.type === 'response.incomplete'
    ) {
      state.failed = true;
      return;
    }
    if (inner.type !== 'response.output_item.done' || state.failed) return;
    const item = object(inner.item);
    if (item?.type !== 'function_call') return;
    if (
      typeof item.call_id !== 'string' ||
      !item.call_id ||
      typeof item.name !== 'string' ||
      typeof item.arguments !== 'string' ||
      (item.status !== undefined && item.status !== 'completed')
    )
      throw new Error('Invalid completed POC function call');
    if (this.calls.has(item.call_id)) return;
    if (this.calls.size >= 64) throw new Error('POC function call limit');
    this.calls.add(item.call_id);
    state.calls.add(item.call_id);
    state.pending++;
    void this.execute(state, item.call_id, item.name, item.arguments).catch(
      () => {
        state.failed = true;
      },
    );
  }
  private async execute(
    state: ResponseState,
    callId: string,
    name: string,
    args: string,
  ) {
    const start = Date.now();
    const fields = {
      call_id: callId,
      tool: /^[a-z_][a-z0-9_]{0,63}$/i.test(name) ? name : 'INVALID_TOOL_NAME',
    };
    this.log('call_received', state.delegationId, fields);
    let result: unknown;
    try {
      const dto = this.spending.validate(name, args);
      this.log('call_validated', state.delegationId, fields);
      this.log('finance_start', state.delegationId, fields);
      result = await this.spending.read(dto);
      this.log('finance_end', state.delegationId, {
        ...fields,
        durationMs: Date.now() - start,
        status: 'success',
      });
    } catch {
      result = {
        error:
          'Unsupported read or invalid/unavailable arguments. No financial facts retrieved. No write occurred.',
      };
      this.log('finance_end', state.delegationId, {
        ...fields,
        durationMs: Date.now() - start,
        status: 'rejected_or_unavailable',
      });
    }
    if (this.closed || state.failed) return;
    this.send({
      type: 'response.item.create',
      event_id: randomUUID(),
      item: {
        type: 'function_call_output',
        call_id: callId,
        output: JSON.stringify(result),
      },
    });
    state.pending--;
    this.log('result_sent', state.delegationId, {
      ...fields,
      durationMs: Date.now() - start,
    });
    this.resume(state);
  }
  private resume(state: ResponseState) {
    if (
      this.closed ||
      state.failed ||
      !state.complete ||
      !state.calls.size ||
      state.pending ||
      state.continued
    )
      return;
    state.continued = true;
    this.send({ type: 'response.create', event_id: randomUUID() });
  }
  private log(
    event: string,
    delegationId: string,
    fields: Record<string, unknown> = {},
  ) {
    pocLog(event, {
      sessionId: this.sessionId,
      delegationId,
      durationMs: 0,
      ...fields,
    });
  }
  close() {
    this.closed = true;
    this.delegations.clear();
    this.responses.clear();
    this.calls.clear();
  }
}

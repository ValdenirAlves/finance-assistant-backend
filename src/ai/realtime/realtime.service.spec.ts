import { RealtimeService } from './realtime.service.js';
import { RealtimeConfig, resolveRealtimeConfig } from '../openai.config.js';
import type { RealtimeTransport } from './realtime.transport.js';
import type { RealtimeToolAdapter } from './realtime-tool.adapter.js';
import type { ConversationService } from '../../conversations/conversation.service.js';
import type { RealtimeServerEvent } from 'openai/resources/realtime/realtime';
import type { RealtimeTurnFilterService } from './realtime-turn-filter.service.js';
describe('realtime lifecycle deadlines', () => {
  let service: RealtimeService;
  let emit: (event: RealtimeServerEvent) => void;
  const send = vi.fn(),
    close = vi.fn(),
    execute = vi.fn();
  const transport = { offer: vi.fn(), attach: vi.fn(), hangup: vi.fn() };
  const classify = vi.fn();
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    classify.mockResolvedValue({
      classification: 'DIRECTED_TO_ASSISTANT',
      reasonCode: 'EXPLICIT_REQUEST',
      pendingStateExists: false,
    });
    transport.offer.mockResolvedValue({
      callId: 'rtc_test',
      sdp: 'v=0\r\nanswer',
    });
    transport.attach.mockImplementation(async (_id, event) => {
      emit = event;
      return { send, close };
    });
    execute.mockResolvedValue({
      conversationId: 'conversation',
      answer: 'Approved answer',
    });
    service = new RealtimeService(
      { settings: resolveRealtimeConfig({}) } as RealtimeConfig,
      transport as unknown as RealtimeTransport,
      { execute } as unknown as RealtimeToolAdapter,
      {
        create: vi.fn().mockResolvedValue({ id: 'conversation' }),
        recentMessages: vi.fn().mockResolvedValue([]),
      } as unknown as ConversationService,
      { classify } as unknown as RealtimeTurnFilterService,
    );
  });
  afterEach(async () => {
    await service.onModuleDestroy();
    vi.useRealTimers();
  });
  it('hangs up a session whose browser never completes setup', async () => {
    const session = await service.create({ sdp: 'v=0\r\noffer' });
    await vi.advanceTimersByTimeAsync(30000);
    expect(service.status(session.sessionId, session.token).state).toBe(
      'disconnected',
    );
    expect(close).toHaveBeenCalledOnce();
    expect(transport.hangup).toHaveBeenCalledOnce();
    expect(execute).not.toHaveBeenCalled();
  });
  it('fails safely when an utterance never receives a transcript', async () => {
    const session = await service.create({ sdp: 'v=0\r\noffer' });
    service.connected(session.sessionId, session.token);
    emit({
      type: 'input_audio_buffer.speech_stopped',
      item_id: 'waiting',
    } as RealtimeServerEvent);
    await vi.advanceTimersByTimeAsync(30000);
    expect(service.status(session.sessionId, session.token).state).toBe(
      'error',
    );
    expect(execute).not.toHaveBeenCalled();
    expect(transport.hangup).toHaveBeenCalledOnce();
  });
  it('times out a missing model/tool response without replaying financial work', async () => {
    const session = await service.create({ sdp: 'v=0\r\noffer' });
    service.connected(session.sessionId, session.token);
    emit({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'turn',
      transcript: 'Question',
    } as RealtimeServerEvent);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(30000);
    expect(service.status(session.sessionId, session.token).state).toBe(
      'error',
    );
    expect(execute).not.toHaveBeenCalled();
    expect(
      send.mock.calls.filter((c) => c[0].type === 'response.create'),
    ).toHaveLength(1);
  });
  it('hangs up a late offer completing after backend shutdown', async () => {
    let complete!: (value: unknown) => void;
    transport.offer.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const request = service.create({ sdp: 'v=0\r\noffer' });
    const rejection = expect(request).rejects.toThrow('Realtime is stopping');
    await Promise.resolve();
    await Promise.resolve();
    await service.onModuleDestroy();
    complete({ callId: 'rtc_late', sdp: 'answer' });
    await rejection;
    expect(transport.attach).not.toHaveBeenCalled();
    expect(transport.hangup).toHaveBeenCalledWith('rtc_late');
  });
  async function connectedSession() {
    const session = await service.create({ sdp: 'v=0\r\noffer' });
    service.connected(session.sessionId, session.token);
    return session;
  }
  it('does not request finance_turn before the semantic decision completes', async () => {
    let decide!: (value: unknown) => void;
    classify.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          decide = resolve;
        }),
    );
    await connectedSession();
    emit({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'filter',
      transcript: 'Question',
    } as RealtimeServerEvent);
    expect(send.mock.calls.some((c) => c[0].type === 'response.create')).toBe(
      false,
    );
    decide({
      classification: 'DIRECTED_TO_ASSISTANT',
      reasonCode: 'EXPLICIT_REQUEST',
      pendingStateExists: false,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(send.mock.calls.some((c) => c[0].type === 'response.create')).toBe(
      true,
    );
    expect(execute).not.toHaveBeenCalled();
  });
  it('does not renew idle lifetime for ignored background speech', async () => {
    const session = await connectedSession();
    await vi.advanceTimersByTimeAsync(50000);
    classify.mockResolvedValueOnce({
      classification: 'LIKELY_INCIDENTAL',
      reasonCode: 'UNRELATED_CONVERSATION',
      pendingStateExists: false,
    });
    emit({ type: 'input_audio_buffer.speech_started' } as RealtimeServerEvent);
    emit({
      type: 'input_audio_buffer.speech_stopped',
      item_id: 'noise',
    } as RealtimeServerEvent);
    emit({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'noise',
      transcript: 'Background conversation',
    } as RealtimeServerEvent);
    await vi.advanceTimersByTimeAsync(0);
    expect(service.status(session.sessionId, session.token)).toMatchObject({
      state: 'listening',
      turns: [],
    });
    await vi.advanceTimersByTimeAsync(9999);
    expect(close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(close).toHaveBeenCalledOnce();
    expect(execute).not.toHaveBeenCalled();
  });
  it('expires at the original T=60 deadline after a two-second ignored classification at T=40', async () => {
    const session = await connectedSession();
    await vi.advanceTimersByTimeAsync(40000);
    classify.mockImplementationOnce(
      () =>
        new Promise((resolve) =>
          setTimeout(
            () =>
              resolve({
                classification: 'LIKELY_INCIDENTAL',
                reasonCode: 'UNRELATED_CONVERSATION',
                pendingStateExists: true,
                awaitingConfirmation: true,
                pendingAction: 'UNRELATED',
              }),
            2000,
          ),
        ),
    );
    emit({ type: 'input_audio_buffer.speech_started' } as RealtimeServerEvent);
    emit({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'background',
      transcript: 'Nearby conversation',
    } as RealtimeServerEvent);
    await vi.advanceTimersByTimeAsync(2000);
    expect(service.status(session.sessionId, session.token).state).toBe(
      'listening',
    );
    await vi.advanceTimersByTimeAsync(17999);
    expect(close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(service.status(session.sessionId, session.token)).toMatchObject({
      state: 'disconnected',
      conversationId: 'conversation',
      turns: [],
    });
    expect(execute).not.toHaveBeenCalled();
  });
  it('cannot extend idle time through repeated overlapping ignored speech or slow classification', async () => {
    const session = await connectedSession();
    classify.mockImplementation(() => new Promise(() => {}));
    await vi.advanceTimersByTimeAsync(50000);
    emit({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'first',
      transcript: 'Noise',
    } as RealtimeServerEvent);
    const signal = classify.mock.calls[0][1];
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(2500);
      emit({
        type: 'input_audio_buffer.speech_started',
      } as RealtimeServerEvent);
      emit({
        type: 'conversation.item.input_audio_transcription.completed',
        item_id: `more${i}`,
        transcript: 'Noise',
      } as RealtimeServerEvent);
    }
    await vi.advanceTimersByTimeAsync(2500);
    expect(service.status(session.sessionId, session.token).state).toBe(
      'disconnected',
    );
    expect(signal.aborted).toBe(true);
    expect(execute).not.toHaveBeenCalled();
  });
  it.each([
    ['DIRECTED_TO_ASSISTANT', 'UNRELATED', 'OK.'],
    ['DIRECTED_TO_ASSISTANT', 'UNCERTAIN', 'Sim.'],
    ['UNCERTAIN', 'CONFIRM', 'Sim.'],
    ['DIRECTED_TO_ASSISTANT', 'CONFIRM', 'OK.'],
    [null, undefined, 'Background speech'],
  ])(
    'silently rejects pending speech: %s / %s / %s',
    async (classification, action, transcript) => {
      const session = await connectedSession();
      classify.mockResolvedValueOnce({
        classification,
        reasonCode: classification ? 'PENDING_RESPONSE' : 'FILTER_TIMEOUT',
        pendingStateExists: true,
        awaitingConfirmation: true,
        pendingAction: action,
      });
      emit({
        type: 'conversation.item.input_audio_transcription.completed',
        item_id: 'pending_noise',
        transcript,
      } as RealtimeServerEvent);
      await vi.advanceTimersByTimeAsync(0);
      expect(service.status(session.sessionId, session.token)).toMatchObject({
        state: 'listening',
        turns: [],
      });
      expect(send.mock.calls.some((c) => c[0].type === 'response.create')).toBe(
        false,
      );
      expect(execute).not.toHaveBeenCalled();
    },
  );
  it('renews the deadline only when a turn is accepted', async () => {
    const session = await connectedSession();
    await vi.advanceTimersByTimeAsync(40000);
    emit({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'accepted',
      transcript: 'Question',
    } as RealtimeServerEvent);
    await vi.advanceTimersByTimeAsync(0);
    // Completing routing is covered below; interruption ends this accepted turn
    // without renewing from the new, unaccepted capture.
    emit({ type: 'input_audio_buffer.speech_started' } as RealtimeServerEvent);
    await vi.advanceTimersByTimeAsync(59999);
    expect(close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(service.status(session.sessionId, session.token).state).toBe(
      'disconnected',
    );
  });
  it('logs ignored pending actions and the original remaining idle budget without raw transcript', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    const log = vi.spyOn(console, 'debug').mockImplementation(() => {});
    try {
      await connectedSession();
      await vi.advanceTimersByTimeAsync(40000);
      classify.mockResolvedValueOnce({
        classification: 'DIRECTED_TO_ASSISTANT',
        reasonCode: 'PENDING_RESPONSE',
        pendingStateExists: true,
        awaitingConfirmation: true,
        pendingAction: 'UNRELATED',
      });
      emit({
        type: 'conversation.item.input_audio_transcription.completed',
        item_id: 'logged',
        transcript: 'Private background utterance',
      } as RealtimeServerEvent);
      await vi.advanceTimersByTimeAsync(0);
      const events = log.mock.calls.map(([line]) => JSON.parse(line));
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            event: 'realtime.pending_action',
            action: 'UNRELATED',
            allowed: false,
          }),
          expect.objectContaining({
            event: 'realtime.turn_ignored',
            acceptedActivity: false,
          }),
          expect.objectContaining({
            event: 'realtime.idle_deadline',
            reason: 'ignored_turn',
            acceptedActivity: false,
            remainingIdleMs: 20000,
          }),
        ]),
      );
      expect(JSON.stringify(events)).not.toContain(
        'Private background utterance',
      );
    } finally {
      log.mockRestore();
      vi.unstubAllEnvs();
    }
  });
  it('keeps the hard cap even during an accepted financial operation', async () => {
    const session = await connectedSession();
    execute.mockImplementationOnce(() => new Promise(() => {}));
    emit({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'busy',
      transcript: 'Question',
    } as RealtimeServerEvent);
    await vi.advanceTimersByTimeAsync(0);
    emit({
      type: 'response.created',
      response: { id: 'route_busy', metadata: { turnId: 'busy' } },
    } as RealtimeServerEvent);
    emit({
      type: 'response.function_call_arguments.done',
      response_id: 'route_busy',
      name: 'finance_turn',
      arguments: '{}',
      call_id: 'busy',
    } as RealtimeServerEvent);
    await vi.advanceTimersByTimeAsync(599999);
    expect(close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(service.status(session.sessionId, session.token).state).toBe(
      'disconnected',
    );
  });
  it('aborts classification on stop and ignores a late positive decision', async () => {
    let decide!: (value: unknown) => void;
    classify.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          decide = resolve;
        }),
    );
    const session = await connectedSession();
    emit({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'late',
      transcript: 'Question',
    } as RealtimeServerEvent);
    await service.stop(session.sessionId, session.token);
    expect(classify.mock.calls[0][1].aborted).toBe(true);
    decide({
      classification: 'DIRECTED_TO_ASSISTANT',
      reasonCode: 'EXPLICIT_REQUEST',
      pendingStateExists: false,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(send.mock.calls.some((c) => c[0].type === 'response.create')).toBe(
      false,
    );
    expect(execute).not.toHaveBeenCalled();
  });
  it('ignores unavailable context when pending confirmation state cannot be established', async () => {
    const session = await connectedSession();
    classify.mockRejectedValueOnce(new Error('unavailable'));
    emit({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'failed',
      transcript: 'Question',
    } as RealtimeServerEvent);
    await vi.advanceTimersByTimeAsync(0);
    expect(service.status(session.sessionId, session.token)).toMatchObject({
      state: 'listening',
      turns: [],
    });
    expect(close).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(send.mock.calls.some((c) => c[0].type === 'response.create')).toBe(
      false,
    );
    expect(service.getTurnFilterMetrics()).toMatchObject({
      filterUnavailable: 1,
      fallbackAccepted: 0,
      fallbackRejected: 1,
    });
  });
  it.each(['FILTER_TIMEOUT', 'FILTER_UNAVAILABLE'] as const)(
    'routes %s once while listening without inventing a semantic classification',
    async (reasonCode) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      await connectedSession();
      classify.mockResolvedValueOnce({
        classification: null,
        reasonCode,
        pendingStateExists: false,
      });
      emit({
        type: 'conversation.item.input_audio_transcription.completed',
        item_id: 'fallback',
        transcript: 'Ontem eu gastei 15 euros e 40 centavos no PetStop',
      } as RealtimeServerEvent);
      await vi.advanceTimersByTimeAsync(0);
      expect(
        send.mock.calls.filter((c) => c[0].type === 'response.create'),
      ).toHaveLength(1);
      emit({
        type: 'response.created',
        response: { id: 'route', metadata: { turnId: 'fallback' } },
      } as RealtimeServerEvent);
      const call = {
        type: 'response.function_call_arguments.done',
        response_id: 'route',
        name: 'finance_turn',
        arguments: '{}',
        call_id: 'once',
      } as RealtimeServerEvent;
      emit(call);
      emit(call);
      await vi.advanceTimersByTimeAsync(0);
      expect(execute).toHaveBeenCalledOnce();
      expect(execute).toHaveBeenCalledWith(
        'finance_turn',
        '{}',
        'Ontem eu gastei 15 euros e 40 centavos no PetStop',
        'conversation',
      );
      expect(service.getTurnFilterMetrics()).toMatchObject({
        filterSuccess: 0,
        fallbackAccepted: 1,
        fallbackRejected: 0,
        [reasonCode === 'FILTER_TIMEOUT'
          ? 'filterTimeout'
          : 'filterUnavailable']: 1,
      });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(reasonCode));
      expect(warn.mock.calls.flat().join(' ')).not.toContain('PetStop');
      warn.mockRestore();
    },
  );
  it.each(['LIKELY_INCIDENTAL', 'UNCERTAIN'] as const)(
    'preserves successful %s decisions',
    async (classification) => {
      await connectedSession();
      classify.mockResolvedValueOnce({
        classification,
        reasonCode: 'AMBIGUOUS_DIRECTION',
        pendingStateExists: false,
      });
      emit({
        type: 'conversation.item.input_audio_transcription.completed',
        item_id: 'semantic',
        transcript: 'A captured utterance',
      } as RealtimeServerEvent);
      await vi.advanceTimersByTimeAsync(0);
      expect(send.mock.calls.some((c) => c[0].type === 'response.create')).toBe(
        false,
      );
      expect(service.getTurnFilterMetrics()).toMatchObject({
        filterSuccess: 1,
        fallbackAccepted: 0,
        filterUnavailable: 0,
      });
    },
  );
  it.each(['speaking', 'processing'] as const)(
    'rejects infrastructure fallback for speech captured while %s',
    async (assistantState) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      await connectedSession();
      classify.mockResolvedValueOnce({
        classification: null,
        reasonCode: 'FILTER_TIMEOUT',
        pendingStateExists: false,
      });
      // Simulate the server-recorded capture state, never text matching or a client flag.
      const session = [...(service as any).sessions.values()][0];
      session.captureState = assistantState;
      emit({
        type: 'input_audio_buffer.speech_stopped',
        item_id: 'background',
      } as RealtimeServerEvent);
      emit({
        type: 'conversation.item.input_audio_transcription.completed',
        item_id: 'background',
        transcript: 'A captured utterance',
      } as RealtimeServerEvent);
      await vi.advanceTimersByTimeAsync(0);
      expect(send.mock.calls.some((c) => c[0].type === 'response.create')).toBe(
        false,
      );
      expect(service.getTurnFilterMetrics()).toMatchObject({
        filterTimeout: 1,
        fallbackRejected: 1,
        fallbackAccepted: 0,
      });
      warn.mockRestore();
    },
  );
  it('does not fall back before the browser confirms an active connection', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await service.create({ sdp: 'v=0\r\noffer' });
    classify.mockResolvedValueOnce({
      classification: null,
      reasonCode: 'FILTER_UNAVAILABLE',
      pendingStateExists: false,
    });
    emit({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'early',
      transcript: 'Question',
    } as RealtimeServerEvent);
    await vi.advanceTimersByTimeAsync(0);
    expect(send.mock.calls.some((c) => c[0].type === 'response.create')).toBe(
      false,
    );
    expect(service.getTurnFilterMetrics().fallbackRejected).toBe(1);
    warn.mockRestore();
  });
  it('expires idle connections without invalidating the conversation', async () => {
    const session = await connectedSession();
    await vi.advanceTimersByTimeAsync(59999);
    expect(service.status(session.sessionId, session.token).state).toBe(
      'listening',
    );
    await vi.advanceTimersByTimeAsync(1);
    expect(service.status(session.sessionId, session.token)).toMatchObject({
      state: 'disconnected',
      conversationId: 'conversation',
    });
    const next = await service.create({
      sdp: 'v=0\r\noffer',
      conversationId: session.conversationId,
    });
    expect(next.conversationId).toBe(session.conversationId);
    expect(next.sessionId).not.toBe(session.sessionId);
  });
  it('status polling does not renew idle timeout', async () => {
    const session = await connectedSession();
    await vi.advanceTimersByTimeAsync(50000);
    service.status(session.sessionId, session.token);
    await vi.advanceTimersByTimeAsync(10000);
    expect(close).toHaveBeenCalledOnce();
  });
  it('does not suspend the idle deadline for unaccepted continuous speech', async () => {
    await connectedSession();
    await vi.advanceTimersByTimeAsync(50000);
    emit({ type: 'input_audio_buffer.speech_started' } as RealtimeServerEvent);
    await vi.advanceTimersByTimeAsync(9999);
    expect(close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(close).toHaveBeenCalledOnce();
  });
  it('renews idle timeout after a response and waits for playback to finish', async () => {
    const session = await connectedSession();
    await vi.advanceTimersByTimeAsync(50000);
    emit({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'renew',
      transcript: 'Question',
    } as RealtimeServerEvent);
    await vi.advanceTimersByTimeAsync(0);
    emit({
      type: 'response.created',
      response: { id: 'route', metadata: { turnId: 'renew' } },
    } as RealtimeServerEvent);
    emit({
      type: 'response.function_call_arguments.done',
      response_id: 'route',
      name: 'finance_turn',
      arguments: '{}',
      call_id: 'call',
    } as RealtimeServerEvent);
    await vi.advanceTimersByTimeAsync(0);
    emit({
      type: 'response.created',
      response: { id: 'speech', metadata: { turnId: 'renew' } },
    } as RealtimeServerEvent);
    emit({
      type: 'output_audio_buffer.started',
      response_id: 'speech',
    } as RealtimeServerEvent);
    emit({
      type: 'response.done',
      response: { id: 'speech', status: 'completed' },
    } as RealtimeServerEvent);
    await vi.advanceTimersByTimeAsync(70000);
    expect(close).not.toHaveBeenCalled();
    emit({
      type: 'output_audio_buffer.stopped',
      response_id: 'speech',
    } as RealtimeServerEvent);
    await vi.advanceTimersByTimeAsync(59999);
    expect(close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(service.status(session.sessionId, session.token).state).toBe(
      'disconnected',
    );
    expect(execute).toHaveBeenCalledOnce();
  });
});

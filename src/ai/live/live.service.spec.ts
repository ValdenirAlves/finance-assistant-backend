import { LiveService } from './live.service.js';
import { LiveConfig, resolveLiveConfig } from './live.config.js';
import { LiveTransport } from './live.transport.js';
import { LiveFinanceAdapter } from './live-finance.adapter.js';
import type { ConnectServerEvent } from 'openai/resources/live/sideband/sideband';
describe('GPT-Live connectivity lifecycle with read-only delegation', () => {
  let service: LiveService,
    emit: (event: ConnectServerEvent) => void,
    fail: (error: unknown) => void;
  const transport = { offer: vi.fn(), attach: vi.fn(), hangup: vi.fn() },
    closeGracefully = vi.fn();
  const id = '11111111-1111-4111-8111-111111111111';
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    transport.offer.mockResolvedValue({ liveId: 'live_test', sdp: 'answer' });
    transport.attach.mockImplementation(async (_id, event, error) => {
      emit = event;
      fail = error;
      return { closeGracefully };
    });
    service = new LiveService(
      {
        settings: resolveLiveConfig({ GPT_LIVE_ENABLED: 'true' }),
      } as LiveConfig,
      transport as unknown as LiveTransport,
      {
        openConversation: vi.fn(
          async (id?: string) => id ?? '11111111-1111-4111-8111-111111111111',
        ),
      } as unknown as LiveFinanceAdapter,
    );
  });
  afterEach(async () => {
    await service.onModuleDestroy();
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });
  const event = (value: object) => emit(value as ConnectServerEvent);
  it('preserves an existing validated conversation reference', async () => {
    const s = await service.create({ sdp: 'offer', conversationId: id });
    expect(s.conversationId).toBe(id);
    expect(s).not.toHaveProperty('liveId');
    expect(() => service.status(s.sessionId, 'wrong')).toThrow(
      'Invalid GPT-Live session token',
    );
    service.connected(s.sessionId, s.token);
    await service.stop(s.sessionId, s.token);
    await service.stop(s.sessionId, s.token);
    expect(closeGracefully).toHaveBeenCalledOnce();
    expect(transport.hangup).toHaveBeenCalledOnce();
    expect(service.status(s.sessionId, s.token)).toMatchObject({
      state: 'disconnected',
      conversationId: id,
    });
  });
  it('supports multiple transcript exchanges and overlapping speech in one session', async () => {
    const s = await service.create({ sdp: 'offer' });
    service.connected(s.sessionId, s.token);
    for (let i = 0; i < 3; i++) {
      event({
        type: 'session.input_transcript.delta',
        event_id: `u${i}`,
        delta: 'Hello',
      });
      event({
        type: 'session.output_transcript.delta',
        event_id: `a${i}`,
        delta: 'Hi',
      });
      await vi.advanceTimersByTimeAsync(2000);
      expect(service.status(s.sessionId, s.token).state).toBe('listening');
    }
    expect(transport.offer).toHaveBeenCalledOnce();
  });
  it('expires on idle, ignores reflected audio/whitespace and preserves the conversation reference', async () => {
    const s = await service.create({ sdp: 'offer', conversationId: id });
    service.connected(s.sessionId, s.token);
    await vi.advanceTimersByTimeAsync(40000);
    event({ type: 'session.input_audio.append', audio: 'not stored' });
    event({
      type: 'session.input_transcript.delta',
      event_id: 'blank',
      delta: ' ',
    });
    await vi.advanceTimersByTimeAsync(20000);
    expect(service.status(s.sessionId, s.token)).toMatchObject({
      state: 'disconnected',
      conversationId: id,
    });
    expect(closeGracefully).toHaveBeenCalledOnce();
  });
  it('renews idle for transcript activity, but not duplicate events', async () => {
    const s = await service.create({ sdp: 'offer' });
    service.connected(s.sessionId, s.token);
    await vi.advanceTimersByTimeAsync(40000);
    const input = {
      type: 'session.input_transcript.delta',
      event_id: 'u',
      delta: 'A new conversational turn',
    };
    event(input);
    await vi.advanceTimersByTimeAsync(40000);
    event(input);
    await vi.advanceTimersByTimeAsync(19999);
    expect(closeGracefully).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(closeGracefully).toHaveBeenCalledOnce();
  });
  it('cleans up a failed sideband without restarting or replaying work', async () => {
    const s = await service.create({ sdp: 'offer' });
    service.connected(s.sessionId, s.token);
    fail(new Error('lost'));
    await vi.advanceTimersByTimeAsync(0);
    expect(service.status(s.sessionId, s.token).state).toBe('error');
    expect(closeGracefully).toHaveBeenCalledOnce();
    expect(transport.offer).toHaveBeenCalledOnce();
  });
  it('bounds sessions whose browser never connects', async () => {
    const s = await service.create({ sdp: 'offer' });
    await vi.advanceTimersByTimeAsync(30000);
    expect(service.status(s.sessionId, s.token).state).toBe('disconnected');
  });
  it('cleans remote sessions when sideband attachment fails', async () => {
    transport.attach.mockRejectedValueOnce(new Error('cannot attach'));
    await expect(service.create({ sdp: 'offer' })).rejects.toThrow(
      'Unable to connect GPT-Live',
    );
    expect(transport.hangup).toHaveBeenCalledWith('live_test');
  });
  it('reports model access errors safely in development', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('OPENAI_API_KEY', 'secret-key');
    const log = vi.spyOn(console, 'debug').mockImplementation(() => {});
    transport.offer.mockRejectedValueOnce({
      status: 403,
      error: { code: 'model_not_found', message: 'No model access secret-key' },
    });
    try {
      await service.create({ sdp: 'offer' });
      throw new Error('Expected failure');
    } catch (error) {
      const body = (error as { getResponse(): unknown }).getResponse();
      expect(body).toMatchObject({
        diagnostics: { status: 403, code: 'model_not_found' },
      });
      expect(JSON.stringify(body)).not.toContain('secret-key');
    } finally {
      log.mockRestore();
    }
  });
});

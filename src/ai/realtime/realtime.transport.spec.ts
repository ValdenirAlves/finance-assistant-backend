import { RealtimeTransport } from './realtime.transport.js';
import { RealtimeConfig, resolveRealtimeConfig } from '../openai.config.js';
describe('realtime server authorization and session offer', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });
  it('sends the permanent key only upstream and disables autonomous financial answers', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-secret-key');
    const fetch = vi.fn().mockResolvedValue(
      new Response('v=0\r\nanswer', {
        status: 201,
        headers: { Location: '/v1/realtime/calls/rtc_test' },
      }),
    );
    vi.stubGlobal('fetch', fetch);
    const transport = new RealtimeTransport({
      settings: resolveRealtimeConfig({}),
    } as RealtimeConfig);
    expect(await transport.offer('v=0\r\noffer')).toEqual({
      callId: 'rtc_test',
      sdp: 'v=0\r\nanswer',
    });
    const request = fetch.mock.calls[0][1];
    expect(request.headers.Authorization).toBe('Bearer test-secret-key');
    const config = JSON.parse(request.body.get('session'));
    expect(config).toMatchObject({
      type: 'realtime',
      model: 'gpt-realtime-2.1-mini',
      tools: [],
      audio: {
        input: {
          turn_detection: { create_response: false, interrupt_response: true },
        },
      },
    });
    expect(JSON.stringify(config)).not.toContain('test-secret-key');
  });
  it('sanitizes upstream errors rather than returning keys/provider payloads', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'test-secret-key');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response('private upstream error test-secret-key', {
          status: 401,
        }),
      ),
    );
    await expect(
      new RealtimeTransport({
        settings: resolveRealtimeConfig({}),
      } as RealtimeConfig).offer('v=0\r\noffer'),
    ).rejects.toThrow('Unable to create realtime session');
  });
  it.each([
    { VOICE_RUNTIME_MODE: 'invalid' },
    { OPENAI_REALTIME_MODEL: '' },
    { OPENAI_REALTIME_VOICE: 'bad voice' },
    { OPENAI_REALTIME_FILTER_MODEL: '' },
    { REALTIME_IDLE_TIMEOUT_MS: '0' },
    { REALTIME_IDLE_TIMEOUT_MS: '-1' },
    { REALTIME_IDLE_TIMEOUT_MS: '1.5' },
    { REALTIME_MAX_SESSION_MS: 'NaN' },
    { REALTIME_MAX_SESSION_MS: '2147483648' },
  ])('rejects invalid configuration %j', (env) =>
    expect(() => resolveRealtimeConfig(env)).toThrow(),
  );
  it('keeps realtime model separate from chat configuration', () => {
    expect(
      resolveRealtimeConfig({
        OPENAI_CHAT_MODEL: 'unrelated-model',
        VOICE_RUNTIME_MODE: 'realtime',
      }),
    ).toMatchObject({ mode: 'realtime', model: 'gpt-realtime-2.1-mini' });
  });
  it('uses configurable idle and hard maximum deadlines', () => {
    expect(resolveRealtimeConfig({})).toMatchObject({
      idleTimeoutMs: 60000,
      maxSessionMs: 600000,
    });
    expect(
      resolveRealtimeConfig({
        REALTIME_IDLE_TIMEOUT_MS: '1500',
        REALTIME_MAX_SESSION_MS: '120000',
      }),
    ).toMatchObject({ idleTimeoutMs: 1500, maxSessionMs: 120000 });
  });
});

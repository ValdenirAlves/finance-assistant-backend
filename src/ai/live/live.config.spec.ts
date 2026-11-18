import { resolveLiveConfig, liveErrorDetails } from './live.config.js';
describe('experimental GPT-Live configuration', () => {
  it('is disabled by default and keeps separate session limits', () => {
    expect(resolveLiveConfig({})).toEqual({
      enabled: false,
      model: 'gpt-live-1',
      voice: 'vesper',
      idleTimeoutMs: 60000,
      maxSessionMs: 600000,
    });
    expect(
      resolveLiveConfig({
        GPT_LIVE_ENABLED: 'true',
        LIVE_IDLE_TIMEOUT_MS: '5000',
      }),
    ).toMatchObject({ enabled: true, idleTimeoutMs: 5000 });
  });
  it('allows the backend environment to override the default Live voice', () => {
    expect(resolveLiveConfig({ OPENAI_LIVE_VOICE: 'quartz' }).voice).toBe(
      'quartz',
    );
  });
  it.each([
    { GPT_LIVE_ENABLED: 'yes' },
    { OPENAI_LIVE_MODEL: 'bad model' },
    { OPENAI_LIVE_VOICE: '' },
    { OPENAI_LIVE_VOICE: 'bad voice' },
    { LIVE_IDLE_TIMEOUT_MS: '0' },
    { LIVE_MAX_SESSION_MS: 'NaN' },
  ])('rejects invalid config %j', (env) =>
    expect(() => resolveLiveConfig(env)).toThrow(),
  );
  it('redacts the actual API key as well as credential-shaped strings', () => {
    vi.stubEnv('OPENAI_API_KEY', 'private-test-key');
    expect(
      JSON.stringify(
        liveErrorDetails({
          status: 403,
          error: {
            code: 'model_not_found',
            message: 'Denied private-test-key Bearer secret sk-example',
          },
        }),
      ),
    ).not.toMatch(/private-test-key|Bearer secret|sk-example/);
    vi.unstubAllEnvs();
  });
});

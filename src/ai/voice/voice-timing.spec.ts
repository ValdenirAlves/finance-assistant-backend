import { of, lastValueFrom } from 'rxjs';
import type { ExecutionContext } from '@nestjs/common';
import { VoiceTimingInterceptor, timing, aiRound } from './voice-timing.js';
describe('development voice timing logs', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });
  it('emits structured request timing and round count without content', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    const log = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const interceptor = new VoiceTimingInterceptor();
    const result = await lastValueFrom(
      interceptor.intercept(
        {
          switchToHttp: () => ({
            getRequest: () => ({
              headers: {
                'x-voice-turn': '2',
                'x-voice-request-id': '00000000-0000-0000-0000-000000000001',
              },
              socket: { localPort: 3000 },
              originalUrl: '/ai/voice',
            }),
          }),
        } as unknown as ExecutionContext,
        {
          handle: () => {
            timing('upload_received', { audioBytes: 123 });
            aiRound({ model: 'test' });
            return of({ answer: 'private financial text' });
          },
        },
      ),
    );
    expect(result).toEqual({ answer: 'private financial text' });
    const rows = log.mock.calls.map((call) => JSON.parse(call[0] as string));
    expect(rows.at(-1)).toMatchObject({
      event: 'voice.backend_total',
      toolCallRounds: 1,
      voiceTurn: 2,
      pid: process.pid,
      port: 3000,
      clientRequestId: '00000000-0000-0000-0000-000000000001',
    });
    expect(new Set(rows.map((row) => row.requestId)).size).toBe(1);
    expect(JSON.stringify(rows)).not.toContain('private financial text');
  });
  it('never emits logs in production', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const log = vi.spyOn(console, 'debug').mockImplementation(() => {});
    await lastValueFrom(
      new VoiceTimingInterceptor().intercept({} as ExecutionContext, {
        handle: () => {
          timing('upload_received');
          return of('same response');
        },
      }),
    );
    expect(log).not.toHaveBeenCalled();
  });
});

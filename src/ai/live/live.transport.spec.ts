import { EventEmitter } from 'node:events';
import { LiveTransport } from './live.transport.js';
import { LiveConfig, resolveLiveConfig } from './live.config.js';
const { create, hangup, connections } = vi.hoisted(() => ({
  create: vi.fn(),
  hangup: vi.fn(),
  connections: [] as any[],
}));
vi.mock('openai', () => ({
  default: class {
    live = { create, sessions: { hangup } };
  },
}));
vi.mock('openai/resources/live/sideband/ws', () => ({
  SidebandWS: class extends EventEmitter {
    socket = Object.assign(new EventEmitter(), { readyState: 1 });
    send = vi.fn(() => this.emit('session.closed', {}));
    close = vi.fn();
    constructor(...args: any[]) {
      super();
      connections.push({ connection: this, args });
    }
  },
}));
describe('official GPT-Live transport', () => {
  let transport: LiveTransport;
  beforeEach(() => {
    vi.resetAllMocks();
    connections.length = 0;
    vi.stubEnv('OPENAI_API_KEY', 'test-key');
    transport = new LiveTransport({
      settings: resolveLiveConfig({}),
    } as LiveConfig);
  });
  afterEach(() => vi.unstubAllEnvs());
  it('uses Live SDK create with client delegation, no backend tools/history and a restricted browser channel', async () => {
    create.mockResolvedValue({
      session: { id: 'live_test' },
      transport: { sdp: 'answer' },
    });
    expect(await transport.offer('offer')).toEqual({
      liveId: 'live_test',
      sdp: 'answer',
    });
    const body = create.mock.calls[0][0];
    expect(body).toMatchObject({
      session: {
        model: 'gpt-live-1',
        audio: { output: { voice: 'vesper' } },
        delegation: { type: 'client' },
        store: false,
        client: { data_channel: { allowed_client_events: [] } },
      },
      transport: { type: 'webrtc', sdp: 'offer' },
    });
    expect(body.session.tools).toBeUndefined();
    expect(body.session.input).toBeUndefined();
    expect(body.session.instructions).toContain('separate explicit save confirmation');
    expect(body.session.instructions).toContain(
      'Never answer financial numeric questions or decide an expense was saved from memory',
    );
    expect(JSON.stringify(body)).not.toContain('test-key');
  });
  it('sends the configured voice in the existing Live SDK creation payload', async () => {
    transport = new LiveTransport({
      settings: resolveLiveConfig({ OPENAI_LIVE_VOICE: 'quartz' }),
    } as LiveConfig);
    create.mockResolvedValue({
      session: { id: 'live_test' },
      transport: { sdp: 'answer' },
    });
    await transport.offer('offer');
    expect(create).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        session: expect.objectContaining({
          audio: { output: { voice: 'quartz' } },
        }),
      }),
    );
  });
  it('attaches the server sideband and requests graceful close before releasing it', async () => {
    const event = vi.fn(),
      failed = vi.fn();
    const connection = await transport.attach('live_test', event, failed);
    const socket = connections[0].connection;
    expect(connections[0].args[1]).toEqual({ session_id: 'live_test' });
    socket.emit('event', { type: 'session.started' });
    expect(event).toHaveBeenCalledOnce();
    await connection.closeGracefully();
    expect(socket.send).toHaveBeenCalledWith({ type: 'session.close' });
    expect(socket.close).toHaveBeenCalledOnce();
  });
  it('hangs up using the Live SDK without retries', async () => {
    await transport.hangup('live_test');
    expect(hangup).toHaveBeenCalledWith('live_test', {
      timeout: 5000,
      maxRetries: 0,
    });
  });
});

import type {
  ConnectServerEvent,
  ConnectClientEvent,
} from 'openai/resources/live/sideband/sideband';
import type { ResponseOutputItemDoneEvent } from 'openai/resources/responses/responses';
import { PocProtocol } from './poc.protocol.js';
import { PocSpendingService, spendingTool } from './poc-spending.service.js';
import { resolvePocConfig, PocConfig } from './poc.config.js';
import { managedSessionPayload, PocTransport } from './poc.transport.js';
import type { AnalyticsService } from '../../analytics/analytics.service.js';
import type { LiveTransport } from '../live/live.transport.js';
const { sdkCreate, standaloneResponses } = vi.hoisted(() => ({
  sdkCreate: vi.fn(),
  standaloneResponses: vi.fn(),
}));
vi.mock('openai', () => ({
  default: class {
    live = { create: sdkCreate };
    responses = { create: standaloneResponses };
  },
}));

const filters = {
  year: 2026,
  month: 10,
  merchant: null,
  category: null,
  currency: null,
};
let eventId = 0;
const envelope = (
  event: Record<string, unknown>,
  delegation_id = 'd1',
): ConnectServerEvent => ({
  type: 'response.event',
  event_id: `e${++eventId}`,
  delegation_id,
  event,
});
const delegation = (id = 'd1', response_id = 'r1'): ConnectServerEvent => ({
  type: 'session.delegation.created',
  event_id: `e${++eventId}`,
  offset_ms: 0,
  delegation: { id, target: 'responses', type: 'delegation', response_id },
});
const completedCall = (
  name = 'get_spending',
  args: unknown = filters,
  callId = 'c1',
): ResponseOutputItemDoneEvent => ({
  type: 'response.output_item.done',
  output_index: 0,
  sequence_number: 2,
  item: {
    type: 'function_call',
    id: `fc_${callId}`,
    call_id: callId,
    name,
    arguments: typeof args === 'string' ? args : JSON.stringify(args),
    status: 'completed',
  },
});
const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

describe('Phase 0 managed Responses contract', () => {
  const spendingPace = vi.fn();
  let protocol: PocProtocol,
    service: PocSpendingService,
    send: ReturnType<typeof vi.fn>;
  const begin = () => {
    protocol.accept(delegation());
    protocol.accept(
      envelope({ type: 'response.created', response: { id: 'r1' } }),
    );
  };
  const finish = (responseId = 'r1', delegationId = 'd1') =>
    protocol.accept(
      envelope(
        {
          type: 'response.completed',
          response: { id: responseId, output: [] },
        },
        delegationId,
      ),
    );
  const output = () => {
    const event = send.mock.calls
      .map(([event]) => event as ConnectClientEvent)
      .find((event) => event.type === 'response.item.create');
    if (
      !event ||
      event.type !== 'response.item.create' ||
      event.item.type !== 'function_call_output' ||
      typeof event.item.output !== 'string'
    )
      throw new Error('No function result');
    return JSON.parse(event.item.output);
  };
  beforeEach(() => {
    vi.resetAllMocks();
    service = new PocSpendingService({
      spendingPace,
    } as unknown as AnalyticsService);
    send = vi.fn();
    protocol = new PocProtocol('session', service, send);
    spendingPace.mockResolvedValue({
      period: { year: 2026, month: 10, effectiveDate: '2026-10-28' },
      results: [
        { currency: 'EUR', spentToDate: '1840.30' },
        { currency: 'BRL', spentToDate: '2730.50' },
      ],
    });
  });
  afterEach(() => {
    protocol.close();
    vi.unstubAllEnvs();
  });

  it('defaults off and refuses non-development environments even with the flag enabled', () => {
    expect(resolvePocConfig({}).enabled).toBe(false);
    expect(resolvePocConfig({ NODE_ENV: 'development' }).enabled).toBe(false);
    for (const NODE_ENV of ['production', 'test', undefined])
      expect(
        resolvePocConfig({
          NODE_ENV,
          GPT_LIVE_RESPONSES_DELEGATION_EXPERIMENT: 'true',
        }).enabled,
      ).toBe(false);
    expect(
      resolvePocConfig({
        NODE_ENV: 'development',
        GPT_LIVE_RESPONSES_DELEGATION_EXPERIMENT: 'true',
      }).enabled,
    ).toBe(true);
  });
  it('uses the installed SDK session shape with exactly one spending tool and no client write capability', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'never-public');
    const settings = resolvePocConfig({
      NODE_ENV: 'development',
      GPT_LIVE_RESPONSES_DELEGATION_EXPERIMENT: 'true',
    });
    const connections = { hangup: vi.fn(), offer: vi.fn() };
    const transport = new PocTransport(
      { settings } as PocConfig,
      connections as unknown as LiveTransport,
    );
    sdkCreate.mockResolvedValue({
      session: { id: 'live_poc' },
      transport: { sdp: 'answer' },
    });
    expect(await transport.create('offer')).toEqual({
      liveId: 'live_poc',
      sdp: 'answer',
    });
    expect(sdkCreate.mock.calls[0][0]).toMatchObject({
      session: {
        delegation: {
          type: 'responses',
          responses: { tools: [spendingTool], parallel_tool_calls: false },
        },
        client: { data_channel: { allowed_client_events: [] } },
      },
      transport: { type: 'webrtc', sdp: 'offer' },
    });
    expect(connections.offer).not.toHaveBeenCalled();
    expect(standaloneResponses).not.toHaveBeenCalled();
    expect(
      JSON.stringify(managedSessionPayload(settings, 'offer')),
    ).not.toContain('never-public');
    const body = sdkCreate.mock.calls[0][0];
    expect(
      body.session.delegation.responses.tools.map(
        (tool: { name: string }) => tool.name,
      ),
    ).toEqual(['get_spending']);
  });
  it('executes an SDK-shaped completed function call without any transcript, offset matching or timer', async () => {
    begin();
    const event = completedCall();
    expect(event).not.toHaveProperty('response_id');
    protocol.accept(envelope({ ...event }));
    await flush();
    expect(spendingPace).toHaveBeenCalledExactlyOnceWith({
      year: '2026',
      month: '10',
      merchant: null,
      category: null,
      currency: null,
    });
    expect(output().totals).toEqual({ EUR: '1840.30', BRL: '2730.50' });
    expect(send).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'response.create' }),
    );
    finish();
    expect(send).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: 'response.create' }),
    );
    expect(send.mock.calls[0][0].item.call_id).toBe('c1');
  });
  it('executes a merchant filter through the existing service', async () => {
    begin();
    protocol.accept(
      envelope({
        ...completedCall('get_spending', { ...filters, merchant: 'Tesco' }),
      }),
    );
    finish();
    await flush();
    expect(spendingPace).toHaveBeenCalledWith(
      expect.objectContaining({ merchant: 'Tesco' }),
    );
    expect(output().totals.EUR).toBe('1840.30');
  });
  it('accepts a category follow-up as another structured delegation without reconstructing earlier text', async () => {
    begin();
    protocol.accept(envelope({ ...completedCall() }));
    finish();
    await flush();
    send.mockClear();
    protocol.accept(delegation('d2', 'r2'));
    protocol.accept(
      envelope({ type: 'response.created', response: { id: 'r2' } }, 'd2'),
    );
    protocol.accept(
      envelope(
        {
          ...completedCall(
            'get_spending',
            { ...filters, category: 'PETS' },
            'c2',
          ),
        },
        'd2',
      ),
    );
    finish('r2', 'd2');
    await flush();
    expect(spendingPace).toHaveBeenLastCalledWith(
      expect.objectContaining({ category: 'PETS', year: '2026', month: '10' }),
    );
    expect(spendingPace).toHaveBeenCalledTimes(2);
    expect(output().totals.BRL).toBe('2730.50');
  });
  it.each([
    { ...filters, month: 13 },
    { ...filters, year: 0 },
    { ...filters, category: 'BANK_BALANCE' },
    { ...filters, currency: 'USD' },
    { ...filters, merchant: ' ' },
    { ...filters, from: 'today' },
    null,
    [],
    '{broken',
  ])('rejects invalid arguments without querying finance: %j', async (args) => {
    begin();
    protocol.accept(envelope({ ...completedCall('get_spending', args) }));
    finish();
    await flush();
    expect(spendingPace).not.toHaveBeenCalled();
    expect(output()).toHaveProperty('error');
  });
  it.each([
    'get_bank_balance',
    'prepare_expense',
    'expense_intent',
    'bank_balance_intent',
    'confirm_expense',
    'get_financial_insights',
  ])('rejects an unsupported tool %s', async (name) => {
    begin();
    protocol.accept(envelope({ ...completedCall(name) }));
    finish();
    await flush();
    expect(spendingPace).not.toHaveBeenCalled();
    expect(output()).toHaveProperty('error');
  });
  it('ignores transcript deltas, argument deltas and unassociated calls', async () => {
    protocol.accept({
      type: 'session.input_transcript.delta',
      event_id: 'speech',
      start_ms: 0,
      end_ms: 1000,
      delta: 'Quanto gastei?',
    });
    protocol.accept(envelope({ ...completedCall() }, 'unknown'));
    begin();
    protocol.accept(
      envelope({
        type: 'response.function_call_arguments.done',
        arguments: JSON.stringify(filters),
        call_id: 'c1',
      }),
    );
    await flush();
    expect(spendingPace).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
  it('deduplicates completed calls and resumes exactly once per completed response', async () => {
    begin();
    const event = completedCall();
    protocol.accept(envelope({ ...event }));
    protocol.accept(envelope({ ...event }));
    finish();
    finish();
    await flush();
    expect(spendingPace).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledTimes(2);
    expect(
      send.mock.calls.filter(([event]) => event.type === 'response.create'),
    ).toHaveLength(1);
  });
  it('allows a continuation response with a new response ID for the same delegation', async () => {
    begin();
    protocol.accept(envelope({ ...completedCall() }));
    finish();
    await flush();
    protocol.accept(
      envelope({ type: 'response.created', response: { id: 'r1_continued' } }),
    );
    protocol.accept(
      envelope({
        ...completedCall(
          'get_spending',
          { ...filters, category: 'PETS' },
          'c2',
        ),
      }),
    );
    finish('r1_continued');
    await flush();
    expect(spendingPace).toHaveBeenCalledTimes(2);
    expect(
      send.mock.calls.filter(([event]) => event.type === 'response.create'),
    ).toHaveLength(2);
  });
  it('waits for every asynchronous tool result even after response.completed', async () => {
    let release!: (value: unknown) => void;
    spendingPace.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    begin();
    protocol.accept(envelope({ ...completedCall() }));
    finish();
    expect(send).not.toHaveBeenCalled();
    release({
      period: {},
      results: [{ currency: 'EUR', spentToDate: '0.00' }],
    });
    await flush();
    expect(output().totals.EUR).toBe('0.00');
    expect(send).toHaveBeenCalledTimes(2);
  });
  it('does not turn backend failures into zero or expose errors/financial payloads in logs', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    spendingPace.mockRejectedValueOnce(new Error('private database detail'));
    begin();
    protocol.accept(envelope({ ...completedCall() }));
    finish();
    await flush();
    expect(output()).toHaveProperty('error');
    expect(output()).not.toHaveProperty('totals');
    expect(JSON.stringify(debug.mock.calls)).not.toContain(
      'private database detail',
    );
    expect(JSON.stringify(debug.mock.calls)).not.toContain('1840.30');
    debug.mockRestore();
  });
  it('suppresses late results after session close', async () => {
    let release!: (value: unknown) => void;
    spendingPace.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    begin();
    protocol.accept(envelope({ ...completedCall() }));
    finish();
    protocol.close();
    release({ period: {}, results: [] });
    await flush();
    expect(send).not.toHaveBeenCalled();
  });
});

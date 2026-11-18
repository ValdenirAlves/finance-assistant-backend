import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { LiveModule } from '../src/ai/live/live.module.js';
import { LiveTransport } from '../src/ai/live/live.transport.js';
import { AiService } from '../src/ai/ai.service.js';
import { RealtimeTurnFilterService } from '../src/ai/realtime/realtime-turn-filter.service.js';
import { RealtimeToolAdapter } from '../src/ai/realtime/realtime-tool.adapter.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { ConversationService } from '../src/conversations/conversation.service.js';
import { AnalyticsService } from '../src/analytics/analytics.service.js';
import { BankAccountsService } from '../src/bank-accounts/bank-accounts.service.js';
import type { ConnectServerEvent } from 'openai/resources/live/sideband/sideband';
import { pendingDatabase } from './helpers/pending-database.js';
const { create } = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('openai', () => ({
  default: class {
    responses = { create };
  },
}));
const call = (name: string, args: object) => ({
  status: 'completed',
  output_text: '',
  output: [
    {
      type: 'function_call',
      name,
      call_id: name,
      id: name,
      arguments: JSON.stringify(args),
    },
  ],
});
describe('GPT-Live financial client delegation endpoints', () => {
  let app: INestApplication;
  let store: ReturnType<typeof pendingDatabase>;
  let emit: (event: ConnectServerEvent) => void;
  let history: Array<{ role: string; content: string }>;
  const offer = vi.fn(),
    hangup = vi.fn(),
    closeGracefully = vi.fn(),
    send = vi.fn(),
    findBalance = vi.fn();
  const conversationId = '11111111-1111-4111-8111-111111111111';
  async function start(enabled?: string) {
    if (enabled !== undefined) vi.stubEnv('GPT_LIVE_ENABLED', enabled);
    else vi.stubEnv('GPT_LIVE_ENABLED', 'false');
    const module = await Test.createTestingModule({ imports: [LiveModule] })
      .overrideProvider(LiveTransport)
      .useValue({
        offer,
        hangup,
        attach: vi.fn(async (_id, event) => {
          emit = event;
          return { closeGracefully, send };
        }),
      })
      .overrideProvider(PrismaService)
      .useValue(store.database)
      .overrideProvider(ConversationService)
      .useValue({
        create: vi.fn().mockResolvedValue({ id: conversationId }),
        recentMessages: vi.fn(async () => [...history]),
        saveTurn: vi.fn(async (_id, user: string, assistant: string) => {
          history.push(
            { role: 'USER', content: user },
            { role: 'ASSISTANT', content: assistant },
          );
        }),
      })
      .overrideProvider(AnalyticsService)
      .useValue({
        monthlySummary: vi.fn().mockResolvedValue({
          period: { year: 2026, month: 10 },
          totals: { EUR: '156.83', BRL: '97.00' },
        }),
        byCategory: vi
          .fn()
          .mockResolvedValue([
            { category: 'PETS', currency: 'EUR', total: '15.40' },
          ]),
      })
      .overrideProvider(BankAccountsService)
      .useValue(
        Object.assign(
          new BankAccountsService(store.database as unknown as PrismaService),
          { findAll: findBalance },
        ),
      )
      .compile();
    expect(module.get(AiService)).toBeDefined();
    expect(() => module.get(RealtimeTurnFilterService)).toThrow();
    expect(() => module.get(RealtimeToolAdapter)).toThrow();
    app = module.createNestApplication();
    await app.init();
  }
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv('OPENAI_API_KEY', 'permanent-secret');
    history = [];
    store = pendingDatabase();
    offer.mockResolvedValue({ liveId: 'live_test', sdp: 'v=0\r\nanswer' });
  });
  afterEach(async () => {
    await app?.close();
    vi.unstubAllEnvs();
  });
  it('is disabled by default and cannot negotiate a session', async () => {
    await start();
    const config = await request(app.getHttpServer())
      .get('/ai/live/config')
      .expect(200);
    expect(config.body.enabled).toBe(false);
    await request(app.getHttpServer())
      .post('/ai/live/sessions')
      .send({ sdp: 'v=0\r\noffer' })
      .expect(503);
    expect(offer).not.toHaveBeenCalled();
  });
  it('keeps the configured voice and credentials out of public configuration', async () => {
    vi.stubEnv('OPENAI_LIVE_VOICE', 'quartz');
    await start('true');
    const { body } = await request(app.getHttpServer())
      .get('/ai/live/config')
      .expect(200);
    expect(Object.keys(body).sort()).toEqual([
      'enabled',
      'idleTimeoutMs',
      'model',
    ]);
    expect(JSON.stringify(body)).not.toContain('quartz');
  });
  it('negotiates, authorizes, preserves conversation reference and stops idempotently', async () => {
    await start('true');
    const conversationId = '11111111-1111-4111-8111-111111111111';
    const { body } = await request(app.getHttpServer())
      .post('/ai/live/sessions')
      .send({ sdp: 'v=0\r\noffer', conversationId })
      .expect(201);
    expect(body).toMatchObject({ sdp: 'v=0\r\nanswer', conversationId });
    expect(body).not.toHaveProperty('apiKey');
    await request(app.getHttpServer())
      .get(`/ai/live/sessions/${body.sessionId}`)
      .expect(403);
    await request(app.getHttpServer())
      .post(`/ai/live/sessions/${body.sessionId}/connected`)
      .set('X-Live-Token', body.token)
      .expect(201);
    await request(app.getHttpServer())
      .post(`/ai/live/sessions/${body.sessionId}/stop`)
      .set('X-Live-Token', body.token)
      .expect(201);
    await request(app.getHttpServer())
      .post(`/ai/live/sessions/${body.sessionId}/stop`)
      .set('X-Live-Token', body.token)
      .expect(201);
    const state = await request(app.getHttpServer())
      .get(`/ai/live/sessions/${body.sessionId}`)
      .set('X-Live-Token', body.token)
      .expect(200);
    expect(state.body).toMatchObject({ state: 'disconnected', conversationId });
    expect(hangup).toHaveBeenCalledOnce();
  });
  it.each([
    { sdp: 'bad' },
    { sdp: 'v=0\r\noffer', apiKey: 'forbidden' },
    { sdp: 'v=0\r\noffer', voice: 'quartz' },
    { sdp: 'v=0\r\noffer', conversationId: 'bad' },
  ])('validates negotiation body %j', async (body) => {
    await start('true');
    await request(app.getHttpServer())
      .post('/ai/live/sessions')
      .send(body)
      .expect(400);
    expect(offer).not.toHaveBeenCalled();
  });
  async function session() {
    await start('true');
    const { body } = await request(app.getHttpServer())
      .post('/ai/live/sessions')
      .send({ sdp: 'v=0\r\noffer', conversationId })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/ai/live/sessions/${body.sessionId}/connected`)
      .set('X-Live-Token', body.token)
      .expect(201);
    return body as { sessionId: string; token: string; conversationId: string };
  }
  async function turn(message: string, delegationId: string, start: number) {
    emit({
      type: 'session.input_transcript.delta',
      event_id: `u${start}`,
      delta: message,
      start_ms: start,
      end_ms: start + 1000,
    });
    emit({
      type: 'session.delegation.created',
      event_id: delegationId,
      offset_ms: start + 1100,
      delegation: { id: delegationId, target: 'client', type: 'delegation' },
    });
    await new Promise((resolve) => setTimeout(resolve, 1650));
  }
  it('delegates monthly and category follow-ups through the real AiService with the same stored conversation', async () => {
    const s = await session();
    create.mockResolvedValueOnce(
      call('get_monthly_summary', { year: 2026, month: 10 }),
    );
    await turn('Quanto eu gastei este mês?', 'monthly', 0);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        delegation_id: 'monthly',
        content: expect.stringContaining('156.83'),
      }),
    );
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('97.00') }),
    );
    create.mockResolvedValueOnce(
      call('get_by_category', {
        category: 'PETS',
        from: '2026-10-01',
        to: '2026-10-23',
        excludeCategories: null,
      }),
    );
    await turn('E com pets?', 'pets', 5000);
    expect(send).toHaveBeenLastCalledWith(
      expect.objectContaining({
        delegation_id: 'pets',
        content: expect.stringContaining('15.40'),
      }),
    );
    expect(JSON.stringify(create.mock.calls[1][0].input)).toContain(
      'Quanto eu gastei este mês?',
    );
    expect(JSON.stringify(send.mock.calls)).not.toContain('permanent-secret');
    const state = await request(app.getHttpServer())
      .get(`/ai/live/sessions/${s.sessionId}`)
      .set('X-Live-Token', s.token)
      .expect(200);
    expect(state.body).toMatchObject({ conversationId, state: 'listening' });
  }, 10000);
  it('refuses unsupported write tools without mutations, and the next financial read works', async () => {
    await session();
    create.mockResolvedValueOnce(call('report_write_unavailable', {}));
    await turn('Ontem gastei vinte euros no Tesco.', 'write', 0);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('FINANCIAL_READ_UNAVAILABLE'),
      }),
    );
    expect(store.database.pendingExpense.upsert).not.toHaveBeenCalled();
    expect(store.database.expense.create).not.toHaveBeenCalled();
    create.mockResolvedValueOnce(
      call('get_monthly_summary', { year: 2026, month: 10 }),
    );
    await turn('Quanto gastei este mês?', 'read', 5000);
    expect(send).toHaveBeenLastCalledWith(
      expect.objectContaining({
        delegation_id: 'read',
        content: expect.stringContaining('FINANCIAL_READ_RESULT'),
      }),
    );
    expect(closeGracefully).not.toHaveBeenCalled();
  }, 10000);
  it('does not disclose a prior balance in the next spending delegation', async () => {
    await session();
    findBalance.mockResolvedValue([
      { currency: 'EUR', currentBalance: '3210.00' },
    ]);
    create.mockResolvedValueOnce(
      call('get_bank_balance', { currency: 'EUR', account: null }),
    );
    await turn('Qual é meu saldo?', 'balance', 0);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('3210.00') }),
    );
    send.mockClear();
    create.mockResolvedValueOnce(
      call('get_bank_balance', { currency: 'EUR', account: null }),
    );
    await turn('Quanto gastei este mês?', 'spending', 5000);
    expect(JSON.stringify(send.mock.calls)).not.toContain('3210.00');
    expect(findBalance).toHaveBeenCalledOnce();
  }, 10000);
  it('keeps the session alive after a finance failure', async () => {
    const s = await session();
    create.mockRejectedValueOnce(new Error('API failure'));
    await turn('Quanto gastei este mês?', 'failure', 0);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('FINANCIAL_READ_UNAVAILABLE'),
      }),
    );
    const status = await request(app.getHttpServer())
      .get(`/ai/live/sessions/${s.sessionId}`)
      .set('X-Live-Token', s.token)
      .expect(200);
    expect(status.body.state).toBe('listening');
    expect(closeGracefully).not.toHaveBeenCalled();
  });
  const intent = (action: string, fields: Record<string, string | null> = {}) =>
    call('expense_intent', {
      action,
      changes: Object.entries(fields).map(([field, value]) => ({
        field,
        value,
      })),
    });
  const result = (id: string) => {
    const events = send.mock.calls
      .map((call) => call[0])
      .filter((event) => event.delegation_id === id);
    const parts = events
      .filter((event) => event.type === 'session.thinking.append')
      .map((event) => JSON.parse(event.content).fragment)
      .join('');
    return JSON.parse(parts || events.at(-1).content);
  };
  it('keeps the first expense draft while a rapid card continuation waits for its newest revision', async () => {
    await session();
    let complete!: (value: ReturnType<typeof call>) => void;
    create.mockReturnValueOnce(
      new Promise((resolve) => {
        complete = resolve;
      }),
    );
    await turn(
      'Gastei 14 euros e 90 centavos no PetStop.',
      'continuation-create',
      0,
    );
    create.mockResolvedValueOnce(
      intent('PATCH', { payer: 'SELF', paymentMethod: 'CARD' }),
    );
    await turn('No meu cartão.', 'continuation-patch', 5000);
    expect(create).toHaveBeenCalledOnce();
    complete(
      intent('CREATE', {
        amount: '14.90',
        currency: 'EUR',
        merchant: 'PetStop',
        category: 'PETS',
        transactionDate: '2026-10-28',
      }),
    );
    await vi.waitFor(() =>
      expect(store.pending.get(conversationId)?.revision).toBe(2),
    );
    expect(result('continuation-patch')).toMatchObject({
      type: 'CONFIRMATION_REQUIRED',
      draft: {
        amount: '14.90',
        merchant: 'PetStop',
        payer: 'SELF',
        paymentMethod: 'CARD',
      },
    });
    expect(store.expenses.size).toBe(0);
    // Cash correction lets this test save without inventing a personal account.
    create.mockResolvedValueOnce(intent('PATCH', { paymentMethod: 'CASH' }));
    await turn('Foi em dinheiro.', 'continuation-cash', 10000);
    create.mockResolvedValueOnce(intent('CONFIRM'));
    await turn('Pode salvar.', 'continuation-confirm', 15000);
    expect(store.expenses.size).toBe(1);
    expect(store.database.bankAccount.updateMany).not.toHaveBeenCalled();
  }, 15000);
  const balanceIntent = (
    action: string,
    fields: Record<string, string | null> = {},
  ) =>
    call('bank_balance_intent', {
      action,
      changes: Object.entries(fields).map(([field, value]) => ({
        field,
        value,
      })),
    });
  it('delegates a balance statement, patches only its amount, confirms once and returns no saved balance', async () => {
    await session();
    create.mockResolvedValueOnce(
      balanceIntent('CREATE', { currentBalance: '2000.00', currency: 'EUR' }),
    );
    await turn('Meu saldo bancário é de 2000 euros.', 'bank-prepare', 0);
    expect(result('bank-prepare')).toMatchObject({
      type: 'BANK_BALANCE_CONFIRMATION_REQUIRED',
      balanceDisclosureAllowed: false,
      balanceDraftDisclosureAllowed: true,
      draft: { currentBalance: '2000.00', currency: 'EUR' },
    });
    expect(store.accounts.size).toBe(0);
    expect(store.expenses.size).toBe(0);
    expect(store.pending.size).toBe(0);
    create.mockResolvedValueOnce(
      balanceIntent('PATCH', { currentBalance: '2100.00' }),
    );
    await turn('Na verdade são 2100.', 'bank-patch', 5000);
    expect(result('bank-patch')).toMatchObject({
      type: 'BANK_BALANCE_CONFIRMATION_REQUIRED',
      pendingRevision: 2,
      draft: { currentBalance: '2100.00', currency: 'EUR' },
    });
    expect(store.accounts.size).toBe(0);
    create.mockResolvedValueOnce(balanceIntent('CONFIRM'));
    await turn('Sim.', 'bank-confirm', 10000);
    expect(result('bank-confirm')).toEqual({
      type: 'BANK_BALANCE_SAVED',
      pendingRevision: 2,
      balanceDisclosureAllowed: false,
      conversationId,
    });
    expect([...store.accounts.values()][0].currentBalance.toFixed(2)).toBe(
      '2100.00',
    );
    create.mockResolvedValueOnce(balanceIntent('CONFIRM'));
    await turn('Pode salvar.', 'bank-repeat', 15000);
    expect(result('bank-repeat')).not.toHaveProperty('draft');
    expect(store.database.bankAccount.upsert).toHaveBeenCalledOnce();
    expect(store.database.expense.create).not.toHaveBeenCalled();
    expect(JSON.stringify(history)).not.toContain('2100');
  }, 15000);
  it('cancels a Live balance update and never confirms the cancelled draft', async () => {
    await session();
    create.mockResolvedValueOnce(
      balanceIntent('CREATE', { currentBalance: '97.00', currency: 'BRL' }),
    );
    await turn('Tenho 97 reais na conta.', 'bank-create', 0);
    create.mockResolvedValueOnce(balanceIntent('CANCEL'));
    await turn('Não, cancela.', 'bank-cancel', 5000);
    expect(result('bank-cancel')).toMatchObject({
      type: 'BANK_BALANCE_CANCELLED',
    });
    create.mockResolvedValueOnce(balanceIntent('CONFIRM'));
    await turn('Sim.', 'bank-cancelled-confirm', 10000);
    expect(result('bank-cancelled-confirm')).toMatchObject({
      type: 'WRITE_REJECTED',
    });
    expect(store.database.bankAccount.upsert).not.toHaveBeenCalled();
    expect(store.expenses.size).toBe(0);
  }, 10000);
  it('prepares, patches and confirms through Live exactly once with atomic card debit and no balance disclosure', async () => {
    await session();
    const bank = new BankAccountsService(
      store.database as unknown as PrismaService,
    );
    const account = await bank.prepare(
      'bank',
      { currency: 'EUR', currentBalance: '1000.00' },
      null,
    );
    await bank.arm('bank', account.revision);
    await bank.confirm('bank', account.revision);
    create.mockResolvedValueOnce(
      intent('CREATE', {
        amount: '50.00',
        currency: 'EUR',
        category: 'FUEL',
        transactionDate: '2026-10-22',
        payer: 'SELF',
        paymentMethod: 'CARD',
      }),
    );
    await turn(
      'Ontem gastei cinquenta euros de combustível no meu cartão.',
      'draft',
      0,
    );
    expect(result('draft')).toMatchObject({
      type: 'CONFIRMATION_REQUIRED',
      draft: {
        amount: '50.00',
        payer: 'SELF',
        paymentMethod: 'CARD',
        category: 'FUEL',
      },
    });
    expect(store.expenses.size).toBe(0);
    create.mockResolvedValueOnce(
      intent('PATCH', { amount: '55.00', merchant: 'Circle K' }),
    );
    await turn(
      'Na verdade foram cinquenta e cinco, no Circle K.',
      'patch',
      5000,
    );
    expect(result('patch')).toMatchObject({
      type: 'CONFIRMATION_REQUIRED',
      pendingRevision: 2,
      draft: {
        amount: '55.00',
        merchant: 'Circle K',
        payer: 'SELF',
        paymentMethod: 'CARD',
        category: 'FUEL',
      },
    });
    create.mockResolvedValueOnce(intent('CONFIRM'));
    await turn('Pode salvar.', 'save', 10000);
    create.mockResolvedValueOnce(intent('CONFIRM'));
    await turn('Isso mesmo, salva.', 'repeat', 15000);
    expect(result('save').type).toBe('EXPENSE_SAVED');
    expect(result('repeat').type).toBe('EXPENSE_SAVED');
    expect(store.expenses.size).toBe(1);
    expect(store.database.bankAccount.updateMany).toHaveBeenCalledOnce();
    expect((await bank.findAll())[0].currentBalance).toBe('945.00');
    expect(JSON.stringify(send.mock.calls)).not.toContain('945.00');
  }, 15000);
  it('preserves a pending cash expense through a real Live stop/reconnect and then confirms it', async () => {
    const first = await session();
    create.mockResolvedValueOnce(
      intent('CREATE', {
        amount: '30.00',
        currency: 'EUR',
        category: 'GROCERIES',
        transactionDate: '2026-10-23',
        payer: 'SELF',
        paymentMethod: 'CASH',
      }),
    );
    await turn(
      'Gastei trinta euros no mercado e paguei em dinheiro.',
      'cash',
      0,
    );
    expect(result('cash')).toMatchObject({
      type: 'CONFIRMATION_REQUIRED',
      draft: { paymentMethod: 'CASH' },
    });
    await request(app.getHttpServer())
      .post(`/ai/live/sessions/${first.sessionId}/stop`)
      .set('X-Live-Token', first.token)
      .expect(201);
    expect(store.pending.get(conversationId)?.status).toBe('PENDING');
    const { body: second } = await request(app.getHttpServer())
      .post('/ai/live/sessions')
      .send({ sdp: 'v=0\r\noffer', conversationId })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/ai/live/sessions/${second.sessionId}/connected`)
      .set('X-Live-Token', second.token)
      .expect(201);
    create.mockResolvedValueOnce(intent('CONFIRM'));
    await turn('Pode salvar.', 'reconnect', 0);
    expect(second.conversationId).toBe(conversationId);
    expect(result('reconnect').type).toBe('EXPENSE_SAVED');
    expect([...store.expenses.values()][0].paymentMethod).toBe('CASH');
    expect(store.database.bankAccount.updateMany).not.toHaveBeenCalled();
  }, 10000);
  it('keeps incomplete details pending and cancellation never saves an expense', async () => {
    await session();
    create.mockResolvedValueOnce(
      intent('CREATE', { category: 'PETS', payer: 'SPOUSE' }),
    );
    await turn(
      'Quero registrar uma compra de ração da minha esposa.',
      'partial',
      0,
    );
    expect(result('partial')).toMatchObject({
      type: 'MISSING_INFORMATION',
      missingFields: ['amount', 'currency', 'transactionDate'],
    });
    create.mockResolvedValueOnce(intent('CANCEL'));
    await turn('Deixa, não salva.', 'cancel', 5000);
    expect(result('cancel').type).toBe('EXPENSE_CANCELLED');
    expect(store.expenses.size).toBe(0);
  }, 10000);
});

import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import type { RealtimeServerEvent } from 'openai/resources/realtime/realtime';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { ConversationService } from '../src/conversations/conversation.service.js';
import { AnalyticsService } from '../src/analytics/analytics.service.js';
import { BudgetsService } from '../src/budgets/budgets.service.js';
import { InsightsService } from '../src/analytics/insights/insights.service.js';
import { RecurringExpensesService } from '../src/analytics/recurring-expenses.service.js';
import { BankAccountsService } from '../src/bank-accounts/bank-accounts.service.js';
import { RealtimeTransport } from '../src/ai/realtime/realtime.transport.js';
import { RealtimeTurnFilterService } from '../src/ai/realtime/realtime-turn-filter.service.js';
import { pendingDatabase } from './helpers/pending-database.js';
import { Prisma } from '../src/generated/prisma/client.js';
import { RealtimeConfig } from '../src/ai/openai.config.js';
import { PendingExpenseService } from '../src/pending-expenses/pending-expense.service.js';
const { create } = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('openai', () => ({
  default: class {
    responses = { create };
  },
}));
const tool = (name: string, args: object) => ({
  status: 'completed',
  output: [
    {
      type: 'function_call',
      name,
      arguments: JSON.stringify(args),
      call_id: 'financial_call',
      id: 'financial_id',
    },
  ],
  output_text: '',
});
const final = (answer: string) => ({
  status: 'completed',
  output: [],
  output_text: answer,
});
describe('realtime session, authoritative finance tool and privacy', () => {
  let app: INestApplication,
    store: ReturnType<typeof pendingDatabase>,
    bank: BankAccountsService;
  let emit: (event: RealtimeServerEvent) => void,
    closed: () => void,
    failed: () => void;
  let session: { sessionId: string; token: string; conversationId: string };
  let history: Array<{ role: string; content: string }>;
  const id = '11111111-1111-4111-8111-111111111111';
  const send = vi.fn(),
    disconnect = vi.fn(),
    hangup = vi.fn();
  const classify = vi.fn();
  const byCategory = vi.fn(),
    budgetStatus = vi.fn(),
    recurring = vi.fn(),
    insights = vi.fn();
  const status = () =>
    request(app.getHttpServer())
      .get(`/ai/realtime/sessions/${session.sessionId}`)
      .set('X-Realtime-Token', session.token);
  const fire = (event: object) => emit(event as RealtimeServerEvent);
  const connected = () =>
    request(app.getHttpServer())
      .post(`/ai/realtime/sessions/${session.sessionId}/connected`)
      .set('X-Realtime-Token', session.token)
      .expect(201);
  beforeEach(async () => {
    vi.resetAllMocks();
    vi.stubEnv('OPENAI_API_KEY', 'permanent-secret');
    classify.mockResolvedValue({
      classification: 'DIRECTED_TO_ASSISTANT',
      reasonCode: 'EXPLICIT_REQUEST',
      pendingStateExists: false,
    });
    store = pendingDatabase();
    history = [];
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(store.database)
      .overrideProvider(ConversationService)
      .useValue({
        create: vi.fn().mockResolvedValue({ id }),
        recentMessages: vi.fn(async () => history),
        saveTurn: vi.fn(
          async (_id: string, user: string, assistant: string) => {
            history.push(
              { role: 'USER', content: user },
              { role: 'ASSISTANT', content: assistant },
            );
          },
        ),
      })
      .overrideProvider(AnalyticsService)
      .useValue({
        byCategory,
        byMerchant: vi.fn().mockResolvedValue([]),
        monthlySummary: vi
          .fn()
          .mockResolvedValue({ totals: { EUR: '42.00', BRL: '0.00' } }),
      })
      .overrideProvider(BudgetsService)
      .useValue({
        getPending: vi.fn().mockResolvedValue(null),
        statusFor: budgetStatus,
      })
      .overrideProvider(RecurringExpensesService)
      .useValue({ findAll: recurring })
      .overrideProvider(InsightsService)
      .useValue({ findAll: insights })
      .overrideProvider(RealtimeTransport)
      .useValue({
        offer: vi
          .fn()
          .mockResolvedValue({ callId: 'rtc_test', sdp: 'v=0\r\nanswer' }),
        attach: vi.fn(
          async (
            _id: string,
            e: typeof emit,
            c: typeof closed,
            f: typeof failed,
          ) => {
            emit = e;
            closed = c;
            failed = f;
            return { send, close: disconnect };
          },
        ),
        hangup,
      })
      .overrideProvider(RealtimeTurnFilterService)
      .useValue({ classify })
      .compile();
    app = module.createNestApplication();
    bank = module.get(BankAccountsService);
    await app.init();
    const response = await request(app.getHttpServer())
      .post('/ai/realtime/sessions')
      .send({ sdp: 'v=0\r\noffer', conversationId: id })
      .expect(201);
    session = response.body;
  });
  afterEach(async () => {
    await app.close();
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });
  async function turn(
    transcript: string,
    item = `item_${send.mock.calls.length}`,
  ) {
    fire({ type: 'input_audio_buffer.speech_stopped', item_id: item });
    fire({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: item,
      transcript,
    });
    await waitForRoute(item);
    const route = send.mock.calls
      .map((c) => c[0])
      .findLast((c) => c.type === 'response.create');
    expect(route.response).toMatchObject({
      conversation: 'none',
      tool_choice: { type: 'function', name: 'finance_turn' },
    });
    fire({
      type: 'response.created',
      response: {
        id: `route_${item}`,
        metadata: { turnId: item, stage: 'routing' },
      },
    });
    fire({
      type: 'response.function_call_arguments.done',
      response_id: `route_${item}`,
      name: 'finance_turn',
      arguments: '{}',
      call_id: `call_${item}`,
    });
    await vi.waitFor(() =>
      expect(
        send.mock.calls
          .map((c) => c[0])
          .some(
            (c) =>
              c.type === 'response.create' &&
              c.response.metadata?.turnId === item &&
              c.response.metadata?.stage === 'speech',
          ),
      ).toBe(true),
    );
    const speech = send.mock.calls
      .map((c) => c[0])
      .findLast((c) => c.type === 'response.create');
    fire({
      type: 'response.created',
      response: {
        id: `speech_${item}`,
        metadata: { turnId: item, stage: 'speech' },
      },
    });
    fire({
      type: 'response.done',
      response: { id: `speech_${item}`, status: 'completed' },
    });
    return speech;
  }
  async function waitForRoute(item: string) {
    await vi.waitFor(() =>
      expect(
        send.mock.calls.some(
          (c) =>
            c[0].type === 'response.create' &&
            c[0].response.metadata?.turnId === item &&
            c[0].response.metadata?.stage === 'routing',
        ),
      ).toBe(true),
    );
  }
  it('returns SDP/capability without exposing permanent API key and protects status/stop', async () => {
    expect(JSON.stringify(session)).not.toContain('permanent-secret');
    expect(session).not.toHaveProperty('apiKey');
    await status().expect(200);
    await request(app.getHttpServer())
      .get(`/ai/realtime/sessions/${session.sessionId}`)
      .expect(403);
    await request(app.getHttpServer())
      .get(`/ai/realtime/sessions/${session.sessionId}`)
      .set('X-Realtime-Token', 'é'.repeat(session.token.length))
      .expect(403);
    await request(app.getHttpServer())
      .post(`/ai/realtime/sessions/${session.sessionId}/stop`)
      .set('X-Realtime-Token', session.token)
      .expect(201);
    expect(disconnect).toHaveBeenCalledOnce();
    expect(hangup).toHaveBeenCalledOnce();
    expect((await status()).body.state).toBe('disconnected');
  });
  it('rejects caller-supplied session tools and credentials', async () => {
    await request(app.getHttpServer())
      .post('/ai/realtime/sessions')
      .send({
        sdp: 'v=0\r\noffer',
        tools: [{ name: 'confirm_expense' }],
        apiKey: 'browser-key',
      })
      .expect(400);
    expect(create).not.toHaveBeenCalled();
  });
  it.each([
    ['LIKELY_INCIDENTAL', 'Você vai sair hoje?'],
    ['LIKELY_INCIDENTAL', 'A comida já está pronta.'],
    ['UNCERTAIN', 'Quanto você gastou no Tesco?'],
    ['UNCERTAIN', 'Qual é o saldo dele?'],
    ['UNCERTAIN', 'Gastei 20 euros no Tesco no meu cartão.'],
    ['UNCERTAIN', 'Quero um orçamento de 500 EUR para supermercados.'],
    ['LIKELY_INCIDENTAL', 'Meu saldo é 1000 EUR.'],
    ['UNCERTAIN', 'Pode salvar mesmo assim.'],
  ])(
    'silently skips %s without finance_turn, clarification, audio or persistence: %s',
    async (classification, transcript) => {
      classify.mockResolvedValueOnce({
        classification,
        reasonCode: 'AMBIGUOUS_DIRECTION',
        pendingStateExists: false,
      });
      fire({ type: 'input_audio_buffer.speech_stopped', item_id: 'ignored' });
      fire({
        type: 'conversation.item.input_audio_transcription.completed',
        item_id: 'ignored',
        transcript,
      });
      await vi.waitFor(() => expect(classify).toHaveBeenCalledOnce());
      await new Promise((resolve) => setImmediate(resolve));
      const response = await status().expect(200);
      expect(response.body).toMatchObject({ state: 'listening', turns: [] });
      expect(send.mock.calls.some((c) => c[0].type === 'response.create')).toBe(
        false,
      );
      expect(create).not.toHaveBeenCalled();
      expect(byCategory).not.toHaveBeenCalled();
      expect(history).toHaveLength(0);
      expect(store.expenses.size).toBe(0);
      expect(store.pending.size).toBe(0);
      // Even a forged tool completion cannot dispatch an ignored turn.
      fire({
        type: 'response.function_call_arguments.done',
        response_id: 'ignored',
        name: 'finance_turn',
        arguments: '{}',
        call_id: 'ignored',
      });
      expect(create).not.toHaveBeenCalled();
    },
  );
  it.each(['LIKELY_INCIDENTAL', 'UNCERTAIN'])(
    'does not confirm a pending write for %s speech',
    async (classification) => {
      create.mockResolvedValueOnce(
        tool('prepare_expense', {
          amount: '20.00',
          currency: 'EUR',
          merchant: 'Tesco',
          transactionDate: '2026-10-15',
          description: null,
          language: 'pt',
          payer: 'SPOUSE',
        }),
      );
      await turn(
        'Gastei 20 euros no Tesco no cartão da minha esposa.',
        'draft',
      );
      expect(store.pending.get(id)?.status).toBe('PENDING');
      const before = send.mock.calls.length;
      classify.mockResolvedValueOnce({
        classification,
        reasonCode: 'AMBIGUOUS_DIRECTION',
        pendingStateExists: true,
      });
      fire({
        type: 'input_audio_buffer.speech_stopped',
        item_id: 'unaccepted_yes',
      });
      fire({
        type: 'conversation.item.input_audio_transcription.completed',
        item_id: 'unaccepted_yes',
        transcript: 'Pode salvar.',
      });
      await new Promise((resolve) => setImmediate(resolve));
      expect(store.pending.get(id)?.status).toBe('PENDING');
      expect(store.expenses.size).toBe(0);
      expect(
        send.mock.calls
          .slice(before)
          .some((c) => c[0].type === 'response.create'),
      ).toBe(false);
      expect(history).toHaveLength(2);
      await turn('Pode salvar.', 'accepted_yes');
      expect(store.expenses.size).toBe(1);
    },
  );
  it('keeps filtering realtime-only and leaves POST chat unaffected', async () => {
    classify.mockResolvedValue({
      classification: 'LIKELY_INCIDENTAL',
      reasonCode: 'UNRELATED_CONVERSATION',
      pendingStateExists: false,
    });
    create
      .mockResolvedValueOnce(
        tool('get_monthly_summary', { year: 2026, month: 10 }),
      )
      .mockResolvedValueOnce(final('Você gastou 42.00 EUR.'));
    const response = await request(app.getHttpServer())
      .post('/ai/chat')
      .send({ message: 'Quanto gastei este mês?', conversationId: id })
      .expect(201);
    expect(response.body.answer).toBe('Você gastou 42.00 EUR.');
    expect(classify).not.toHaveBeenCalled();
  });

  it.each([
    ['DIRECTED_TO_ASSISTANT', 'UNRELATED', '어 음.'],
    ['DIRECTED_TO_ASSISTANT', 'UNRELATED', '不許不許'],
    ['DIRECTED_TO_ASSISTANT', 'UNCERTAIN', 'OK.'],
    ['UNCERTAIN', 'CONFIRM', 'Sim.'],
    ['DIRECTED_TO_ASSISTANT', 'CONFIRM', 'OK.'],
    [null, undefined, 'Nearby conversation'],
  ])(
    'silently gates pending confirmation: %s / %s',
    async (classification, pendingAction, transcript) => {
      create.mockResolvedValueOnce(
        tool('prepare_expense', {
          amount: '50.00',
          currency: 'EUR',
          merchant: 'Tesco',
          transactionDate: '2026-10-21',
          description: null,
          payer: 'SPOUSE',
          language: 'pt',
        }),
      );
      await turn(
        'Gastei 50 euros no Tesco no cartão da minha esposa.',
        'prepare_gate',
      );
      const original = store.pending.get(id)!;
      expect(original.confirmationRequested).toBe(true);
      const before = send.mock.calls.length;
      const priorHistory = [...history];
      classify.mockResolvedValueOnce({
        classification,
        reasonCode: classification ? 'PENDING_RESPONSE' : 'FILTER_TIMEOUT',
        pendingStateExists: true,
        awaitingConfirmation: true,
        pendingAction,
      });
      fire({
        type: 'input_audio_buffer.speech_stopped',
        item_id: 'noise_pending',
      });
      fire({
        type: 'conversation.item.input_audio_transcription.completed',
        item_id: 'noise_pending',
        transcript,
      });
      await new Promise((resolve) => setImmediate(resolve));
      expect(store.pending.get(id)).toEqual(original);
      expect(store.expenses.size).toBe(0);
      expect(history).toEqual(priorHistory);
      expect((await status()).body).toMatchObject({
        state: 'listening',
        turns: [{ id: 'prepare_gate' }],
      });
      expect(
        send.mock.calls
          .slice(before)
          .some((c) => c[0].type === 'response.create'),
      ).toBe(false);
      expect(create).toHaveBeenCalledOnce();
    },
  );

  it.each(['CONFIRM', 'CANCEL', 'EDIT_PENDING'])(
    'dispatches semantic %s through the existing guarded domain flow',
    async (action) => {
      create.mockResolvedValueOnce(
        tool('prepare_expense', {
          amount: '50.00',
          currency: 'EUR',
          merchant: 'Tesco',
          transactionDate: '2026-10-21',
          description: null,
          payer: 'SPOUSE',
          language: 'pt',
        }),
      );
      await turn(
        'Gastei 50 euros no Tesco no cartão da minha esposa.',
        'pending_gate',
      );
      const original = store.pending.get(id)!;
      classify.mockResolvedValueOnce({
        classification: 'DIRECTED_TO_ASSISTANT',
        reasonCode: 'PENDING_RESPONSE',
        pendingStateExists: true,
        awaitingConfirmation: true,
        pendingAction: action,
      });
      if (action === 'EDIT_PENDING')
        create.mockResolvedValueOnce(
          tool('patch_pending_expense', {
            changes: [{ field: 'amount', value: '18.00' }],
            language: 'pt',
            confirmationQuestion: null,
          }),
        );
      await turn(
        action === 'CONFIRM'
          ? 'Sim.'
          : action === 'CANCEL'
            ? 'Cancela.'
            : 'Na verdade foram dezoito euros.',
        'pending_action',
      );
      const current = store.pending.get(id)!;
      expect(current.id).toBe(original.id);
      if (action === 'EDIT_PENDING') {
        expect(current).toMatchObject({
          payer: original.payer,
          merchant: original.merchant,
          transactionDate: original.transactionDate,
          status: 'PENDING',
          confirmationRequested: true,
        });
        expect(current.amount.toFixed(2)).toBe('18.00');
        expect(store.expenses.size).toBe(0);
      } else {
        expect(current.status).toBe(
          action === 'CONFIRM' ? 'CONFIRMED' : 'CANCELLED',
        );
        await turn('Sim.', 'repeat_gate');
        expect(store.expenses.size).toBe(action === 'CONFIRM' ? 1 : 0);
        expect(store.database.expense.create).toHaveBeenCalledTimes(
          action === 'CONFIRM' ? 1 : 0,
        );
      }
    },
  );

  it('preserves the pending review across a real idle disconnect and reconnect with the same conversation', async () => {
    const pending = app.get(PendingExpenseService);
    const draft = await pending.prepare(
      id,
      {
        amount: '50.00',
        currency: 'EUR',
        merchant: 'Tesco',
        transactionDate: '2026-10-21',
        payer: 'SPOUSE',
      },
      null,
    );
    await pending.requestConfirmation(id, draft.revision);
    const original = store.pending.get(id)!;
    await request(app.getHttpServer())
      .post(`/ai/realtime/sessions/${session.sessionId}/stop`)
      .set('X-Realtime-Token', session.token)
      .expect(201);
    const config = app.get(RealtimeConfig);
    const previous = config.settings.idleTimeoutMs;
    config.settings.idleTimeoutMs = 30;
    session = (
      await request(app.getHttpServer())
        .post('/ai/realtime/sessions')
        .send({ sdp: 'v=0\r\noffer', conversationId: id })
        .expect(201)
    ).body;
    await vi.waitFor(
      async () => expect((await status()).body.state).toBe('disconnected'),
      { timeout: 2000, interval: 20 },
    );
    expect((await status()).body.conversationId).toBe(id);
    expect(store.pending.get(id)).toEqual(original);
    expect(history).toHaveLength(0);
    expect(store.expenses.size).toBe(0);
    const priorSession = session.sessionId;
    config.settings.idleTimeoutMs = previous;
    session = (
      await request(app.getHttpServer())
        .post('/ai/realtime/sessions')
        .send({ sdp: 'v=0\r\noffer', conversationId: id })
        .expect(201)
    ).body;
    expect(session.sessionId).not.toBe(priorSession);
    expect(session.conversationId).toBe(id);
    expect(store.pending.get(id)).toEqual(original);
    expect(create).not.toHaveBeenCalled();
  });
  it('processes an active-session request and successive contextual follow-ups without repeating a wake word', async () => {
    byCategory.mockResolvedValue([]);
    create
      .mockResolvedValueOnce(
        tool('get_monthly_summary', { year: 2026, month: 10 }),
      )
      .mockResolvedValueOnce(final('Você gastou 42.00 EUR.'))
      .mockResolvedValueOnce(
        tool('get_by_category', {
          from: '2026-10-01',
          to: '2026-10-15',
          category: 'PETS',
          excludeCategories: null,
        }),
      )
      .mockResolvedValueOnce(final('Nenhum gasto com pets.'))
      .mockResolvedValueOnce(
        tool('get_expenses', {
          from: '2026-10-01',
          to: '2026-10-15',
          merchant: 'Tesco',
          currency: null,
          category: null,
        }),
      )
      .mockResolvedValueOnce(final('Nenhuma despesa no Tesco.'));
    await turn('Quanto gastei este mês?', 'active_first');
    await turn('E com pets?', 'active_pets');
    await turn('E no Tesco?', 'active_merchant');
    expect(classify.mock.calls.map((c) => c[0].transcript)).toEqual([
      'Quanto gastei este mês?',
      'E com pets?',
      'E no Tesco?',
    ]);
    expect(
      classify.mock.calls.map((c) => c[0].conversationState.acceptedTurns),
    ).toEqual([0, 1, 2]);
    const result = (await status()).body;
    expect(result.conversationId).toBe(id);
    expect(result.turns).toHaveLength(3);
    expect(history).toHaveLength(6);
    expect(create).toHaveBeenCalledTimes(6);
  });
  it.each([
    ['Sim.', 'CONFIRMED', 1],
    ['Cancela.', 'CANCELLED', 0],
    ['Não.', 'CANCELLED', 0],
  ])(
    'preserves accepted pending reply %s using existing domain semantics',
    async (reply, expected, expenses) => {
      create.mockResolvedValueOnce(
        tool('prepare_expense', {
          amount: '20.00',
          currency: 'EUR',
          merchant: 'Tesco',
          transactionDate: '2026-10-15',
          description: null,
          language: 'pt',
          payer: 'SPOUSE',
        }),
      );
      await turn(
        'Gastei 20 euros no Tesco no cartão da minha esposa.',
        'pending',
      );
      classify.mockResolvedValueOnce({
        classification: 'DIRECTED_TO_ASSISTANT',
        reasonCode: 'PENDING_RESPONSE',
        pendingStateExists: true,
      });
      await turn(String(reply), 'pending_reply');
      expect(store.pending.get(id)?.status).toBe(expected);
      expect(store.expenses.size).toBe(expenses);
      expect(create).toHaveBeenCalledOnce();
    },
  );
  it('skips unclear balance speech without reading private accounts', async () => {
    const read = vi.spyOn(bank, 'findAll');
    classify.mockResolvedValueOnce({
      classification: 'UNCERTAIN',
      reasonCode: 'AMBIGUOUS_DIRECTION',
      pendingStateExists: false,
    });
    fire({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'private',
      transcript: 'Qual meu saldo?',
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(read).not.toHaveBeenCalled();
    expect(history).toHaveLength(0);
    expect((await status()).body.turns).toEqual([]);
  });
  it.each(['LIKELY_INCIDENTAL', 'DIRECTED_TO_ASSISTANT'])(
    'supports playback interruption while enforcing directionality: %s',
    async (classification) => {
      create
        .mockResolvedValueOnce(
          tool('get_monthly_summary', { year: 2026, month: 10 }),
        )
        .mockResolvedValueOnce(final('Você gastou 42.00 EUR.'));
      await turn('Quanto gastei este mês?', 'first');
      fire({
        type: 'output_audio_buffer.started',
        response_id: 'speech_first',
      });
      fire({
        type: 'input_audio_buffer.speech_started',
        item_id: 'interruption',
      });
      fire({
        type: 'output_audio_buffer.cleared',
        response_id: 'speech_first',
      });
      classify.mockResolvedValueOnce({
        classification,
        reasonCode: 'AMBIGUOUS_DIRECTION',
        pendingStateExists: false,
      });
      if (classification === 'DIRECTED_TO_ASSISTANT') {
        create
          .mockResolvedValueOnce(
            tool('get_by_category', {
              from: '2026-10-01',
              to: '2026-10-15',
              category: 'PETS',
            }),
          )
          .mockResolvedValueOnce(final('Não houve gastos com pets.'));
        byCategory.mockResolvedValue([]);
        await turn('VAS, consulte agora os gastos com pets.', 'interruption');
        expect(byCategory).toHaveBeenCalledOnce();
      } else {
        fire({
          type: 'input_audio_buffer.speech_stopped',
          item_id: 'interruption',
        });
        fire({
          type: 'conversation.item.input_audio_transcription.completed',
          item_id: 'interruption',
          transcript: 'Você vai sair hoje?',
        });
        await new Promise((resolve) => setImmediate(resolve));
        expect(create).toHaveBeenCalledTimes(2);
        expect(history).toHaveLength(2);
        expect(
          send.mock.calls.some(
            (c) =>
              c[0].type === 'response.create' &&
              c[0].response.metadata?.turnId === 'interruption',
          ),
        ).toBe(false);
      }
      expect(classify.mock.calls.at(-1)?.[0].assistantState).toBe('speaking');
      expect((await status()).body.state).not.toBe('error');
    },
  );
  it('returns semantic clarification identically through POST chat and realtime finance_turn', async () => {
    const message =
      'Quero consultar os gastos daquela viagem, mas ainda não defini quais dias incluir.';
    const question =
      'Devo olhar apenas os dias da viagem ou incluir também os dias seguintes?';
    create
      .mockResolvedValueOnce(tool('ask_clarification', { question }))
      .mockResolvedValueOnce(tool('ask_clarification', { question }));
    const normal = await request(app.getHttpServer())
      .post('/ai/chat')
      .send({ message, conversationId: id })
      .expect(201);
    const speech = await turn(message, 'clarification');
    const realtime = (await status()).body.turns.find(
      (t: { id: string }) => t.id === 'clarification',
    );
    expect(normal.body.answer).toBe(question);
    expect(realtime.answer).toBe(normal.body.answer);
    expect(JSON.parse(speech.response.input[1].output).speechText).toBe(
      question,
    );
    expect(create).toHaveBeenCalledTimes(2);
    expect(byCategory).not.toHaveBeenCalled();
    expect(budgetStatus).not.toHaveBeenCalled();
    expect(insights).not.toHaveBeenCalled();
    expect(recurring).not.toHaveBeenCalled();
    expect(store.pending.size).toBe(0);
    expect(store.database.expense.create).not.toHaveBeenCalled();
  });
  it('returns identical backend exclusion results through POST chat and realtime finance_turn', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-15T12:00:00Z'));
    const records = [
      ['GROCERIES', 'EUR', '100.00'],
      ['PETS', 'EUR', '50.00'],
      ['OTHER', 'EUR', '0.10'],
      ['OTHER', 'EUR', '0.20'],
      ['OTHER', 'BRL', '9.87'],
      ['TRANSPORT', 'EUR', '4.56'],
    ].map(([category, currency, amount]) => ({
      category,
      currency,
      amount: new Prisma.Decimal(amount),
    }));
    const findMany = vi.fn(async ({ where }: any) =>
      records.filter((row) => !where.category?.notIn?.includes(row.category)),
    );
    const domain = new AnalyticsService({
      expense: { findMany },
    } as unknown as PrismaService);
    byCategory.mockImplementation((input) => domain.byCategory(input));
    const message =
      'Quanto eu gastei em outras despesas, além de mercado e pets?';
    const answer =
      'Outras despesas: 0.30 EUR e 9.87 BRL; transporte: 4.56 EUR.';
    const args = {
      from: '1999-01-01',
      to: '1999-01-31',
      category: 'OTHER',
      excludeCategories: null,
    };
    create
      .mockResolvedValueOnce(tool('get_by_category', args))
      .mockResolvedValueOnce(final(answer))
      .mockResolvedValueOnce(tool('get_by_category', args))
      .mockResolvedValueOnce(final(answer));
    const normal = await request(app.getHttpServer())
      .post('/ai/chat')
      .send({ message, conversationId: id })
      .expect(201);
    const speech = await turn(message, 'excluded');
    const realtime = (await status()).body.turns.find(
      (t: { id: string }) => t.id === 'excluded',
    );
    expect(realtime.answer).toBe(normal.body.answer);
    expect(realtime.answer).toBe(answer);
    expect(create.mock.calls[0][0].tool_choice).toEqual({
      type: 'function',
      name: 'get_by_category',
    });
    expect(create.mock.calls[2][0].tool_choice).toEqual({
      type: 'function',
      name: 'get_by_category',
    });
    expect(byCategory).toHaveBeenCalledTimes(2);
    expect(byCategory).toHaveBeenLastCalledWith(
      expect.objectContaining({
        from: '2026-10-01',
        to: '2026-10-15',
        category: undefined,
        excludeCategories: ['GROCERIES', 'PETS'],
      }),
    );
    expect(findMany.mock.calls[0][0].where.category).toEqual({
      notIn: ['GROCERIES', 'PETS'],
    });
    const expected = [
      { category: 'OTHER', currency: 'BRL', total: '9.87' },
      { category: 'OTHER', currency: 'EUR', total: '0.30' },
      { category: 'TRANSPORT', currency: 'EUR', total: '4.56' },
    ];
    for (const round of [1, 3]) {
      const output = create.mock.calls[round][0].input.findLast(
        (item: { type: string }) => item.type === 'function_call_output',
      );
      expect(JSON.parse(output.output)).toEqual(expected);
    }
    expect(
      JSON.parse(speech.response.input[1].output).speechText,
    ).not.toContain('No financial data');
  });
  it('restores persisted history for a category follow-up after reconnect', async () => {
    byCategory.mockResolvedValue([]);
    create
      .mockResolvedValueOnce(
        tool('get_by_category', {
          from: '2026-10-01',
          to: '2026-10-31',
          category: 'GROCERIES',
        }),
      )
      .mockResolvedValueOnce(
        final('Não houve gastos com supermercados em outubro de 2026.'),
      );
    await turn(
      'Quanto gastei com supermercados em outubro de 2026?',
      'before_disconnect',
    );
    await request(app.getHttpServer())
      .post(`/ai/realtime/sessions/${session.sessionId}/stop`)
      .set('X-Realtime-Token', session.token)
      .expect(201);
    const oldSessionId = session.sessionId;
    const next = await request(app.getHttpServer())
      .post('/ai/realtime/sessions')
      .send({ sdp: 'v=0\r\noffer', conversationId: session.conversationId })
      .expect(201);
    session = next.body;
    expect(session.sessionId).not.toBe(oldSessionId);
    expect(session.conversationId).toBe(id);
    create
      .mockResolvedValueOnce(
        tool('get_by_category', {
          from: '2026-10-01',
          to: '2026-10-31',
          category: 'PETS',
        }),
      )
      .mockResolvedValueOnce(
        final('Não houve gastos com pets em outubro de 2026.'),
      );
    await turn('E com pets?', 'after_reconnect');
    const modelRequest = create.mock.calls[2][0];
    expect(modelRequest.input).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'user',
          content: 'Quanto gastei com supermercados em outubro de 2026?',
        }),
        expect.objectContaining({
          role: 'assistant',
          content: 'Não houve gastos com supermercados em outubro de 2026.',
        }),
        expect.objectContaining({ role: 'user', content: 'E com pets?' }),
      ]),
    );
    expect(byCategory).toHaveBeenLastCalledWith(
      expect.objectContaining({
        category: 'PETS',
        from: '2026-10-01',
        to: '2026-10-31',
      }),
    );
  });
  it.each([
    [
      'Quanto gastei com supermercados este mês?',
      'get_by_category',
      { from: '2026-10-01', to: '2026-10-31', category: 'GROCERIES' },
      'Você gastou 42.00 EUR em supermercados.',
      'category',
    ],
    [
      'Como está o orçamento do Tesco?',
      'get_budget_status',
      {
        year: 2026,
        month: 10,
        currency: 'EUR',
        merchant: 'Tesco',
        category: null,
      },
      'Você ainda pode gastar 100.00 EUR.',
      'budget',
    ],
    [
      'Quais despesas recorrentes tenho?',
      'get_recurring_expenses',
      {
        currency: null,
        category: null,
        merchant: null,
        from: null,
        to: null,
        confidence: null,
      },
      'Não há despesas recorrentes.',
      'recurring',
    ],
    [
      'Tem algo importante nas minhas finanças este mês?',
      'get_financial_insights',
      { currency: null, category: null, type: null, severity: null },
      'Não há alertas relevantes.',
      'insights',
    ],
  ])(
    'reuses backend services for %s',
    async (message, name, args, answer, service) => {
      const spy = {
        category: byCategory,
        budget: budgetStatus,
        recurring,
        insights,
      }[service]!;
      spy.mockResolvedValue(
        service === 'budget' ? { remaining: '100.00', currency: 'EUR' } : [],
      );
      if (service === 'insights') create.mockResolvedValueOnce(final(answer));
      else
        create
          .mockResolvedValueOnce(tool(name, args))
          .mockResolvedValueOnce(final(answer));
      const speech = await turn(message);
      expect(spy).toHaveBeenCalledOnce();
      expect(speech.response).toMatchObject({
        conversation: 'none',
        tools: [],
        tool_choice: 'none',
        output_modalities: ['audio'],
      });
      expect((await status()).body.turns.at(-1).answer).toBe(answer);
    },
  );
  it.each([
    ['SELF', 'no meu cartão', '80.00'],
    ['SPOUSE', 'no cartão da minha esposa', '100.00'],
  ])(
    'requires confirmation and preserves %s balance behavior',
    async (payer, wording, expected) => {
      await connected();
      classify.mockResolvedValue({
        classification: null,
        reasonCode: 'FILTER_TIMEOUT',
        pendingStateExists: false,
      });
      const draft = await bank.prepare(
        'bank',
        { currency: 'EUR', currentBalance: '100.00' },
        null,
      );
      await bank.arm('bank', draft.revision);
      await bank.confirm('bank', draft.revision);
      create.mockResolvedValueOnce(
        tool('prepare_expense', {
          paymentMethod: 'CARD',
          amount: '20.00',
          currency: 'EUR',
          merchant: 'Tesco',
          transactionDate: '2026-10-15',
          description: null,
          language: 'pt',
          payer,
        }),
      );
      await turn(`Gastei 20 euros no Tesco ${wording}.`, 'expense');
      expect(store.expenses.size).toBe(0);
      await turn('Pode salvar.', 'confirm');
      await turn('Pode salvar.', 'confirm_again');
      expect(store.expenses.size).toBe(1);
      expect((await bank.findAll())[0].currentBalance).toBe(expected);
      expect(create).toHaveBeenCalledOnce();
    },
  );
  it('isolates authorized balance speech from a later unrelated turn', async () => {
    await connected();
    classify.mockResolvedValue({
      classification: null,
      reasonCode: 'FILTER_UNAVAILABLE',
      pendingStateExists: false,
    });
    const draft = await bank.prepare(
      'bank',
      { currency: 'EUR', currentBalance: '3208.00' },
      null,
    );
    await bank.arm('bank', draft.revision);
    await bank.confirm('bank', draft.revision);
    const balance = await turn('Qual meu saldo?', 'balance');
    expect(JSON.stringify(balance.response.input)).toContain('3208');
    const count = send.mock.calls.length;
    create
      .mockResolvedValueOnce(
        tool('get_monthly_summary', { year: 2026, month: 10 }),
      )
      .mockResolvedValueOnce(final('Você gastou 42.00 EUR.'));
    const speech = await turn('Quanto gastei este mês?', 'unrelated');
    expect(JSON.stringify(send.mock.calls.slice(count))).not.toContain('3208');
    expect(JSON.stringify(speech)).not.toContain('saldo');
    expect(speech.response.conversation).toBe('none');
  });
  it.each(['FILTER_TIMEOUT', 'FILTER_UNAVAILABLE'] as const)(
    'processes active read requests despite %s',
    async (reasonCode) => {
      await connected();
      classify.mockResolvedValueOnce({
        classification: null,
        reasonCode,
        pendingStateExists: false,
      });
      create
        .mockResolvedValueOnce(
          tool('get_monthly_summary', { year: 2026, month: 10 }),
        )
        .mockResolvedValueOnce(final('Você gastou 42.00 EUR.'));
      const response = await turn('Quanto gastei este mês?', 'fallback_read');
      expect((await status()).body.turns.at(-1).answer).toBe(
        'Você gastou 42.00 EUR.',
      );
      expect(response.response.metadata.stage).toBe('speech');
      expect(create).toHaveBeenCalledTimes(2);
      expect(store.expenses.size).toBe(0);
    },
  );
  it('does not discard the PetStop write on timeout and still requires payer clarification and later confirmation', async () => {
    await connected();
    store.mappings.set('petstop', 'PETS');
    classify.mockResolvedValue({
      classification: null,
      reasonCode: 'FILTER_TIMEOUT',
      pendingStateExists: false,
    });
    create.mockResolvedValueOnce(
      tool('prepare_expense', {
        amount: '15.40',
        currency: 'EUR',
        merchant: 'PetStop',
        transactionDate: '2026-10-20',
        payer: null,
        description: null,
        language: 'pt',
      }),
    );
    fire({ type: 'input_audio_buffer.speech_started', item_id: 'petstop' });
    await turn('Ontem eu gastei 15 euros e 40 centavos no PetStop', 'petstop');
    expect(store.expenses.size).toBe(0);
    expect([...store.pending.values()][0]).toMatchObject({
      status: 'PENDING',
      payer: null,
      confirmationRequested: false,
    });
    expect([...store.pending.values()][0].amount.toFixed(2)).toBe('15.40');
    await turn('Pode salvar.', 'missing_payer');
    expect(store.expenses.size).toBe(0);
    create.mockResolvedValueOnce(
      tool('patch_pending_expense', {
        changes: [{ field: 'payer', value: 'SPOUSE' }],
        language: 'pt',
      }),
    );
    await turn('No cartão da minha esposa.', 'payer');
    expect([...store.pending.values()][0]).toMatchObject({
      status: 'PENDING',
      payer: 'SPOUSE',
      confirmationRequested: true,
    });
    expect(store.expenses.size).toBe(0);
    await turn('Pode salvar.', 'final_confirmation');
    await turn('Pode salvar.', 'repeat_confirmation');
    expect(store.expenses.size).toBe(1);
    expect([...store.pending.values()][0].status).toBe('CONFIRMED');
    expect(create).toHaveBeenCalledTimes(2);
  });
  it('keeps POST /ai/chat independent of Realtime classifier availability', async () => {
    classify.mockRejectedValue(new Error('classifier unavailable'));
    create
      .mockResolvedValueOnce(
        tool('get_monthly_summary', { year: 2026, month: 10 }),
      )
      .mockResolvedValueOnce(final('Você gastou 42.00 EUR.'));
    const result = await request(app.getHttpServer())
      .post('/ai/chat')
      .send({ conversationId: id, message: 'Quanto gastei este mês?' })
      .expect(201);
    expect(result.body.answer).toBe('Você gastou 42.00 EUR.');
    expect(classify).not.toHaveBeenCalled();
  });

  it('shares merchant/payer/amount/date patches between Realtime and chat without tying them to the last question', async () => {
    await connected();
    create.mockResolvedValueOnce(
      tool('prepare_expense', {
        amount: '16.43',
        currency: 'EUR',
        merchant: null,
        description: null,
        transactionDate: '2026-10-21',
        payer: null,
        language: 'pt',
      }),
    );
    await turn(
      'Ontem eu gastei dezesseis euros e quarenta e três centavos.',
      'draft',
    );
    expect((await status()).body.turns.at(-1).answer).toContain(
      'Foi no seu cartão',
    );
    create
      .mockResolvedValueOnce(
        tool('patch_pending_expense', {
          changes: [{ field: 'merchant', value: 'Mr. Price' }],
          language: 'pt',
        }),
      )
      .mockResolvedValueOnce(final('{"category":"SHOPPING"}'));
    await turn('na loja Mr. Price.', 'merchant_patch');
    expect([...store.pending.values()][0]).toMatchObject({
      merchant: 'Mr. Price',
      payer: null,
      category: 'SHOPPING',
    });
    expect((await status()).body.turns.at(-1).answer).toContain(
      'Foi no seu cartão',
    );

    create.mockResolvedValueOnce(
      tool('patch_pending_expense', {
        changes: [{ field: 'payer', value: 'SPOUSE' }],
        language: 'pt',
      }),
    );
    const payer = await request(app.getHttpServer())
      .post('/ai/chat')
      .send({ conversationId: id, message: 'da minha esposa' })
      .expect(201);
    expect(payer.body.answer).toContain('Deseja salvar?');
    create.mockResolvedValueOnce(
      tool('patch_pending_expense', {
        changes: [{ field: 'amount', value: '18.00' }],
        language: 'pt',
      }),
    );
    await turn('na verdade foram 18 euros', 'amount_patch');
    create.mockResolvedValueOnce(
      tool('patch_pending_expense', {
        changes: [{ field: 'transactionDate', value: '2026-10-20' }],
        language: 'pt',
      }),
    );
    await request(app.getHttpServer())
      .post('/ai/chat')
      .send({
        conversationId: id,
        message: 'Foi no dia 20 de outubro de 2026.',
      })
      .expect(201);
    const draft = [...store.pending.values()][0];
    expect(draft).toMatchObject({
      merchant: 'Mr. Price',
      payer: 'SPOUSE',
      category: 'SHOPPING',
      transactionDate: new Date('2026-10-20'),
      revision: 5,
    });
    expect(draft.amount.toFixed(2)).toBe('18.00');
    expect(store.expenses.size).toBe(0);
    await turn('Pode salvar.', 'confirm_patched');
    await turn('Pode salvar.', 'confirm_patched_again');
    expect(store.database.expense.create).toHaveBeenCalledOnce();
    expect([...store.expenses.values()][0]).toMatchObject({
      merchant: 'Mr. Price',
      payer: 'SPOUSE',
      category: 'SHOPPING',
      transactionDate: new Date('2026-10-20'),
    });
  });

  it.each(['Sim.', 'Não.'])(
    'keeps one persisted Realtime draft and conversation through clear payer then %s',
    async (action) => {
      await connected();
      store.mappings.set('mr. price', 'SHOPPING');
      create.mockResolvedValueOnce(
        tool('prepare_expense', {
          amount: '16.43',
          currency: 'EUR',
          merchant: 'Mr. Price',
          transactionDate: '2026-10-21',
          payer: null,
          description: null,
          language: 'pt',
        }),
      );
      await turn(
        'Eu gastei dezesseis euros e quarenta e três centavos ontem no Mr. Price.',
        'payer_draft',
      );
      const original = store.pending.get(session.conversationId)!;
      expect(original).toMatchObject({
        payer: null,
        status: 'PENDING',
        confirmationRequested: false,
      });
      expect((await status()).body.turns.at(-1).answer).toContain(
        'Foi no seu cartão',
      );
      expect(store.expenses.size).toBe(0);
      create.mockResolvedValueOnce(
        tool('patch_pending_expense', {
          changes: [{ field: 'payer', value: 'SPOUSE' }],
          language: 'pt',
          confirmationQuestion: null,
        }),
      );
      await turn('Foi minha esposa.', 'payer_answer');
      expect(store.pending.get(session.conversationId)).toMatchObject({
        ...original,
        payer: 'SPOUSE',
        revision: 2,
        confirmationRequested: true,
      });
      const reviewed = await status();
      expect(reviewed.body.conversationId).toBe(session.conversationId);
      expect(reviewed.body.turns.at(-1).answer).toContain('Deseja salvar?');
      expect(reviewed.body.turns.at(-1).answer).not.toContain(
        'Você quis dizer',
      );
      expect(store.expenses.size).toBe(0);
      await turn(action, 'payer_decision');
      await turn('Sim.', 'payer_repeated_confirmation');
      expect(store.pending.get(session.conversationId)).toMatchObject({
        id: original.id,
        status: action === 'Sim.' ? 'CONFIRMED' : 'CANCELLED',
      });
      expect(store.expenses.size).toBe(action === 'Sim.' ? 1 : 0);
      expect(store.database.expense.create).toHaveBeenCalledTimes(
        action === 'Sim.' ? 1 : 0,
      );
      expect(create).toHaveBeenCalledTimes(2);
      expect(
        history
          .filter((message) => message.role === 'USER')
          .map((message) => message.content),
      ).toEqual([
        'Eu gastei dezesseis euros e quarenta e três centavos ontem no Mr. Price.',
        'Foi minha esposa.',
        action,
        'Sim.',
      ]);
    },
  );

  it('preserves an ambiguous payer clarification across Realtime and chat without authorizing a write', async () => {
    await connected();
    create.mockResolvedValueOnce(
      tool('prepare_expense', {
        amount: '16.43',
        currency: 'EUR',
        merchant: 'Tesco',
        transactionDate: '2026-10-21',
        payer: null,
        description: null,
        language: 'pt',
      }),
    );
    await turn(
      'Eu gastei dezesseis euros e quarenta e três centavos ontem no Tesco.',
      'ambiguous_draft',
    );
    const original = store.pending.get(session.conversationId)!;
    const question = 'Quem é o titular do cartão compartilhado?';
    create.mockResolvedValueOnce(tool('ask_clarification', { question }));
    await turn('Foi naquele cartão compartilhado.', 'ambiguous_payer');
    expect((await status()).body.turns.at(-1).answer).toBe(question);
    expect(store.pending.get(session.conversationId)).toEqual(original);
    const yes = await request(app.getHttpServer())
      .post('/ai/chat')
      .send({ conversationId: session.conversationId, message: 'Sim.' })
      .expect(201);
    expect(yes.body.answer).toContain('Foi no seu cartão');
    expect(yes.body.answer).not.toContain('Não há despesa pendente');
    expect(store.pending.get(session.conversationId)).toEqual(original);
    expect(store.expenses.size).toBe(0);
  });
  it('deduplicates function-call events and does not retry domain work', async () => {
    create
      .mockResolvedValueOnce(
        tool('get_monthly_summary', { year: 2026, month: 10 }),
      )
      .mockResolvedValueOnce(final('Você gastou 42.00 EUR.'));
    await turn('Quanto gastei este mês?', 'read');
    fire({
      type: 'response.function_call_arguments.done',
      response_id: 'route_read',
      name: 'finance_turn',
      arguments: '{}',
      call_id: 'call_read',
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(create).toHaveBeenCalledTimes(2);
    expect(history).toHaveLength(2);
  });
  it('refuses model arguments that invent a confirmation message', async () => {
    fire({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'bad',
      transcript: 'Quanto gastei?',
    });
    await waitForRoute('bad');
    fire({
      type: 'response.created',
      response: { id: 'route_bad', metadata: { turnId: 'bad' } },
    });
    fire({
      type: 'response.function_call_arguments.done',
      response_id: 'route_bad',
      name: 'finance_turn',
      arguments: '{"message":"Pode salvar"}',
      call_id: 'bad',
    });
    await vi.waitFor(() => expect(send.mock.calls.at(-1)?.[0]).toBeTruthy());
    expect(create).not.toHaveBeenCalled();
    expect(store.expenses.size).toBe(0);
  });
  it.each(['close', 'error'])(
    'handles sideband %s without financial retries',
    async (type) => {
      if (type === 'close') closed();
      else failed();
      await vi.waitFor(() => expect(hangup).toHaveBeenCalledOnce());
      expect((await status()).body.state).toBe(
        type === 'close' ? 'disconnected' : 'error',
      );
      expect(create).not.toHaveBeenCalled();
    },
  );
  it('does not authorize a queued yes spoken before the pending review completed', async () => {
    let resolve!: (value: unknown) => void;
    create.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    fire({ type: 'input_audio_buffer.speech_stopped', item_id: 'draft' });
    fire({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'draft',
      transcript: 'Gastei 20 euros no Tesco no cartão da minha esposa.',
    });
    await waitForRoute('draft');
    fire({
      type: 'response.created',
      response: { id: 'route_draft', metadata: { turnId: 'draft' } },
    });
    fire({
      type: 'response.function_call_arguments.done',
      response_id: 'route_draft',
      name: 'finance_turn',
      arguments: '{}',
      call_id: 'draft_call',
    });
    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
    fire({ type: 'input_audio_buffer.speech_started', item_id: 'early_yes' });
    fire({ type: 'input_audio_buffer.speech_stopped', item_id: 'early_yes' });
    fire({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'early_yes',
      transcript: 'Pode salvar.',
    });
    resolve(
      tool('prepare_expense', {
        amount: '20.00',
        currency: 'EUR',
        merchant: 'Tesco',
        transactionDate: '2026-10-15',
        payer: 'SPOUSE',
        language: 'pt',
        description: null,
      }),
    );
    await vi.waitFor(() => expect(history).toHaveLength(4));
    expect(store.expenses.size).toBe(0);
    expect(send.mock.calls.some((c) => c[0].type === 'response.cancel')).toBe(
      false,
    );
    await turn('Pode salvar.', 'later_yes');
    expect(store.expenses.size).toBe(1);
    expect(create).toHaveBeenCalledOnce();
  });
});

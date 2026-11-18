import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { AnalyticsService } from '../src/analytics/analytics.service.js';
import { ExpensesService } from '../src/expenses/expenses.service.js';
import { ConversationService } from '../src/conversations/conversation.service.js';
import { NotFoundException } from '@nestjs/common';
import { PendingExpenseService } from '../src/pending-expenses/pending-expense.service.js';
import { BudgetsService } from '../src/budgets/budgets.service.js';
import { InsightsService } from '../src/analytics/insights/insights.service.js';

const { create } = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('openai', () => ({
  default: class {
    responses = { create };
  },
}));

describe('POST /ai/chat (mocked SDK)', () => {
  let app: INestApplication;
  const monthlySummary = vi.fn();
  const byMerchant = vi.fn();
  const spendingPace = vi.fn();
  const byCategory = vi.fn();
  const budgetStatus = vi.fn();
  const financialInsights = vi.fn();
  const findAll = vi.fn();
  const conversationId = '11111111-1111-4111-8111-111111111111';
  const conversations = {
    create: vi.fn(),
    recentMessages: vi.fn(),
    saveTurn: vi.fn(),
  };
  const final = {
    status: 'completed',
    output: [],
    output_text: 'You spent EUR 78.50 and BRL 119.90.',
  };
  const call = (name: string, args: object) => ({
    status: 'completed',
    output: [
      {
        type: 'function_call',
        name,
        arguments: JSON.stringify(args),
        call_id: 'call1',
        id: 'fc1',
      },
    ],
    output_text: '',
  });
  beforeEach(async () => {
    vi.resetAllMocks();
    vi.stubEnv('OPENAI_API_KEY', 'test-key');
    conversations.create.mockResolvedValue({ id: conversationId });
    conversations.recentMessages.mockResolvedValue([]);
    conversations.saveTurn.mockResolvedValue(undefined);
    monthlySummary.mockResolvedValue({
      period: { year: 2026, month: 10 },
      totals: { EUR: '78.50', BRL: '119.90' },
    });
    findAll.mockResolvedValue([]);
    byMerchant.mockResolvedValue([
      { merchant: 'Tesco', currency: 'EUR', total: '78.50' },
      { merchant: 'Tesco', currency: 'BRL', total: '119.90' },
    ]);
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(InsightsService)
      .useValue({ findAll: financialInsights })
      .overrideProvider(BudgetsService)
      .useValue({
        getPending: vi.fn().mockResolvedValue(null),
        statusFor: budgetStatus,
      })
      .overrideProvider(PrismaService)
      .useValue({pendingBankBalance: {findUnique: vi.fn().mockResolvedValue(null)}})
      .overrideProvider(AnalyticsService)
      .useValue({ monthlySummary, byMerchant, spendingPace, byCategory })
      .overrideProvider(ExpensesService)
      .useValue({ findAll })
      .overrideProvider(ConversationService)
      .useValue(conversations)
      .overrideProvider(PendingExpenseService)
      .useValue({ get: vi.fn().mockResolvedValue(null) })
      .compile();
    app = module.createNestApplication();
    await app.init();
  });
  afterEach(async () => {
    await app?.close();
    vi.unstubAllEnvs();
  });

  it('accepts a valid monthly question and returns a tool-grounded response', async () => {
    create
      .mockResolvedValueOnce(
        call('get_monthly_summary', { year: 2026, month: 10 }),
      )
      .mockResolvedValueOnce(final);
    await request(app.getHttpServer())
      .post('/ai/chat')
      .send({ message: 'How much did I spend in October 2026?' })
      .expect(201)
      .expect({ conversationId, answer: final.output_text });
    expect(monthlySummary).toHaveBeenCalledWith({ year: '2026', month: '10' });
  });

  it.each([
    ['Tem algo importante nas minhas finanças este mês?', null, null],
    [
      'Alguma assinatura aumentou?',
      'RECURRING_EXPENSE_INCREASE',
      'SUBSCRIPTIONS',
    ],
  ])('uses backend insights for %s', async (message, type, category) => {
    financialInsights.mockResolvedValue([
      {
        type: type ?? 'BUDGET_AT_RISK',
        severity: 'WARNING',
        currency: 'EUR',
        data: { projectedMonthTotal: '602.59' },
      },
    ]);
    const exact =
      message === 'Tem algo importante nas minhas finanças este mês?';
    if (!exact)
      create.mockResolvedValueOnce(
        call('get_financial_insights', {
          currency: null,
          severity: null,
          type,
          category,
        }),
      );
    create.mockResolvedValueOnce({
      ...final,
      output_text: 'Há um alerta financeiro.',
    });
    await request(app.getHttpServer())
      .post('/ai/chat')
      .send({ message })
      .expect(201);
    expect(financialInsights).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ type, category }),
    );
    expect(create.mock.calls[0][0].instructions).toContain(
      'Never calculate insight thresholds, severity, increases or problems yourself',
    );
    expect(JSON.stringify(create.mock.calls[exact ? 0 : 1][0].input)).toContain(
      '602.59',
    );
    if (exact) {
      expect(create).toHaveBeenCalledOnce();
      expect(create.mock.calls[0][0].tool_choice).toBe('none');
    }
  });
  it('permits a normal no-alerts response after empty backend insights', async () => {
    financialInsights.mockResolvedValue([]);
    const answer =
      'Não encontrei nenhum alerta financeiro relevante neste mês até agora.';
    create
      .mockResolvedValueOnce(
        call('get_financial_insights', {
          currency: null,
          severity: null,
          type: null,
          category: null,
        }),
      )
      .mockResolvedValueOnce({ ...final, output_text: answer });
    const result = await request(app.getHttpServer())
      .post('/ai/chat')
      .send({ message: 'Do I have any financial warnings this month?' })
      .expect(201);
    expect(result.body.answer).toBe(answer);
    expect(financialInsights).toHaveBeenCalledOnce();
    expect(create.mock.calls[0][0].instructions).toContain(
      'never invent advice or warnings',
    );
  });
  it('does not execute a repeated insight tool after exact-query prefetch', async () => {
    financialInsights.mockResolvedValue([]);
    create.mockResolvedValueOnce(
      call('get_financial_insights', {
        currency: null,
        type: null,
        severity: null,
        category: null,
      }),
    );
    await request(app.getHttpServer())
      .post('/ai/chat')
      .send({ message: 'Tem algo importante nas minhas finanças este mês?' })
      .expect(502);
    expect(financialInsights).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledOnce();
    expect(create.mock.calls[0][0].tool_choice).toBe('none');
  });

  it.each([
    ['Quais despesas recorrentes eu tenho?', 'get_recurring_expenses', null],
    ['Quais assinaturas eu tenho?', 'get_recurring_expenses', 'SUBSCRIPTIONS'],
    [
      'Quanto gasto por mês com despesas recorrentes?',
      'get_recurring_expense_summary',
      null,
    ],
  ])(
    'uses backend recurrence evidence for %s',
    async (message, name, category) => {
      const rows = ['2026-07-05', '2026-08-05', '2026-09-06', '2026-10-05'].map(
        (date, index) => ({
          id: String(index),
          merchant: 'Netflix',
          category: 'SUBSCRIPTIONS',
          currency: 'EUR',
          amount: '17.99',
          transactionDate: new Date(`${date}T00:00:00Z`),
        }),
      );
      findAll.mockResolvedValue(rows);
      create
        .mockResolvedValueOnce(
          call(name, {
            currency: null,
            category,
            merchant: null,
            from: null,
            to: null,
            confidence: null,
          }),
        )
        .mockResolvedValueOnce({
          ...final,
          output_text: 'Netflix: 17,99 EUR por mês.',
        });
      const response = await request(app.getHttpServer())
        .post('/ai/chat')
        .send({ message })
        .expect(201);
      expect(response.body.answer).toContain('17,99');
      expect(findAll).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ category }),
      );
      expect(create.mock.calls[0][0].instructions).toContain(
        'Never infer recurrence from merchant names',
      );
      expect(JSON.stringify(create.mock.calls[1][0].input)).toContain('17.99');
      if (name === 'get_recurring_expenses')
        expect(JSON.stringify(create.mock.calls[1][0].input)).toContain('HIGH');
    },
  );

  it('uses backend category totals for supermercado questions', async () => {
    byCategory.mockResolvedValue([
      { category: 'GROCERIES', currency: 'EUR', total: '252.70' },
    ]);
    create
      .mockResolvedValueOnce(
        call('get_by_category', {
          from: '2026-10-01',
          to: '2026-10-31',
          category: 'GROCERIES',
        }),
      )
      .mockResolvedValueOnce(final);
    await request(app.getHttpServer())
      .post('/ai/chat')
      .send({ message: 'Quanto gastei em supermercado este mês?' })
      .expect(201);
    expect(byCategory).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ category: 'GROCERIES' }),
    );
    expect(create.mock.calls[0][0].instructions).toContain(
      'Never manually consolidate Tesco + Lidl + Aldi',
    );
  });

  it.each([
    ['Qual minha média semanal com supermercado?', 'get_spending_pace'],
    ['Quanto ainda posso gastar com supermercado?', 'get_budget_status'],
  ])('uses category backend tool for %s', async (message, name) => {
    const args = {
      year: 2026,
      month: 10,
      currency: 'EUR',
      merchant: null,
      category: 'GROCERIES',
    };
    spendingPace.mockResolvedValue({
      results: [{ currency: 'EUR', weeklyAverage: '136.07' }],
    });
    budgetStatus.mockResolvedValue({ currency: 'EUR', remaining: '247.30' });
    create.mockResolvedValueOnce(call(name, args)).mockResolvedValueOnce(final);
    await request(app.getHttpServer())
      .post('/ai/chat')
      .send({ message })
      .expect(201);
    const domain = name === 'get_spending_pace' ? spendingPace : budgetStatus;
    expect(domain).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ category: 'GROCERIES', currency: 'EUR' }),
    );
  });

  it.each([
    'Qual minha média semanal no Tesco este mês?',
    'How much am I projected to spend this month?',
  ])('dispatches deterministic pace analytics for %s', async (message) => {
    const pace = {
      period: { year: 2026, month: 10, daysElapsed: 13, daysInMonth: 31 },
      results: [
        {
          currency: 'EUR',
          weeklyAverage: '136.07',
          projectedMonthTotal: '602.59',
        },
      ],
    };
    spendingPace.mockResolvedValue(pace);
    create
      .mockResolvedValueOnce(
        call('get_spending_pace', {
          year: 2026,
          month: 10,
          merchant: 'Tesco',
          currency: 'EUR',
        }),
      )
      .mockResolvedValueOnce({
        ...final,
        output_text: '136.07 EUR; 602.59 EUR',
      });
    const response = await request(app.getHttpServer())
      .post('/ai/chat')
      .send({ message })
      .expect(201);
    expect(response.body.answer).toBe('136.07 EUR; 602.59 EUR');
    expect(spendingPace).toHaveBeenCalledExactlyOnceWith({
      year: '2026',
      month: '10',
      merchant: 'Tesco',
      currency: 'EUR',
    });
    expect(create.mock.calls[0][0].tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'get_spending_pace' }),
      ]),
    );
    expect(create.mock.calls[0][0].instructions).toContain(
      'MUST use get_spending_pace',
    );
    expect(create.mock.calls[0][0].instructions).toContain(
      'Never invent week counts or compute projections',
    );
    expect(JSON.stringify(create.mock.calls[1][0].input)).toContain('136.07');
  });

  it('uses filtered expenses for a merchant question', async () => {
    create
      .mockResolvedValueOnce(
        call('get_expenses', {
          currency: null,
          merchant: 'Tesco',
          from: null,
          to: null,
        }),
      )
      .mockResolvedValueOnce(final);
    await request(app.getHttpServer())
      .post('/ai/chat')
      .send({ message: 'How much at Tesco?' })
      .expect(201);
    expect(findAll).toHaveBeenCalledWith(
      expect.objectContaining({ merchant: 'Tesco' }),
    );
    expect(byMerchant).toHaveBeenCalled();
  });

  it.each([
    [
      'How much did I spend at Amazon in January 2025?',
      'Amazon',
      '2025-01-01',
      '2025-01-31',
      'No Amazon expenses found in January 2025.',
    ],
    [
      'Show my Tesco expenses from October 1st to October 31st 2026.',
      'Tesco',
      '2026-10-01',
      '2026-10-31',
      'No Tesco expenses found from October 1 to October 31, 2026. There are 0 matching expenses.',
    ],
  ])(
    'accepts an empty-result answer for %s',
    async (message, merchant, from, to, answer) => {
      findAll.mockResolvedValue([]);
      byMerchant.mockResolvedValue([]);
      create
        .mockResolvedValueOnce(
          call('get_expenses', { currency: null, merchant, from, to }),
        )
        .mockResolvedValueOnce({ ...final, output_text: answer });
      await request(app.getHttpServer())
        .post('/ai/chat')
        .send({ message })
        .expect(201)
        .expect({ conversationId, answer });
      expect(findAll).toHaveBeenCalledWith(
        expect.objectContaining({ merchant, from, to }),
      );
    },
  );

  it.each([
    {},
    { message: '' },
    { message: '  ' },
    { message: 42 },
    { message: 'ok', secret: 'extra' },
  ])('rejects invalid body %j', async (body) => {
    await request(app.getHttpServer()).post('/ai/chat').send(body).expect(400);
    expect(create).not.toHaveBeenCalled();
  });

  it('reuses the returned conversation id in a second request', async () => {
    create
      .mockResolvedValueOnce(
        call('get_monthly_summary', { year: 2026, month: 10 }),
      )
      .mockResolvedValueOnce(final);
    const first = await request(app.getHttpServer())
      .post('/ai/chat')
      .send({ message: 'October 2026?' })
      .expect(201);
    expect(first.body.conversationId).toBe(conversationId);
    conversations.recentMessages.mockResolvedValue([
      { role: 'USER', content: 'October 2026?' },
      { role: 'ASSISTANT', content: final.output_text },
    ]);
    create
      .mockResolvedValueOnce(
        call('get_monthly_summary', { year: 2026, month: 9 }),
      )
      .mockResolvedValueOnce(final);
    await request(app.getHttpServer())
      .post('/ai/chat')
      .send({
        conversationId: first.body.conversationId,
        message: 'And in September?',
      })
      .expect(201)
      .expect({ conversationId, answer: final.output_text });
    expect(conversations.create).toHaveBeenCalledTimes(1);
    expect(conversations.recentMessages).toHaveBeenCalledWith(conversationId);
    expect(monthlySummary).toHaveBeenLastCalledWith({
      year: '2026',
      month: '9',
    });
  });

  it('returns 404 for an unknown conversation without invoking OpenAI', async () => {
    conversations.recentMessages.mockRejectedValue(
      new NotFoundException('Conversation not found'),
    );
    await request(app.getHttpServer())
      .post('/ai/chat')
      .send({ conversationId, message: 'follow-up' })
      .expect(404);
    expect(create).not.toHaveBeenCalled();
  });

  it.each(['not-a-uuid', '', null, 123])(
    'returns 400 for invalid conversationId %j',
    async (invalidId) => {
      await request(app.getHttpServer())
        .post('/ai/chat')
        .send({ conversationId: invalidId, message: 'follow-up' })
        .expect(400);
      expect(conversations.recentMessages).not.toHaveBeenCalled();
      expect(create).not.toHaveBeenCalled();
    },
  );

  it('returns a safe upstream error', async () => {
    create.mockRejectedValue(new Error('secret upstream trace'));
    const response = await request(app.getHttpServer())
      .post('/ai/chat')
      .send({ message: 'this month' })
      .expect(502);
    expect(JSON.stringify(response.body)).not.toMatch(/secret|trace/);
  });
});

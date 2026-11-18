import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { BudgetsService } from '../src/budgets/budgets.service.js';
import { ConversationService } from '../src/conversations/conversation.service.js';
import { PendingExpenseService } from '../src/pending-expenses/pending-expense.service.js';
import { Prisma } from '../src/generated/prisma/client.js';
import { budgetDatabase } from './helpers/budget-database.js';
const { create } = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('openai', () => ({
  default: class {
    responses = { create };
  },
}));
describe('contextual budget pace follow-ups (real domain services)', () => {
  let app: INestApplication;
  let budgets: BudgetsService;
  let spent: string;
  let history: Array<{ role: string; content: string }>;
  const id = '11111111-1111-4111-8111-111111111111';
  const tool = (name: string, args: object) => ({
    status: 'completed',
    output: [
      {
        type: 'function_call',
        name,
        arguments: JSON.stringify(args),
        call_id: '1',
        id: 'fc1',
      },
    ],
    output_text: '',
  });
  const reply = (answer: string) => ({
    status: 'completed',
    output: [],
    output_text: answer,
  });
  const chat = (message: string) =>
    request(app.getHttpServer())
      .post('/ai/chat')
      .send({ message, conversationId: id });
  beforeEach(async () => {
    vi.resetAllMocks();
    vi.stubEnv('OPENAI_API_KEY', 'test');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-14T12:00:00Z'));
    spent = '252.70';
    history = [];
    const store = budgetDatabase();
    store.database.expense = {
      findMany: vi.fn(async ({ where }: any = {}) =>
        [
          {
            id: 'eur',
            amount: new Prisma.Decimal(spent),
            currency: 'EUR',
            category: 'GROCERIES',
            merchant: 'Tesco',
            transactionDate: new Date('2026-10-14Z'),
          },
          {
            id: 'brl',
            amount: new Prisma.Decimal('97.00'),
            currency: 'BRL',
            category: 'GROCERIES',
            merchant: 'Tesco',
            transactionDate: new Date('2026-10-14Z'),
          },
        ].filter(
          (row) =>
            (!where?.currency || row.currency === where.currency) &&
            (!where?.category || row.category === where.category) &&
            (!where?.transactionDate ||
              ((!where.transactionDate.gte ||
                row.transactionDate >= where.transactionDate.gte) &&
                (!where.transactionDate.lt ||
                  row.transactionDate < where.transactionDate.lt) &&
                (!where.transactionDate.lte ||
                  row.transactionDate <= where.transactionDate.lte))),
        ),
      ),
    };
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(store.database)
      .overrideProvider(PendingExpenseService)
      .useValue({ get: vi.fn().mockResolvedValue(null) })
      .overrideProvider(ConversationService)
      .useValue({
        create: vi.fn().mockResolvedValue({ id }),
        recentMessages: vi.fn(async () => history),
        saveTurn: vi.fn(async (_id: string, user: string, answer: string) => {
          history.push(
            { role: 'USER', content: user },
            { role: 'ASSISTANT', content: answer },
          );
        }),
      })
      .compile();
    budgets = module.get(BudgetsService);
    await budgets.create({
      amount: '500.00',
      currency: 'EUR' as never,
      year: 2026,
      month: 10,
      merchant: 'Tesco',
    });
    app = module.createNestApplication();
    await app.init();
  });
  afterEach(async () => {
    await app.close();
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });
  it('extends budget status with the requested daily guidance', async () => {
    const row = (await budgets.findAll())[0];
    const result = await request(app.getHttpServer())
      .get(`/budgets/${row.id}/status`)
      .expect(200);
    expect(result.body).toMatchObject({
      spent: '252.70',
      remaining: '247.30',
      daysElapsed: 14,
      daysRemaining: 17,
      currentDailyAverage: '18.05',
      allowedDailyAverageRemaining: '14.55',
      requiredDailyReduction: '3.50',
      requiredReductionPercentage: '19.41',
    });
  });
  it('insight -> reduction resolves Tesco and fetches fresh facts without another model decision', async () => {
    create.mockResolvedValueOnce(
      reply(
        'O orçamento do Tesco de 500 EUR está em risco: gasto de 252.70 EUR e projeção de 559.55 EUR.',
      ),
    );
    await chat('Tem algo importante nas minhas finanças este mês?').expect(201);
    const status = vi.spyOn(budgets, 'statusFor');
    const result = await chat(
      'Quanto preciso reduzir meus gastos para não estourar o orçamento?',
    ).expect(201);
    expect(result.body.answer).toContain('247.30 EUR');
    expect(result.body.answer).toContain('14.55 EUR');
    expect(result.body.answer).toContain('19.41%');
    expect(status).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledOnce();
    spent = '270.00';
    const changed = await chat('Quanto posso gastar por dia?').expect(201);
    expect(changed.body.answer).toContain('230.00 EUR');
    expect(changed.body.answer).not.toContain('247.30 EUR');
    expect(status).toHaveBeenCalledTimes(2);
  });
  it('budget status -> daily and weekly follow-ups reuse budget scope only', async () => {
    create
      .mockResolvedValueOnce(
        tool('get_budget_status', {
          year: 2026,
          month: 10,
          currency: 'EUR',
          merchant: 'Tesco',
          category: null,
        }),
      )
      .mockResolvedValueOnce(
        reply('Seu orçamento no Tesco em EUR tem 247.30 EUR restantes.'),
      );
    await chat('Estou dentro do orçamento do Tesco?').expect(201);
    const daily = await chat('Quanto posso gastar por dia?').expect(201);
    expect(daily.body.answer).toContain('14.55 EUR');
    const weekly = await chat('E quanto por semana?').expect(201);
    expect(weekly.body.answer).toContain('101.83 EUR');
    expect(weekly.body.answer).toContain('7 dias');
  });
  it('clarifies ambiguous or missing context instead of generic fallback', async () => {
    const missing = await chat('Quanto preciso reduzir?').expect(201);
    expect(missing.body.answer).toContain('A qual orçamento');
    expect(missing.body.answer).not.toContain('No financial data');
    await budgets.create({
      amount: '500.00',
      currency: 'EUR' as never,
      year: 2026,
      month: 10,
      category: 'GROCERIES' as never,
    });
    history = [
      {
        role: 'ASSISTANT',
        content:
          'O orçamento do Tesco e o orçamento de supermercado em EUR estão em risco.',
      },
    ];
    const ambiguous = await chat('Quanto preciso reduzir?').expect(201);
    expect(ambiguous.body.answer).toContain('A qual orçamento');
    expect(create).not.toHaveBeenCalled();
  });
  it('keeps BRL/EUR guidance separate', async () => {
    await budgets.create({
      amount: '200.00',
      currency: 'BRL' as never,
      year: 2026,
      month: 10,
      merchant: 'Tesco',
    });
    const result = await chat(
      'Quanto posso gastar por dia no Tesco em BRL?',
    ).expect(201);
    expect(result.body.answer).toContain('103.00 BRL');
    expect(result.body.answer).not.toContain('EUR');
  });
});

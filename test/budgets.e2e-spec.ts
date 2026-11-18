import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { PendingExpenseService } from '../src/pending-expenses/pending-expense.service.js';
import { ConversationService } from '../src/conversations/conversation.service.js';
import { Prisma } from '../src/generated/prisma/client.js';
import { budgetDatabase } from './helpers/budget-database.js';
const { create } = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('openai', () => ({
  default: class {
    responses = { create };
  },
}));
describe('Budgets HTTP and conversational confirmation', () => {
  let app: INestApplication;
  let store: ReturnType<typeof budgetDatabase>;
  const id = '11111111-1111-4111-8111-111111111111';
  const input = {
    amount: '500.00',
    currency: 'EUR',
    year: 2026,
    month: 10,
    merchant: 'Tesco',
  };
  let history: Array<{ role: string; content: string }>;
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
  const chat = (message: string) =>
    request(app.getHttpServer())
      .post('/ai/chat')
      .send({ message, conversationId: id });
  beforeEach(async () => {
    vi.resetAllMocks();
    vi.stubEnv('OPENAI_API_KEY', 'test');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-13T12:00:00Z'));
    store = budgetDatabase();
    history = [];
    store.database.expense = {
      findMany: vi.fn(async ({ where }: any) => {
        const rows = [
          {
            amount: new Prisma.Decimal('252.70'),
            currency: 'EUR',
            merchant: 'Tesco',
            category: 'GROCERIES',
          },
          {
            amount: new Prisma.Decimal('97.00'),
            currency: 'BRL',
            merchant: 'Tesco',
            category: 'GROCERIES',
          },
        ];
        return rows
          .filter((row) => !where.currency || row.currency === where.currency)
          .filter(
            (row) =>
              !where.merchant ||
              row.merchant
                .toLowerCase()
                .includes(where.merchant.contains.toLowerCase()),
          )
          .filter((row) => !where.category || row.category === where.category);
      }),
    };
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(store.database)
      .overrideProvider(PendingExpenseService)
      .useValue({ get: vi.fn().mockResolvedValue(null) })
      .overrideProvider(ConversationService)
      .useValue({
        recentMessages: vi.fn(async () => history),
        create: vi.fn().mockResolvedValue({ id }),
        saveTurn: vi.fn(async (_id: string, user: string, answer: string) => {
          history.push(
            { role: 'USER', content: user },
            { role: 'ASSISTANT', content: answer },
          );
        }),
      })
      .compile();
    app = module.createNestApplication();
    await app.init();
  });
  afterEach(async () => {
    await app.close();
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });
  it('creates, lists, retrieves and calculates EUR status with no BRL mixing', async () => {
    const created = await request(app.getHttpServer())
      .post('/budgets')
      .send(input)
      .expect(201);
    const budgetId = created.body.id;
    await request(app.getHttpServer()).get('/budgets').expect(200);
    await request(app.getHttpServer()).get(`/budgets/${budgetId}`).expect(200);
    const status = await request(app.getHttpServer())
      .get(`/budgets/${budgetId}/status`)
      .expect(200);
    expect(status.body).toMatchObject({
      spent: '252.70',
      remaining: '247.30',
      percentageUsed: '50.54',
      status: 'ON_TRACK',
      projectedMonthTotal: '602.59',
      projectedOverBudget: true,
    });
    await request(app.getHttpServer())
      .post('/budgets')
      .send({ ...input, merchant: 'tesco' })
      .expect(409);
  });
  it('calculates category budget from categorized expenses', async () => {
    const row = await request(app.getHttpServer())
      .post('/budgets')
      .send({ ...input, merchant: undefined, category: 'GROCERIES' })
      .expect(201);
    const status = await request(app.getHttpServer())
      .get(`/budgets/${row.body.id}/status`)
      .expect(200);
    expect(status.body.spent).toBe('252.70');
  });
  it.each([
    { amount: '0' },
    { currency: 'USD' },
    { category: 'GROCERIES' },
    { merchant: undefined },
  ])('rejects invalid budget %j', async (change) => {
    await request(app.getHttpServer())
      .post('/budgets')
      .send({ ...input, ...change })
      .expect(400);
  });
  it('prepares, confirms once, and preserves context for fresh budget status tools', async () => {
    create.mockResolvedValueOnce(
      tool('prepare_budget', { ...input, category: null }),
    );
    const pending = await chat(
      'Quero gastar no máximo 500 euros no Tesco este mês.',
    ).expect(201);
    expect(pending.body.answer).toContain('Orçamento pendente');
    expect(store.budgets.size).toBe(0);
    await chat('Pode salvar.').expect(201);
    await chat('Pode salvar.').expect(201);
    expect(store.budgets.size).toBe(1);
    const args = {
      year: 2026,
      month: 10,
      currency: 'EUR',
      merchant: 'Tesco',
      category: null,
    };
    create
      .mockResolvedValueOnce(tool('get_budget_status', args))
      .mockResolvedValueOnce({
        status: 'completed',
        output: [],
        output_text: 'Restam 247,30 EUR.',
      });
    await chat('Quanto ainda posso gastar no Tesco?').expect(201);
    create
      .mockResolvedValueOnce(tool('get_budget_status', args))
      .mockResolvedValueOnce({
        status: 'completed',
        output: [],
        output_text: '247.30 EUR left.',
      });
    await chat('And how much is left?').expect(201);
    const lastRequest = create.mock.calls[3][0];
    expect(JSON.stringify(lastRequest.input)).toContain('Tesco');
    expect(lastRequest.instructions).toContain('Never calculate remaining');
  });
  it('cancels pending budget without persistence', async () => {
    create.mockResolvedValueOnce(
      tool('prepare_budget', { ...input, category: null }),
    );
    await chat('Create a Tesco budget of 500 EUR.').expect(201);
    await chat('cancel').expect(201);
    await chat('yes').expect(201);
    expect(store.budgets.size).toBe(0);
  });
});

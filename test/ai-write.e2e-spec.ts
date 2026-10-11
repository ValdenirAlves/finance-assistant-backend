import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { ConversationService } from '../src/conversations/conversation.service.js';
import { ExpensesService } from '../src/expenses/expenses.service.js';
import { pendingDatabase } from './helpers/pending-database.js';

const { create } = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('openai', () => ({
  default: class {
    responses = { create };
  },
}));

describe('AI expense preparation and confirmation (mocked SDK/database)', () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const other = '22222222-2222-4222-8222-222222222222';
  const input = {
    amount: '45.00',
    currency: 'EUR',
    merchant: 'Tesco',
    description: null,
    transactionDate: '2026-10-09',
    language: 'en',
  };
  const preparation = (args: object) => ({
    status: 'completed',
    output: [
      {
        type: 'function_call',
        name: 'prepare_expense',
        arguments: JSON.stringify(args),
        call_id: 'call1',
        id: 'fc1',
      },
    ],
    output_text: '',
  });
  let store: ReturnType<typeof pendingDatabase>;
  let app: INestApplication;
  let expenses: ExpensesService;
  let turnHistory: Array<{ role: string; content: string }>;
  const chat = (message: string, conversationId: string | undefined = id) =>
    request(app.getHttpServer())
      .post('/ai/chat')
      .send({ message, ...(conversationId ? { conversationId } : {}) });
  beforeEach(async () => {
    vi.resetAllMocks();
    vi.stubEnv('OPENAI_API_KEY', 'test-key');
    store = pendingDatabase();
    turnHistory = [];
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(store.database)
      .overrideProvider(ConversationService)
      .useValue({
        create: vi.fn().mockResolvedValue({ id }),
        recentMessages: vi.fn(async () => turnHistory),
        saveTurn: vi.fn(
          async (_id: string, user: string, assistant: string) => {
            turnHistory.push(
              { role: 'USER', content: user },
              { role: 'ASSISTANT', content: assistant },
            );
          },
        ),
      })
      .compile();
    expenses = module.get(ExpensesService);
    app = module.createNestApplication();
    await app.init();
  });
  afterEach(async () => {
    await app?.close();
    vi.unstubAllEnvs();
  });

  it.each(['EUR', 'BRL'])(
    'prepares %s, asks confirmation and saves only once after yes',
    async (currency) => {
      create.mockResolvedValueOnce(preparation({ ...input, currency }));
      const first = await chat(
        `I spent 45 ${currency} at Tesco today.`,
        undefined,
      ).expect(201);
      expect(first.body.conversationId).toBe(id);
      expect(first.body.answer).toContain('Save this expense?');
      expect(first.body.answer).toContain(`45.00 ${currency}`);
      expect(store.expenses.size).toBe(0);
      expect(store.pending.get(id)?.status).toBe('PENDING');
      expect(first.body.answer).not.toContain('read-only');
      expect(first.body.answer).not.toContain(
        'No financial data was retrieved',
      );
      expect(create.mock.calls[0][0].tool_choice).toEqual({
        type: 'function',
        name: 'prepare_expense',
      });
      expect(create.mock.calls[0][0].tools).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'prepare_expense' }),
        ]),
      );
      const response = await chat(
        'Yes, save it.',
        first.body.conversationId,
      ).expect(201);
      expect(response.body.answer).toContain('Saved');
      expect(store.pending.get(id)?.status).toBe('CONFIRMED');
      const expenseId = store.pending.get(id)!.expenseId!;
      expect(await expenses.findById(expenseId)).toMatchObject({
        amount: '45.0000',
        currency,
        merchant: 'Tesco',
      });
      await chat('Yes.').expect(201);
      expect(store.database.expense.create).toHaveBeenCalledOnce();
      expect(create).toHaveBeenCalledOnce();
    },
  );

  it.each([
    'Yes',
    'Save it.',
    'Confirm',
    'Go ahead.',
    'Sim',
    'Pode salvar',
    'Confirma',
  ])(
    'confirms persisted pending state deterministically with %s',
    async (message) => {
      create.mockResolvedValueOnce(preparation(input));
      const save = vi.spyOn(expenses, 'create');
      await chat('I spent 45 EUR at Tesco today.').expect(201);
      const response = await chat(message).expect(201);
      expect(response.body.answer).toMatch(/Saved|Salvo/);
      expect(store.pending.get(id)?.status).toBe('CONFIRMED');
      expect(store.expenses.size).toBe(1);
      expect(save).toHaveBeenCalledOnce();
      await chat('Yes, save it.').expect(201);
      expect(save).toHaveBeenCalledOnce();
      expect(create).toHaveBeenCalledOnce();
    },
  );

  it.each([
    ['Add 32 EUR for lunch.', '32.00', 'EUR', 'en'],
    ['Registra 85 reais no Carrefour.', '85.00', 'BRL', 'pt'],
    ['Yesterday I paid 119.90 BRL for Claro.', '119.90', 'BRL', 'en'],
  ])(
    'forces preparation for %s and never creates a final expense',
    async (message, amount, currency, language) => {
      create.mockResolvedValueOnce(
        preparation({ ...input, amount, currency, language }),
      );
      const response = await chat(message).expect(201);
      expect(response.body.answer).toContain(`${amount} ${currency}`);
      expect(store.pending.get(id)?.status).toBe('PENDING');
      expect(store.database.expense.create).not.toHaveBeenCalled();
      expect(create.mock.calls[0][0].tool_choice).toEqual({
        type: 'function',
        name: 'prepare_expense',
      });
    },
  );

  it.each(['How much did I spend at Tesco?', 'What did I spend this month?'])(
    'keeps %s on the read path',
    async (message) => {
      create
        .mockResolvedValueOnce({
          status: 'completed',
          output: [
            {
              type: 'function_call',
              name: 'get_monthly_summary',
              arguments: '{"year":2026,"month":10}',
              call_id: 'read1',
              id: 'fc2',
            },
          ],
          output_text: '',
        })
        .mockResolvedValueOnce({
          status: 'completed',
          output: [],
          output_text: 'EUR 0.00 and BRL 0.00',
        });
      await chat(message).expect(201);
      expect(create.mock.calls[0][0].tool_choice).toBeUndefined();
      expect(store.pending.size).toBe(0);
      expect(store.database.expense.create).not.toHaveBeenCalled();
    },
  );

  it('does not return the obsolete fallback if a provider ignores forced preparation', async () => {
    create.mockResolvedValueOnce({
      status: 'completed',
      output: [],
      output_text: 'Do you want to save it?',
    });
    const response = await chat('I spent 45 EUR at Tesco today.').expect(502);
    expect(response.body.message).toContain('AI did not prepare');
    expect(JSON.stringify(response.body)).not.toContain('read-only');
    expect(store.expenses.size).toBe(0);
  });

  it('accepts the actual OpenAI arguments that previously failed on confirmationQuestion', async () => {
    create.mockResolvedValueOnce(
      preparation({
        ...input,
        confirmationQuestion:
          'Do you want to save the expense of 45 EUR at Tesco today?',
      }),
    );
    const response = await chat('I spent 45 EUR at Tesco today.').expect(201);
    expect(response.body.answer).toContain('45.00 EUR');
    expect(response.body.answer).toContain('Save this expense?');
    expect(store.pending.get(id)?.status).toBe('PENDING');
    expect(store.database.expense.create).not.toHaveBeenCalled();
  });

  it('normalizes model-friendly numeric amount, currency and relative date before domain validation', async () => {
    create.mockResolvedValueOnce(
      preparation({
        amount: 45,
        currency: 'eur',
        merchant: 'Tesco',
        transactionDate: 'today',
      }),
    );
    await chat('I spent 45 EUR at Tesco today.').expect(201);
    expect(store.pending.get(id)?.amount.toString()).toBe('45');
    expect(store.pending.get(id)?.currency).toBe('EUR');
    expect(
      store.pending.get(id)?.transactionDate.toISOString().slice(0, 10),
    ).toBe(new Date().toISOString().slice(0, 10));
    expect(store.database.expense.create).not.toHaveBeenCalled();
  });

  it('edits amount, merchant and date, then confirms only the final draft', async () => {
    create.mockResolvedValueOnce(preparation(input));
    await chat('I spent 45 EUR at Tesco today.').expect(201);
    create.mockResolvedValueOnce(preparation({ ...input, amount: '52.00' }));
    await chat('Actually it was 52 EUR.').expect(201);
    create.mockResolvedValueOnce(
      preparation({ ...input, amount: '52.00', merchant: 'Aldi' }),
    );
    await chat('Change the merchant to Aldi.').expect(201);
    create.mockResolvedValueOnce(
      preparation({
        ...input,
        amount: '52.00',
        merchant: 'Aldi',
        transactionDate: '2026-10-08',
      }),
    );
    await chat('And it was yesterday.').expect(201);
    expect(store.expenses.size).toBe(0);
    expect(store.pending.size).toBe(1);
    const lastRequest = create.mock.calls[3][0];
    expect(lastRequest.instructions).toContain('"merchant":"Aldi"');
    await chat('save it').expect(201);
    expect(
      await expenses.findById(store.pending.get(id)!.expenseId!),
    ).toMatchObject({
      amount: '52.0000',
      merchant: 'Aldi',
      transactionDate: new Date('2026-10-08'),
    });
  });

  it('cancels and never saves a cancelled draft', async () => {
    create.mockResolvedValueOnce(preparation(input));
    await chat('I spent 45 EUR at Tesco.').expect(201);
    await chat('cancel').expect(201);
    expect(store.pending.get(id)?.status).toBe('CANCELLED');
    await chat('yes').expect(201);
    expect(store.expenses.size).toBe(0);
  });

  it('does not authorize another conversation or an initial yes', async () => {
    await chat('yes', undefined).expect(201);
    create.mockResolvedValueOnce(preparation(input));
    await chat('I spent 45 EUR at Tesco.').expect(201);
    await chat('yes', other).expect(201);
    expect(store.expenses.size).toBe(0);
  });

  it.each(['maybe', 'I think so', 'wait', 'change it'])(
    'does not save on ambiguous response %s',
    async (message) => {
      create.mockResolvedValueOnce(preparation(input));
      await chat('I spent 45 EUR at Tesco.').expect(201);
      await chat(message).expect(201);
      expect(store.expenses.size).toBe(0);
      expect(store.pending.get(id)?.status).toBe('PENDING');
    },
  );

  it('responds to Portuguese preparation, confirmation and cancellation', async () => {
    create.mockResolvedValueOnce(
      preparation({ ...input, currency: 'BRL', language: 'pt' }),
    );
    const response = await chat('Registra 45 reais no Tesco hoje.').expect(201);
    expect(response.body.answer).toContain('Deseja salvar?');
    const confirmed = await chat('pode salvar').expect(201);
    expect(confirmed.body.answer).toContain('Salvo');
    expect(store.expenses.size).toBe(1);
  });

  it('keeps an ordinary spending question read-only and de-arms stale confirmation', async () => {
    create.mockResolvedValueOnce(preparation(input));
    await chat('I spent 45 EUR at Tesco.').expect(201);
    store.database.expense.findMany = vi.fn().mockResolvedValue([]);
    create
      .mockResolvedValueOnce({
        status: 'completed',
        output: [
          {
            type: 'function_call',
            name: 'get_monthly_summary',
            arguments: '{"year":2026,"month":10}',
            call_id: 'read1',
            id: 'fc2',
          },
        ],
        output_text: '',
      })
      .mockResolvedValueOnce({
        status: 'completed',
        output: [],
        output_text: 'EUR 0.00 and BRL 0.00',
      });
    await chat('How much did I spend this month?').expect(201);
    expect(store.expenses.size).toBe(0);
    expect(store.pending.get(id)?.confirmationRequested).toBe(false);
    const review = await chat('yes').expect(201);
    expect(review.body.answer).toContain('Save this expense?');
    expect(store.expenses.size).toBe(0);
  });

  it('rejects invalid preparation and a model attempt to bypass confirmation', async () => {
    create.mockResolvedValueOnce(preparation({ ...input, amount: '0' }));
    await chat('I spent zero EUR').expect(400);
    expect(store.expenses.size).toBe(0);
    expect(store.pending.size).toBe(0);
    create
      .mockResolvedValueOnce({
        status: 'completed',
        output: [
          {
            type: 'function_call',
            name: 'confirm_expense',
            arguments: '{}',
            call_id: 'bad1',
            id: 'fc3',
          },
        ],
        output_text: '',
      })
      .mockResolvedValueOnce({
        status: 'completed',
        output: [],
        output_text: 'saved',
      });
    await chat('Save without asking').expect(201);
    expect(store.expenses.size).toBe(0);
  });

  it('uses a localized question without letting the model replace financial facts', async () => {
    create.mockResolvedValueOnce(
      preparation({
        ...input,
        language: 'fr',
        confirmationQuestion: 'Voulez-vous enregistrer cette dépense ?',
      }),
    );
    const response = await chat(
      "J'ai dépensé quarante-cinq euros chez Tesco aujourd'hui.",
    ).expect(201);
    expect(response.body.answer).toContain('45.00 EUR');
    expect(response.body.answer).toContain(
      'Voulez-vous enregistrer cette dépense ?',
    );
    expect(store.expenses.size).toBe(0);
  });

  it('creation failure leaves the draft pending and allows retry', async () => {
    create.mockResolvedValueOnce(preparation(input));
    await chat('I spent 45 EUR at Tesco.').expect(201);
    store.database.expense.create.mockRejectedValueOnce(
      new Error('private database detail'),
    );
    const failed = await chat('yes').expect(503);
    expect(JSON.stringify(failed.body)).not.toContain('private');
    expect(store.pending.get(id)?.status).toBe('PENDING');
    await chat('yes').expect(201);
    expect(store.expenses.size).toBe(1);
  });
});

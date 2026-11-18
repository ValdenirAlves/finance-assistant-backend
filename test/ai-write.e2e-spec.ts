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
    payer: 'SPOUSE' as const,
    amount: '45.00',
    currency: 'EUR',
    merchant: 'Tesco',
    description: null,
    transactionDate: '2026-10-09',
    language: 'en',
  };
  const preparation = (args: object, name = 'prepare_expense') => ({
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
  const patch = (changes: Record<string, unknown>, language = 'pt') =>
    preparation(
      {
        changes: Object.entries(changes).map(([field, value]) => ({
          field,
          value,
        })),
        language,
      },
      'patch_pending_expense',
    );
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
        `I spent 45 ${currency} at Tesco today on my spouse’s card.`,
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
        type: 'allowed_tools',
        mode: 'required',
        tools: [
          { type: 'function', name: 'prepare_expense' },
          { type: 'function', name: 'ask_clarification' },
        ],
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
      expect(response.body.answer).toContain(`45.00 ${currency}`);
      expect(response.body.answer).not.toContain('45.0000');
      expect(store.pending.get(id)?.status).toBe('CONFIRMED');
      const expenseId = store.pending.get(id)!.expenseId!;
      expect(await expenses.findById(expenseId)).toMatchObject({
        amount: '45.00',
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
      await chat('I spent 45 EUR at Tesco today on my spouse’s card.').expect(
        201,
      );
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
        type: 'allowed_tools',
        mode: 'required',
        tools: [
          { type: 'function', name: 'prepare_expense' },
          { type: 'function', name: 'ask_clarification' },
        ],
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
              name: message.startsWith('How')
                ? 'get_expenses'
                : 'get_monthly_summary',
              arguments: message.startsWith('How')
                ? '{"merchant":"Tesco","from":null,"to":null}'
                : '{"year":2026,"month":10}',
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
      expect(create.mock.calls[0][0].tool_choice).toEqual(
        message.startsWith('How')
          ? { type: 'function', name: 'get_expenses' }
          : undefined,
      );
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
    const response = await chat(
      'I spent 45 EUR at Tesco today on my spouse’s card.',
    ).expect(502);
    expect(response.body.message).toContain('AI did not prepare');
    expect(JSON.stringify(response.body)).not.toContain('read-only');
    expect(store.expenses.size).toBe(0);
  });

  it('clarifies ambiguous write details without preparing or confirming an expense', async () => {
    const question = 'Você quer registrar a primeira compra ou a segunda?';
    create.mockResolvedValueOnce({
      status: 'completed',
      output: [
        {
          type: 'function_call',
          name: 'ask_clarification',
          arguments: JSON.stringify({ question }),
          call_id: 'clarify',
          id: 'fc_clarify',
        },
      ],
      output_text: '',
    });
    const response = await chat(
      'I spent 45 EUR at Tesco or Lidl on my spouse’s card.',
    ).expect(201);
    expect(response.body.answer).toBe(question);
    expect(create.mock.calls[0][0].tool_choice).toEqual({
      type: 'allowed_tools',
      mode: 'required',
      tools: [
        { type: 'function', name: 'prepare_expense' },
        { type: 'function', name: 'ask_clarification' },
      ],
    });
    expect(store.pending.size).toBe(0);
    expect(store.expenses.size).toBe(0);
    expect(store.database.expense.create).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledOnce();
    await chat('Yes').expect(201);
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
    const response = await chat(
      'I spent 45 EUR at Tesco today on my spouse’s card.',
    ).expect(201);
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
    await chat('I spent 45 EUR at Tesco today on my spouse’s card.').expect(
      201,
    );
    expect(store.pending.get(id)?.amount.toString()).toBe('45');
    expect(store.pending.get(id)?.currency).toBe('EUR');
    expect(
      store.pending.get(id)?.transactionDate.toISOString().slice(0, 10),
    ).toBe(new Date().toISOString().slice(0, 10));
    expect(store.database.expense.create).not.toHaveBeenCalled();
  });

  it('edits amount, merchant and date, then confirms only the final draft', async () => {
    create.mockResolvedValueOnce(preparation(input));
    await chat('I spent 45 EUR at Tesco today on my spouse’s card.').expect(
      201,
    );
    create.mockResolvedValueOnce(
      preparation(
        { changes: [{ field: 'amount', value: '52.00' }], language: 'en' },
        'patch_pending_expense',
      ),
    );
    await chat('Actually it was 52 EUR.').expect(201);
    create.mockResolvedValueOnce(
      preparation(
        { changes: [{ field: 'merchant', value: 'Aldi' }], language: 'en' },
        'patch_pending_expense',
      ),
    );
    await chat('Change the merchant to Aldi.').expect(201);
    create.mockResolvedValueOnce(
      preparation(
        {
          changes: [{ field: 'transactionDate', value: '2026-10-08' }],
          language: 'en',
        },
        'patch_pending_expense',
      ),
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
      amount: '52.00',
      merchant: 'Aldi',
      transactionDate: new Date('2026-10-08'),
    });
  });

  it('cancels and never saves a cancelled draft', async () => {
    create.mockResolvedValueOnce(preparation(input));
    await chat('I spent 45 EUR at Tesco on my spouse’s card.').expect(201);
    await chat('cancel').expect(201);
    expect(store.pending.get(id)?.status).toBe('CANCELLED');
    await chat('yes').expect(201);
    expect(store.expenses.size).toBe(0);
  });

  it('preserves a free-form Mr Price merchant from the complete transcript without a known mapping', async () => {
    create
      .mockResolvedValueOnce(
        preparation({
          ...input,
          amount: '16.43',
          merchant: 'Mr Price',
          payer: null,
          language: 'pt',
        }),
      )
      .mockResolvedValueOnce({
        status: 'completed',
        output: [],
        output_text: '{"category":"SHOPPING"}',
      });
    const message = 'VAS, eu gastei 16 euros e 43 centavos no Mr Price.';
    const response = await chat(message).expect(201);
    expect(turnHistory[0].content).toBe(message);
    expect(store.pending.get(id)).toMatchObject({
      merchant: 'Mr Price',
      payer: null,
      category: 'SHOPPING',
      status: 'PENDING',
    });
    expect(response.body.answer).toContain('Mr Price');
    expect(response.body.answer).toContain('Foi no seu cartão');
    expect(create.mock.calls[0][0].instructions).toContain('free-form text');
    expect(store.expenses.size).toBe(0);
    expect(store.mappings.has('mr price')).toBe(false);
  });

  it('accepts merchant, payer, amount and date corrections in any order, then saves only after a separate confirmation', async () => {
    create.mockResolvedValueOnce(
      preparation({
        ...input,
        amount: '16.43',
        merchant: null,
        payer: null,
        language: 'pt',
      }),
    );
    const first = await chat(
      'Ontem eu gastei dezesseis euros e quarenta e três centavos.',
    ).expect(201);
    expect(first.body.answer).toContain('Foi no seu cartão');
    await chat('Pode salvar').expect(201);
    expect(store.expenses.size).toBe(0);

    create
      .mockResolvedValueOnce(patch({ merchant: 'Mr. Price' }))
      .mockResolvedValueOnce({
        status: 'completed',
        output: [],
        output_text: '{"category":"SHOPPING"}',
      });
    const merchant = await chat('na loja Mr. Price.').expect(201);
    expect(merchant.body.answer).toContain('Mr. Price');
    expect(merchant.body.answer).toContain('Foi no seu cartão');
    expect(store.pending.get(id)).toMatchObject({
      merchant: 'Mr. Price',
      payer: null,
      category: 'SHOPPING',
    });
    expect(
      create.mock.calls[1][0].tools.map((tool: any) => tool.name),
    ).toContain('patch_pending_expense');
    expect(
      create.mock.calls[1][0].tools.map((tool: any) => tool.name),
    ).not.toContain('prepare_expense');

    create.mockResolvedValueOnce(patch({ payer: 'SPOUSE' }));
    const payer = await chat('da minha esposa').expect(201);
    expect(payer.body.answer).toContain('Deseja salvar?');
    create.mockResolvedValueOnce(patch({ amount: '18' }));
    await chat('na verdade foram 18 euros').expect(201);
    expect(store.pending.get(id)).toMatchObject({
      merchant: 'Mr. Price',
      payer: 'SPOUSE',
      category: 'SHOPPING',
    });
    expect(store.pending.get(id)?.amount.toFixed(2)).toBe('18.00');
    const yesterday = new Date();
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    create.mockResolvedValueOnce(patch({ transactionDate: 'ontem' }));
    await chat('foi ontem').expect(201);
    expect(
      store.pending.get(id)?.transactionDate.toISOString().slice(0, 10),
    ).toBe(yesterday.toISOString().slice(0, 10));
    expect(store.pending.get(id)).toMatchObject({
      merchant: 'Mr. Price',
      payer: 'SPOUSE',
      category: 'SHOPPING',
      revision: 5,
    });
    expect(store.expenses.size).toBe(0);
    await chat('Pode salvar').expect(201);
    await chat('Pode salvar').expect(201);
    expect(store.expenses.size).toBe(1);
    expect([...store.expenses.values()][0]).toMatchObject({
      merchant: 'Mr. Price',
      payer: 'SPOUSE',
      category: 'SHOPPING',
    });
    expect([...store.expenses.values()][0].amount.toFixed(2)).toBe('18.00');
    expect(store.database.expense.create).toHaveBeenCalledOnce();
  });

  it('accepts payer even if the last model question requested merchant, which remains optional', async () => {
    create.mockResolvedValueOnce(
      preparation({ ...input, merchant: null, payer: null, language: 'pt' }),
    );
    await chat('Gastei 45 euros hoje').expect(201);
    create.mockResolvedValueOnce(
      preparation(
        { question: 'Em qual estabelecimento foi a compra?' },
        'ask_clarification',
      ),
    );
    await chat('Quais informações faltam?').expect(201);
    create.mockResolvedValueOnce(patch({ payer: 'SPOUSE' }));
    const reply = await chat('da minha esposa').expect(201);
    expect(reply.body.answer).toContain('Deseja salvar?');
    expect(store.pending.get(id)).toMatchObject({
      merchant: null,
      payer: 'SPOUSE',
      confirmationRequested: true,
    });
    expect(store.expenses.size).toBe(0);
  });

  it.each(['Sim.', 'Não.'])(
    'persists the exact spoken-amount draft, patches a clear payer and handles %s only after save review',
    async (action) => {
      store.mappings.set('mr. price', 'SHOPPING');
      create.mockResolvedValueOnce(
        preparation({
          ...input,
          amount: '16.43',
          merchant: 'Mr. Price',
          transactionDate: '2026-10-21',
          payer: null,
          language: 'pt',
        }),
      );
      const first = await chat(
        'Eu gastei dezesseis euros e quarenta e três centavos ontem no Mr. Price.',
        undefined,
      ).expect(201);
      expect(first.body.conversationId).toBe(id);
      expect(first.body.answer).toContain('Foi no seu cartão');
      const original = store.pending.get(id)!;
      expect(original.payer).toBeNull();
      expect(store.expenses.size).toBe(0);
      create.mockResolvedValueOnce(patch({ payer: 'SPOUSE' }));
      const review = await chat(
        'Foi minha esposa.',
        first.body.conversationId,
      ).expect(201);
      expect(review.body.conversationId).toBe(first.body.conversationId);
      expect(review.body.answer).toContain('Deseja salvar?');
      expect(review.body.answer).not.toContain('Você quis dizer');
      expect(store.pending.get(id)).toMatchObject({
        ...original,
        revision: 2,
        payer: 'SPOUSE',
        confirmationRequested: true,
      });
      expect(store.expenses.size).toBe(0);
      const response = await chat(action, review.body.conversationId).expect(
        201,
      );
      expect(response.body.conversationId).toBe(id);
      expect(response.body.answer).toContain(
        action === 'Sim.' ? 'Salvo' : 'cancelada',
      );
      expect(store.pending.get(id)).toMatchObject({
        id: original.id,
        status: action === 'Sim.' ? 'CONFIRMED' : 'CANCELLED',
      });
      await chat('Sim.').expect(201);
      expect(store.expenses.size).toBe(action === 'Sim.' ? 1 : 0);
      expect(create).toHaveBeenCalledTimes(2);
    },
  );

  it('keeps a genuinely ambiguous payer clarification in the same persisted draft', async () => {
    create.mockResolvedValueOnce(
      preparation({ ...input, payer: null, language: 'pt' }),
    );
    await chat('Gastei 45 euros no Tesco.').expect(201);
    const original = store.pending.get(id)!;
    const question = 'Quem é o titular do cartão compartilhado?';
    create.mockResolvedValueOnce(
      preparation({ question }, 'ask_clarification'),
    );
    const response = await chat('Usei nosso cartão compartilhado.').expect(201);
    expect(response.body).toEqual({ conversationId: id, answer: question });
    expect(store.pending.get(id)).toEqual(original);
    await chat('Sim.').expect(201);
    expect(store.pending.get(id)).toEqual(original);
    expect(store.expenses.size).toBe(0);
    create.mockResolvedValueOnce(patch({ payer: 'SPOUSE' }));
    await chat('Foi minha esposa.').expect(201);
    await chat('Sim.').expect(201);
    await chat('Sim.').expect(201);
    expect(store.database.expense.create).toHaveBeenCalledOnce();
  });

  it.each([0, 1, 2])(
    'cancels at draft stage %i without creating an expense',
    async (stage) => {
      create.mockResolvedValueOnce(
        preparation({ ...input, payer: null, language: 'pt' }),
      );
      await chat('Gastei 45 euros no Tesco').expect(201);
      if (stage >= 1) {
        create.mockResolvedValueOnce(patch({ payer: 'SPOUSE' }));
        await chat('da minha esposa').expect(201);
      }
      if (stage >= 2) {
        create.mockResolvedValueOnce(patch({ amount: '18.00' }));
        await chat('na verdade foram 18 euros').expect(201);
      }
      await chat('cancela').expect(201);
      await chat('Pode salvar').expect(201);
      expect(store.pending.get(id)?.status).toBe('CANCELLED');
      expect(store.expenses.size).toBe(0);
    },
  );

  it('validates combined currency/category/description corrections and only clears explicit optional fields', async () => {
    create.mockResolvedValueOnce(preparation(input));
    await chat('I spent 45 EUR at Tesco on my spouse’s card.').expect(201);
    create.mockResolvedValueOnce(
      patch({
        currency: 'brl',
        category: 'SHOPPING',
        description: 'Presente',
        merchant: null,
      }),
    );
    await chat('Era em reais, uma compra de presente; retire a loja.').expect(
      201,
    );
    expect(store.pending.get(id)).toMatchObject({
      currency: 'BRL',
      category: 'SHOPPING',
      description: 'Presente',
      merchant: null,
      payer: 'SPOUSE',
    });
    expect(store.pending.get(id)?.amount.toFixed(2)).toBe('45.00');
    expect(store.expenses.size).toBe(0);
  });

  it.each([
    patch({ amount: '0' }),
    patch({ amount: '1.001' }),
    patch({ amount: 18 }),
    patch({ currency: 'USD' }),
    patch({ transactionDate: '2026-02-30' }),
    patch({ category: 'UNCONTROLLED' }),
    patch({ payer: 'OTHER' }),
    patch({ amount: null }),
    patch({ status: 'CONFIRMED' }),
    preparation({ changes: [], language: 'pt' }, 'patch_pending_expense'),
    preparation(
      {
        changes: [
          { field: 'amount', value: '18.00' },
          { field: 'amount', value: '19.00' },
        ],
        language: 'pt',
      },
      'patch_pending_expense',
    ),
    preparation({ changes: [null], language: 'pt' }, 'patch_pending_expense'),
  ])(
    'rejects malformed or invalid patch arguments without altering financial values: %j',
    async (invalid) => {
      create.mockResolvedValueOnce(preparation(input));
      await chat('I spent 45 EUR at Tesco on my spouse’s card.').expect(201);
      const original = store.pending.get(id)!;
      create.mockResolvedValueOnce(invalid);
      await chat('Corrija o rascunho.').expect(400);
      expect(store.pending.get(id)).toMatchObject({
        ...original,
        confirmationRequested: false,
      });
      expect(store.expenses.size).toBe(0);
    },
  );

  it('rejects a legacy full replacement for a correction instead of erasing omitted fields', async () => {
    create.mockResolvedValueOnce(preparation(input));
    await chat('I spent 45 EUR at Tesco on my spouse’s card.').expect(201);
    create.mockResolvedValueOnce(
      preparation({ ...input, merchant: null, amount: '18.00' }),
    );
    await chat('Actually it was 18 euros.').expect(400);
    expect(store.pending.get(id)?.merchant).toBe('Tesco');
    expect(store.pending.get(id)?.amount.toFixed(2)).toBe('45.00');
  });

  it('retains the existing localized review-question contract for other languages', async () => {
    create.mockResolvedValueOnce(preparation(input));
    await chat('I spent 45 EUR at Tesco on my spouse’s card.').expect(201);
    create.mockResolvedValueOnce(
      preparation(
        {
          changes: [{ field: 'amount', value: '18.00' }],
          language: 'fr',
          confirmationQuestion: 'Voulez-vous enregistrer cette dépense ?',
        },
        'patch_pending_expense',
      ),
    );
    const response = await chat(
      'En fait, le montant était de dix-huit euros.',
    ).expect(201);
    expect(response.body.answer).toContain('18.00 EUR');
    expect(response.body.answer).toContain(
      'Voulez-vous enregistrer cette dépense ?',
    );
    expect(store.expenses.size).toBe(0);
  });

  it('does not authorize another conversation or an initial yes', async () => {
    await chat('yes', undefined).expect(201);
    create.mockResolvedValueOnce(preparation(input));
    await chat('I spent 45 EUR at Tesco on my spouse’s card.').expect(201);
    await chat('yes', other).expect(201);
    expect(store.expenses.size).toBe(0);
  });

  it.each(['maybe', 'I think so', 'wait', 'change it'])(
    'does not save on ambiguous response %s',
    async (message) => {
      create.mockResolvedValueOnce(preparation(input));
      await chat('I spent 45 EUR at Tesco on my spouse’s card.').expect(201);
      await chat(message).expect(201);
      expect(store.expenses.size).toBe(0);
      expect(store.pending.get(id)?.status).toBe('PENDING');
    },
  );

  it('responds to Portuguese preparation, confirmation and cancellation', async () => {
    create.mockResolvedValueOnce(
      preparation({ ...input, currency: 'BRL', language: 'pt' }),
    );
    const response = await chat(
      'Registra 45 reais no Tesco hoje no cartão da minha esposa.',
    ).expect(201);
    expect(response.body.answer).toContain('Deseja salvar?');
    const confirmed = await chat('pode salvar').expect(201);
    expect(confirmed.body.answer).toContain('Salvo');
    expect(store.expenses.size).toBe(1);
  });

  it('keeps an ordinary spending question read-only and de-arms stale confirmation', async () => {
    create.mockResolvedValueOnce(preparation(input));
    await chat('I spent 45 EUR at Tesco on my spouse’s card.').expect(201);
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
    await chat('I spent 45 EUR at Tesco on my spouse’s card.').expect(201);
    store.database.expense.create.mockRejectedValueOnce(
      new Error('private database detail'),
    );
    const failed = await chat('yes').expect(503);
    expect(JSON.stringify(failed.body)).not.toContain('private');
    expect(store.pending.get(id)?.status).toBe('PENDING');
    await chat('yes').expect(201);
    expect(store.expenses.size).toBe(1);
  });

  it('classifies unknown merchant once and learns only after confirmation', async () => {
    create
      .mockResolvedValueOnce(preparation({ ...input, merchant: 'SuperValu' }))
      .mockResolvedValueOnce({
        status: 'completed',
        output: [],
        output_text: '{"category":"GROCERIES"}',
      });
    const response = await chat(
      'I spent 45 EUR at SuperValu today on my spouse’s card.',
    ).expect(201);
    expect(response.body.answer).toContain('groceries');
    expect(store.pending.get(id)?.category).toBe('GROCERIES');
    expect(store.mappings.has('supervalu')).toBe(false);
    await chat('yes').expect(201);
    expect(store.mappings.get('supervalu')).toBe('GROCERIES');
    expect([...store.expenses.values()][0].category).toBe('GROCERIES');
    create.mockResolvedValueOnce(
      preparation({ ...input, merchant: ' SuperValu ', amount: '46.00' }),
    );
    await chat('I spent 46 EUR at SuperValu today on my spouse’s card.').expect(
      201,
    );
    expect(create).toHaveBeenCalledTimes(3);
    await chat('cancel').expect(201);
    expect(store.expenses.size).toBe(1);
  });

  it.each([
    ['Yes, save another one.', 'yes'],
    ['Yes, save it anyway.', 'yes'],
    ['Save the duplicate.', 'yes'],
    ['Sim, pode salvar outra.', 'sim'],
    ['Pode salvar mesmo assim.', 'sim'],
  ])(
    'requires explicit duplicate override %s and saves at most once',
    async (override, confirmation) => {
      const { language, ...expenseInput } = input;
      void language;
      await expenses.create(expenseInput);
      const save = vi.spyOn(expenses, 'create');
      create.mockResolvedValueOnce(preparation(input));
      await chat('I spent 45 EUR at Tesco today on my spouse’s card.').expect(
        201,
      );
      const warning = await chat(confirmation).expect(201);
      expect(warning.body.answer).toMatch(/already exists|Já existe/);
      expect(save).not.toHaveBeenCalled();
      expect(store.pending.get(id)?.duplicateReviewRequired).toBe(true);
      expect(store.pending.get(id)?.status).toBe('PENDING');
      await chat('yes').expect(201);
      expect(save).not.toHaveBeenCalled();
      await chat(override).expect(201);
      await chat(override).expect(201);
      expect(save).toHaveBeenCalledOnce();
      expect(store.expenses.size).toBe(2);
      expect(store.pending.get(id)?.status).toBe('CONFIRMED');
      expect(create).toHaveBeenCalledOnce();
    },
  );

  it('cannot override a normal or cancelled pending expense', async () => {
    create.mockResolvedValueOnce(preparation(input));
    await chat('I spent 45 EUR at Tesco today on my spouse’s card.').expect(
      201,
    );
    await chat('Save the duplicate.').expect(201);
    expect(store.expenses.size).toBe(0);
    await chat('cancel').expect(201);
    await chat('Yes, save another one.').expect(201);
    expect(store.expenses.size).toBe(0);
  });
});

import { AiService } from './ai.service.js';
import { AnalyticsService } from '../analytics/analytics.service.js';
import { CategoriesService } from '../categories/categories.service.js';
import { ConversationService } from '../conversations/conversation.service.js';
import { ExpensesService } from '../expenses/expenses.service.js';
import { PendingExpenseService } from '../pending-expenses/pending-expense.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { pendingDatabase } from '../../test/helpers/pending-database.js';

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
      call_id: 'call',
      id: 'fc',
    },
  ],
  output_text: '',
});

describe('backend-owned pending expense conversation', () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const statement =
    'Eu gastei dezesseis euros e quarenta e três centavos ontem no Mr. Price.';
  let store: ReturnType<typeof pendingDatabase>,
    pending: PendingExpenseService,
    ai: AiService;
  let history: Array<{ role: string; content: string }>;
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv('OPENAI_API_KEY', 'test');
    store = pendingDatabase();
    store.mappings.set('mr. price', 'SHOPPING');
    const prisma = store.database as unknown as PrismaService;
    const expenses = new ExpensesService(prisma, new CategoriesService(prisma));
    pending = new PendingExpenseService(prisma, expenses);
    history = [];
    ai = new AiService(
      {} as AnalyticsService,
      expenses,
      {
        create: vi.fn().mockResolvedValue({ id }),
        recentMessages: vi.fn(async () => history),
        saveTurn: vi.fn(
          async (_id: string, user: string, assistant: string) => {
            expect(_id).toBe(id);
            history.push(
              { role: 'USER', content: user },
              { role: 'ASSISTANT', content: assistant },
            );
          },
        ),
      } as unknown as ConversationService,
      pending,
    );
  });
  afterEach(() => vi.unstubAllEnvs());
  const chat = (message: string) => ai.chat({ conversationId: id, message });
  async function prepare() {
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
    return chat(statement);
  }

  it('persists a spoken-amount expense before the backend asks for its missing payer', async () => {
    const response = await prepare();
    expect(response.conversationId).toBe(id);
    expect(response.answer).toContain('Foi no seu cartão');
    expect(await pending.get(id)).toMatchObject({
      status: 'PENDING',
      merchant: 'Mr. Price',
      payer: null,
      confirmationRequested: false,
    });
    expect((await pending.get(id))?.amount.toFixed(2)).toBe('16.43');
    const request = create.mock.calls[0][0];
    expect(request.instructions).toContain(
      'Missing payer does NOT prevent preparing a draft',
    );
    expect(request.instructions).toContain(
      'whether written as digits or words',
    );
    expect(
      request.tools.find((item: any) => item.name === 'prepare_expense')
        .description,
    ).toContain('persists the draft before asking who paid');
    expect(store.expenses.size).toBe(0);
  });

  it.each([
    ['Foi minha esposa.', 'SPOUSE'],
    ['Foi no cartão da minha esposa.', 'SPOUSE'],
    ['Minha esposa pagou.', 'SPOUSE'],
    ['Desta vez quem pagou fui eu.', 'SELF'],
    ['Essa saiu do meu bolso.', 'SELF'],
  ])(
    'patches the semantically resolved payer for %s without reconfirming its meaning',
    async (message, payer) => {
      await prepare();
      const original = (await pending.get(id))!;
      const patch = vi.spyOn(pending, 'patch');
      create.mockResolvedValueOnce(
        tool('patch_pending_expense', {
          changes: [{ field: 'payer', value: payer }],
          language: 'pt',
          confirmationQuestion: null,
        }),
      );
      const response = await chat(message);
      expect(patch).toHaveBeenCalledWith(id, { payer }, original.revision);
      expect(await pending.get(id)).toMatchObject({
        ...original,
        payer,
        revision: 2,
        confirmationRequested: true,
      });
      expect(response.answer).toContain('Deseja salvar?');
      expect(response.answer).not.toContain('Você quis dizer');
      expect(create).toHaveBeenCalledTimes(2);
      expect(create.mock.calls[1][0].instructions).toContain(
        'Do not ask the user to confirm an already clear interpretation',
      );
      expect(store.expenses.size).toBe(0);
    },
  );

  it('preserves the pending row through genuine ambiguity and does not confuse semantic yes with save authorization', async () => {
    await prepare();
    const original = (await pending.get(id))!;
    const question =
      'Você está se referindo ao pagamento pessoal ou ao compartilhado?';
    create.mockResolvedValueOnce(tool('ask_clarification', { question }));
    expect((await chat('Saiu daquele cartão que usamos juntos.')).answer).toBe(
      question,
    );
    expect(await pending.get(id)).toEqual(original);
    const unclearYes = await chat('Sim.');
    expect(unclearYes.answer).toContain('Foi no seu cartão');
    expect(unclearYes.answer).not.toContain('Não há despesa pendente');
    expect(await pending.get(id)).toEqual(original);
    expect(store.expenses.size).toBe(0);

    create.mockResolvedValueOnce(
      tool('patch_pending_expense', {
        changes: [{ field: 'payer', value: 'SPOUSE' }],
        language: 'pt',
        confirmationQuestion: null,
      }),
    );
    await chat('Minha esposa pagou.');
    expect(store.expenses.size).toBe(0);
    expect((await chat('Sim.')).answer).toContain('Salvo');
    await chat('Sim.');
    expect(store.database.expense.create).toHaveBeenCalledOnce();
    expect((await pending.get(id))?.id).toBe(original.id);
  });
});

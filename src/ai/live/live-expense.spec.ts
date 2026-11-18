import { AiService } from '../ai.service.js';
import { LiveFinanceAdapter } from './live-finance.adapter.js';
import { PendingExpenseService } from '../../pending-expenses/pending-expense.service.js';
import { ExpensesService } from '../../expenses/expenses.service.js';
import { BankAccountsService } from '../../bank-accounts/bank-accounts.service.js';
import { CategoriesService } from '../../categories/categories.service.js';
import { pendingDatabase } from '../../../test/helpers/pending-database.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { AnalyticsService } from '../../analytics/analytics.service.js';
import type { ConversationService } from '../../conversations/conversation.service.js';
import type { ExpenseIntentDto } from '../../pending-expenses/expense-intent.dto.js';
const { create } = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('openai', () => ({
  default: class {
    responses = { create };
  },
}));
const call = (name: string, args: object) => ({
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
  output_text: 'Never trust model prose or disclose a balance.',
});
const command = (
  action: ExpenseIntentDto['action'],
  fields: Record<string, string | null> = {},
): ExpenseIntentDto => ({
  action,
  changes: Object.entries(fields).map(([field, value]) => ({
    field: field as ExpenseIntentDto['changes'][number]['field'],
    value,
  })),
});

describe('Live semantic expense intents through shared domain state', () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const base = {
    amount: '50.00',
    currency: 'EUR',
    category: 'FUEL',
    payer: 'SELF',
    paymentMethod: 'CARD',
    transactionDate: '2026-10-22',
  };
  let store: ReturnType<typeof pendingDatabase>,
    pending: PendingExpenseService,
    expenses: ExpensesService,
    ai: AiService,
    adapter: LiveFinanceAdapter;
  let history: Array<{ role: string; content: string }>;
  beforeEach(async () => {
    vi.resetAllMocks();
    vi.stubEnv('OPENAI_API_KEY', 'test-key');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-23T12:00:00Z'));
    store = pendingDatabase();
    history = [];
    const prisma = store.database as unknown as PrismaService;
    expenses = new ExpensesService(prisma, new CategoriesService(prisma));
    pending = new PendingExpenseService(prisma, expenses);
    const conversations = {
      create: vi.fn().mockResolvedValue({ id }),
      recentMessages: vi.fn(async () => history),
      saveTurn: vi.fn(async (_id: string, user: string, assistant: string) => {
        history.push(
          { role: 'USER', content: user },
          { role: 'ASSISTANT', content: assistant },
        );
      }),
    };
    const bank = new BankAccountsService(prisma);
    const balance = await bank.prepare(
      'bank',
      { currency: 'EUR', currentBalance: '1000.00' },
      null,
    );
    await bank.arm('bank', balance.revision);
    await bank.confirm('bank', balance.revision);
    ai = new AiService(
      {
        monthlySummary: vi
          .fn()
          .mockResolvedValue({ totals: { EUR: '50.00', BRL: '97.00' } }),
      } as unknown as AnalyticsService,
      expenses,
      conversations as unknown as ConversationService,
      pending,
      undefined,
      undefined,
      undefined,
      bank,
    );
    adapter = new LiveFinanceAdapter(
      ai,
      conversations as unknown as ConversationService,
    );
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });
  let turnId = 0;
  const turn = (message: string, intent: ExpenseIntentDto) => {
    create.mockResolvedValueOnce(call('expense_intent', intent));
    return adapter.execute(
      {
        sessionId: 'live',
        conversationId: id,
        delegationId: `d${++turnId}`,
        userTurn: message,
      },
      new AbortController().signal,
    );
  };
  const balance = () =>
    [...store.accounts.values()]
      .find((row) => row.currency === 'EUR')
      ?.currentBalance.toFixed(2);
  it.each([
    ['Ontem eu gastei cinquenta euros de combustível no meu cartão.', base],
    [
      'Coloquei cinquenta euros de gasolina ontem.',
      { ...base, payer: null, paymentMethod: null },
    ],
    [
      'Ontem abasteci cinquenta euros.',
      { ...base, payer: null, paymentMethod: null },
    ],
    [
      'Gastei cinquenta euros no mercado e paguei em dinheiro.',
      { ...base, category: 'GROCERIES', paymentMethod: 'CASH' },
    ],
    [
      'Minha esposa pagou trinta euros em dinheiro.',
      { ...base, amount: '30.00', payer: 'SPOUSE', paymentMethod: 'CASH' },
    ],
  ])(
    'persists interpreted fields for %s without creating an Expense',
    async (message, fields) => {
      const result = await turn(message, command('CREATE', fields));
      expect(result).toMatchObject({
        type: fields.payer ? 'CONFIRMATION_REQUIRED' : 'MISSING_INFORMATION',
        draft: {
          ...fields,
          transactionDate: '2026-10-22T00:00:00.000Z',
        },
        balanceDisclosureAllowed: false,
      });
      if (fields.payer) expect((result as any).missingFields).toBeUndefined();
      expect(store.expenses.size).toBe(0);
      expect(balance()).toBe('1000.00');
    },
  );
  it('accepts independent corrections in any order, preserving omitted fields and resetting confirmation revision', async () => {
    await turn(
      'Ontem gastei cinquenta euros de combustível no meu cartão.',
      command('CREATE', base),
    );
    const patches = [
      ['Na verdade foram cinquenta e cinco.', { amount: '55.00' }],
      ['Foi no Circle K.', { merchant: 'Circle K' }],
      ['Não foi ontem, foi anteontem.', { transactionDate: '2026-10-21' }],
      ['Foi minha esposa.', { payer: 'SPOUSE' }],
      ['Ela pagou em dinheiro.', { paymentMethod: 'CASH' }],
    ] as const;
    const expected = {
      ...base,
      amount: '55.00',
      merchant: 'Circle K',
      transactionDate: '2026-10-21T00:00:00.000Z',
      payer: 'SPOUSE',
      paymentMethod: 'CASH',
    };
    for (const [message, fields] of patches) {
      const result = await turn(message, command('PATCH', fields));
      expect(result.type).toBe('CONFIRMATION_REQUIRED');
    }
    expect(pending.summary((await pending.get(id))!)).toMatchObject(expected);
    expect((await pending.get(id))!.revision).toBe(6);
    const saved = await turn('Pode salvar.', command('CONFIRM'));
    expect(saved.type).toBe('EXPENSE_SAVED');
    expect(store.expenses.size).toBe(1);
    expect(balance()).toBe('1000.00');
    expect([...store.expenses.values()][0].category).toBe('FUEL');
  });
  it('persists genuinely incomplete drafts and asks only for missing required fields', async () => {
    const first = await turn(
      'Quero registrar combustível.',
      command('CREATE', { category: 'FUEL' }),
    );
    expect(first).toMatchObject({
      type: 'MISSING_INFORMATION',
      missingFields: ['amount', 'currency', 'transactionDate', 'payer'],
    });
    expect((await pending.get(id))!.amount).toBeNull();
    expect(pending.summary((await pending.get(id))!).state).toBe(
      'AWAITING_DETAILS',
    );
    await turn(
      'Foram cinquenta euros ontem.',
      command('PATCH', {
        amount: '50',
        currency: 'EUR',
        transactionDate: '2026-10-22',
      }),
    );
    const ready = await turn(
      'Foi minha esposa.',
      command('PATCH', { payer: 'SPOUSE' }),
    );
    expect(ready).toMatchObject({
      type: 'CONFIRMATION_REQUIRED',
      draft: {
        amount: '50.00',
        merchant: null,
        paymentMethod: null,
        payer: 'SPOUSE',
        category: 'FUEL',
      },
    });
    expect(store.expenses.size).toBe(0);
  });
  it.each(['CARD', 'BANK_ACCOUNT', 'CASH', 'OTHER', null])(
    'SELF + %s has only the allowed bank impact and repeated confirmation saves once',
    async (paymentMethod) => {
      await turn(
        'Uma despesa minha.',
        command('CREATE', { ...base, paymentMethod }),
      );
      await turn('Pode salvar.', command('CONFIRM'));
      await turn('Sim, salva.', command('CONFIRM'));
      expect(store.expenses.size).toBe(1);
      expect(balance()).toBe(
        paymentMethod === 'CARD' || paymentMethod === 'BANK_ACCOUNT'
          ? '950.00'
          : '1000.00',
      );
      expect(store.database.expense.create).toHaveBeenCalledOnce();
    },
  );
  it('SPOUSE never debits the personal account, even for card payments', async () => {
    await turn(
      'Minha esposa gastou cinquenta euros no cartão.',
      command('CREATE', { ...base, payer: 'SPOUSE' }),
    );
    await turn('Correto, salva.', command('CONFIRM'));
    expect(balance()).toBe('1000.00');
    expect(store.database.bankAccount.updateMany).not.toHaveBeenCalled();
  });
  it.each(['CASH', 'OTHER', null])(
    'SELF + %s can save without inventing or requiring a bank account',
    async (paymentMethod) => {
      store.accounts.clear();
      await turn(
        'Uma despesa minha.',
        command('CREATE', { ...base, paymentMethod, currency: 'BRL' }),
      );
      expect((await turn('Pode salvar.', command('CONFIRM'))).type).toBe(
        'EXPENSE_SAVED',
      );
      expect(store.accounts.size).toBe(0);
      expect([...store.expenses.values()][0].currency).toBe('BRL');
    },
  );
  it('CARD requires the matching account and never debits a different currency', async () => {
    await turn(
      'Uma despesa no meu cartão.',
      command('CREATE', { ...base, currency: 'BRL' }),
    );
    expect((await turn('Pode salvar.', command('CONFIRM'))).type).toBe(
      'WRITE_ERROR',
    );
    expect(store.expenses.size).toBe(0);
    expect(balance()).toBe('1000.00');
    expect((await pending.get(id))!.status).toBe('PENDING');
  });
  it('does not save after unrelated/ambiguous speech, cancellation, or a combined edit/confirm action', async () => {
    await turn('Uma despesa.', command('CREATE', base));
    await turn(
      'Pode ser, estava falando com outra pessoa.',
      command('NO_ACTION'),
    );
    expect(store.expenses.size).toBe(0);
    const invalid = await turn(
      'Mude para 55 e salve.',
      command('CONFIRM', { amount: '55.00' }),
    );
    expect(invalid.type).toBe('WRITE_REJECTED');
    await turn('Deixa, não salva.', command('CANCEL'));
    expect((await turn('Pode salvar.', command('CONFIRM'))).type).toBe(
      'WRITE_REJECTED',
    );
    expect(store.expenses.size).toBe(0);
  });
  it('requires a fresh revision review and rejects stale confirmations', async () => {
    await turn('Uma despesa.', command('CREATE', base));
    await turn('Foram 55.', command('PATCH', { amount: '55.00' }));
    await expect(
      pending.applyIntent(id, command('CONFIRM'), 1),
    ).rejects.toThrow('changed');
    expect(store.expenses.size).toBe(0);
  });
  it('retains existing duplicate checks and requires separate intentional override, once', async () => {
    await turn('Uma despesa.', command('CREATE', base));
    await turn('Salva.', command('CONFIRM'));
    await turn('Outra igual.', command('CREATE', base));
    expect((await turn('Pode salvar.', command('CONFIRM'))).type).toBe(
      'DUPLICATE_CONFIRMATION_REQUIRED',
    );
    expect(store.expenses.size).toBe(1);
    expect(balance()).toBe('950.00');
    await turn(
      'Quero registrar outra mesmo assim.',
      command('DUPLICATE_CONFIRM'),
    );
    await turn('Isso mesmo.', command('DUPLICATE_CONFIRM'));
    expect(store.expenses.size).toBe(2);
    expect(balance()).toBe('900.00');
  });
  it('rolls back expense, debit and confirmation together on failure and returns no balance', async () => {
    await turn('Uma despesa.', command('CREATE', base));
    store.database.pendingExpense.update.mockRejectedValueOnce(
      new Error('failed marking confirmed'),
    );
    const result = await turn('Salva.', command('CONFIRM'));
    expect(result.type).toBe('WRITE_ERROR');
    expect(store.expenses.size).toBe(0);
    expect(balance()).toBe('1000.00');
    expect((await pending.get(id))!.status).toBe('PENDING');
    expect(JSON.stringify(result)).not.toContain('1000.00');
  });
  it('uses persisted mappings first and accepts unknown free-form merchants without forcing OTHER', async () => {
    const mapped = await turn(
      'Uma despesa no Tesco.',
      command('CREATE', { ...base, merchant: 'Tesco', category: 'OTHER' }),
    );
    expect(mapped).toMatchObject({ draft: { category: 'GROCERIES' } });
    await turn('Não salva.', command('CANCEL'));
    const result = await turn(
      'Uma despesa no Mr. Price.',
      command('CREATE', {
        ...base,
        merchant: 'Mr. Price',
        category: 'SHOPPING',
        payer: 'SPOUSE',
      }),
    );
    expect(result).toMatchObject({
      draft: { merchant: 'Mr. Price', category: 'SHOPPING' },
    });
  });
  it('reconnect resolves pending from the conversation and confirms without reconstructing values', async () => {
    await turn('Uma despesa.', command('CREATE', base));
    const reconnected = new LiveFinanceAdapter(ai, {
      recentMessages: async () => history,
    } as unknown as ConversationService);
    expect(await reconnected.openConversation(id)).toBe(id);
    create.mockResolvedValueOnce(call('expense_intent', command('CONFIRM')));
    const saved = await reconnected.execute(
      {
        sessionId: 'new-live',
        conversationId: id,
        delegationId: 'reconnect-confirm',
        userTurn: 'Pode salvar.',
      },
      new AbortController().signal,
    );
    expect(saved.type).toBe('EXPENSE_SAVED');
    expect(store.expenses.size).toBe(1);
    expect(create.mock.lastCall![0].instructions).toContain('"amount":"50.00"');
  });
  it('never mutates financial state for an already aborted delegation', async () => {
    const aborted = new AbortController();
    aborted.abort();
    await expect(
      adapter.execute(
        {
          sessionId: 's',
          conversationId: id,
          delegationId: 'd',
          userTurn: 'Salva.',
        },
        aborted.signal,
      ),
    ).rejects.toThrow();
    expect(store.pending.size).toBe(0);
    expect(store.expenses.size).toBe(0);
  });
});

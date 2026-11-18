import { AiService } from './ai.service.js';
import type { AnalyticsService } from '../analytics/analytics.service.js';
import type { ExpensesService } from '../expenses/expenses.service.js';
import type { ConversationService } from '../conversations/conversation.service.js';
import type { PendingExpenseService } from '../pending-expenses/pending-expense.service.js';
import type { BankAccountsService } from '../bank-accounts/bank-accounts.service.js';
const { create } = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('openai', () => ({
  default: class {
    responses = { create };
  },
}));

const tool = (name: string, args: object, id = name) => ({
  type: 'function_call',
  name,
  arguments: JSON.stringify(args),
  call_id: id,
  id,
});
const response = (...output: ReturnType<typeof tool>[]) => ({
  status: 'completed',
  output,
  output_text: 'Invented prose 999999 EUR is never returned.',
});
describe('restricted AiService Live read entry', () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const conversations = {
    create: vi.fn(),
    recentMessages: vi.fn(),
    saveTurn: vi.fn(),
  };
  const analytics = {
    monthlySummary: vi.fn(),
    byCategory: vi.fn(),
    byMerchant: vi.fn(),
  };
  const expenses = { findAll: vi.fn(), create: vi.fn() };
  const pending = {
    get: vi.fn(),
    prepare: vi.fn(),
    confirm: vi.fn(),
    patch: vi.fn(),
  };
  const bank = { findAll: vi.fn(), prepare: vi.fn(), confirm: vi.fn() };
  let ai: AiService;
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv('OPENAI_API_KEY', 'test-key');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-23T12:00:00Z'));
    conversations.create.mockResolvedValue({ id });
    conversations.recentMessages.mockResolvedValue([]);
    analytics.monthlySummary.mockImplementation(async (dto) => ({
      period: dto,
      totals: { EUR: '156.83', BRL: '97.00' },
    }));
    analytics.byCategory.mockResolvedValue([
      { category: 'PETS', currency: 'EUR', total: '15.40' },
    ]);
    analytics.byMerchant.mockResolvedValue([
      { merchant: 'Tesco', currency: 'EUR', total: '45.00' },
    ]);
    expenses.findAll.mockResolvedValue([
      { merchant: 'Tesco', currency: 'EUR', amount: '45.0000' },
    ]);
    bank.findAll.mockResolvedValue([
      { currency: 'EUR', currentBalance: '3210.00' },
    ]);
    ai = new AiService(
      analytics as unknown as AnalyticsService,
      expenses as unknown as ExpensesService,
      conversations as unknown as ConversationService,
      pending as unknown as PendingExpenseService,
      undefined,
      undefined,
      undefined,
      bank as unknown as BankAccountsService,
    );
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });
  const read = (message: string) =>
    ai.readOnly({ message, conversationId: id });
  it('uses existing monthly analytics, preserving EUR/BRL and ignoring all model prose', async () => {
    create.mockResolvedValue(
      response(tool('get_monthly_summary', { year: 2026, month: 10 })),
    );
    const result = await read('Quanto eu gastei este mês?');
    expect(result).toMatchObject({
      type: 'FINANCIAL_READ_RESULT',
      conversationId: id,
      balanceDisclosureAllowed: false,
      data: [
        {
          tool: 'get_monthly_summary',
          result: { totals: { EUR: '156.83', BRL: '97.00' } },
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain('999999');
    expect(analytics.monthlySummary).toHaveBeenCalledWith({
      year: '2026',
      month: '10',
    });
  });
  it('reuses merchant filters, date defaults and domain totals', async () => {
    create.mockResolvedValue(
      response(
        tool('get_expenses', {
          currency: null,
          merchant: 'Tesco',
          category: null,
          from: null,
          to: null,
        }),
      ),
    );
    const result = await read('Quanto eu gastei no Tesco?');
    expect(expenses.findAll).toHaveBeenCalledWith(
      expect.objectContaining({
        merchant: 'Tesco',
        from: '2026-10-01',
        to: '2026-10-23',
      }),
    );
    expect(result).toMatchObject({
      data: [
        {
          result: {
            expenses: [{ amount: '45.00' }],
            merchantTotals: [{ total: '45.00' }],
          },
        },
      ],
    });
  });
  it('uses the same stored conversation to resolve a category follow-up and fetches fresh data', async () => {
    create.mockResolvedValueOnce(
      response(tool('get_monthly_summary', { year: 2026, month: 10 })),
    );
    await read('Quanto eu gastei este mês?');
    const saved = conversations.saveTurn.mock.calls[0];
    conversations.recentMessages.mockResolvedValue([
      { role: 'USER', content: saved[1] },
      { role: 'ASSISTANT', content: saved[2] },
    ]);
    create.mockResolvedValueOnce(
      response(
        tool('get_by_category', {
          category: 'PETS',
          from: '2026-10-01',
          to: '2026-10-23',
          excludeCategories: null,
        }),
      ),
    );
    const result = await read('E com pets?');
    expect(result.conversationId).toBe(id);
    expect(analytics.byCategory).toHaveBeenCalledWith(
      expect.objectContaining({ category: 'PETS', from: '2026-10-01' }),
    );
    expect(create.mock.calls[1][0].input).toEqual(
      expect.arrayContaining([
        { role: 'user', content: 'Quanto eu gastei este mês?' },
        { role: 'user', content: 'E com pets?' },
      ]),
    );
  });
  it('honors yesterday and can retrieve both monthly comparison periods without LLM arithmetic', async () => {
    create.mockResolvedValueOnce(
      response(
        tool('get_expenses', {
          from: '2026-10-22',
          to: '2026-10-22',
          merchant: null,
          currency: null,
          category: null,
        }),
      ),
    );
    await read('Quanto eu gastei ontem?');
    expect(expenses.findAll).toHaveBeenCalledWith(
      expect.objectContaining({ from: '2026-10-22', to: '2026-10-22' }),
    );
    create.mockResolvedValueOnce(
      response(
        tool('get_monthly_summary', { year: 2026, month: 10 }),
        tool('get_monthly_summary', { year: 2026, month: 9 }),
      ),
    );
    const result = await read('Compare outubro com setembro.');
    expect(result).toMatchObject({
      data: [
        { result: { period: { month: '10' } } },
        { result: { period: { month: '9' } } },
      ],
    });
  });
  it('only exposes and dispatches bank balance for the explicit CURRENT turn', async () => {
    create.mockResolvedValueOnce(
      response(tool('get_bank_balance', { currency: 'EUR', account: null })),
    );
    expect(await read('Qual é meu saldo?')).toMatchObject({
      balanceDisclosureAllowed: true,
      data: [{ tool: 'get_bank_balance' }],
    });
    conversations.recentMessages.mockResolvedValue([
      { role: 'ASSISTANT', content: 'Seu saldo é 3210.00 EUR.' },
    ]);
    create.mockResolvedValueOnce(
      response(tool('get_bank_balance', { currency: 'EUR', account: null })),
    );
    expect(await read('Quanto gastei no Tesco?')).toMatchObject({
      type: 'FINANCIAL_READ_UNAVAILABLE',
      balanceDisclosureAllowed: false,
    });
    expect(bank.findAll).toHaveBeenCalledOnce();
    expect(
      create.mock.calls[1][0].tools.map((t: { name: string }) => t.name),
    ).not.toContain('get_bank_balance');
    expect(JSON.stringify(create.mock.calls[1][0].input)).not.toContain(
      '3210.00',
    );
    expect(JSON.stringify(conversations.saveTurn.mock.calls[0])).not.toContain(
      '3210.00',
    );
  });
  it.each([
    'prepare_expense',
    'patch_pending_expense',
    'prepare_budget',
    'prepare_bank_balance_update',
    'confirm_expense',
    'report_write_unavailable',
  ])(
    'cannot dispatch %s or invoke pending state, even with an existing conversation',
    async (name) => {
      create.mockResolvedValue(response(tool(name, {})));
      const result = await read('Ontem gastei vinte euros no Tesco.');
      expect(['WRITE_UNAVAILABLE', 'FINANCIAL_READ_UNAVAILABLE']).toContain(
        result.type,
      );
      expect(expenses.create).not.toHaveBeenCalled();
      for (const method of Object.values(pending))
        expect(method).not.toHaveBeenCalled();
      expect(bank.prepare).not.toHaveBeenCalled();
      expect(bank.confirm).not.toHaveBeenCalled();
      expect(
        create.mock.calls[0][0].tools.map((t: { name: string }) => t.name),
      ).not.toEqual(expect.arrayContaining(['prepare_expense']));
    },
  );
  it('blocks financial claims without a successful tool; semantic clarification remains available', async () => {
    create.mockResolvedValueOnce(response());
    expect(await read('Quanto gastei?')).toMatchObject({
      type: 'FINANCIAL_READ_UNAVAILABLE',
    });
    create.mockResolvedValueOnce(
      response(
        tool('ask_clarification', {
          question: 'Qual dos dois períodos você quer consultar?',
        }),
      ),
    );
    expect(await read('E naquele período?')).toMatchObject({
      type: 'CLARIFICATION_REQUIRED',
      question: 'Qual dos dois períodos você quer consultar?',
    });
  });
  it('does not publish or persist results after cancellation', async () => {
    const controller = new AbortController();
    create.mockImplementationOnce(async () => {
      controller.abort();
      return response(tool('get_monthly_summary', { year: 2026, month: 10 }));
    });
    await expect(
      ai.readOnly(
        { message: 'Quanto gastei?', conversationId: id },
        controller.signal,
      ),
    ).rejects.toThrow();
    expect(analytics.monthlySummary).not.toHaveBeenCalled();
    expect(conversations.saveTurn).not.toHaveBeenCalled();
  });
});

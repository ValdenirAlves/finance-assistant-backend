import { AiService } from '../ai.service.js';
import { LiveFinanceAdapter } from './live-finance.adapter.js';
import { LIVE_INSTRUCTIONS } from './live.prompt.js';
import { BankAccountsService } from '../../bank-accounts/bank-accounts.service.js';
import { PendingExpenseService } from '../../pending-expenses/pending-expense.service.js';
import { ExpensesService } from '../../expenses/expenses.service.js';
import { pendingDatabase } from '../../../test/helpers/pending-database.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { AnalyticsService } from '../../analytics/analytics.service.js';
import type { ConversationService } from '../../conversations/conversation.service.js';
import type { BankBalanceIntentDto } from '../../bank-accounts/bank-balance-intent.dto.js';
const { create } = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('openai', () => ({
  default: class {
    responses = { create };
  },
}));

const command = (
  action: BankBalanceIntentDto['action'],
  fields: Record<string, string | null> = {},
): BankBalanceIntentDto => ({
  action,
  changes: Object.entries(fields).map(([field, value]) => ({
    field: field as BankBalanceIntentDto['changes'][number]['field'],
    value,
  })),
});
const response = (name: string, args: object) => ({
  status: 'completed',
  output_text: 'Unverified 999999 EUR must never be returned.',
  output: [
    {
      type: 'function_call',
      name,
      arguments: JSON.stringify(args),
      call_id: 'call',
      id: 'fc',
    },
  ],
});

describe('Live BANK_BALANCE through the existing bank domain', () => {
  const id = '11111111-1111-4111-8111-111111111111';
  let store: ReturnType<typeof pendingDatabase>,
    bank: BankAccountsService,
    ai: AiService,
    adapter: LiveFinanceAdapter;
  let conversations: {
    create: ReturnType<typeof vi.fn>;
    recentMessages: ReturnType<typeof vi.fn>;
    saveTurn: ReturnType<typeof vi.fn>;
  };
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv('OPENAI_API_KEY', 'test-key');
    store = pendingDatabase();
    const prisma = store.database as unknown as PrismaService;
    bank = new BankAccountsService(prisma);
    const expenses = new ExpensesService(prisma);
    const pending = new PendingExpenseService(prisma, expenses);
    conversations = {
      create: vi.fn().mockResolvedValue({ id }),
      recentMessages: vi.fn().mockResolvedValue([]),
      saveTurn: vi.fn(),
    };
    ai = new AiService(
      {
        monthlySummary: vi
          .fn()
          .mockResolvedValue({ totals: { EUR: '20.00', BRL: '97.00' } }),
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
  afterEach(() => vi.unstubAllEnvs());
  const turn = (message: string, intent: BankBalanceIntentDto) => {
    create.mockResolvedValueOnce(response('bank_balance_intent', intent));
    return adapter.execute(
      {
        sessionId: 'live',
        conversationId: id,
        delegationId: 'd',
        userTurn: message,
      },
      new AbortController().signal,
    );
  };
  const prepare = () =>
    turn(
      'Meu saldo bancário é de 2000 euros.',
      command('CREATE', { currentBalance: '2000.00', currency: 'EUR' }),
    );

  it.each([
    'Meu saldo bancário é de 2000 euros.',
    'Meu saldo é 2000 euros.',
    'Tenho 2000 euros na conta.',
    'Atualize meu saldo para 2000 euros.',
    'Na minha conta tenho dois mil euros.',
  ])(
    'routes the structured interpretation of %s to PendingBankBalance only',
    async (message) => {
      const result = await turn(
        message,
        command('CREATE', { currentBalance: '2000.00', currency: 'EUR' }),
      );
      expect(result).toMatchObject({
        type: 'BANK_BALANCE_CONFIRMATION_REQUIRED',
        balanceDisclosureAllowed: false,
        balanceDraftDisclosureAllowed: true,
        draft: { currentBalance: '2000.00', currency: 'EUR' },
      });
      expect(store.balanceDrafts.get(id)).toMatchObject({
        status: 'PENDING',
        revision: 1,
        confirmationRequested: true,
      });
      expect(store.accounts.size).toBe(0);
      expect(store.expenses.size).toBe(0);
      expect(store.pending.size).toBe(0);
      expect(store.database.expense.create).not.toHaveBeenCalled();
      expect(
        create.mock.calls[0][0].tools.map(
          (tool: { name: string }) => tool.name,
        ),
      ).toEqual(
        expect.arrayContaining(['expense_intent', 'bank_balance_intent']),
      );
      expect(conversations.saveTurn).toHaveBeenCalledWith(
        id,
        '[Private bank balance interaction]',
        '[Private bank balance interaction]',
      );
    },
  );

  it('does not guess currency or create an account for an incomplete setting request', async () => {
    expect(
      await turn(
        'Meu saldo atual é de 2000.',
        command('CREATE', { currentBalance: '2000.00' }),
      ),
    ).toMatchObject({
      type: 'MISSING_INFORMATION',
      domain: 'BANK_BALANCE',
      missingFields: ['currency'],
    });
    expect(store.accounts.size).toBe(0);
    expect(store.balanceDrafts.size).toBe(0);
  });
  it('patches amount only, then currency only, preserving name and omitted details', async () => {
    await turn(
      'Meu saldo no AIB é 2000 euros.',
      command('CREATE', {
        currentBalance: '2000.00',
        currency: 'EUR',
        name: 'AIB',
      }),
    );
    expect(
      await turn(
        'Na verdade são 2100.',
        command('PATCH', { currentBalance: '2100.00' }),
      ),
    ).toMatchObject({
      type: 'BANK_BALANCE_CONFIRMATION_REQUIRED',
      pendingRevision: 2,
      draft: { currentBalance: '2100.00', currency: 'EUR', name: 'AIB' },
    });
    expect(
      await turn('É em reais.', command('PATCH', { currency: 'BRL' })),
    ).toMatchObject({
      pendingRevision: 3,
      draft: { currentBalance: '2100.00', currency: 'BRL', name: 'AIB' },
    });
    expect(
      await turn('É em euros.', command('PATCH', { currency: 'EUR' })),
    ).toMatchObject({
      pendingRevision: 4,
      draft: { currentBalance: '2100.00', currency: 'EUR', name: 'AIB' },
    });
    expect(store.accounts.size).toBe(0);
    expect(create.mock.calls.at(-1)![0].instructions).toContain('2100.00');
  });
  it('confirms explicitly, returns no balance value and never reapplies a repeated confirmation', async () => {
    await prepare();
    const result = await turn('Sim.', command('CONFIRM'));
    expect(result).toEqual({
      type: 'BANK_BALANCE_SAVED',
      pendingRevision: 1,
      conversationId: id,
      balanceDisclosureAllowed: false,
    });
    expect((await bank.findAll())[0].currentBalance).toBe('2000.00');
    expect(store.balanceDrafts.get(id)).toMatchObject({
      status: 'CONFIRMED',
      confirmationRequested: false,
    });
    await Promise.all([
      turn('Sim.', command('CONFIRM')),
      turn('Pode salvar.', command('CONFIRM')),
    ]);
    expect(store.database.bankAccount.upsert).toHaveBeenCalledOnce();
    expect(create.mock.calls.at(-1)![0].instructions).not.toContain('2000.00');
  });
  it('does not reapply the saved balance after an eligible expense debit', async () => {
    await prepare();
    await turn('Sim.', command('CONFIRM'));
    await new ExpensesService(
      store.database as unknown as PrismaService,
    ).create({
      amount: '20.00',
      currency: 'EUR',
      transactionDate: '2026-10-21',
      payer: 'SELF',
      paymentMethod: 'CARD',
    });
    await turn('Pode salvar.', command('CONFIRM'));
    expect((await bank.findAll())[0].currentBalance).toBe('1980.00');
    expect(store.database.bankAccount.upsert).toHaveBeenCalledOnce();
  });
  it('cancels without mutating an existing balance and rejects later confirmation', async () => {
    await prepare();
    await turn('Sim.', command('CONFIRM'));
    await turn(
      'Atualize para 2100 euros.',
      command('CREATE', { currentBalance: '2100.00', currency: 'EUR' }),
    );
    expect(await turn('Cancela.', command('CANCEL'))).toMatchObject({
      type: 'BANK_BALANCE_CANCELLED',
    });
    expect(await turn('Sim.', command('CONFIRM'))).toMatchObject({
      type: 'WRITE_REJECTED',
    });
    expect((await bank.findAll())[0].currentBalance).toBe('2000.00');
    expect(store.database.bankAccount.upsert).toHaveBeenCalledOnce();
  });
  it('keeps EUR and BRL accounts separate', async () => {
    await prepare();
    await turn('Sim.', command('CONFIRM'));
    await turn(
      'Tenho 97 reais na conta.',
      command('CREATE', { currentBalance: '97.00', currency: 'BRL' }),
    );
    await turn('Salva.', command('CONFIRM'));
    expect((await bank.findAll({ currency: 'EUR' }))[0].currentBalance).toBe(
      '2000.00',
    );
    expect((await bank.findAll({ currency: 'BRL' }))[0].currentBalance).toBe(
      '97.00',
    );
  });
  it('rejects no-draft consent and combined edits/confirmation without writes', async () => {
    expect(await turn('Sim.', command('CONFIRM'))).toMatchObject({
      type: 'WRITE_REJECTED',
    });
    await prepare();
    expect(
      await turn(
        'São 2100, pode salvar.',
        command('CONFIRM', { currentBalance: '2100.00' }),
      ),
    ).toMatchObject({ type: 'WRITE_REJECTED' });
    expect(store.accounts.size).toBe(0);
    expect(store.balanceDrafts.get(id)!.currentBalance.toFixed(2)).toBe(
      '2000.00',
    );
  });
  it('requires a new review/consent after a read and never returns balance in spending results', async () => {
    await prepare();
    create.mockResolvedValueOnce(
      response('get_monthly_summary', { year: 2026, month: 10 }),
    );
    const spending = await ai.liveTurn({
      message: 'Quanto gastei este mês?',
      conversationId: id,
    });
    expect(spending).toMatchObject({
      type: 'FINANCIAL_READ_RESULT',
      balanceDisclosureAllowed: false,
    });
    expect(JSON.stringify(spending)).not.toContain('2000.00');
    expect(await turn('Sim.', command('CONFIRM'))).toMatchObject({
      type: 'BANK_BALANCE_CONFIRMATION_REQUIRED',
    });
    expect(store.accounts.size).toBe(0);
    await turn('Pode salvar.', command('CONFIRM'));
    expect(store.accounts.size).toBe(1);
  });
  it('rejects mixed tool calls before mutating either domain', async () => {
    const first = response(
      'bank_balance_intent',
      command('CREATE', { currentBalance: '2000.00', currency: 'EUR' }),
    );
    create.mockResolvedValueOnce({
      ...first,
      output: [
        ...first.output,
        ...response('expense_intent', { action: 'CONFIRM', changes: [] })
          .output,
      ],
    });
    expect(
      await ai.liveTurn({
        message: 'Atualize meu saldo e registre uma despesa.',
        conversationId: id,
      }),
    ).toMatchObject({ type: 'WRITE_REJECTED' });
    expect(store.balanceDrafts.size).toBe(0);
    expect(store.expenses.size).toBe(0);
  });
  it('does not let an incomplete new setting request leave old confirmation armed', async () => {
    await prepare();
    expect(
      await turn(
        'Meu novo saldo é 2100.',
        command('CREATE', { currentBalance: '2100.00' }),
      ),
    ).toMatchObject({ type: 'MISSING_INFORMATION' });
    expect(store.balanceDrafts.get(id)!.confirmationRequested).toBe(false);
    expect(await turn('Sim.', command('CONFIRM'))).toMatchObject({
      type: 'BANK_BALANCE_CONFIRMATION_REQUIRED',
    });
    expect(store.accounts.size).toBe(0);
  });
  it('allows an explicit fresh balance read after save, without granting future disclosure', async () => {
    await prepare();
    await turn('Sim.', command('CONFIRM'));
    create.mockResolvedValueOnce(
      response('get_bank_balance', { currency: 'EUR', account: null }),
    );
    expect(
      await ai.liveTurn({ message: 'Qual é meu saldo?', conversationId: id }),
    ).toMatchObject({
      type: 'FINANCIAL_READ_RESULT',
      balanceDisclosureAllowed: true,
      data: [
        {
          tool: 'get_bank_balance',
          result: [{ currency: 'EUR', currentBalance: '2000.00' }],
        },
      ],
    });
    create.mockResolvedValueOnce(
      response('get_bank_balance', { currency: 'EUR', account: null }),
    );
    const result = await ai.liveTurn({
      message: 'Quanto gastei este mês?',
      conversationId: id,
    });
    expect(result).toMatchObject({
      type: 'FINANCIAL_READ_UNAVAILABLE',
      balanceDisclosureAllowed: false,
    });
    expect(JSON.stringify(result)).not.toContain('2000.00');
  });
  it('rolls back account persistence if confirmation fails', async () => {
    await prepare();
    store.database.pendingBankBalance.update.mockRejectedValueOnce(
      new Error('persistence failed'),
    );
    expect(await turn('Sim.', command('CONFIRM'))).toMatchObject({
      type: 'WRITE_ERROR',
    });
    expect(store.accounts.size).toBe(0);
    expect(store.balanceDrafts.get(id)!.status).toBe('PENDING');
  });
  it.each([
    { currentBalance: '2000.001', currency: 'EUR' },
    { currentBalance: '2000.00', currency: 'USD' },
  ])('retains existing domain validation for %j', async (fields) => {
    expect(
      await turn('Defina meu saldo.', command('CREATE', fields)),
    ).toMatchObject({ type: 'WRITE_ERROR' });
    expect(store.accounts.size).toBe(0);
    expect(store.balanceDrafts.size).toBe(0);
  });
  it('checks revision and rolls back an aborted confirmation before commit', async () => {
    await prepare();
    await turn(
      'Na verdade 2100.',
      command('PATCH', { currentBalance: '2100.00' }),
    );
    await expect(bank.applyIntent(id, command('CONFIRM'), 1)).rejects.toThrow(
      'changed',
    );
    const abort = new AbortController();
    const update =
      store.database.pendingBankBalance.update.getMockImplementation()!;
    store.database.pendingBankBalance.update.mockImplementationOnce(
      async (args) => {
        const result = await update(args);
        abort.abort();
        return result;
      },
    );
    await expect(
      bank.applyIntent(id, command('CONFIRM'), 2, abort.signal),
    ).rejects.toThrow();
    expect(store.accounts.size).toBe(0);
    expect(store.balanceDrafts.get(id)!.status).toBe('PENDING');
  });
  it('instructs Live to delegate balance writes and speak no amount after saving', () => {
    expect(LIVE_INSTRUCTIONS).toContain('PendingBankBalance');
    expect(LIVE_INSTRUCTIONS).toContain(
      'BANK_BALANCE_SAVED acknowledges the update without any value',
    );
    expect(LIVE_INSTRUCTIONS).not.toContain(
      'bank-balance mutations remain disabled',
    );
  });
});

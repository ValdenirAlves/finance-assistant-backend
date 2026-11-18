import type { ConnectServerEvent } from 'openai/resources/live/sideband/sideband';
import { LiveDelegation, LIVE_TURN_SETTLE_MS } from './live-delegation.js';
import { LiveFinanceAdapter } from './live-finance.adapter.js';
import { AiService } from '../ai.service.js';
import { PendingExpenseService } from '../../pending-expenses/pending-expense.service.js';
import { BankAccountsService } from '../../bank-accounts/bank-accounts.service.js';
import { ExpensesService } from '../../expenses/expenses.service.js';
import { CategoriesService } from '../../categories/categories.service.js';
import { pendingDatabase } from '../../../test/helpers/pending-database.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { ConversationService } from '../../conversations/conversation.service.js';
import type { AnalyticsService } from '../../analytics/analytics.service.js';
const { create } = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('openai', () => ({
  default: class {
    responses = { create };
  },
}));
const call = (name: string, args: object) => ({
  status: 'completed',
  output_text: '',
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
const expense = (action: string, fields: Record<string, string | null> = {}) =>
  call('expense_intent', {
    action,
    changes: Object.entries(fields).map(([field, value]) => ({ field, value })),
  });
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  return {
    promise: new Promise<T>((done) => {
      resolve = done;
    }),
    resolve: (value: T) => resolve(value),
  };
};

describe('Live ordered pending-write continuations', () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const base = {
    amount: '14.90',
    currency: 'EUR',
    merchant: 'PetStop',
    category: 'PETS',
    transactionDate: '2026-10-28',
    payer: null,
  };
  let store: ReturnType<typeof pendingDatabase>,
    pending: PendingExpenseService,
    bank: BankAccountsService;
  let adapter: LiveFinanceAdapter, coordinator: LiveDelegation, seq: number;
  let send: ReturnType<typeof vi.fn>,
    log: ReturnType<typeof vi.fn>,
    monthly: ReturnType<typeof vi.fn>;
  let gates: Array<ReturnType<typeof deferred<ReturnType<typeof call>>>>;
  let coordinators: LiveDelegation[];
  beforeEach(async () => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-28T12:00:00Z'));
    vi.stubEnv('OPENAI_API_KEY', 'test-key');
    seq = 0;
    gates = [];
    coordinators = [];
    store = pendingDatabase();
    const prisma = store.database as unknown as PrismaService;
    const expenses = new ExpensesService(prisma, new CategoriesService(prisma));
    pending = new PendingExpenseService(prisma, expenses);
    bank = new BankAccountsService(prisma);
    const balance = await bank.prepare(
      'bank',
      { currency: 'EUR', currentBalance: '1000.00' },
      null,
    );
    await bank.arm('bank', balance.revision);
    await bank.confirm('bank', balance.revision);
    const history: Array<{ role: string; content: string }> = [];
    const conversations = {
      create: vi.fn().mockResolvedValue({ id }),
      recentMessages: vi.fn(async () => [...history]),
      saveTurn: vi.fn(async (_id: string, user: string, answer: string) => {
        history.push(
          { role: 'USER', content: user },
          { role: 'ASSISTANT', content: answer },
        );
      }),
    };
    monthly = vi
      .fn()
      .mockResolvedValue({ totals: { EUR: '20.00', BRL: '97.00' } });
    const ai = new AiService(
      { monthlySummary: monthly } as unknown as AnalyticsService,
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
    send = vi.fn();
    log = vi.fn();
    coordinator = makeCoordinator();
  });
  function makeCoordinator(sessionId = 'session') {
    const result = new LiveDelegation({
      sessionId,
      conversationId: id,
      finance: adapter,
      send,
      log,
      work: vi.fn(),
    });
    coordinators.push(result);
    return result;
  }
  afterEach(async () => {
    coordinators.forEach((item) => item.close());
    gates.forEach((gate) =>
      gate.resolve(
        call('ask_clarification', { question: 'Could you clarify?' }),
      ),
    );
    await vi.advanceTimersByTimeAsync(0);
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });
  const queueTurn = async (text: string, target = coordinator) => {
    const index = ++seq,
      start = index * 5000;
    target.accept({
      type: 'session.input_transcript.delta',
      event_id: `u${index}`,
      delta: text,
      start_ms: start,
      end_ms: start + 1000,
    } as ConnectServerEvent);
    target.accept({
      type: 'session.delegation.created',
      event_id: `e${index}`,
      offset_ms: start + 1100,
      delegation: { id: `d${index}`, type: 'delegation', target: 'client' },
    } as ConnectServerEvent);
    await vi.advanceTimersByTimeAsync(LIVE_TURN_SETTLE_MS);
    return `d${index}`;
  };
  const hold = () => {
    const gate = deferred<ReturnType<typeof call>>();
    gates.push(gate);
    create.mockReturnValueOnce(gate.promise);
    return gate;
  };
  const flush = () => vi.advanceTimersByTimeAsync(0);
  const result = (delegationId: string) => {
    const events = send.mock.calls
      .map(([event]) => event)
      .filter((event) => event.delegation_id === delegationId);
    const fragments = events
      .filter((event) => event.type === 'session.thinking.append')
      .map((event) => JSON.parse(event.content).fragment)
      .join('');
    return JSON.parse(fragments || events.at(-1).content);
  };
  const balance = () =>
    [...store.accounts.values()]
      .find((row) => row.currency === 'EUR')!
      .currentBalance.toFixed(2);

  it('composes the exact PetStop utterances while the first interpretation is pending, then saves/debits once', async () => {
    const gate = hold();
    const first = await queueTurn('Gastei 14 euros e 90 centavos no PetStop.');
    const firstSignal = create.mock.calls[0][1].signal as AbortSignal;
    create.mockResolvedValueOnce(
      expense('PATCH', { payer: 'SELF', paymentMethod: 'CARD' }),
    );
    const second = await queueTurn('No meu cartão.');
    expect(create).toHaveBeenCalledOnce();
    expect(firstSignal.aborted).toBe(false);
    gate.resolve(expense('CREATE', base));
    await flush();
    expect(store.pending.size).toBe(1);
    expect(store.expenses.size).toBe(0);
    expect(balance()).toBe('1000.00');
    expect(pending.summary((await pending.get(id))!)).toMatchObject({
      amount: '14.90',
      currency: 'EUR',
      merchant: 'PetStop',
      payer: 'SELF',
      paymentMethod: 'CARD',
      revision: 2,
    });
    expect(result(second).type).toBe('CONFIRMATION_REQUIRED');
    expect(
      send.mock.calls.some(([event]) => event.delegation_id === first),
    ).toBe(false);
    expect(create.mock.calls[1][0].instructions).toContain('"revision":1');
    create.mockResolvedValueOnce(expense('CONFIRM'));
    await queueTurn('Pode salvar.');
    create.mockResolvedValueOnce(expense('CONFIRM'));
    await queueTurn('Sim, pode salvar.');
    expect(store.expenses.size).toBe(1);
    expect(balance()).toBe('985.10');
    expect(store.database.bankAccount.updateMany).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith(
      'write_patch_applied',
      expect.objectContaining({
        conversationId: id,
        delegationId: second,
        queueDepth: 1,
        pendingRevision: 2,
      }),
    );
    expect(JSON.stringify(log.mock.calls)).not.toContain('14.90');
  });
  it('applies a rapid amount correction and rejects confirmation of the older revision', async () => {
    const gate = hold();
    await queueTurn('Gastei 50 euros no Tesco.');
    create.mockResolvedValueOnce(expense('PATCH', { amount: '15.00' }));
    await queueTurn('Não, foram 15.');
    gate.resolve(
      expense('CREATE', { ...base, amount: '50.00', merchant: 'Tesco' }),
    );
    await flush();
    expect((await pending.get(id))!.amount!.toFixed(2)).toBe('15.00');
    await expect(pending.confirm(id, 1)).rejects.toThrow('review');
    expect(store.expenses.size).toBe(0);
    expect(balance()).toBe('1000.00');
  });
  it('preserves multiple queued patches in order with a fresh snapshot on each turn', async () => {
    const gate = hold();
    await queueTurn('Gastei 50 euros.');
    create.mockResolvedValueOnce(expense('PATCH', { merchant: 'Tesco' }));
    await queueTurn('No Tesco.');
    create.mockResolvedValueOnce(
      expense('PATCH', { transactionDate: '2026-10-27' }),
    );
    await queueTurn('Ontem.');
    create.mockResolvedValueOnce(
      expense('PATCH', { payer: 'SELF', paymentMethod: 'CARD' }),
    );
    const last = await queueTurn('No meu cartão.');
    expect(create).toHaveBeenCalledOnce();
    gate.resolve(
      expense('CREATE', { ...base, amount: '50.00', merchant: null }),
    );
    await flush();
    expect(pending.summary((await pending.get(id))!)).toMatchObject({
      amount: '50.00',
      merchant: 'Tesco',
      transactionDate: '2026-10-27T00:00:00.000Z',
      payer: 'SELF',
      paymentMethod: 'CARD',
      revision: 4,
    });
    expect(result(last).type).toBe('CONFIRMATION_REQUIRED');
    expect(store.database.pendingExpense.upsert).toHaveBeenCalledOnce();
    expect(store.expenses.size).toBe(0);
  });
  it('a failed queued patch leaves the draft coherent and does not prevent the next patch', async () => {
    const gate = hold();
    await queueTurn('Gastei 50 euros no Tesco.');
    create.mockResolvedValueOnce(expense('PATCH', { amount: '-15.00' }));
    await queueTurn('Uma correção inválida.');
    create.mockResolvedValueOnce(
      expense('PATCH', { payer: 'SPOUSE', paymentMethod: 'CASH' }),
    );
    const last = await queueTurn('Minha esposa pagou em dinheiro.');
    gate.resolve(expense('CREATE', { ...base, amount: '50.00' }));
    await flush();
    expect(pending.summary((await pending.get(id))!)).toMatchObject({
      amount: '50.00',
      payer: 'SPOUSE',
      paymentMethod: 'CASH',
      revision: 2,
    });
    expect(result(last).type).toBe('CONFIRMATION_REQUIRED');
    expect(store.expenses.size).toBe(0);
  });
  it('deduplicates a delegation while its interpretation is still running', async () => {
    const gate = hold();
    await queueTurn('Gastei 14,90 no PetStop.');
    coordinator.accept({
      type: 'session.delegation.created',
      event_id: 'duplicate-event',
      offset_ms: 6100,
      delegation: { id: 'd1', type: 'delegation', target: 'client' },
    } as ConnectServerEvent);
    gate.resolve(expense('CREATE', base));
    await flush();
    expect(create).toHaveBeenCalledOnce();
    expect(store.pending.size).toBe(1);
    expect((await pending.get(id))!.revision).toBe(1);
  });
  it('cannot save a newly prepared revision using consent spoken before processing completed', async () => {
    const gate = hold();
    await queueTurn('Gastei 14,90 euros no PetStop com meu cartão.');
    create.mockResolvedValueOnce(expense('CONFIRM'));
    const early = await queueTurn('Sim, salva.');
    gate.resolve(
      expense('CREATE', { ...base, payer: 'SELF', paymentMethod: 'CARD' }),
    );
    await flush();
    expect(result(early)).toMatchObject({
      type: 'WRITE_REJECTED',
      pendingRevision: 1,
      draft: { status: 'PENDING' },
    });
    expect(store.expenses.size).toBe(0);
    create.mockResolvedValueOnce(expense('CONFIRM'));
    await queueTurn('Agora pode salvar.');
    expect(store.expenses.size).toBe(1);
  });
  it('does not execute an obsolete final-save intent even if its model response arrives late', async () => {
    create.mockResolvedValueOnce(
      expense('CREATE', { ...base, payer: 'SELF', paymentMethod: 'CARD' }),
    );
    await queueTurn('Gastei 14,90 euros no meu cartão.');
    const gate = hold();
    await queueTurn('Pode salvar.');
    create.mockResolvedValueOnce(expense('PATCH', { amount: '15.00' }));
    const last = await queueTurn('Não, foram 15.');
    gate.resolve(expense('CONFIRM'));
    await flush();
    expect(result(last)).toMatchObject({
      type: 'CONFIRMATION_REQUIRED',
      pendingRevision: 2,
    });
    expect(store.expenses.size).toBe(0);
    expect(balance()).toBe('1000.00');
  });
  it('reports prepared versus saved from backend state for a semantic status query', async () => {
    const gate = hold();
    await queueTurn('Gastei 14,90 euros no meu cartão.');
    create.mockResolvedValueOnce(expense('STATUS'));
    const status = await queueTurn('Registrou?');
    gate.resolve(
      expense('CREATE', { ...base, payer: 'SELF', paymentMethod: 'CARD' }),
    );
    await flush();
    expect(result(status)).toMatchObject({
      type: 'EXPENSE_STATUS',
      draft: { status: 'PENDING', state: 'AWAITING_CONFIRMATION' },
    });
    expect(store.expenses.size).toBe(0);
    create.mockResolvedValueOnce(expense('CONFIRM'));
    await queueTurn('Pode salvar.');
    create.mockResolvedValueOnce(expense('STATUS'));
    const savedStatus = await queueTurn('Já ficou registrado?');
    expect(result(savedStatus)).toMatchObject({
      type: 'EXPENSE_STATUS',
      draft: { status: 'CONFIRMED', state: 'SAVED' },
    });
  });
  it('rolls back a final-save transaction if a correction arrives while it is awaiting persistence', async () => {
    create.mockResolvedValueOnce(
      expense('CREATE', { ...base, payer: 'SELF', paymentMethod: 'CARD' }),
    );
    await queueTurn('Gastei 14,90 euros no meu cartão.');
    const gate = deferred<void>();
    const persist = store.database.expense.create.getMockImplementation()!;
    store.database.expense.create.mockImplementationOnce(async (args) => {
      await gate.promise;
      return persist(args);
    });
    create.mockResolvedValueOnce(expense('CONFIRM'));
    await queueTurn('Pode salvar.');
    create.mockResolvedValueOnce(expense('PATCH', { amount: '15.00' }));
    const last = await queueTurn('Não, foram 15.');
    gate.resolve();
    await flush();
    expect(store.expenses.size).toBe(0);
    expect(balance()).toBe('1000.00');
    expect(result(last)).toMatchObject({
      type: 'CONFIRMATION_REQUIRED',
      pendingRevision: 2,
      draft: { amount: '15.00' },
    });
  });
  it('discards a superseded read before querying analytics and preserves the newer read result', async () => {
    const gate = hold();
    const first = await queueTurn('Quanto gastei este mês?');
    create.mockResolvedValueOnce(
      call('get_monthly_summary', { year: 2026, month: 10 }),
    );
    const last = await queueTurn('E no mês passado?');
    gate.resolve(call('get_monthly_summary', { year: 2026, month: 10 }));
    await flush();
    expect(monthly).toHaveBeenCalledOnce();
    expect(result(last).type).toBe('FINANCIAL_READ_RESULT');
    expect(
      send.mock.calls.some(([event]) => event.delegation_id === first),
    ).toBe(false);
  });
  it('cleans queued turns on close and cannot establish a late draft', async () => {
    const gate = hold();
    await queueTurn('Gastei 14,90 no PetStop.');
    create.mockResolvedValueOnce(expense('PATCH', { payer: 'SELF' }));
    await queueTurn('Fui eu.');
    coordinator.close();
    gate.resolve(expense('CREATE', base));
    await flush();
    expect(create).toHaveBeenCalledOnce();
    expect(store.pending.size).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });
  it('serializes the same conversation even when two Live sessions overlap', async () => {
    const gate = hold();
    await queueTurn('Gastei 14,90 euros no PetStop.');
    create.mockResolvedValueOnce(
      expense('PATCH', { payer: 'SELF', paymentMethod: 'CARD' }),
    );
    const last = await queueTurn(
      'No meu cartão.',
      makeCoordinator('reconnected-session'),
    );
    expect(create).toHaveBeenCalledOnce();
    gate.resolve(expense('CREATE', base));
    await flush();
    expect((await pending.get(id))!.revision).toBe(2);
    expect(result(last).type).toBe('CONFIRMATION_REQUIRED');
    expect(store.expenses.size).toBe(0);
  });
  it('keeps bank balance preparation/correction ordered and requires a later confirmation', async () => {
    const bankCall = (action: string, fields: Record<string, string> = {}) =>
      call('bank_balance_intent', {
        action,
        changes: Object.entries(fields).map(([field, value]) => ({
          field,
          value,
        })),
      });
    const gate = hold();
    await queueTurn('Meu saldo é 2000 euros.');
    create.mockResolvedValueOnce(
      bankCall('PATCH', { currentBalance: '2100.00' }),
    );
    const last = await queueTurn('Na verdade são 2100.');
    gate.resolve(
      bankCall('CREATE', { currentBalance: '2000.00', currency: 'EUR' }),
    );
    await flush();
    expect(result(last)).toMatchObject({
      type: 'BANK_BALANCE_CONFIRMATION_REQUIRED',
      pendingRevision: 2,
    });
    expect(balance()).toBe('1000.00');
    create.mockResolvedValueOnce(bankCall('CONFIRM'));
    const saved = await queueTurn('Sim.');
    expect(result(saved).type).toBe('BANK_BALANCE_SAVED');
    expect(balance()).toBe('2100.00');
    expect(store.expenses.size).toBe(0);
  });
});

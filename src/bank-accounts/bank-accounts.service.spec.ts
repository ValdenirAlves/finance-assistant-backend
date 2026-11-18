import { BadRequestException, ConflictException } from '@nestjs/common';
import { BankAccountsService } from './bank-accounts.service.js';
import { pendingDatabase } from '../../test/helpers/pending-database.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ExpensesService } from '../expenses/expenses.service.js';
import { PendingExpenseService } from '../pending-expenses/pending-expense.service.js';

describe('bank balances and atomic expense impact', () => {
  let store: ReturnType<typeof pendingDatabase>;
  let bank: BankAccountsService;
  let expenses: ExpensesService;
  let pending: PendingExpenseService;
  const conversation = 'balance-conversation';
  const expense = {
    amount: '42.10',
    currency: 'EUR' as const,
    merchant: 'Tesco',
    transactionDate: '2026-10-15',
    payer: 'SELF' as const,
    paymentMethod: 'CARD' as const,
  };
  beforeEach(() => {
    store = pendingDatabase();
    const prisma = store.database as unknown as PrismaService;
    bank = new BankAccountsService(prisma);
    expenses = new ExpensesService(prisma);
    pending = new PendingExpenseService(prisma, expenses);
  });
  async function setBalance(
    currency: 'EUR' | 'BRL' = 'EUR',
    currentBalance = '3250.00',
  ) {
    const previous = await bank.getPending(conversation);
    const draft = await bank.prepare(
      conversation,
      { currency, currentBalance, name: 'AIB' },
      previous?.revision ?? null,
    );
    await bank.arm(conversation, draft.revision);
    await bank.confirm(conversation, draft.revision);
    return draft;
  }
  async function confirmExpense(input = expense) {
    const previous = await pending.get('expense-conversation');
    const draft = await pending.prepare(
      'expense-conversation',
      input,
      previous?.revision ?? null,
    );
    await pending.requestConfirmation('expense-conversation', draft.revision);
    return pending.confirm('expense-conversation', draft.revision);
  }
  const balance = async (currency: 'EUR' | 'BRL' = 'EUR') =>
    (await bank.findAll({ currency }))[0]?.currentBalance;
  it.each(['EUR', 'BRL'] as const)(
    'sets %s only after a separately armed confirmation',
    async (currency) => {
      const draft = await bank.prepare(
        conversation,
        { currency, currentBalance: '3250.01' },
        null,
      );
      expect(store.accounts.size).toBe(0);
      await expect(
        bank.confirm(conversation, draft.revision),
      ).rejects.toBeInstanceOf(BadRequestException);
      await bank.arm(conversation, draft.revision);
      await bank.confirm(conversation, draft.revision);
      expect(await balance(currency)).toBe('3250.01');
      expect(store.accounts.size).toBe(1);
    },
  );
  it('preserves large exact Decimal cents without floating point', async () => {
    await setBalance('EUR', '99999999999999999.99');
    await expenses.create({ ...expense, amount: '0.01' });
    expect(await balance()).toBe('99999999999999999.98');
  });
  it('cancellation and stale revisions cannot change a balance', async () => {
    await setBalance();
    const draft = await bank.prepare(
      conversation,
      { currency: 'EUR', currentBalance: '1.00' },
      1,
    );
    await expect(bank.confirm(conversation, 1)).rejects.toBeInstanceOf(
      ConflictException,
    );
    await bank.arm(conversation, draft.revision);
    await bank.cancel(conversation, draft.revision);
    await expect(
      bank.confirm(conversation, draft.revision),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(await balance()).toBe('3250.00');
  });
  it('does not reapply a confirmed balance update after an intervening expense', async () => {
    const draft = await setBalance();
    await confirmExpense();
    await bank.confirm(conversation, draft.revision);
    expect(await balance()).toBe('3207.90');
  });
  it('rolls back a balance upsert if marking its draft confirmed fails', async () => {
    const draft = await bank.prepare(
      conversation,
      { currency: 'EUR', currentBalance: '3250.00' },
      null,
    );
    await bank.arm(conversation, draft.revision);
    store.database.pendingBankBalance.update.mockRejectedValueOnce(
      new Error('confirmation failed'),
    );
    await expect(bank.confirm(conversation, draft.revision)).rejects.toThrow();
    expect(store.accounts.size).toBe(0);
    expect(store.balanceDrafts.get(conversation)?.status).toBe('PENDING');
    await bank.confirm(conversation, draft.revision);
    expect(await balance()).toBe('3250.00');
  });
  it('debits SELF once even for simultaneous/repeated confirmations', async () => {
    await setBalance();
    await confirmExpense();
    await Promise.all([
      pending.confirm('expense-conversation', 1),
      pending.confirm('expense-conversation', 1),
    ]);
    expect(store.expenses.size).toBe(1);
    expect(await balance()).toBe('3207.90');
    expect(store.database.bankAccount.updateMany).toHaveBeenCalledOnce();
  });
  it('rolls back debit, expense and pending status together on failure', async () => {
    await setBalance();
    store.database.pendingExpense.update.mockRejectedValueOnce(
      new Error('after debit/insert'),
    );
    await expect(confirmExpense()).rejects.toThrow();
    expect(store.expenses.size).toBe(0);
    expect(await balance()).toBe('3250.00');
    expect(store.pending.get('expense-conversation')?.status).toBe('PENDING');
    await pending.confirm('expense-conversation', 1);
    expect(await balance()).toBe('3207.90');
  });
  it('rolls back debit when expense insertion fails', async () => {
    await setBalance();
    store.database.expense.create.mockRejectedValueOnce(
      new Error('insert failed'),
    );
    await expect(confirmExpense()).rejects.toThrow();
    expect(await balance()).toBe('3250.00');
    expect(store.expenses.size).toBe(0);
  });
  it('keeps spouse expenses and never debits any account', async () => {
    await setBalance();
    const saved = await expenses.create({ ...expense, payer: 'SPOUSE' });
    expect(saved.payer).toBe('SPOUSE');
    expect(store.expenses.size).toBe(1);
    expect(await balance()).toBe('3250.00');
    expect(store.database.bankAccount.updateMany).not.toHaveBeenCalled();
  });
  it('requires payer and a matching account without conversion or zero-account creation', async () => {
    await setBalance('BRL', '97.00');
    await expect(
      expenses.create({ ...expense, payer: undefined }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(confirmExpense()).rejects.toThrow(/EUR/);
    expect(store.expenses.size).toBe(0);
    expect(await balance('EUR')).toBeUndefined();
    expect(await balance('BRL')).toBe('97.00');
  });
  it('touches only the matching currency', async () => {
    await setBalance('EUR');
    await setBalance('BRL', '100.00');
    await confirmExpense();
    expect(await balance('BRL')).toBe('100.00');
    expect(await balance('EUR')).toBe('3207.90');
  });
  it('duplicate override creates exactly one additional debit', async () => {
    await setBalance();
    await confirmExpense();
    const next = await pending.prepare('expense-conversation', expense, 1);
    await pending.requestConfirmation('expense-conversation', next.revision);
    expect(
      await pending.confirm('expense-conversation', next.revision),
    ).toBeNull();
    expect(await balance()).toBe('3207.90');
    await Promise.all([
      pending.confirm('expense-conversation', next.revision, true),
      pending.confirm('expense-conversation', next.revision, true),
    ]);
    expect(store.expenses.size).toBe(2);
    expect(await balance()).toBe('3165.80');
  });
  it('missing payer stays pending and cannot be armed or confirmed', async () => {
    await pending.prepare(
      'expense-conversation',
      { ...expense, payer: undefined },
      null,
    );
    await expect(
      pending.requestConfirmation('expense-conversation', 1),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(pending.confirm('expense-conversation', 1)).rejects.toThrow();
    expect(store.expenses.size).toBe(0);
  });
  it('balance preparation cancels a competing pending expense', async () => {
    await pending.prepare(conversation, expense, null);
    await bank.prepare(
      conversation,
      { currency: 'EUR', currentBalance: '100.00' },
      null,
    );
    expect(store.pending.get(conversation)?.status).toBe('CANCELLED');
    await expect(pending.confirm(conversation, 1)).rejects.toThrow();
  });
  it('expense preparation cancels a competing pending balance', async () => {
    await bank.prepare(
      conversation,
      { currency: 'EUR', currentBalance: '100.00' },
      null,
    );
    await pending.prepare(conversation, expense, null);
    expect(store.balanceDrafts.get(conversation)?.status).toBe('CANCELLED');
  });
  it.each(['1.001', 'NaN', '1e2', '100000000000000000', '-100000000000000000'])(
    'rejects invalid balance %s',
    async (currentBalance) => {
      await expect(
        bank.prepare(conversation, { currency: 'EUR', currentBalance }, null),
      ).rejects.toBeInstanceOf(BadRequestException);
    },
  );
});

import {
  BadRequestException,
  ConflictException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { ExpensesService } from '../expenses/expenses.service.js';
import { Currency } from '../generated/prisma/enums.js';
import { Prisma } from '../generated/prisma/client.js';
import { PendingExpenseService } from './pending-expense.service.js';
import { pendingAction } from './confirmation.js';
import { pendingDatabase } from '../../test/helpers/pending-database.js';

describe('PendingExpenseService', () => {
  const conversation = '11111111-1111-4111-8111-111111111111';
  const input = {
    amount: '45.00',
    currency: Currency.EUR,
    merchant: 'Tesco',
    transactionDate: '2026-10-09T00:00:00Z',
  };
  let store: ReturnType<typeof pendingDatabase>;
  let service: PendingExpenseService;
  let expenses: ExpensesService;
  beforeEach(() => {
    store = pendingDatabase();
    const prisma = store.database as unknown as PrismaService;
    expenses = new ExpensesService(prisma);
    service = new PendingExpenseService(prisma, expenses);
  });

  it.each([Currency.EUR, Currency.BRL])(
    'persists a validated pending %s amount as Decimal without creating Expense',
    async (currency) => {
      const draft = await service.prepare(
        conversation,
        { ...input, currency },
        null,
      );
      expect(draft.amount).toBeInstanceOf(Prisma.Decimal);
      expect(draft.amount.toString()).toBe('45');
      expect((await service.get(conversation))?.currency).toBe(currency);
      expect(store.database.expense.create).not.toHaveBeenCalled();
      expect(draft.status).toBe('PENDING');
    },
  );

  it.each([
    { ...input, amount: '0' },
    { ...input, amount: '-1' },
    { ...input, amount: '1.001' },
    { ...input, currency: 'USD' as Currency },
    { ...input, transactionDate: '2026-02-30' },
  ])('rejects invalid draft %j', async (invalid) => {
    await expect(
      service.prepare(conversation, invalid, null),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(store.pending.size).toBe(0);
  });

  it('requires a recorded review before confirmation', async () => {
    await service.prepare(conversation, input, null);
    await expect(service.confirm(conversation, 1)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(store.expenses.size).toBe(0);
  });

  it('confirms once atomically and handles sequential/concurrent duplicate confirmations', async () => {
    await service.prepare(conversation, input, null);
    await service.requestConfirmation(conversation, 1);
    const [first, duplicate] = await Promise.all([
      service.confirm(conversation, 1),
      service.confirm(conversation, 1),
    ]);
    expect(first.id).toBe(duplicate.id);
    expect((await service.confirm(conversation, 1)).id).toBe(first.id);
    expect(store.database.expense.create).toHaveBeenCalledOnce();
    expect((await service.get(conversation))?.status).toBe('CONFIRMED');
    expect((await service.get(conversation))?.expenseId).toBe(first.id);
  });

  it('rolls back creation and state on failure, then allows retry', async () => {
    await service.prepare(conversation, input, null);
    await service.requestConfirmation(conversation, 1);
    store.database.pendingExpense.update.mockRejectedValueOnce(
      new Error('private failure after expense insert'),
    );
    await expect(service.confirm(conversation, 1)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(store.expenses.size).toBe(0);
    expect((await service.get(conversation))?.status).toBe('PENDING');
    await service.confirm(conversation, 1);
    expect(store.expenses.size).toBe(1);
  });

  it('does not confirm on expense creation failure', async () => {
    await service.prepare(conversation, input, null);
    await service.requestConfirmation(conversation, 1);
    store.database.expense.create.mockRejectedValueOnce(
      new Error('database unavailable'),
    );
    await expect(service.confirm(conversation, 1)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect((await service.get(conversation))?.status).toBe('PENDING');
  });

  it('edits amount, merchant and date in the same draft and requires review again', async () => {
    const original = await service.prepare(conversation, input, null);
    await service.requestConfirmation(conversation, 1);
    const changed = await service.prepare(
      conversation,
      {
        ...input,
        amount: '52.00',
        merchant: 'Aldi',
        transactionDate: '2026-10-08',
      },
      1,
    );
    expect(changed.id).toBe(original.id);
    expect(changed.revision).toBe(2);
    expect(changed.confirmationRequested).toBe(false);
    await expect(service.confirm(conversation, 1)).rejects.toBeInstanceOf(
      ConflictException,
    );
    await expect(service.confirm(conversation, 2)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(store.expenses.size).toBe(0);
    await service.requestConfirmation(conversation, 2);
    const saved = await service.confirm(conversation, 2);
    expect(saved).toMatchObject({
      amount: '52.0000',
      merchant: 'Aldi',
      transactionDate: new Date('2026-10-08'),
    });
  });

  it('cancels without creation and rejects confirmation of a cancelled draft', async () => {
    await service.prepare(conversation, input, null);
    await service.requestConfirmation(conversation, 1);
    expect(await service.cancel(conversation, 1)).toBe(true);
    expect((await service.get(conversation))?.status).toBe('CANCELLED');
    await expect(service.confirm(conversation, 1)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(store.expenses.size).toBe(0);
  });

  it('cannot confirm another conversation draft', async () => {
    await service.prepare(conversation, input, null);
    await service.requestConfirmation(conversation, 1);
    await expect(
      service.confirm('22222222-2222-4222-8222-222222222222', 1),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(store.expenses.size).toBe(0);
  });

  it.each([
    'maybe',
    'I think so',
    'wait',
    'change it',
    'yes, but change it',
    'do not confirm',
    'I spent 45 EUR, yes',
  ])('does not authorize ambiguous/mixed prose %s', (message) => {
    expect(pendingAction(message)).not.toBe('confirm');
  });
  it.each([
    'yes',
    'Yes.',
    'confirm',
    'save it',
    'go ahead',
    'sim',
    'confirma',
    'pode salvar',
  ])('recognizes full explicit phrase %s', (message) => {
    expect(pendingAction(message)).toBe('confirm');
  });
});

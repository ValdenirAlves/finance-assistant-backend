import { randomUUID } from 'node:crypto';
import { bankState } from './bank-state.js';
import { ExpenseCategory } from '../../src/generated/prisma/enums.js';
import type {
  Expense,
  PendingExpense,
} from '../../src/generated/prisma/client.js';
import type { ExpensesService } from '../../src/expenses/expenses.service.js';

type Draft = ReturnType<ExpensesService['validateCreate']>;
type Where = { conversationId: string; revision?: number; status?: string };

// Stateful transaction mock: tests run real domain services, with serialized
// transactions and rollback of draft/expense rows when an operation throws.
export function pendingDatabase() {
  const bank = bankState();
  const mappings = new Map<string, ExpenseCategory>([
    ['tesco', ExpenseCategory.GROCERIES],
    ['lidl', ExpenseCategory.GROCERIES],
    ['aldi', ExpenseCategory.GROCERIES],
    ['pet stop', ExpenseCategory.PETS],
    ['maxi zoo', ExpenseCategory.PETS],
    ['netflix', ExpenseCategory.SUBSCRIPTIONS],
  ]);
  const pending = new Map<string, PendingExpense>();
  const expenses = new Map<string, Expense>();
  let queue = Promise.resolve();
  const matches = (row: PendingExpense | undefined, where: Where) =>
    row &&
    (!(where as any).payer || row.payer != null) &&
    (where.revision === undefined || row.revision === where.revision) &&
    (where.status === undefined || row.status === where.status);
  const database = {
    bankAccount: bank.bankAccount,
    pendingBankBalance: bank.pendingBankBalance,
    merchantCategoryMapping: {
      findUnique: vi.fn(
        async ({ where }: { where: { normalizedMerchant: string } }) =>
          mappings.has(where.normalizedMerchant)
            ? { category: mappings.get(where.normalizedMerchant)! }
            : null,
      ),
      createMany: vi.fn(
        async ({
          data,
        }: {
          data: Array<{
            normalizedMerchant: string;
            category: ExpenseCategory;
          }>;
        }) => {
          for (const row of data)
            if (!mappings.has(row.normalizedMerchant))
              mappings.set(row.normalizedMerchant, row.category);
          return { count: data.length };
        },
      ),
    },
    pendingBudget: {
      findUnique: vi.fn().mockResolvedValue(null),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    conversation: {
      create: vi.fn(async () => ({ id: randomUUID() })),
      update: vi.fn().mockResolvedValue({}),
    },
    pendingExpense: {
      findUnique: vi.fn(
        async ({ where }: { where: Where }) =>
          pending.get(where.conversationId) ?? null,
      ),
      upsert: vi.fn(
        async ({
          where,
          create,
          update,
        }: {
          where: Where;
          create: Draft & { conversationId: string };
          update: Draft & { revision: { increment: number } };
        }) => {
          const current = pending.get(where.conversationId);
          const row = current
            ? {
                ...current,
                ...update,
                revision: current.revision + update.revision.increment,
              }
            : {
                id: randomUUID(),
                ...create,
                status: 'PENDING',
                revision: 1,
                confirmationRequested: false,
                duplicateReviewRequired: false,
                expenseId: null,
                createdAt: new Date(),
                updatedAt: new Date(),
              };
          pending.set(where.conversationId, row as PendingExpense);
          return row;
        },
      ),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: Where;
          data: Partial<PendingExpense>;
        }) => {
          const row = pending.get(where.conversationId);
          if (!matches(row, where)) return { count: 0 };
          pending.set(where.conversationId, { ...row!, ...data });
          return { count: 1 };
        },
      ),
      update: vi.fn(
        async ({
          where,
          data,
        }: {
          where: Where;
          data: Omit<Partial<PendingExpense>, 'revision'> & {
            revision?: number | { increment: number };
          };
        }) => {
          const row = pending.get(where.conversationId);
          if (!row) throw new Error('row missing');
          const result = {
            ...row,
            ...data,
            revision:
              typeof data.revision === 'object'
                ? row.revision + data.revision.increment
                : (data.revision ?? row.revision),
          };
          pending.set(where.conversationId, result);
          return result;
        },
      ),
    },
    expense: {
      findFirst: vi.fn(
        async ({
          where,
        }: {
          where: {
            amount: Draft['amount'];
            currency: string;
            merchant: null | { equals: string };
            transactionDate: { gte: Date; lt: Date };
          };
        }) => {
          return (
            [...expenses.values()].find(
              (row) =>
                row.amount.eq(where.amount) &&
                row.currency === where.currency &&
                (where.merchant === null
                  ? row.merchant === null
                  : row.merchant?.toLowerCase() ===
                    where.merchant.equals
                      .replace(/\\([\\%_])/g, '$1')
                      .toLowerCase()) &&
                row.transactionDate >= where.transactionDate.gte &&
                row.transactionDate < where.transactionDate.lt,
            ) ?? null
          );
        },
      ),
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn(async ({ data }: { data: Draft }) => {
        const result = {
          ...data,
          id: randomUUID(),
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        expenses.set(result.id, result);
        return result;
      }),
      findUnique: vi.fn(
        async ({ where }: { where: { id: string } }) =>
          expenses.get(where.id) ?? null,
      ),
      findUniqueOrThrow: vi.fn(async ({ where }: { where: { id: string } }) => {
        const result = expenses.get(where.id);
        if (!result) throw new Error('expense missing');
        return result;
      }),
    },
    $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => {
      const previous = queue;
      let release!: () => void;
      queue = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      const originalPending = new Map(pending);
      const originalExpenses = new Map(expenses);
      const originalMappings = new Map(mappings);
      const originalAccounts = new Map(bank.accounts);
      const originalBalances = new Map(bank.balanceDrafts);
      try {
        return await callback(database);
      } catch (error) {
        pending.clear();
        originalPending.forEach((row, id) => pending.set(id, row));
        expenses.clear();
        originalExpenses.forEach((row, id) => expenses.set(id, row));
        mappings.clear();
        originalMappings.forEach((value, key) => mappings.set(key, value));
        bank.accounts.clear();
        originalAccounts.forEach((row, id) => bank.accounts.set(id, row));
        bank.balanceDrafts.clear();
        originalBalances.forEach((row, id) => bank.balanceDrafts.set(id, row));
        throw error;
      } finally {
        release();
      }
    }),
  };
  return {
    database,
    pending,
    expenses,
    mappings,
    accounts: bank.accounts,
    balanceDrafts: bank.balanceDrafts,
  };
}

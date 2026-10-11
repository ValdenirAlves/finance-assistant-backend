import { randomUUID } from 'node:crypto';
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
  const pending = new Map<string, PendingExpense>();
  const expenses = new Map<string, Expense>();
  let queue = Promise.resolve();
  const matches = (row: PendingExpense | undefined, where: Where) =>
    row &&
    (where.revision === undefined || row.revision === where.revision) &&
    (where.status === undefined || row.status === where.status);
  const database = {
    conversation: { update: vi.fn().mockResolvedValue({}) },
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
          data: Partial<PendingExpense>;
        }) => {
          const row = pending.get(where.conversationId);
          if (!row) throw new Error('row missing');
          const result = { ...row, ...data };
          pending.set(where.conversationId, result);
          return result;
        },
      ),
    },
    expense: {
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
      try {
        return await callback(database);
      } catch (error) {
        pending.clear();
        originalPending.forEach((row, id) => pending.set(id, row));
        expenses.clear();
        originalExpenses.forEach((row, id) => expenses.set(id, row));
        throw error;
      } finally {
        release();
      }
    }),
  };
  return { database, pending, expenses };
}

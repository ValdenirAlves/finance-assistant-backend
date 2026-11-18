import { randomUUID } from 'node:crypto';
import { Prisma } from '../../src/generated/prisma/client.js';
export function budgetDatabase() {
  const budgets = new Map<string, any>();
  const drafts = new Map<string, any>();
  let queue = Promise.resolve();
  const database: any = {
    pendingBankBalance: {
      findUnique: vi.fn().mockResolvedValue(null),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    conversation: { update: vi.fn().mockResolvedValue({}) },
    pendingExpense: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    budget: {
      create: vi.fn(async ({ data }: any) => {
        if (
          [...budgets.values()].some(
            (row) =>
              row.year === data.year &&
              row.month === data.month &&
              row.currency === data.currency &&
              row.scopeKey === data.scopeKey,
          )
        )
          throw new Prisma.PrismaClientKnownRequestError('duplicate', {
            code: 'P2002',
            clientVersion: 'test',
          });
        const row = {
          id: randomUUID(),
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data,
        };
        budgets.set(row.id, row);
        return row;
      }),
      findMany: vi.fn(async () => [...budgets.values()]),
      findUnique: vi.fn(async ({ where }: any) =>
        where.id
          ? (budgets.get(where.id) ?? null)
          : ([...budgets.values()].find((row) =>
              Object.entries(where.year_month_currency_scopeKey).every(
                ([key, value]) => row[key] === value,
              ),
            ) ?? null),
      ),
      findUniqueOrThrow: vi.fn(async ({ where }: any) => {
        const row = budgets.get(where.id);
        if (!row) throw new Error('missing');
        return row;
      }),
    },
    pendingBudget: {
      findUnique: vi.fn(
        async ({ where }: any) => drafts.get(where.conversationId) ?? null,
      ),
      upsert: vi.fn(async ({ where, create, update }: any) => {
        const prev = drafts.get(where.conversationId);
        const row = prev
          ? { ...prev, ...update, revision: prev.revision + 1 }
          : {
              id: randomUUID(),
              status: 'PENDING',
              revision: 1,
              confirmationRequested: false,
              budgetId: null,
              ...create,
            };
        drafts.set(where.conversationId, row);
        return row;
      }),
      updateMany: vi.fn(async ({ where, data }: any) => {
        const row = drafts.get(where.conversationId);
        if (
          !row ||
          Object.entries(where).some(([key, value]) => row[key] !== value)
        )
          return { count: 0 };
        drafts.set(where.conversationId, { ...row, ...data });
        return { count: 1 };
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const row = { ...drafts.get(where.conversationId), ...data };
        drafts.set(where.conversationId, row);
        return row;
      }),
    },
    $transaction: vi.fn(async (callback: any) => {
      const previous = queue;
      let release!: () => void;
      queue = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      const saved = new Map(budgets),
        pending = new Map(drafts);
      try {
        return await callback(database);
      } catch (error) {
        budgets.clear();
        saved.forEach((row, id) => budgets.set(id, row));
        drafts.clear();
        pending.forEach((row, id) => drafts.set(id, row));
        throw error;
      } finally {
        release();
      }
    }),
  };
  return { database, budgets, drafts };
}

import { randomUUID } from 'node:crypto';
import { Prisma } from '../../src/generated/prisma/client.js';
import type {
  BankAccount,
  PendingBankBalance,
} from '../../src/generated/prisma/client.js';

// Stateful Prisma test double. Transactions in pendingDatabase snapshot these
// maps together with expenses, so failed writes roll back both domains.
export function bankState() {
  const accounts = new Map<string, BankAccount>();
  const balanceDrafts = new Map<string, PendingBankBalance>();
  const bankAccount = {
    findMany: vi.fn(async ({ where }: any = {}) =>
      [...accounts.values()].filter(
        (row) =>
          (!where?.currency || row.currency === where.currency) &&
          (!where?.name ||
            row.name.toLowerCase() === where.name.equals.toLowerCase()),
      ),
    ),
    findUnique: vi.fn(async ({ where }: any) =>
      where.id
        ? (accounts.get(where.id) ?? null)
        : ([...accounts.values()].find(
            (row) =>
              row.currency === where.owner_currency.currency &&
              row.owner === where.owner_currency.owner,
          ) ?? null),
    ),
    upsert: vi.fn(async ({ where, create, update }: any) => {
      const existing = [...accounts.values()].find(
        (row) => row.currency === where.owner_currency.currency,
      );
      const row = existing
        ? { ...existing, ...update, updatedAt: new Date() }
        : {
            id: randomUUID(),
            createdAt: new Date(),
            updatedAt: new Date(),
            ...create,
          };
      accounts.set(row.id, row);
      return row;
    }),
    updateMany: vi.fn(async ({ where, data }: any) => {
      const row = [...accounts.values()].find(
        (row) => row.currency === where.currency && row.owner === where.owner,
      );
      if (!row) return { count: 0 };
      accounts.set(row.id, {
        ...row,
        currentBalance: new Prisma.Decimal(row.currentBalance).minus(
          data.currentBalance.decrement,
        ),
        updatedAt: new Date(),
      });
      return { count: 1 };
    }),
  };
  const pendingBankBalance = {
    findUnique: vi.fn(
      async ({ where }: any) => balanceDrafts.get(where.conversationId) ?? null,
    ),
    upsert: vi.fn(async ({ where, create, update }: any) => {
      const prev = balanceDrafts.get(where.conversationId);
      const row = prev
        ? {
            ...prev,
            ...update,
            revision: prev.revision + 1,
            updatedAt: new Date(),
          }
        : {
            id: randomUUID(),
            status: 'PENDING',
            revision: 1,
            confirmationRequested: false,
            accountId: null,
            createdAt: new Date(),
            updatedAt: new Date(),
            ...create,
          };
      balanceDrafts.set(where.conversationId, row);
      return row;
    }),
    updateMany: vi.fn(async ({ where, data }: any) => {
      const row = balanceDrafts.get(where.conversationId);
      if (
        !row ||
        (where.status && row.status !== where.status) ||
        (where.revision && row.revision !== where.revision)
      )
        return { count: 0 };
      balanceDrafts.set(where.conversationId, {
        ...row,
        ...data,
        updatedAt: new Date(),
      });
      return { count: 1 };
    }),
    update: vi.fn(async ({ where, data }: any) => {
      const row = balanceDrafts.get(where.conversationId);
      if (!row) throw new Error('missing draft');
      const result = { ...row, ...data, updatedAt: new Date() };
      balanceDrafts.set(where.conversationId, result);
      return result;
    }),
  };
  return { accounts, balanceDrafts, bankAccount, pendingBankBalance };
}

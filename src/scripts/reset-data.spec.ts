import type { PrismaClient } from '../generated/prisma/client.js';
import {
  assertDevelopmentEnvironment,
  resetDevelopmentData,
} from './reset-data.js';

describe('development data reset', () => {
  const order = [
    'pendingExpense',
    'pendingBudget',
    'pendingBankBalance',
    'conversationMessage',
    'conversation',
    'expense',
    'budget',
    'bankAccount',
    'legacyBudgetCategory',
    'merchantCategoryMapping',
  ];

  function fixture() {
    const deleted: string[] = [];
    const tx = Object.fromEntries(
      order.map((table) => [
        table,
        {
          deleteMany: vi.fn().mockImplementation(() => {
            deleted.push(table);
            return Promise.resolve({ count: 2 });
          }),
        },
      ]),
    );
    const transaction = vi.fn(
      async (callback: (transaction: typeof tx) => Promise<unknown>) =>
        callback(tx),
    );
    const prisma = { $transaction: transaction } as unknown as PrismaClient;
    return { tx, transaction, prisma, deleted, log: vi.fn() };
  }

  it.each(['production', 'staging', 'test', 'Production'])(
    'rejects NODE_ENV=%s before database access',
    async (env) => {
      const { prisma, transaction, log } = fixture();
      await expect(resetDevelopmentData(prisma, env, log)).rejects.toThrow(
        'development-only',
      );
      expect(transaction).not.toHaveBeenCalled();
      expect(log).not.toHaveBeenCalled();
    },
  );

  it('allows development and an unset NODE_ENV', () => {
    expect(() => assertDevelopmentEnvironment('development')).not.toThrow();
    expect(() => assertDevelopmentEnvironment(undefined)).not.toThrow();
  });

  it('clears all runtime models in dependency order within one transaction', async () => {
    const { prisma, transaction, deleted, log } = fixture();
    const results = await resetDevelopmentData(prisma, 'development', log);
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(deleted).toEqual(order);
    expect(results).toHaveLength(10);
    expect(results.every(({ count }) => count === 2)).toBe(true);
    expect(log).toHaveBeenLastCalledWith(
      'Development data reset committed successfully.',
    );
  });

  it('preserves the six migration-seeded merchant mappings', async () => {
    const { prisma, tx, log } = fixture();
    await resetDevelopmentData(prisma, 'development', log);
    expect(tx.merchantCategoryMapping.deleteMany).toHaveBeenCalledWith({
      where: {
        id: {
          notIn: [
            '00000000-0000-4000-8000-000000000001',
            '00000000-0000-4000-8000-000000000002',
            '00000000-0000-4000-8000-000000000003',
            '00000000-0000-4000-8000-000000000004',
            '00000000-0000-4000-8000-000000000005',
            '00000000-0000-4000-8000-000000000006',
          ],
        },
      },
    });
  });

  it('propagates deletion failures so the transaction rolls back and no success is reported', async () => {
    const { prisma, tx, deleted, log } = fixture();
    tx.expense.deleteMany.mockRejectedValueOnce(new Error('database failure'));
    await expect(
      resetDevelopmentData(prisma, 'development', log),
    ).rejects.toThrow('database failure');
    expect(deleted).not.toContain('budget');
    expect(log).not.toHaveBeenCalledWith(
      'Development data reset committed successfully.',
    );
  });
});

import { ExpensesService } from './expenses.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { Currency } from '../generated/prisma/enums.js';
import { pendingDatabase } from '../../test/helpers/pending-database.js';
describe('possible expense duplicates', () => {
  const input = {
    payer: 'SPOUSE' as const,
    amount: '50.00',
    currency: Currency.EUR,
    merchant: 'Tesco',
    transactionDate: '2026-10-11T23:59:59Z',
  };
  it.each([
    [{}, true],
    [{ amount: '51.00' }, false],
    [{ currency: Currency.BRL }, false],
    [{ merchant: 'Aldi' }, false],
    [{ merchant: 'tesco' }, true],
    [{ transactionDate: '2026-10-12T00:00:00Z' }, false],
    [{ description: 'different description' }, true],
  ])('matches all business fields %j', async (change, expected) => {
    const store = pendingDatabase();
    const service = new ExpensesService(
      store.database as unknown as PrismaService,
    );
    await service.create({ ...input, transactionDate: '2026-10-11T00:00:00Z' });
    expect(
      Boolean(await service.findPotentialDuplicate({ ...input, ...change })),
    ).toBe(expected);
  });
});

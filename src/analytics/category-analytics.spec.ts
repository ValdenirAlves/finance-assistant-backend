import { AnalyticsService } from './analytics.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';
import { ExpenseCategory } from '../generated/prisma/enums.js';
describe('category analytics', () => {
  const findMany = vi.fn();
  const service = new AnalyticsService({
    expense: { findMany },
  } as unknown as PrismaService);
  const rows = [
    {
      category: 'GROCERIES',
      currency: 'EUR',
      amount: new Prisma.Decimal('100.10'),
    },
    {
      category: 'GROCERIES',
      currency: 'EUR',
      amount: new Prisma.Decimal('100.20'),
    },
    {
      category: 'GROCERIES',
      currency: 'EUR',
      amount: new Prisma.Decimal('52.40'),
    },
    {
      category: 'GROCERIES',
      currency: 'BRL',
      amount: new Prisma.Decimal('97.00'),
    },
  ];
  afterEach(() => vi.useRealTimers());
  it('consolidates category expenses across merchants with separate currencies', async () => {
    findMany.mockResolvedValue(rows);
    const result = await service.byCategory({
      from: '2026-10-01',
      to: '2026-10-31',
    });
    expect(result).toEqual([
      { category: 'GROCERIES', currency: 'BRL', total: '97.00' },
      { category: 'GROCERIES', currency: 'EUR', total: '252.70' },
    ]);
  });
  it('uses category in pace without merchant matching or cross-currency arithmetic', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-13Z'));
    findMany.mockResolvedValue(rows.slice(0, 3));
    const result = await service.spendingPace({
      year: '2026',
      month: '10',
      category: ExpenseCategory.GROCERIES,
    });
    expect(findMany.mock.calls.at(-1)![0].where.category).toBe('GROCERIES');
    expect(result.results[0].weeklyAverage).toBe('136.07');
    expect(result.results[0].projectedMonthTotal).toBe('602.59');
  });
});

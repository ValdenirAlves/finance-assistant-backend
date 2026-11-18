import { AnalyticsService } from './analytics.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';
import { Currency } from '../generated/prisma/enums.js';
describe('deterministic spending pace', () => {
  const findMany = vi.fn();
  const service = new AnalyticsService({
    expense: { findMany },
  } as unknown as PrismaService);
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-13T23:59:59Z'));
    findMany.mockReset();
    findMany.mockResolvedValue([]);
  });
  afterEach(() => vi.useRealTimers());
  it('uses 13 calendar days and unrounded Decimal averages', async () => {
    findMany.mockResolvedValue([
      { amount: new Prisma.Decimal('252.70'), currency: Currency.EUR },
      { amount: new Prisma.Decimal('13.00'), currency: Currency.BRL },
    ]);
    const result = await service.spendingPace({ year: '2026', month: '10' });
    expect(result.period).toMatchObject({
      effectiveDate: '2026-10-13',
      daysElapsed: 13,
      daysInMonth: 31,
      status: 'current',
    });
    expect(result.results).toEqual([
      {
        currency: 'EUR',
        spentToDate: '252.70',
        dailyAverage: '19.44',
        weeklyAverage: '136.07',
        projectedMonthTotal: '602.59',
      },
      {
        currency: 'BRL',
        spentToDate: '13.00',
        dailyAverage: '1.00',
        weeklyAverage: '7.00',
        projectedMonthTotal: '31.00',
      },
    ]);
    expect(findMany.mock.calls[0][0].where.transactionDate).toEqual({
      gte: new Date('2026-10-01Z'),
      lt: new Date('2026-10-14Z'),
    });
  });
  it('reuses literal case-insensitive partial merchant and currency filters', async () => {
    const result = await service.spendingPace({
      year: '2026',
      month: '10',
      currency: Currency.EUR,
      merchant: 'Tes%_co',
    });
    expect(findMany.mock.calls[0][0].where).toMatchObject({
      currency: 'EUR',
      merchant: { contains: 'Tes\\%\\_co', mode: 'insensitive' },
    });
    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({
      spentToDate: '0.00',
      weeklyAverage: '0.00',
      projectedMonthTotal: '0.00',
    });
  });
  it.each([
    ['2025', '2', 28],
    ['2024', '2', 29],
    ['2026', '9', 30],
    ['2026', '8', 31],
  ])('uses completed calendar month %s-%s', async (year, month, days) => {
    findMany.mockResolvedValue([
      { amount: new Prisma.Decimal('100.01'), currency: Currency.EUR },
    ]);
    const result = await service.spendingPace({ year, month });
    expect(result.period.daysElapsed).toBe(days);
    expect(result.period.daysInMonth).toBe(days);
    expect(result.results[0].projectedMonthTotal).toBe('100.01');
  });
  it('returns unavailable averages/projection for future months without querying', async () => {
    const result = await service.spendingPace({ year: '2026', month: '11' });
    expect(result.period).toMatchObject({
      effectiveDate: null,
      daysElapsed: 0,
      status: 'future',
    });
    expect(result.results[0]).toMatchObject({
      spentToDate: '0.00',
      dailyAverage: null,
      weeklyAverage: null,
      projectedMonthTotal: null,
    });
    expect(findMany).not.toHaveBeenCalled();
  });
  it('preserves large Decimal precision', async () => {
    findMany.mockResolvedValue([
      {
        amount: new Prisma.Decimal('999999999999999.99'),
        currency: Currency.EUR,
      },
    ]);
    const result = await service.spendingPace({ year: '2026', month: '10' });
    expect(result.results[0].projectedMonthTotal).toBe(
      new Prisma.Decimal('999999999999999.99').div(13).mul(31).toFixed(2),
    );
  });
  it.each([
    { year: '0000', month: '10' },
    { year: '2026', month: '13' },
    { year: '2026', month: '10', currency: 'USD' },
  ])('validates inputs %j', async (input) => {
    await expect(service.spendingPace(input as never)).rejects.toThrow();
  });
});

import { BadRequestException } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import { Currency } from '../generated/prisma/enums.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AnalyticsService } from './analytics.service.js';

describe('AnalyticsService', () => {
  let findMany: ReturnType<typeof vi.fn>;
  let service: AnalyticsService;
  const row = (
    amount: string,
    currency: Currency,
    merchant: string | null = 'Tesco',
  ) => ({ amount: new Prisma.Decimal(amount), currency, merchant });
  const range = { from: '2026-10-01', to: '2026-10-31' };

  beforeEach(() => {
    findMany = vi.fn().mockResolvedValue([]);
    service = new AnalyticsService({
      expense: { findMany },
    } as unknown as PrismaService);
  });

  it('applies category exclusions in the database before Decimal aggregation', async () => {
    findMany.mockResolvedValue([
      { ...row('0.10', Currency.EUR), category: 'OTHER' },
      { ...row('0.20', Currency.EUR), category: 'OTHER' },
      { ...row('4.56', Currency.EUR), category: 'TRANSPORT' },
      { ...row('9.87', Currency.BRL), category: 'OTHER' },
    ]);
    expect(
      await service.byCategory({
        ...range,
        excludeCategories: ['GROCERIES', 'PETS'],
      }),
    ).toEqual([
      { category: 'OTHER', currency: 'BRL', total: '9.87' },
      { category: 'OTHER', currency: 'EUR', total: '0.30' },
      { category: 'TRANSPORT', currency: 'EUR', total: '4.56' },
    ]);
    expect(findMany.mock.calls[0][0].where.category).toEqual({
      notIn: ['GROCERIES', 'PETS'],
    });
  });
  it('applies inclusion and exclusion together without overriding either', async () => {
    await service.byCategory({
      ...range,
      category: 'OTHER',
      excludeCategories: ['OTHER'],
    });
    expect(findMany.mock.calls[0][0].where.category).toEqual({
      equals: 'OTHER',
      notIn: ['OTHER'],
    });
  });
  it.each([['INVALID'], ['PETS', 'PETS'], 'PETS'])(
    'rejects invalid excluded categories %j before querying',
    async (excludeCategories) => {
      await expect(
        service.byCategory({ ...range, excludeCategories } as never),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(findMany).not.toHaveBeenCalled();
    },
  );

  it('sums EUR and BRL independently with exact Decimal addition', async () => {
    findMany.mockResolvedValue([
      row('0.10', Currency.EUR),
      row('0.20', Currency.EUR),
      row('1200.01', Currency.BRL),
      row('1530.49', Currency.BRL),
    ]);
    expect(await service.monthlySummary({ year: '2026', month: '10' })).toEqual(
      {
        period: { year: 2026, month: 10 },
        totals: { EUR: '0.30', BRL: '2730.50' },
      },
    );
    expect(findMany).toHaveBeenCalledWith({
      where: {
        transactionDate: {
          gte: new Date('2026-10-01T00:00:00Z'),
          lt: new Date('2026-11-01T00:00:00Z'),
        },
      },
      select: { amount: true, currency: true },
    });
  });

  it('returns zero strings for an empty month', async () => {
    expect(
      (await service.monthlySummary({ year: '2026', month: '10' })).totals,
    ).toEqual({ EUR: '0.00', BRL: '0.00' });
  });

  it('keeps an absent currency at zero', async () => {
    findMany.mockResolvedValue([row('1840.30', Currency.EUR)]);
    expect(
      (await service.monthlySummary({ year: '2026', month: '10' })).totals,
    ).toEqual({ EUR: '1840.30', BRL: '0.00' });
  });

  it.each([
    ['2024', '02', '2024-02-01T00:00:00Z', '2024-03-01T00:00:00Z'],
    ['2026', '12', '2026-12-01T00:00:00Z', '2027-01-01T00:00:00Z'],
    ['0001', '01', '0001-01-01T00:00:00Z', '0001-02-01T00:00:00Z'],
  ])('uses UTC month bounds for %s-%s', async (year, month, start, end) => {
    await service.monthlySummary({ year, month });
    expect(findMany.mock.calls[0][0].where.transactionDate).toEqual({
      gte: new Date(start),
      lt: new Date(end),
    });
  });

  it.each([
    { year: '2026', month: '0' },
    { year: '2026', month: '13' },
    { year: '2026', month: '1.5' },
    { year: '0000', month: '10' },
    { year: 'bad', month: '10' },
    { year: '10000', month: '10' },
  ])('rejects invalid period %j before querying', async (period) => {
    await expect(service.monthlySummary(period)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(findMany).not.toHaveBeenCalled();
  });

  it('groups exact merchant names and currencies independently with deterministic ordering', async () => {
    findMany.mockResolvedValue([
      row('0.10', Currency.EUR),
      row('0.20', Currency.EUR),
      row('2.01', Currency.BRL),
      row('3.02', Currency.BRL),
      row('1.00', Currency.EUR, null),
      row('9.00', Currency.EUR, 'Aldi'),
      row('4.00', Currency.EUR, 'tesco'),
    ]);
    expect(await service.byMerchant(range)).toEqual([
      { merchant: 'Tesco', currency: 'BRL', total: '5.03' },
      { merchant: null, currency: 'EUR', total: '1.00' },
      { merchant: 'Aldi', currency: 'EUR', total: '9.00' },
      { merchant: 'Tesco', currency: 'EUR', total: '0.30' },
      { merchant: 'tesco', currency: 'EUR', total: '4.00' },
    ]);
    expect(findMany).toHaveBeenCalledWith({
      where: {
        transactionDate: {
          gte: new Date('2026-10-01T00:00:00Z'),
          lte: new Date('2026-10-31T23:59:59.999Z'),
        },
      },
      select: { amount: true, currency: true, merchant: true },
    });
  });

  it('retains decimal precision for large sums and rounds only the final total', async () => {
    findMany.mockResolvedValue([
      row('999999999999999.9999', Currency.EUR),
      row('0.0001', Currency.EUR),
    ]);
    expect((await service.byMerchant(range))[0].total).toBe(
      '1000000000000000.00',
    );
  });

  it('returns an empty merchant list for an empty range', async () => {
    expect(await service.byMerchant(range)).toEqual([]);
  });

  it('uses exact inclusive timestamp bounds including timezone offsets', async () => {
    await service.byMerchant({
      from: '2026-10-01T12:00:00+01:00',
      to: '2026-10-01T11:00:00Z',
    });
    expect(findMany.mock.calls[0][0].where.transactionDate).toEqual({
      gte: new Date('2026-10-01T11:00:00Z'),
      lte: new Date('2026-10-01T11:00:00Z'),
    });
  });

  it.each([
    { from: 'bad', to: range.to },
    { from: range.from, to: 'bad' },
    { from: '2026-02-30', to: range.to },
    { from: range.from, to: '2026-02-30' },
    { from: '2026-11-01', to: range.to },
    { from: '', to: range.to },
  ])('rejects invalid merchant range %j before querying', async (input) => {
    await expect(service.byMerchant(input)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(findMany).not.toHaveBeenCalled();
  });
});

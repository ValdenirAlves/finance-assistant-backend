import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import { Currency } from '../generated/prisma/enums.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ExpensesService } from './expenses.service.js';

describe('ExpensesService', () => {
  const record = {
    id: '11111111-1111-4111-8111-111111111111',
    amount: new Prisma.Decimal('12.50'),
    currency: Currency.EUR,
    description: null,
    merchant: null,
    transactionDate: new Date('2026-10-07T12:00:00Z'),
    createdAt: new Date('2026-10-07T12:00:00Z'),
    updatedAt: new Date('2026-10-07T12:00:00Z'),
  };
  let prisma: {
    expense: {
      create: ReturnType<typeof vi.fn>;
      findMany: ReturnType<typeof vi.fn>;
      findUnique: ReturnType<typeof vi.fn>;
    };
  };
  let service: ExpensesService;
  const input = {
    amount: '12.50',
    currency: Currency.EUR,
    transactionDate: '2026-10-07T12:00:00Z',
  };

  beforeEach(() => {
    prisma = {
      expense: {
        create: vi.fn().mockResolvedValue(record),
        findMany: vi.fn(),
        findUnique: vi.fn(),
      },
    };
    service = new ExpensesService(prisma as unknown as PrismaService);
  });

  it.each([Currency.EUR, Currency.BRL])(
    'creates an expense preserving %s and exact amount',
    async (currency) => {
      prisma.expense.create.mockResolvedValue({ ...record, currency });
      const result = await service.create({ ...input, currency });
      const data = prisma.expense.create.mock.calls[0][0].data;
      expect(data.amount).toBeInstanceOf(Prisma.Decimal);
      expect(data.amount.toString()).toBe('12.5');
      expect(data).toMatchObject({
        currency,
        description: null,
        merchant: null,
        transactionDate: record.transactionDate,
      });
      expect(result).toEqual({ ...record, currency, amount: '12.5000' });
    },
  );

  it('stores optional text', async () => {
    await service.create({ ...input, description: 'Lunch', merchant: 'Cafe' });
    expect(prisma.expense.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ description: 'Lunch', merchant: 'Cafe' }),
    });
  });

  it('rejects unsupported currency before persistence', async () => {
    await expect(
      service.create({ ...input, currency: 'USD' as Currency }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.expense.create).not.toHaveBeenCalled();
  });

  it.each(['12', '12.5', '12.50', '0.01', '999999999999999.99'])(
    'accepts amount %s with at most two fractional digits',
    async (amount) => {
      prisma.expense.create.mockResolvedValue({
        ...record,
        amount: new Prisma.Decimal(amount),
      });
      const result = await service.create({ ...input, amount });
      expect(
        prisma.expense.create.mock.calls[0][0].data.amount.toString(),
      ).toBe(new Prisma.Decimal(amount).toString());
      expect(result.amount).toBe(new Prisma.Decimal(amount).toFixed(4));
    },
  );

  it.each([
    '0',
    '0.00',
    '-1',
    '1.001',
    '1.0000',
    '1.00001',
    '1000000000000000',
    'NaN',
    '1e2',
  ])('rejects invalid amount %s', async (amount) => {
    await expect(service.create({ ...input, amount })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(prisma.expense.create).not.toHaveBeenCalled();
  });

  it('rejects an impossible calendar date', async () => {
    await expect(
      service.create({ ...input, transactionDate: '2026-02-30' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.expense.create).not.toHaveBeenCalled();
  });

  it('findAll returns individual expenses ordered by transactionDate descending', async () => {
    const brl = {
      ...record,
      id: '22222222-2222-4222-8222-222222222222',
      currency: Currency.BRL,
    };
    prisma.expense.findMany.mockResolvedValue([record, brl]);
    expect(await service.findAll()).toEqual([
      { ...record, amount: '12.5000' },
      { ...brl, amount: '12.5000' },
    ]);
    expect(prisma.expense.findMany).toHaveBeenCalledWith({
      orderBy: { transactionDate: 'desc' },
    });
  });

  it('findById returns an expense', async () => {
    prisma.expense.findUnique.mockResolvedValue(record);
    expect(await service.findById(record.id)).toEqual({
      ...record,
      amount: '12.5000',
    });
    expect(prisma.expense.findUnique).toHaveBeenCalledWith({
      where: { id: record.id },
    });
  });

  it('findById throws when the expense does not exist', async () => {
    prisma.expense.findUnique.mockResolvedValue(null);
    await expect(service.findById(record.id)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

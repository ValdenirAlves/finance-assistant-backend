import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { Prisma } from '../src/generated/prisma/client.js';
import { Currency } from '../src/generated/prisma/enums.js';

describe('Expenses endpoints (e2e, mocked persistence)', () => {
  let app: INestApplication;
  const id = '11111111-1111-4111-8111-111111111111';
  const date = new Date('2026-10-07T12:00:00Z');
  const record = {
    id,
    amount: new Prisma.Decimal('12.50'),
    currency: Currency.EUR,
    description: null,
    merchant: null,
    transactionDate: date,
    createdAt: date,
    updatedAt: date,
  };
  const input = {
    payer: 'SPOUSE',
    amount: '12.50',
    currency: 'EUR',
    transactionDate: date.toISOString(),
  };
  let expense: {
    create: ReturnType<typeof vi.fn>;
    findMany: ReturnType<typeof vi.fn>;
    findUnique: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    expense = {
      create: vi.fn().mockResolvedValue(record),
      findMany: vi.fn().mockResolvedValue([record]),
      findUnique: vi.fn().mockResolvedValue(record),
    };
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue({ expense })
      .compile();
    app = module.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app?.close();
  });

  it.each(['EUR', 'BRL'])(
    'POST /expenses creates in %s with a string amount',
    async (currency) => {
      expense.create.mockResolvedValue({ ...record, currency });
      const response = await request(app.getHttpServer())
        .post('/expenses')
        .send({ ...input, currency })
        .expect(201);
      expect(response.body).toEqual({
        ...record,
        currency,
        amount: '12.50',
        transactionDate: date.toISOString(),
        createdAt: date.toISOString(),
        updatedAt: date.toISOString(),
      });
      expect(expense.create.mock.calls[0][0].data.currency).toBe(currency);
    },
  );

  it.each(['12', '12.5', '12.50', '0.01', '999999999999999.99'])(
    'POST /expenses accepts amount %s with at most two fractional digits',
    async (amount) => {
      expense.create.mockResolvedValue({
        ...record,
        amount: new Prisma.Decimal(amount),
      });
      const response = await request(app.getHttpServer())
        .post('/expenses')
        .send({ ...input, amount })
        .expect(201);
      expect(response.body.amount).toBe(new Prisma.Decimal(amount).toFixed(2));
      expect(expense.create.mock.calls[0][0].data.amount.toString()).toBe(
        new Prisma.Decimal(amount).toString(),
      );
    },
  );

  it('GET /expenses returns expenses without aggregation', async () => {
    expense.findMany.mockResolvedValue([
      record,
      { ...record, currency: Currency.BRL },
    ]);
    const response = await request(app.getHttpServer())
      .get('/expenses')
      .expect(200);
    expect(
      response.body.map((item: { currency: string }) => item.currency),
    ).toEqual(['EUR', 'BRL']);
    expect(response.body[0].amount).toBe('12.50');
    expect(expense.findMany).toHaveBeenCalledWith({
      orderBy: { transactionDate: 'desc' },
    });
  });

  it.each([
    ['currency=EUR', { currency: Currency.EUR }],
    [
      'merchant=Tesco',
      { merchant: { contains: 'Tesco', mode: 'insensitive' } },
    ],
    [
      'from=2026-10-01&to=2026-10-31',
      {
        transactionDate: {
          gte: new Date('2026-10-01T00:00:00Z'),
          lte: new Date('2026-10-31T23:59:59.999Z'),
        },
      },
    ],
    [
      'currency=EUR&merchant=Tesco&from=2026-10-01&to=2026-10-31',
      {
        currency: Currency.EUR,
        merchant: { contains: 'Tesco', mode: 'insensitive' },
        transactionDate: {
          gte: new Date('2026-10-01T00:00:00Z'),
          lte: new Date('2026-10-31T23:59:59.999Z'),
        },
      },
    ],
  ])(
    'GET /expenses?%s passes combined filters to persistence',
    async (query, where) => {
      const response = await request(app.getHttpServer())
        .get(`/expenses?${query}`)
        .expect(200);
      expect(response.body[0]).toMatchObject({
        id,
        amount: '12.50',
        currency: 'EUR',
      });
      expect(expense.findMany).toHaveBeenCalledWith({
        where,
        orderBy: { transactionDate: 'desc' },
      });
    },
  );

  it.each([
    'currency=USD',
    'from=invalid',
    'to=invalid',
    'from=2026-02-30',
    'to=2026-02-30',
    'from=2026-11-01&to=2026-10-31',
    'currency=EUR&currency=BRL',
    'merchant=Tesco&merchant=Lidl',
    'unknown=value',
  ])('GET /expenses?%s returns 400 before persistence', async (query) => {
    await request(app.getHttpServer()).get(`/expenses?${query}`).expect(400);
    expect(expense.findMany).not.toHaveBeenCalled();
  });

  it('GET /expenses returns an empty array when no expenses exist', async () => {
    expense.findMany.mockResolvedValue([]);
    await request(app.getHttpServer()).get('/expenses').expect(200).expect([]);
  });

  it('GET /expenses/:id returns one expense', async () => {
    const response = await request(app.getHttpServer())
      .get(`/expenses/${id}`)
      .expect(200);
    expect(response.body.id).toBe(id);
    expect(response.body.amount).toBe('12.50');
  });

  it('unknown expense UUID returns 404', async () => {
    expense.findUnique.mockResolvedValue(null);
    await request(app.getHttpServer()).get(`/expenses/${id}`).expect(404);
  });

  it('malformed expense id returns 400 before persistence', async () => {
    await request(app.getHttpServer()).get('/expenses/not-a-uuid').expect(400);
    expect(expense.findUnique).not.toHaveBeenCalled();
  });

  it.each([
    {},
    { ...input, amount: 12.5 },
    { ...input, amount: '0' },
    { ...input, amount: '0.00' },
    { ...input, amount: '-2' },
    { ...input, amount: '1.001' },
    { ...input, amount: '1.0000' },
    { ...input, amount: '1.001' },
    { ...input, amount: '1000000000000000' },
    { ...input, currency: 'USD' },
    { ...input, transactionDate: 'invalid' },
    { ...input, transactionDate: '2026-02-30' },
    { ...input, description: 42 },
    { ...input, merchant: [] },
    { ...input, extra: 'unexpected' },
  ])('invalid POST returns 400: %j', async (body) => {
    await request(app.getHttpServer()).post('/expenses').send(body).expect(400);
    expect(expense.create).not.toHaveBeenCalled();
  });
});

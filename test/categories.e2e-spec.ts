import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { pendingDatabase } from './helpers/pending-database.js';
import { budgetDatabase } from './helpers/budget-database.js';
describe('category expense, analytics and budget HTTP integration', () => {
  let app: INestApplication;
  let store: ReturnType<typeof pendingDatabase>;
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-13T12:00:00Z'));
    store = pendingDatabase();
    const budgets = budgetDatabase();
    store.database.expense.findMany.mockImplementation(
      async ({ where }: any = {}) =>
        [...store.expenses.values()].filter(
          (row) =>
            (!where?.category ||
              (typeof where.category === 'string'
                ? row.category === where.category
                : (!where.category.equals ||
                    row.category === where.category.equals) &&
                  !where.category.notIn?.includes(row.category))) &&
            (!where?.currency || row.currency === where.currency) &&
            (!where?.transactionDate ||
              ((!where.transactionDate.gte ||
                row.transactionDate >= where.transactionDate.gte) &&
                (!where.transactionDate.lt ||
                  row.transactionDate < where.transactionDate.lt) &&
                (!where.transactionDate.lte ||
                  row.transactionDate <= where.transactionDate.lte))),
        ),
    );
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue({
        ...budgets.database,
        expense: store.database.expense,
        merchantCategoryMapping: store.database.merchantCategoryMapping,
      })
      .compile();
    app = module.createNestApplication();
    await app.init();
    for (const [merchant, amount] of [
      ['Tesco', '100.10'],
      ['Lidl', '100.20'],
      ['Aldi', '52.40'],
    ])
      await request(app.getHttpServer())
        .post('/expenses')
        .send({
          payer: 'SPOUSE',
          merchant,
          amount,
          currency: 'EUR',
          transactionDate: '2026-10-13',
        })
        .expect(201);
    await request(app.getHttpServer())
      .post('/expenses')
      .send({
        payer: 'SPOUSE',
        merchant: 'Lidl',
        amount: '97.00',
        currency: 'BRL',
        transactionDate: '2026-10-13',
      })
      .expect(201);
  });
  afterEach(async () => {
    await app.close();
    vi.useRealTimers();
  });
  it('filters combined category, currency and date', async () => {
    const result = await request(app.getHttpServer())
      .get(
        '/expenses?category=GROCERIES&currency=EUR&from=2026-10-01&to=2026-10-31',
      )
      .expect(200);
    expect(result.body).toHaveLength(3);
    expect(result.body[0].category).toBe('GROCERIES');
    await request(app.getHttpServer())
      .get('/expenses?category=INVALID')
      .expect(400);
  });
  it('consolidates merchant expenses by category without combining currencies', async () => {
    const result = await request(app.getHttpServer())
      .get('/analytics/by-category?from=2026-10-01&to=2026-10-31')
      .expect(200);
    expect(result.body).toEqual([
      { category: 'GROCERIES', currency: 'BRL', total: '97.00' },
      { category: 'GROCERIES', currency: 'EUR', total: '252.70' },
    ]);
  });
  it('uses category pace for a category budget', async () => {
    const created = await request(app.getHttpServer())
      .post('/budgets')
      .send({
        amount: '500.00',
        currency: 'EUR',
        year: 2026,
        month: 10,
        category: 'GROCERIES',
      })
      .expect(201);
    const status = await request(app.getHttpServer())
      .get(`/budgets/${created.body.id}/status`)
      .expect(200);
    expect(status.body).toMatchObject({
      spent: '252.70',
      remaining: '247.30',
      projectedMonthTotal: '602.59',
      projectedOverBudget: true,
    });
  });
  it('excludes categories before summing, keeping all remaining categories and currencies', async () => {
    for (const [category, amount, currency] of [
      ['PETS', '123.45', 'EUR'],
      ['OTHER', '0.10', 'EUR'],
      ['OTHER', '0.20', 'EUR'],
      ['TRANSPORT', '4.56', 'EUR'],
      ['OTHER', '9.87', 'BRL'],
    ])
      await request(app.getHttpServer())
        .post('/expenses')
        .send({
          payer: 'SPOUSE',
          category,
          amount,
          currency,
          transactionDate: '2026-10-13',
        })
        .expect(201);
    const result = await request(app.getHttpServer())
      .get(
        '/analytics/by-category?from=2026-10-01&to=2026-10-15&excludeCategories=GROCERIES&excludeCategories=PETS',
      )
      .expect(200);
    expect(result.body).toEqual([
      { category: 'OTHER', currency: 'BRL', total: '9.87' },
      { category: 'OTHER', currency: 'EUR', total: '0.30' },
      { category: 'TRANSPORT', currency: 'EUR', total: '4.56' },
    ]);
    const other = await request(app.getHttpServer())
      .get(
        '/analytics/by-category?from=2026-10-01&to=2026-10-15&category=OTHER',
      )
      .expect(200);
    expect(other.body).toHaveLength(2);
    expect(
      other.body.every((row: { category: string }) => row.category === 'OTHER'),
    ).toBe(true);
  });
  it('rejects invalid excluded categories through the HTTP DTO', async () => {
    await request(app.getHttpServer())
      .get(
        '/analytics/by-category?from=2026-10-01&to=2026-10-15&excludeCategories=INVALID&excludeCategories=PETS',
      )
      .expect(400);
  });
});

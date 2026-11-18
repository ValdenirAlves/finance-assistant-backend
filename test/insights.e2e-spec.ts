import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { InsightsModule } from '../src/analytics/insights/insights.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { Prisma } from '../src/generated/prisma/client.js';
import { budgetDatabase } from './helpers/budget-database.js';
import { BudgetsService } from '../src/budgets/budgets.service.js';
describe('GET monthly financial insights (real services, mocked DB)', () => {
  let app: INestApplication;
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-14T12:00:00Z'));
    const budgets = budgetDatabase();
    const rows = [
      {
        id: 'g1',
        amount: new Prisma.Decimal('200.00'),
        currency: 'EUR',
        category: 'GROCERIES',
        merchant: 'Tesco',
        transactionDate: new Date('2026-09-10Z'),
      },
      {
        id: 'g2',
        amount: new Prisma.Decimal('300.00'),
        currency: 'EUR',
        category: 'GROCERIES',
        merchant: 'Tesco',
        transactionDate: new Date('2026-10-10Z'),
      },
      {
        id: 'excluded',
        amount: new Prisma.Decimal('1000.00'),
        currency: 'EUR',
        category: 'GROCERIES',
        merchant: 'Tesco',
        transactionDate: new Date('2026-09-25Z'),
      },
      ...[6, 7, 8, 9, 10].map((month, index) => ({
        id: `b${index}`,
        amount: new Prisma.Decimal(month === 10 ? '30.00' : '25.00'),
        currency: 'BRL',
        category: 'SUBSCRIPTIONS',
        merchant: 'Btv',
        transactionDate: new Date(
          `2026-${String(month).padStart(2, '0')}-14T00:00:00Z`,
        ),
      })),
    ];
    budgets.database.expense = {
      findMany: vi.fn(async ({ where }: any = {}) =>
        rows.filter(
          (row) =>
            (!where?.currency || row.currency === where.currency) &&
            (!where?.category || row.category === where.category) &&
            (!where?.merchant ||
              row.merchant
                .toLowerCase()
                .includes(where.merchant.contains.toLowerCase())) &&
            (!where?.transactionDate ||
              ((!where.transactionDate.gte ||
                row.transactionDate >= where.transactionDate.gte) &&
                (!where.transactionDate.lte ||
                  row.transactionDate <= where.transactionDate.lte) &&
                (!where.transactionDate.lt ||
                  row.transactionDate < where.transactionDate.lt))),
        ),
      ),
    };
    const module = await Test.createTestingModule({ imports: [InsightsModule] })
      .overrideProvider(PrismaService)
      .useValue(budgets.database)
      .compile();
    const service = module.get(BudgetsService);
    await service.create({
      amount: '500.00',
      currency: 'EUR' as never,
      year: 2026,
      month: 10,
      merchant: 'Tesco',
    });
    await service.create({
      amount: '200.00',
      currency: 'EUR' as never,
      year: 2026,
      month: 10,
      category: 'GROCERIES' as never,
    });
    app = module.createNestApplication();
    await app.init();
  });
  afterEach(async () => {
    await app.close();
    vi.useRealTimers();
  });
  it('returns all five on-demand insight types with evidence and priority', async () => {
    const response = await request(app.getHttpServer())
      .get('/analytics/insights')
      .expect(200);
    expect(new Set(response.body.map((row: any) => row.type))).toEqual(
      new Set([
        'BUDGET_AT_RISK',
        'BUDGET_EXCEEDED',
        'CATEGORY_SPEND_SPIKE',
        'MONTH_OVER_MONTH_INCREASE',
        'RECURRING_EXPENSE_INCREASE',
      ]),
    );
    expect(response.body[0].severity).toBe('CRITICAL');
    const spike = response.body.find(
      (row: any) => row.type === 'CATEGORY_SPEND_SPIKE',
    );
    expect(spike.data).toMatchObject({
      previousAmount: '200.00',
      currentAmount: '300.00',
      increasePercentage: '50.00',
    });
    const recurring = response.body.find(
      (row: any) => row.type === 'RECURRING_EXPENSE_INCREASE',
    );
    expect(recurring).toMatchObject({
      currency: 'BRL',
      data: {
        previousAmount: '25.00',
        latestAmount: '30.00',
        increasePercentage: '20.00',
      },
    });
  });
  it('filters currency and returns summary counts', async () => {
    const response = await request(app.getHttpServer())
      .get('/analytics/insights?currency=BRL')
      .expect(200);
    expect(response.body).toHaveLength(1);
    const summary = await request(app.getHttpServer())
      .get('/analytics/insights/summary')
      .expect(200);
    expect(summary.body).toEqual({ critical: 3, warning: 2, info: 0 });
  });
  it('filters severity, type and category', async () => {
    const result = await request(app.getHttpServer())
      .get(
        '/analytics/insights?severity=CRITICAL&type=CATEGORY_SPEND_SPIKE&category=GROCERIES',
      )
      .expect(200);
    expect(result.body).toHaveLength(1);
  });
  it.each([
    'currency=USD',
    'severity=EXTREME',
    'type=FAKE',
    'category=UNKNOWN',
  ])('rejects invalid filter %s', async (query) => {
    await request(app.getHttpServer())
      .get(`/analytics/insights?${query}`)
      .expect(400);
  });
});

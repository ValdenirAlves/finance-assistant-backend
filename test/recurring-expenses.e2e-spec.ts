import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AnalyticsModule } from '../src/analytics/analytics.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { Prisma } from '../src/generated/prisma/client.js';
describe('recurring expenses analytics endpoints', () => {
  let app: INestApplication;
  const rows = ['2026-07-05', '2026-08-05', '2026-09-06', '2026-10-05'].flatMap(
    (date, index) => [
      {
        id: `eur${index}`,
        merchant: 'Netflix',
        currency: 'EUR',
        category: 'SUBSCRIPTIONS',
        amount: new Prisma.Decimal('17.99'),
        transactionDate: new Date(`${date}T00:00:00Z`),
      },
      {
        id: `brl${index}`,
        merchant: 'Netflix',
        currency: 'BRL',
        category: 'SUBSCRIPTIONS',
        amount: new Prisma.Decimal('97.00'),
        transactionDate: new Date(`${date}T00:00:00Z`),
      },
    ],
  );
  const findMany = vi.fn(async ({ where }: any = {}) =>
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
              row.transactionDate <= where.transactionDate.lte))),
    ),
  );
  beforeEach(async () => {
    const module = await Test.createTestingModule({
      imports: [AnalyticsModule],
    })
      .overrideProvider(PrismaService)
      .useValue({ expense: { findMany } })
      .compile();
    app = module.createNestApplication();
    await app.init();
  });
  afterEach(async () => {
    await app.close();
  });
  it('returns separate deterministic candidates with evidence', async () => {
    const response = await request(app.getHttpServer())
      .get('/analytics/recurring-expenses')
      .expect(200);
    expect(response.body).toHaveLength(2);
    expect(response.body[0]).toMatchObject({
      merchant: 'Netflix',
      currency: 'BRL',
      occurrences: 4,
      confidence: 'HIGH',
      averageAmount: '97.00',
      nextExpectedDate: '2026-11-05',
    });
    expect(response.body[1].evidence.chargeDates).toHaveLength(4);
  });
  it('returns per-currency recurring summary', async () => {
    const response = await request(app.getHttpServer())
      .get('/analytics/recurring-expenses/summary')
      .expect(200);
    expect(response.body).toEqual({
      EUR: {
        estimatedMonthlyRecurringTotal: '17.99',
        recurringMerchantCount: 1,
        highConfidenceCount: 1,
      },
      BRL: {
        estimatedMonthlyRecurringTotal: '97.00',
        recurringMerchantCount: 1,
        highConfidenceCount: 1,
      },
    });
  });
  it('combines historical filters and confidence', async () => {
    const response = await request(app.getHttpServer())
      .get(
        '/analytics/recurring-expenses?currency=EUR&category=SUBSCRIPTIONS&merchant=Net&confidence=HIGH&from=2026-07-01&to=2026-10-31',
      )
      .expect(200);
    expect(response.body).toHaveLength(1);
    expect(response.body[0].currency).toBe('EUR');
    const absent = await request(app.getHttpServer())
      .get('/analytics/recurring-expenses?category=PETS')
      .expect(200);
    expect(absent.body).toEqual([]);
  });
  it.each([
    'currency=USD',
    'category=FAKE',
    'confidence=CERTAIN',
    'from=bad',
    'from=2026-10-31&to=2026-07-01',
  ])('rejects invalid filter %s', async (query) => {
    await request(app.getHttpServer())
      .get(`/analytics/recurring-expenses?${query}`)
      .expect(400);
  });
});

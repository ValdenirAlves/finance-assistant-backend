import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { Prisma } from '../src/generated/prisma/client.js';

describe('Analytics endpoints (mocked persistence)', () => {
  let app: INestApplication;
  let findMany: ReturnType<typeof vi.fn>;
  beforeEach(async () => {
    findMany = vi.fn().mockResolvedValue([
      {
        currency: 'EUR',
        merchant: 'Tesco',
        amount: new Prisma.Decimal('0.10'),
      },
      {
        currency: 'EUR',
        merchant: 'Tesco',
        amount: new Prisma.Decimal('0.20'),
      },
      {
        currency: 'BRL',
        merchant: 'Tesco',
        amount: new Prisma.Decimal('119.90'),
      },
    ]);
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue({ expense: { findMany } })
      .compile();
    app = module.createNestApplication();
    await app.init();
  });
  afterEach(async () => {
    await app?.close();
  });

  it('monthly-summary keeps both currencies separate and returns string totals', async () => {
    await request(app.getHttpServer())
      .get('/analytics/monthly-summary?year=2026&month=10')
      .expect(200)
      .expect({
        period: { year: 2026, month: 10 },
        totals: { EUR: '0.30', BRL: '119.90' },
      });
    expect(findMany.mock.calls[0][0].where.transactionDate).toEqual({
      gte: new Date('2026-10-01T00:00:00Z'),
      lt: new Date('2026-11-01T00:00:00Z'),
    });
  });

  it('monthly-summary returns both zero totals for an empty month', async () => {
    findMany.mockResolvedValue([]);
    const response = await request(app.getHttpServer())
      .get('/analytics/monthly-summary?year=2026&month=10')
      .expect(200);
    expect(response.body.totals).toEqual({ EUR: '0.00', BRL: '0.00' });
  });

  it('by-merchant separates the same merchant by currency', async () => {
    await request(app.getHttpServer())
      .get('/analytics/by-merchant?from=2026-10-01&to=2026-10-31')
      .expect(200)
      .expect([
        { merchant: 'Tesco', currency: 'BRL', total: '119.90' },
        { merchant: 'Tesco', currency: 'EUR', total: '0.30' },
      ]);
    expect(findMany.mock.calls[0][0].where.transactionDate).toEqual({
      gte: new Date('2026-10-01T00:00:00Z'),
      lte: new Date('2026-10-31T23:59:59.999Z'),
    });
  });

  it('by-merchant preserves null merchants', async () => {
    findMany.mockResolvedValue([
      { merchant: null, currency: 'EUR', amount: new Prisma.Decimal('1.00') },
    ]);
    await request(app.getHttpServer())
      .get('/analytics/by-merchant?from=2026-10-01&to=2026-10-31')
      .expect(200)
      .expect([{ merchant: null, currency: 'EUR', total: '1.00' }]);
  });

  it.each([
    'monthly-summary?year=2026&month=13',
    'monthly-summary?year=2026&month=0',
    'monthly-summary?year=bad&month=10',
    'monthly-summary?year=0000&month=10',
    'monthly-summary?month=10',
    'monthly-summary?year=2026',
    'monthly-summary?year=2026&month=10&month=11',
    'by-merchant?from=bad&to=2026-10-31',
    'by-merchant?from=2026-10-01&to=bad',
    'by-merchant?from=2026-02-30&to=2026-10-31',
    'by-merchant?from=2026-11-01&to=2026-10-31',
    'by-merchant?from=2026-10-01',
    'by-merchant?to=2026-10-31',
    'by-merchant?from=2026-10-01&to=2026-10-31&extra=value',
  ])('returns 400 for %s before persistence', async (path) => {
    await request(app.getHttpServer()).get(`/analytics/${path}`).expect(400);
    expect(findMany).not.toHaveBeenCalled();
  });
});

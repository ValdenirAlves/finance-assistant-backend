import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AnalyticsModule } from '../src/analytics/analytics.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { Prisma } from '../src/generated/prisma/client.js';
describe('GET /analytics/spending-pace', () => {
  let app: INestApplication;
  const findMany = vi.fn();
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-13T12:00:00Z'));
    findMany.mockReset();
    findMany.mockResolvedValue([
      { currency: 'EUR', amount: new Prisma.Decimal('252.70') },
    ]);
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
    vi.useRealTimers();
  });
  it('returns deterministic filtered projection at a fixed UTC date', async () => {
    const response = await request(app.getHttpServer())
      .get(
        '/analytics/spending-pace?year=2026&month=10&merchant=Tesco&currency=EUR',
      )
      .expect(200);
    expect(response.body.period.daysElapsed).toBe(13);
    expect(response.body.results[0]).toMatchObject({
      weeklyAverage: '136.07',
      projectedMonthTotal: '602.59',
    });
    expect(findMany.mock.calls[0][0].where.merchant).toEqual({
      contains: 'Tesco',
      mode: 'insensitive',
    });
  });
  it('rejects unsupported currency', async () => {
    await request(app.getHttpServer())
      .get('/analytics/spending-pace?year=2026&month=10&currency=USD')
      .expect(400);
  });
});

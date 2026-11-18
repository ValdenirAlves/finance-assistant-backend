import { BudgetsService } from './budgets.service.js';
import { AnalyticsService } from '../analytics/analytics.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { Currency } from '../generated/prisma/enums.js';
import { budgetDatabase } from '../../test/helpers/budget-database.js';
describe('Budgets domain', () => {
  const input = {
    amount: '500.00',
    currency: Currency.EUR,
    year: 2026,
    month: 10,
    merchant: 'Tesco',
  };
  let store: ReturnType<typeof budgetDatabase>;
  let service: BudgetsService;
  const spendingPace = vi.fn();
  beforeEach(() => {
    store = budgetDatabase();
    service = new BudgetsService(
      store.database as PrismaService,
      { spendingPace } as unknown as AnalyticsService,
    );
    spendingPace.mockReset();
  });
  it('creates merchant and category budgets with Decimal-safe values', async () => {
    expect(await service.create(input)).toMatchObject({
      amount: '500.00',
      merchant: 'Tesco',
      category: null,
    });
    expect(
      await service.create({
        ...input,
        merchant: undefined,
        category: 'GROCERIES',
      }),
    ).toMatchObject({ category: 'GROCERIES' });
  });
  it.each([
    { amount: '0' },
    { amount: '-1' },
    { amount: '1.001' },
    { currency: 'USD' },
    { month: 13 },
    { year: 0 },
    { category: 'GROCERIES' },
    { merchant: undefined },
    { merchant: ' ' },
  ])('rejects invalid budget %j', async (change) => {
    await expect(
      service.create({ ...input, ...change } as never),
    ).rejects.toThrow();
  });
  it('rejects case-insensitive duplicate budgets', async () => {
    await service.create(input);
    await expect(
      service.create({ ...input, merchant: 'tesco' }),
    ).rejects.toThrow('Budget already exists');
  });
  it.each([
    ['252.70', 'ON_TRACK', '247.30'],
    ['400.00', 'NEAR_LIMIT', '100.00'],
    ['500.00', 'NEAR_LIMIT', '0.00'],
    ['501.00', 'OVER_BUDGET', '-1.00'],
  ])('calculates status for %s', async (spent, status, remaining) => {
    const budget = await service.create(input);
    spendingPace.mockResolvedValue({
      period: {},
      results: [{ spentToDate: spent, projectedMonthTotal: '602.59' }],
    });
    const result = await service.status(budget.id);
    expect(result).toMatchObject({
      spent,
      remaining,
      status,
      projectedOverBudget: true,
      projectedMonthTotal: '602.59',
    });
    if (spent === '252.70') expect(result.percentageUsed).toBe('50.54');
    expect(spendingPace).toHaveBeenCalledWith({
      year: '2026',
      month: '10',
      currency: 'EUR',
      merchant: 'Tesco',
      category: undefined,
    });
  });
  it('has null future projection', async () => {
    const budget = await service.create(input);
    spendingPace.mockResolvedValue({
      period: {},
      results: [{ spentToDate: '0.00', projectedMonthTotal: null }],
    });
    expect((await service.status(budget.id)).projectedOverBudget).toBeNull();
  });
  it('prepares without saving, confirms exactly once and rejects cancellation', async () => {
    const row = await service.prepare('conversation', input);
    expect(store.budgets.size).toBe(0);
    await service.arm('conversation', row.revision);
    const [a, b] = await Promise.all([
      service.confirm('conversation', 1),
      service.confirm('conversation', 1),
    ]);
    expect(a.id).toBe(b.id);
    expect(store.budgets.size).toBe(1);
    await service.prepare('conversation', { ...input, month: 11 });
    await service.arm('conversation', 2);
    await service.cancel('conversation');
    await expect(service.confirm('conversation', 2)).rejects.toThrow();
    expect(store.budgets.size).toBe(1);
  });
  it('creation failure leaves pending state available', async () => {
    await service.prepare('conversation', input);
    await service.arm('conversation', 1);
    store.database.budget.create.mockRejectedValueOnce(new Error('failed'));
    await expect(service.confirm('conversation', 1)).rejects.toThrow();
    expect(store.drafts.get('conversation').status).toBe('PENDING');
  });
});

import { InsightsService } from './insights.service.js';
import {
  comparisonPeriods,
  InsightType,
  InsightSeverity,
} from './insights.dto.js';
import { AnalyticsService } from '../analytics.service.js';
import { BudgetsService } from '../../budgets/budgets.service.js';
import { RecurringExpensesService } from '../recurring-expenses.service.js';
import { detectRecurringExpenses } from '../recurring-expenses.js';
import { Currency, ExpenseCategory } from '../../generated/prisma/enums.js';
describe('deterministic monthly insights', () => {
  const byCategory = vi.fn(),
    findAll = vi.fn(),
    status = vi.fn(),
    analyze = vi.fn();
  const analytics = {
    currentDate: () => new Date('2026-10-14T23:59:59Z'),
    byCategory,
  };
  const service = new InsightsService(
    analytics as unknown as AnalyticsService,
    { findAll, status } as unknown as BudgetsService,
    { analyze } as unknown as RecurringExpensesService,
  );
  const row = (
    total: string,
    currency: Currency = Currency.EUR,
    category: ExpenseCategory = ExpenseCategory.GROCERIES,
  ) => ({ total, currency, category });
  beforeEach(() => {
    vi.resetAllMocks();
    findAll.mockResolvedValue([]);
    analyze.mockResolvedValue({ rows: [], candidates: [] });
    byCategory.mockImplementation(async ({ from }) =>
      from === '2026-10-01' ? [row('300.00')] : [row('200.00')],
    );
  });
  function budget(over = false, category: ExpenseCategory | null = null) {
    findAll.mockResolvedValue([
      {
        id: 'budget',
        amount: '500.00',
        currency: 'EUR',
        year: 2026,
        month: 10,
        merchant: category ? null : 'Tesco',
        category,
      },
    ]);
    status.mockResolvedValue({
      budgetAmount: '500.00',
      spent: over ? '550.00' : '252.70',
      remaining: over ? '-50.00' : '247.30',
      percentageUsed: over ? '110.00' : '50.54',
      status: over ? 'OVER_BUDGET' : 'ON_TRACK',
      projectedOverBudget: true,
      projectedMonthTotal: '602.59',
      projectedOverage: '102.59',
      overage: over ? '50.00' : '0.00',
    });
  }
  it.each([null, ExpenseCategory.GROCERIES])(
    'reports budget risk for scope %s',
    async (category) => {
      budget(false, category);
      const result = await service.findAll({
        type: InsightType.BUDGET_AT_RISK,
      });
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        type: 'BUDGET_AT_RISK',
        severity: 'WARNING',
        currency: 'EUR',
        data: {
          budgetAmount: '500.00',
          remaining: '247.30',
          projectedOverage: '102.59',
        },
      });
      expect(status).toHaveBeenCalledExactlyOnceWith(
        'budget',
        new Date('2026-10-14T23:59:59Z'),
      );
    },
  );
  it('exceeded suppresses risk for the same budget', async () => {
    budget(true);
    const result = await service.findAll();
    expect(
      result.filter((row) => row.type === InsightType.BUDGET_EXCEEDED),
    ).toHaveLength(1);
    expect(result.some((row) => row.type === InsightType.BUDGET_AT_RISK)).toBe(
      false,
    );
    expect(result[0].severity).toBe('CRITICAL');
  });
  it('uses comparable MTD periods, not the entire previous month', async () => {
    await service.findAll();
    expect(byCategory).toHaveBeenCalledWith({
      from: '2026-10-01',
      to: '2026-10-14',
    });
    expect(byCategory).toHaveBeenCalledWith({
      from: '2026-09-01',
      to: '2026-09-14',
    });
  });
  it.each([
    ['200.00', '260.00', 1, 'WARNING'],
    ['200.00', '300.00', 1, 'CRITICAL'],
    ['50.00', '69.99', 0, null],
    ['200.00', '220.00', 0, null],
    ['0.00', '300.00', 0, null],
    ['200.00', '100.00', 0, null],
  ])(
    'category thresholds previous %s current %s',
    async (previous, current, count, severity) => {
      byCategory.mockImplementation(async ({ from }) => [
        row(from === '2026-10-01' ? current : previous),
      ]);
      const result = await service.findAll({
        type: InsightType.CATEGORY_SPEND_SPIKE,
      });
      expect(result).toHaveLength(count);
      if (count) expect(result[0].severity).toBe(severity);
    },
  );
  it('separates currencies for overall increases', async () => {
    byCategory.mockImplementation(async ({ from }) =>
      from === '2026-10-01'
        ? [row('700.00'), row('97.00', Currency.BRL)]
        : [row('500.00'), row('200.00', Currency.BRL)],
    );
    const result = await service.findAll({
      type: InsightType.MONTH_OVER_MONTH_INCREASE,
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      currency: 'EUR',
      data: { increaseAmount: '200.00', increasePercentage: '40.00' },
    });
  });
  it.each([
    ['0.00', '100.00', 0],
    ['200.00', '249.99', 0],
    ['200.00', '250.00', 1],
  ])('overall threshold %s -> %s', async (previous, current, count) => {
    byCategory.mockImplementation(async ({ from }) => [
      row(from === '2026-10-01' ? current : previous),
    ]);
    expect(
      await service.findAll({ type: InsightType.MONTH_OVER_MONTH_INCREASE }),
    ).toHaveLength(count);
  });
  it('formats precise financial differences and percentages', async () => {
    byCategory.mockImplementation(async ({ from }) => [
      row(from === '2026-10-01' ? '130.13' : '100.10'),
    ]);
    const result = await service.findAll({
      type: InsightType.CATEGORY_SPEND_SPIKE,
    });
    expect(result[0]).toMatchObject({
      data: { increaseAmount: '30.03', increasePercentage: '30.00' },
    });
  });
  function recurring(amounts: string[]) {
    const rows = amounts.map((amount, index) => ({
      id: String(index),
      merchant: 'Btv',
      currency: Currency.BRL,
      category: ExpenseCategory.SUBSCRIPTIONS,
      amount,
      transactionDate: new Date(
        `2026-${String(index + 6).padStart(2, '0')}-14T00:00:00Z`,
      ),
    }));
    analyze.mockResolvedValue({
      rows,
      candidates: detectRecurringExpenses(rows),
    });
  }
  it('detects a stable recurring price increase in the current MTD', async () => {
    recurring(['25.00', '25.00', '25.00', '25.00', '30.00']);
    const result = await service.findAll({
      type: InsightType.RECURRING_EXPENSE_INCREASE,
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      severity: 'WARNING',
      currency: 'BRL',
      data: {
        previousAmount: '25.00',
        latestAmount: '30.00',
        increaseAmount: '5.00',
        increasePercentage: '20.00',
        latestChargeDate: '2026-10-14',
      },
    });
  });
  it.each([
    ['25.00', '25.00', '25.00', '25.00', '25.00'],
    ['25.00', '25.00', '25.00', '25.00', '20.00'],
    ['20.00', '24.00', '25.00', '25.00', '30.00'],
  ])(
    'does not infer price increases for unstable/unchanged/decreased charges',
    async (...amounts) => {
      recurring(amounts);
      expect(
        await service.findAll({ type: InsightType.RECURRING_EXPENSE_INCREASE }),
      ).toEqual([]);
    },
  );
  it.each([
    { currency: Currency.EUR },
    { severity: InsightSeverity.CRITICAL },
    { type: InsightType.CATEGORY_SPEND_SPIKE },
    { category: ExpenseCategory.GROCERIES },
  ])('filters %j', async (filter) => {
    const result = await service.findAll(filter);
    expect(result.length).toBeGreaterThan(0);
    if (filter.currency)
      expect(result.every((row) => row.currency === filter.currency)).toBe(
        true,
      );
    if (filter.severity)
      expect(result.every((row) => row.severity === filter.severity)).toBe(
        true,
      );
    if (filter.type)
      expect(result.every((row) => row.type === filter.type)).toBe(true);
    if (filter.category)
      expect(
        result.every(
          (row) =>
            'category' in row.data && row.data.category === filter.category,
        ),
      ).toBe(true);
  });
  it('rejects arbitrary enum filters', async () => {
    await expect(service.findAll({ type: 'FAKE' as never })).rejects.toThrow();
  });
  it('returns no invented alerts for zero/unchanged data', async () => {
    byCategory.mockResolvedValue([row('0.00')]);
    expect(await service.findAll()).toEqual([]);
    expect(await service.summary()).toEqual({
      critical: 0,
      warning: 0,
      info: 0,
    });
  });
});
describe('UTC comparison periods', () => {
  it.each([
    ['2026-10-14T23:59:59Z', '2026-09-14'],
    ['2026-03-31T00:00:00Z', '2026-02-28'],
    ['2024-03-31T00:00:00Z', '2024-02-29'],
    ['2026-05-31T00:00:00Z', '2026-04-30'],
    ['2026-01-14T00:00:00Z', '2025-12-14'],
  ])('clamps %s to prior %s', (current, previous) => {
    expect(comparisonPeriods(new Date(current)).previous.to).toBe(previous);
  });
});

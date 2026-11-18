import {
  detectRecurringExpenses,
  nextMonth,
  recurringSummary,
} from './recurring-expenses.js';
import type { RecurrenceExpense } from './recurring-expenses.js';
import { RecurringExpensesService } from './recurring-expenses.service.js';
import { ExpensesService } from '../expenses/expenses.service.js';
import { ExpenseCategory, Currency } from '../generated/prisma/enums.js';
import { RecurrenceConfidence } from './dto/recurring-expenses.dto.js';
function charges(
  dates: string[],
  amounts: string[] = ['17.99'],
  merchant = 'Netflix',
  currency: Currency = Currency.EUR,
  category: ExpenseCategory = ExpenseCategory.SUBSCRIPTIONS,
): RecurrenceExpense[] {
  return dates.map((date, index) => ({
    id: `${merchant}-${currency}-${category}-${index}`,
    merchant,
    currency,
    category,
    amount: amounts[index % amounts.length],
    transactionDate: new Date(`${date}T12:00:00Z`),
  }));
}
const months = ['2026-07-05', '2026-08-05', '2026-09-06', '2026-10-05'];
describe('deterministic monthly recurrence', () => {
  it('detects three occurrences as MEDIUM and four stable as HIGH', () => {
    expect(
      detectRecurringExpenses(charges(months.slice(0, 3)))[0],
    ).toMatchObject({ occurrences: 3, confidence: 'MEDIUM' });
    expect(detectRecurringExpenses(charges(months))[0]).toMatchObject({
      occurrences: 4,
      confidence: 'HIGH',
      averageAmount: '17.99',
      minAmount: '17.99',
      maxAmount: '17.99',
      lastChargeDate: '2026-10-05',
      nextExpectedDate: '2026-11-05',
    });
  });
  it('accepts five-day tolerance, rejecting six-day deviation and cumulative drift', () => {
    expect(
      detectRecurringExpenses(
        charges(['2026-07-05', '2026-08-10', '2026-09-04']),
      ),
    ).toHaveLength(1);
    expect(
      detectRecurringExpenses(
        charges(['2026-07-05', '2026-08-11', '2026-09-04']),
      ),
    ).toHaveLength(0);
    expect(
      detectRecurringExpenses(
        charges(['2026-07-05', '2026-08-10', '2026-09-15']),
      ),
    ).toHaveLength(0);
  });
  it('rejects irregular retail dates, gaps, same-month extras and missing merchants', () => {
    expect(
      detectRecurringExpenses(
        charges(
          ['2026-07-05', '2026-07-10', '2026-08-19', '2026-10-02'],
          ['10.00'],
          'Tesco',
        ),
      ),
    ).toEqual([]);
    expect(
      detectRecurringExpenses(
        charges(['2026-07-05', '2026-09-05', '2026-10-05']),
      ),
    ).toEqual([]);
    expect(detectRecurringExpenses(charges(months, ['17.99'], ' '))).toEqual(
      [],
    );
  });
  it('normalizes merchants and separates currencies and categories', () => {
    const rows = charges(months);
    rows[0].merchant = ' netflix ';
    rows[1].merchant = 'NETFLIX';
    const result = detectRecurringExpenses([
      ...rows,
      ...charges(months, ['97.00'], 'Netflix', Currency.BRL),
      ...charges(
        months,
        ['45.00'],
        'Netflix',
        Currency.EUR,
        ExpenseCategory.UTILITIES,
      ),
    ]);
    expect(result).toHaveLength(3);
    expect(result.every((row) => row.normalizedMerchant === 'netflix')).toBe(
      true,
    );
  });
  it('keeps small variation HIGH, variable utilities MEDIUM and large variation LOW', () => {
    expect(
      detectRecurringExpenses(charges(months, ['17.00', '18.00']))[0]
        .confidence,
    ).toBe('HIGH');
    expect(
      detectRecurringExpenses(
        charges(
          ['2026-07-10', '2026-08-11', '2026-09-09', '2026-10-10'],
          ['70.00', '82.00', '75.00', '90.00'],
          'Internet',
          Currency.EUR,
          ExpenseCategory.UTILITIES,
        ),
      )[0].confidence,
    ).toBe('MEDIUM');
    expect(
      detectRecurringExpenses(charges(months, ['10.00', '50.00']))[0]
        .confidence,
    ).toBe('LOW');
  });
  it('calculates exact large monetary averages without Number', () => {
    expect(
      detectRecurringExpenses(
        charges(months, ['999999999999999.99', '999999999999999.97']),
      )[0].averageAmount,
    ).toBe('999999999999999.98');
  });
  it.each([
    ['2026-01-31', '2026-02-28'],
    ['2024-01-31', '2024-02-29'],
    ['2026-03-31', '2026-04-30'],
    ['2026-04-30', '2026-05-30'],
    ['2026-12-31', '2027-01-31'],
  ])('advances calendar date %s to %s in UTC', (date, next) => {
    expect(
      nextMonth(new Date(`${date}T23:59:59Z`))
        .toISOString()
        .slice(0, 10),
    ).toBe(next);
  });
  it('preserves Jan 31 billing anchor through February and March', () => {
    const result = detectRecurringExpenses(
      charges(['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30']),
    );
    expect(result[0]).toMatchObject({
      confidence: 'HIGH',
      nextExpectedDate: '2026-05-31',
    });
  });
  it('summarizes HIGH/MEDIUM only, with distinct merchants per currency', () => {
    const candidates = detectRecurringExpenses([
      ...charges(months),
      ...charges(
        months.slice(0, 3),
        ['97.00'],
        'Claro',
        Currency.BRL,
        ExpenseCategory.UTILITIES,
      ),
      ...charges(months, ['10.00', '50.00'], 'Variable'),
    ]);
    expect(recurringSummary(candidates)).toEqual({
      EUR: {
        estimatedMonthlyRecurringTotal: '17.99',
        recurringMerchantCount: 1,
        highConfidenceCount: 1,
      },
      BRL: {
        estimatedMonthlyRecurringTotal: '97.00',
        recurringMerchantCount: 1,
        highConfidenceCount: 0,
      },
    });
  });
});
describe('recurring service filters', () => {
  const findAll = vi.fn();
  const service = new RecurringExpensesService({
    findAll,
  } as unknown as ExpensesService);
  beforeEach(() => {
    findAll.mockReset();
    findAll.mockResolvedValue(charges(months));
  });
  it.each([
    { currency: Currency.EUR },
    { category: ExpenseCategory.SUBSCRIPTIONS },
    { merchant: 'Net' },
    { from: '2026-07-01', to: '2026-10-31' },
  ])('forwards expense filters %j', async (filters) => {
    await service.findAll(filters);
    expect(findAll).toHaveBeenCalledExactlyOnceWith(filters);
  });
  it('filters confidence after detection', async () => {
    expect(
      await service.findAll({ confidence: RecurrenceConfidence.HIGH }),
    ).toHaveLength(1);
    expect(
      await service.findAll({ confidence: RecurrenceConfidence.LOW }),
    ).toEqual([]);
  });
  it('rejects invalid currency/category/confidence', async () => {
    await expect(
      service.findAll({ currency: 'USD' as never }),
    ).rejects.toThrow();
    await expect(
      service.findAll({ category: 'UNKNOWN' as never }),
    ).rejects.toThrow();
    await expect(
      service.findAll({ confidence: 'CERTAIN' as never }),
    ).rejects.toThrow();
  });
});

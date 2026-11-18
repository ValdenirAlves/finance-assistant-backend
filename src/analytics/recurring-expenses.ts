import { Prisma } from '../generated/prisma/client.js';
import type { Currency, ExpenseCategory } from '../generated/prisma/enums.js';
import { normalizeMerchant } from '../categories/categories.service.js';
import { RecurrenceConfidence } from './dto/recurring-expenses.dto.js';
const Decimal = Prisma.Decimal.clone({ precision: 40 });
const DAY_MS = 86400000;
export function recurringAmountStats(rows: Array<{ amount: string }>) {
  let total = new Decimal('0'),
    min = new Decimal(rows[0]?.amount ?? '0'),
    max = min;
  for (const row of rows) {
    const amount = new Decimal(row.amount);
    total = total.plus(amount);
    if (amount.lt(min)) min = amount;
    if (amount.gt(max)) max = amount;
  }
  const average = rows.length
    ? total.div(String(rows.length))
    : new Decimal('0');
  const variation = average.gt('0')
    ? max.minus(min).div(average).mul('100')
    : new Decimal('0');
  return { average, min, max, variation };
}
export interface RecurrenceExpense {
  id: string;
  merchant: string | null;
  currency: Currency;
  category: ExpenseCategory;
  amount: string;
  transactionDate: Date;
}
export interface RecurringExpense {
  merchant: string;
  normalizedMerchant: string;
  category: ExpenseCategory;
  currency: Currency;
  frequency: 'MONTHLY';
  occurrences: number;
  averageAmount: string;
  minAmount: string;
  maxAmount: string;
  averageIntervalDays: number;
  lastChargeDate: string;
  nextExpectedDate: string;
  confidence: RecurrenceConfidence;
  evidence: {
    chargeDates: string[];
    intervalDays: number[];
    maxDateDeviationDays: number;
    amountVariationPercentage: string;
  };
}
export function nextMonth(date: Date, billingDay = date.getUTCDate()) {
  const result = new Date(date);
  result.setUTCHours(0, 0, 0, 0);
  const day = billingDay;
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + 1);
  const following = new Date(result);
  following.setUTCMonth(following.getUTCMonth() + 1);
  result.setUTCDate(
    Math.min(day, new Date(following.getTime() - 1).getUTCDate()),
  );
  return result;
}
const utcDay = (date: Date) => {
  const result = new Date(date);
  result.setUTCHours(0, 0, 0, 0);
  return result;
};
export function detectRecurringExpenses(
  expenses: RecurrenceExpense[],
): RecurringExpense[] {
  const groups = new Map<string, RecurrenceExpense[]>();
  for (const expense of expenses) {
    const normalized = expense.merchant
      ? normalizeMerchant(expense.merchant)
      : '';
    if (!normalized) continue;
    const key = JSON.stringify([
      normalized,
      expense.currency,
      expense.category,
    ]);
    const group = groups.get(key) ?? [];
    group.push(expense);
    groups.set(key, group);
  }
  const candidates: RecurringExpense[] = [];
  for (const group of groups.values()) {
    if (group.length < 3) continue;
    group.sort(
      (a, b) =>
        a.transactionDate.getTime() - b.transactionDate.getTime() ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
    const dates = group.map((row) => utcDay(row.transactionDate));
    const intervals: number[] = [];
    const deviations: number[] = [];
    let valid = true;
    for (let index = 1; index < dates.length; index++) {
      const previous = dates[index - 1],
        current = dates[index];
      const monthGap =
        (current.getUTCFullYear() - previous.getUTCFullYear()) * 12 +
        current.getUTCMonth() -
        previous.getUTCMonth();
      const deviation = Math.abs(
        (current.getTime() -
          nextMonth(previous, dates[0].getUTCDate()).getTime()) /
          DAY_MS,
      );
      if (monthGap !== 1 || deviation > 5) {
        valid = false;
        break;
      }
      intervals.push((current.getTime() - previous.getTime()) / DAY_MS);
      deviations.push(deviation);
    }
    if (!valid) continue;
    const { average, min, max, variation } = recurringAmountStats(group);
    if (!average.gt('0')) continue;
    const maxDeviation = Math.max(...deviations);
    const confidence =
      group.length >= 4 && maxDeviation <= 2 && variation.lte('10')
        ? RecurrenceConfidence.HIGH
        : variation.lte('30')
          ? RecurrenceConfidence.MEDIUM
          : RecurrenceConfidence.LOW;
    const last = dates.at(-1)!;
    candidates.push({
      merchant: group.at(-1)!.merchant!.trim(),
      normalizedMerchant: normalizeMerchant(group[0].merchant!),
      category: group[0].category,
      currency: group[0].currency,
      frequency: 'MONTHLY',
      occurrences: group.length,
      averageAmount: average.toFixed(2),
      minAmount: min.toFixed(2),
      maxAmount: max.toFixed(2),
      averageIntervalDays:
        Math.round(
          (intervals.reduce((sum, days) => sum + days, 0) / intervals.length) *
            10,
        ) / 10,
      lastChargeDate: last.toISOString().slice(0, 10),
      nextExpectedDate: nextMonth(last, dates[0].getUTCDate())
        .toISOString()
        .slice(0, 10),
      confidence,
      evidence: {
        chargeDates: dates.map((date) => date.toISOString().slice(0, 10)),
        intervalDays: intervals,
        maxDateDeviationDays: maxDeviation,
        amountVariationPercentage: variation.toFixed(2),
      },
    });
  }
  const rank = { HIGH: 0, MEDIUM: 1, LOW: 2 };
  const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  return candidates.sort(
    (a, b) =>
      rank[a.confidence] - rank[b.confidence] ||
      compare(a.normalizedMerchant, b.normalizedMerchant) ||
      compare(a.currency, b.currency) ||
      compare(a.category, b.category),
  );
}
export function recurringSummary(candidates: RecurringExpense[]) {
  const result = {
    EUR: {
      estimatedMonthlyRecurringTotal: '0.00',
      recurringMerchantCount: 0,
      highConfidenceCount: 0,
    },
    BRL: {
      estimatedMonthlyRecurringTotal: '0.00',
      recurringMerchantCount: 0,
      highConfidenceCount: 0,
    },
  };
  for (const currency of ['EUR', 'BRL'] as const) {
    const included = candidates.filter(
      (row) =>
        row.currency === currency &&
        row.confidence !== RecurrenceConfidence.LOW,
    );
    result[currency] = {
      estimatedMonthlyRecurringTotal: included
        .reduce((total, row) => total.plus(row.averageAmount), new Decimal('0'))
        .toFixed(2),
      recurringMerchantCount: new Set(
        included.map((row) => row.normalizedMerchant),
      ).size,
      highConfidenceCount: included.filter(
        (row) => row.confidence === RecurrenceConfidence.HIGH,
      ).length,
    };
  }
  return result;
}

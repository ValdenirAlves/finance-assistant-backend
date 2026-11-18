import { Prisma } from '../generated/prisma/client.js';
const Decimal = Prisma.Decimal.clone({ precision: 40 });
export enum BudgetGuidanceState {
  ON_TRACK = 'ON_TRACK',
  REDUCTION_NEEDED = 'REDUCTION_NEEDED',
  BUDGET_EXCEEDED = 'BUDGET_EXCEEDED',
  NO_DAYS_REMAINING = 'NO_DAYS_REMAINING',
  UNAVAILABLE = 'UNAVAILABLE',
}
export function budgetPaceGuidance(
  amount: string,
  spentValue: string,
  period: { status: string; daysElapsed: number; daysInMonth: number },
) {
  const spent = new Decimal(spentValue),
    remaining = new Decimal(amount).minus(spent);
  const daysElapsed = period.daysElapsed;
  const unavailable = {
    daysElapsed,
    daysRemaining: null,
    currentDailyAverage: null,
    allowedDailyAverageRemaining: null,
    allowedSpendingNextWeek: null,
    nextWeekDays: 0,
    requiredDailyReduction: null,
    requiredReductionPercentage: null,
  };
  if (period.status !== 'current' || daysElapsed <= 0)
    return {
      ...unavailable,
      paceGuidanceState: BudgetGuidanceState.UNAVAILABLE,
    };
  const daysRemaining = period.daysInMonth - daysElapsed;
  const current = spent.div(String(daysElapsed));
  if (daysRemaining <= 0)
    return {
      ...unavailable,
      daysRemaining: 0,
      currentDailyAverage: current.toFixed(2),
      paceGuidanceState: remaining.lt('0')
        ? BudgetGuidanceState.BUDGET_EXCEEDED
        : BudgetGuidanceState.NO_DAYS_REMAINING,
    };
  const allowed = Decimal.max(remaining, '0').div(String(daysRemaining));
  const reduction = Decimal.max(current.minus(allowed), '0');
  const percentage = current.gt('0')
    ? reduction.div(current).mul('100')
    : new Decimal('0');
  const nextWeekDays = Math.min(7, daysRemaining);
  return {
    daysElapsed,
    daysRemaining,
    currentDailyAverage: current.toFixed(2),
    allowedDailyAverageRemaining: allowed.toFixed(2),
    allowedSpendingNextWeek: allowed.mul(String(nextWeekDays)).toFixed(2),
    nextWeekDays,
    requiredDailyReduction: reduction.toFixed(2),
    requiredReductionPercentage: percentage.toFixed(2),
    paceGuidanceState: remaining.lt('0')
      ? BudgetGuidanceState.BUDGET_EXCEEDED
      : reduction.gt('0')
        ? BudgetGuidanceState.REDUCTION_NEEDED
        : BudgetGuidanceState.ON_TRACK,
  };
}

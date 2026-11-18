import { budgetPaceGuidance } from './budget-pace.js';
describe('Decimal-safe budget pace guidance', () => {
  const period = { status: 'current', daysElapsed: 14, daysInMonth: 31 };
  it('calculates daily reduction, percentage and next-week allowance without interim rounding', () => {
    expect(budgetPaceGuidance('500.00', '252.70', period)).toMatchObject({
      daysElapsed: 14,
      daysRemaining: 17,
      currentDailyAverage: '18.05',
      allowedDailyAverageRemaining: '14.55',
      requiredDailyReduction: '3.50',
      requiredReductionPercentage: '19.41',
      allowedSpendingNextWeek: '101.83',
      paceGuidanceState: 'REDUCTION_NEEDED',
    });
  });
  it('returns zero reduction for already safe pace and zero spending', () => {
    expect(budgetPaceGuidance('500.00', '100.00', period)).toMatchObject({
      requiredDailyReduction: '0.00',
      requiredReductionPercentage: '0.00',
      paceGuidanceState: 'ON_TRACK',
    });
    expect(budgetPaceGuidance('500.00', '0.00', period)).toMatchObject({
      currentDailyAverage: '0.00',
      requiredReductionPercentage: '0.00',
    });
  });
  it('does not divide by zero on the last day', () => {
    expect(
      budgetPaceGuidance('500.00', '252.70', { ...period, daysElapsed: 31 }),
    ).toMatchObject({
      daysRemaining: 0,
      allowedDailyAverageRemaining: null,
      requiredDailyReduction: null,
      requiredReductionPercentage: null,
      paceGuidanceState: 'NO_DAYS_REMAINING',
    });
  });
  it('clamps an exceeded budget daily allowance to zero without hiding the state', () => {
    expect(budgetPaceGuidance('500.00', '540.00', period)).toMatchObject({
      allowedDailyAverageRemaining: '0.00',
      requiredReductionPercentage: '100.00',
      paceGuidanceState: 'BUDGET_EXCEEDED',
    });
  });
  it('limits weekly allowance to actual remaining days', () => {
    expect(
      budgetPaceGuidance('500.00', '350.00', { ...period, daysElapsed: 28 }),
    ).toMatchObject({
      daysRemaining: 3,
      nextWeekDays: 3,
      allowedSpendingNextWeek: '150.00',
    });
  });
  it.each(['past', 'future'])(
    'returns unavailable guidance outside current month (%s)',
    (status) => {
      expect(
        budgetPaceGuidance('500.00', '0.00', { ...period, status }),
      ).toMatchObject({
        daysRemaining: null,
        paceGuidanceState: 'UNAVAILABLE',
      });
    },
  );
  it('preserves large exact amounts', () => {
    expect(
      budgetPaceGuidance('999999999999999.99', '130.13', {
        status: 'current',
        daysElapsed: 13,
        daysInMonth: 31,
      }).currentDailyAverage,
    ).toBe('10.01');
  });
});

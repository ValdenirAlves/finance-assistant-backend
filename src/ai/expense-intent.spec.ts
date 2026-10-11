import { isExplicitExpensePreparation } from './expense-intent.js';

describe('explicit expense preparation routing', () => {
  it.each([
    'I spent 45 EUR at Tesco today.',
    'Add 32 EUR for lunch.',
    'Registra 85 reais no Carrefour.',
    'Yesterday I paid 119.90 BRL for Claro.',
  ])('routes %s to preparation without authorizing confirmation', (message) => {
    expect(isExplicitExpensePreparation(message)).toBe(true);
  });
  it.each([
    'How much did I spend at Tesco?',
    'What did I spend this month?',
    'How much did I spend at Tesco',
    'What did I spend this month',
    'Did I spend 45 EUR at Tesco?',
    'I spent 45 EUR at Tesco. How much this month?',
    'yes',
    'maybe',
    'I spent time at Tesco',
  ])('does not force preparation for %s', (message) => {
    expect(isExplicitExpensePreparation(message)).toBe(false);
  });
});

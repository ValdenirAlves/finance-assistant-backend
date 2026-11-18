import { isBudgetGuidance, resolveGuidanceBudget } from './budget-guidance.js';
import { Currency } from '../generated/prisma/enums.js';
const budget = {
  id: 'one',
  year: 2026,
  month: 10,
  currency: Currency.EUR,
  merchant: 'Tesco',
  category: null,
};
const now = new Date('2026-10-14Z');
const history = [
  { role: 'USER', content: 'Tem algo importante nas minhas finanças?' },
  {
    role: 'ASSISTANT',
    content: 'Seu orçamento do Tesco de 999999 EUR está em risco.',
  },
];
describe('deterministic budget guidance routing', () => {
  it.each([
    'Quanto preciso reduzir meus gastos para não estourar o orçamento?',
    'Quanto posso gastar por dia?',
    'Qual deve ser meu ritmo até o fim do mês?',
    'E quanto por semana?',
    'Como faço para ficar dentro desse orçamento?',
  ])('recognizes %s', (message) => {
    expect(isBudgetGuidance(message)).toBe(true);
  });
  it('resolves identity only, never stale assistant amounts', () => {
    expect(
      resolveGuidanceBudget('Quanto preciso reduzir?', history, [budget], now),
    ).toEqual({
      year: 2026,
      month: 10,
      currency: 'EUR',
      merchant: 'Tesco',
      category: undefined,
    });
  });
  it('does not guess an ambiguous or context-free budget', () => {
    const other = { ...budget, id: 'two', merchant: 'Lidl' };
    expect(
      resolveGuidanceBudget('Quanto preciso reduzir?', [], [budget], now),
    ).toBeNull();
    expect(
      resolveGuidanceBudget(
        'Quanto preciso reduzir?',
        [{ role: 'ASSISTANT', content: 'Orçamentos do Tesco e Lidl em EUR.' }],
        [budget, other],
        now,
      ),
    ).toBeNull();
  });
  it('uses current user currency over history but never combines currencies', () => {
    expect(
      resolveGuidanceBudget(
        'E quanto por dia em BRL?',
        history,
        [budget, { ...budget, id: 'brl', currency: Currency.BRL }],
        now,
      )?.currency,
    ).toBe('BRL');
  });
  it('does not reuse older context after unrelated turns or a new unknown scope', () => {
    expect(
      resolveGuidanceBudget(
        'Quanto preciso reduzir?',
        [
          ...history,
          { role: 'USER', content: 'Thanks' },
          { role: 'ASSISTANT', content: 'You are welcome.' },
        ],
        [budget],
        now,
      ),
    ).toBeNull();
    expect(
      resolveGuidanceBudget(
        'Quanto posso gastar por dia no Aldi?',
        history,
        [budget],
        now,
      ),
    ).toBeNull();
  });
  it('does not steal historical spending pace or expense write intents', () => {
    expect(
      isBudgetGuidance('What is my weekly average at Tesco this month?'),
    ).toBe(false);
    expect(isBudgetGuidance('Reduce my Tesco budget to 450 EUR.')).toBe(false);
  });
});

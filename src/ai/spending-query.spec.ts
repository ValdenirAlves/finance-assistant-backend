import { resolveSpendingQuery } from './spending-query.js';
const now = new Date('2026-10-15T23:59:00Z');
describe('direct spending read scope', () => {
  it.each([
    ['Quanto gastei com supermercados?', 'GROCERIES'],
    ['Quanto gastei com pets?', 'PETS'],
    ['Quanto gastei em outros gastos?', 'OTHER'],
    ['Quanto gastei em outras despesas?', 'OTHER'],
    ['How much did I spend on groceries?', 'GROCERIES'],
  ])('defaults %s to month-to-date UTC', (message, category) => {
    expect(resolveSpendingQuery(message, now)).toEqual({
      range: { from: '2026-10-01', to: '2026-10-15' },
      category,
      tool: 'get_by_category',
    });
  });
  it('distinguishes exclusions from OTHER, even with both wordings present', () => {
    expect(
      resolveSpendingQuery(
        'Olá, quanto eu gastei em outras despesas, além de mercado e pets?',
        now,
      ),
    ).toEqual({
      range: { from: '2026-10-01', to: '2026-10-15' },
      excludeCategories: ['GROCERIES', 'PETS'],
      tool: 'get_by_category',
    });
  });
  it.each([
    'Quanto gastei ontem?',
    'Quanto gastei em setembro?',
    'Quanto gastei entre 1 e 10 de outubro?',
    'Quanto gastei este ano?',
    'Quanto gastei com outros gastos este mês?',
    'How much did I spend last month?',
    'Quanto gastei desde o início?',
    'Quanto gastei em 2025?',
  ])('never replaces the period in %s', (message) => {
    expect(resolveSpendingQuery(message, now)?.range).toBeUndefined();
  });
  it.each([
    'I spent 45 EUR today.',
    'Quanto posso gastar no orçamento?',
    'Qual meu saldo?',
    'Quanto gastei por semana no Tesco?',
    'How much am I projected to spend?',
    'E com pets?',
  ])(
    'leaves other intents and context-dependent follow-ups alone: %s',
    (message) => {
      expect(resolveSpendingQuery(message, now)).toBeUndefined();
    },
  );
  it('uses the UTC day and month across local day/year boundaries', () => {
    expect(
      resolveSpendingQuery(
        'Quanto gastei com pets?',
        new Date('2027-01-01T00:30:00+01:00'),
      )?.range,
    ).toEqual({ from: '2026-12-01', to: '2026-12-31' });
  });
  it.each([
    'Quanto gastei no Mercado Livre?',
    'How much did I spend at Pets at Home?',
  ])(
    'does not treat category words in a merchant query as category intent: %s',
    (message) => {
      expect(resolveSpendingQuery(message, now)).toMatchObject({
        tool: 'get_expenses',
        range: { from: '2026-10-01', to: '2026-10-15' },
      });
      expect(resolveSpendingQuery(message, now)?.category).toBeUndefined();
    },
  );
});

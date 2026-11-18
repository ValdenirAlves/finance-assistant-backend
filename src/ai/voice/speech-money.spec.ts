import { speechMoney } from './speech-money.js';

describe('speech monetary formatting', () => {
  it.each([
    ['33.33 EUR', '33 euros e 33 centavos'],
    ['45.00 EUR', '45 euros'],
    ['1.00 EUR', '1 euro'],
    ['1.01 EUR', '1 euro e 1 centavo'],
    ['97.00 BRL', '97 reais'],
    ['33.33 BRL', '33 reais e 33 centavos'],
    ['1.00 BRL', '1 real'],
    ['1.01 BRL', '1 real e 1 centavo'],
    ['33,33 EUR', '33 euros e 33 centavos'],
    ['EUR 45.0000', '45 euros'],
    ['0.01 BRL', '0 reais e 1 centavo'],
  ])('speaks Portuguese %s exactly', (input, expected) => {
    expect(speechMoney(`Salvo: ${input}.`, 'yes')).toBe(`Salvo: ${expected}.`);
  });
  it.each([
    ['45.00 EUR', '45 euros'],
    ['33.33 EUR', '33 euros and 33 cents'],
    ['97.00 BRL', '97 Brazilian reais'],
    ['33.33 BRL', '33 Brazilian reais and 33 cents'],
    ['1.01 EUR', '1 euro and 1 cent'],
    ['1.01 BRL', '1 Brazilian real and 1 cent'],
    ['999999999999999.99 EUR', '999999999999999 euros and 99 cents'],
  ])('speaks English %s exactly', (input, expected) => {
    expect(speechMoney(`Saved: ${input}.`, 'sim')).toBe(`Saved: ${expected}.`);
  });
  it('uses transcript language for a terse answer', () => {
    expect(speechMoney('45.00 EUR', 'Pode salvar')).toBe('45 euros');
  });
  it('does not change dates, IDs, unrelated numbers or ambiguous precision', () => {
    const answer =
      'Saved: 45.00 EUR; 2026-10-09T00:00:00.000Z; id abc-97 BRL; 2025; 33.333 EUR; 1,234.56 BRL; 2 transactions.';
    expect(speechMoney(answer, 'yes')).toBe(
      answer.replace('45.00 EUR', '45 euros'),
    );
  });
  it('leaves unknown languages untouched', () => {
    expect(speechMoney('Enregistre: 45.00 EUR', 'oui')).toBe(
      'Enregistre: 45.00 EUR',
    );
  });
});

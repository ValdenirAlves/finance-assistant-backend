import {
  balanceReadRequested,
  balanceWriteRequested,
  payerFromMessage,
} from './balance-privacy.js';
describe('current-turn bank privacy and explicit payer', () => {
  it.each([
    'Qual meu saldo?',
    'Qual é meu saldo?',
    'Quanto tenho de saldo?',
    'What is my bank balance?',
    'Show my account balance',
    'E meu saldo?',
    'Quanto tenho na conta?',
    'How much money do I have in my bank account?',
  ])('permits explicit balance request %s', (message) =>
    expect(balanceReadRequested(message)).toBe(true),
  );
  it.each([
    'Quanto gastei no Tesco?',
    'Qual o saldo do orçamento?',
    'Do not show my balance',
    'Não mostre meu saldo. Quanto gastei?',
    'Earlier I asked what my balance was. What did I spend?',
    'Tem algo importante nas minhas finanças este mês?',
    'Qual é o saldo da minha esposa?',
  ])('does not authorize %s', (message) =>
    expect(balanceReadRequested(message)).toBe(false),
  );
  it.each([
    'Meu saldo no AIB é 3250 euros.',
    'Atualize meu saldo para 3100 euros.',
    'Tenho 2800 euros na conta.',
  ])('recognizes only draft intent %s', (message) =>
    expect(balanceWriteRequested(message)).toBe(true),
  );
  it.each([
    'Não atualize meu saldo para 3100 euros.',
    'Earlier my balance was 3100 EUR.',
    'Meu saldo é 3100 EUR; quanto gastei?',
  ])(
    'does not turn historical/negative/read statements into balance writes: %s',
    (message) => expect(balanceWriteRequested(message)).toBe(false),
  );
  it.each([
    ['Gastei 42 euros no Tesco no meu cartão.', 'SELF'],
    ['Gastei 70 euros no Lidl no cartão da minha esposa.', 'SPOUSE'],
    ['my own card', 'SELF'],
    ['my wife’s card', 'SPOUSE'],
    ['Gastei 35 euros no Tesco.', null],
    ['not my card', null],
    ['my card or my wife’s card', null],
  ])('resolves %s conservatively', (message, expected) =>
    expect(payerFromMessage(message!)).toBe(expected),
  );
});

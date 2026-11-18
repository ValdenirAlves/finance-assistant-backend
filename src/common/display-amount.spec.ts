import { displayAmount } from './display-amount.js';

describe('monetary display', () => {
  it.each([
    ['33.3300', '33.33'],
    ['45.0000', '45.00'],
    ['97.0000', '97.00'],
    ['999999999999999.9900', '999999999999999.99'],
  ])('formats %s without floating point conversion', (input, expected) => {
    expect(displayAmount(input)).toBe(expected);
  });
});

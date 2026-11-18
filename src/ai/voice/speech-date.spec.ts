import { speechDate } from './speech-date.js';
import { speechMoney } from './speech-money.js';

describe('speech financial dates', () => {
  const pt = 'Despesa pendente: 111.00 EUR; Tesco; 2026-10-10T00:00:00.000Z.';
  const en = 'Pending expense: 45.00 EUR; Tesco; 2026-10-10T00:00:00.000Z.';
  it.each(['Ontem eu gastei 111 euros no Tesco.', 'Hoje eu gastei 111 euros.'])(
    'omits the resolved year for %s',
    (message) => {
      expect(speechDate(pt, message)).toBe(
        'Despesa pendente: 111.00 EUR; Tesco; 10 de outubro.',
      );
    },
  );
  it('includes explicit Portuguese year', () => {
    expect(
      speechDate(
        pt,
        'No dia 10 de outubro de 2026 eu gastei 111 euros no Tesco.',
      ),
    ).toContain('10 de outubro de 2026');
  });
  it('includes explicit English year', () => {
    expect(speechDate(en, 'I spent 45 EUR on October 10, 2026.')).toContain(
      'October 10, 2026',
    );
  });
  it('omits the year for English relative date', () => {
    expect(speechDate(en, 'I spent 45 EUR yesterday.')).toContain(
      'October 10.',
    );
  });
  it('preserves UTC day at the end of the day', () => {
    expect(
      speechDate(
        en.replace('00:00:00', '23:59:59'),
        'Yesterday I spent 45 EUR.',
      ),
    ).toContain('October 10.');
  });
  it('formats currency and date together without altering the input', () => {
    expect(
      speechMoney(
        speechDate(pt, 'Ontem gastei 111 euros.'),
        'Ontem gastei 111 euros.',
      ),
    ).toBe('Despesa pendente: 111 euros; Tesco; 10 de outubro.');
    expect(pt).toContain('111.00 EUR; Tesco; 2026-10-10T00:00:00.000Z');
  });
  it('does not mistake a financial amount for an explicit year', () => {
    expect(speechDate(en, 'I spent 2026 EUR yesterday.')).not.toContain('2026');
  });
  it('leaves unrelated dates, years and malformed dates unchanged', () => {
    const answer =
      'Saved: 45.00 EUR; Tesco; 2026-02-30T00:00:00.000Z. Reference 2025, 2026-10-10.';
    expect(speechDate(answer, 'yes')).toBe(answer);
  });
  it('formats an explicitly labelled transaction date', () => {
    expect(
      speechDate('Expense transactionDate: 2026-10-10', 'on 2026-10-10'),
    ).toBe('Expense transactionDate: October 10, 2026');
  });
});

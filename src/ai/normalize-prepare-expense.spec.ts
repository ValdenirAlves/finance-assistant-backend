import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { PrepareExpenseDto } from './dto/prepare-expense.dto.js';
import { normalizePrepareExpenseArguments } from './normalize-prepare-expense.js';
import { ExpensesService } from '../expenses/expenses.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';

describe('prepare expense normalization', () => {
  const now = new Date('2026-10-09T23:59:59Z');
  const actual = {
    amount: '45.00',
    currency: 'EUR',
    merchant: 'Tesco',
    description: null,
    transactionDate: '2026-10-09',
    language: 'en',
    confirmationQuestion:
      'Do you want to save the expense of 45 EUR at Tesco today?',
  };
  it('accepts the exact failing real tool arguments by discarding unused English prose', () => {
    const normalized = normalizePrepareExpenseArguments(
      JSON.stringify(actual),
      'I spent 45 EUR at Tesco today.',
      now,
    );
    expect(normalized).toEqual({ ...actual, confirmationQuestion: null });
    expect(
      validateSync(plainToInstance(PrepareExpenseDto, normalized)),
    ).toEqual([]);
  });

  it('normalizes number 45, lower-case currency, today and omitted optional fields', () => {
    const normalized = normalizePrepareExpenseArguments(
      '{"amount":45,"currency":" eur ","merchant":"Tesco","transactionDate":"today"}',
      'I spent 45 EUR at Tesco today.',
      now,
    );
    expect(normalized).toEqual({
      amount: '45.00',
      currency: 'EUR',
      merchant: 'Tesco',
      transactionDate: '2026-10-09',
      language: 'en',
      confirmationQuestion: null,
    });
    expect(
      validateSync(plainToInstance(PrepareExpenseDto, normalized)),
    ).toEqual([]);
  });

  it('preserves large numeric literal precision without converting amount to a JS number', () => {
    const normalized = normalizePrepareExpenseArguments(
      '{"amount":999999999999999.99,"currency":"EUR","transactionDate":"today"}',
      'Add expense',
      now,
    );
    expect(normalized.amount).toBe('999999999999999.99');
    expect(
      validateSync(plainToInstance(PrepareExpenseDto, normalized)),
    ).toEqual([]);
  });

  it.each(['yesterday', 'ontem'])(
    'resolves %s across UTC month/year boundaries',
    (relative) => {
      const normalized = normalizePrepareExpenseArguments(
        JSON.stringify({ ...actual, transactionDate: relative }),
        'expense',
        new Date('2026-01-01T00:01:00Z'),
      );
      expect(normalized.transactionDate).toBe('2025-12-31');
    },
  );

  it('normalizes Portuguese language aliases and localized decimal strings', () => {
    const normalized = normalizePrepareExpenseArguments(
      JSON.stringify({
        ...actual,
        amount: '119,90',
        currency: 'brl',
        language: 'Portuguese',
        transactionDate: 'hoje',
      }),
      'Registra 119,90 reais',
      now,
    );
    expect(normalized).toMatchObject({
      amount: '119.90',
      currency: 'BRL',
      language: 'pt',
      transactionDate: '2026-10-09',
      confirmationQuestion: null,
    });
  });

  it('preserves literal numbers and escaped amount keys in merchant text', () => {
    const merchant = 'Store 45: "amount": 999.99';
    expect(
      normalizePrepareExpenseArguments(
        JSON.stringify({ ...actual, merchant }),
        'expense',
        now,
      ).merchant,
    ).toBe(merchant);
  });

  it.each([
    { ...actual, amount: '45.001' },
    { ...actual, amount: -45 },
    { ...actual, currency: 'USD' },
    { ...actual, transactionDate: '2026-02-30' },
    { ...actual, merchant: 45 },
    { ...actual, description: 45 },
    { ...actual, language: 'fr', confirmationQuestion: 'Save 45 EUR?' },
  ])('does not weaken validation or round invalid input %j', (raw) => {
    const dto = plainToInstance(
      PrepareExpenseDto,
      normalizePrepareExpenseArguments(JSON.stringify(raw), 'expense', now),
    );
    expect(
      validateSync(dto, { whitelist: true, forbidNonWhitelisted: true }).length,
    ).toBeGreaterThan(0);
  });

  it('preserves domain rejection of zero after normalization', () => {
    const normalized = normalizePrepareExpenseArguments(
      JSON.stringify({ ...actual, amount: 0 }),
      'expense',
      now,
    );
    const { language, confirmationQuestion, ...input } = normalized;
    void language;
    void confirmationQuestion;
    const service = new ExpensesService({} as PrismaService);
    expect(() =>
      service.validateCreate(input as unknown as PrepareExpenseDto),
    ).toThrow('amount must be greater than 0');
  });
});

import {
  BadGatewayException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { AiService } from './ai.service.js';
import { AnalyticsService } from '../analytics/analytics.service.js';
import { ExpensesService } from '../expenses/expenses.service.js';
import { ConversationService } from '../conversations/conversation.service.js';

const { create } = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('openai', () => ({
  default: class {
    responses = { create };
  },
}));

describe('AiService', () => {
  let service: AiService;
  const monthlySummary = vi.fn();
  const byMerchant = vi.fn();
  const findAll = vi.fn();
  const conversationId = '11111111-1111-4111-8111-111111111111';
  const conversations = {
    create: vi.fn(),
    recentMessages: vi.fn(),
    saveTurn: vi.fn(),
  };
  const summary = {
    period: { year: 2026, month: 10 },
    totals: { EUR: '78.50', BRL: '119.90' },
  };
  const call = (name: string, args: string) => ({
    status: 'completed',
    output: [
      {
        type: 'function_call',
        name,
        arguments: args,
        call_id: 'call1',
        id: 'fc1',
      },
    ],
    output_text: '',
  });
  const final = {
    status: 'completed',
    output: [],
    output_text: 'EUR 78.50 and BRL 119.90',
  };

  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv('OPENAI_API_KEY', 'test-key');
    conversations.create.mockResolvedValue({ id: conversationId });
    conversations.recentMessages.mockResolvedValue([]);
    conversations.saveTurn.mockResolvedValue(undefined);
    monthlySummary.mockResolvedValue(summary);
    byMerchant.mockResolvedValue([
      { merchant: 'Tesco', currency: 'EUR', total: '78.50' },
    ]);
    findAll.mockResolvedValue([
      { merchant: 'Tesco', currency: 'EUR', amount: '78.5000' },
    ]);
    service = new AiService(
      { monthlySummary, byMerchant } as unknown as AnalyticsService,
      { findAll } as unknown as ExpensesService,
      conversations as unknown as ConversationService,
    );
  });
  afterEach(() => vi.unstubAllEnvs());

  it('calls monthly service and returns tool results to the SDK without mixing currencies', async () => {
    create
      .mockResolvedValueOnce(
        call('get_monthly_summary', '{"year":2026,"month":10}'),
      )
      .mockResolvedValueOnce(final);
    expect(
      await service.chat({ message: 'How much in October 2026?' }),
    ).toEqual({ conversationId, answer: final.output_text });
    expect(monthlySummary).toHaveBeenCalledWith({ year: '2026', month: '10' });
    const result = create.mock.calls[1][0].input.find(
      (item: { type?: string }) => item.type === 'function_call_output',
    );
    expect(JSON.parse(result.output)).toEqual(summary);
    expect(result.call_id).toBe('call1');
  });

  it('calls expense filters and domain merchant analytics without calculating totals', async () => {
    create
      .mockResolvedValueOnce(
        call(
          'get_expenses',
          '{"currency":"EUR","merchant":"Tesco","from":"2026-10-01","to":"2026-10-31"}',
        ),
      )
      .mockResolvedValueOnce({ ...final, output_text: 'EUR 78.50' });
    await service.chat({ message: 'What did I spend at Tesco in October?' });
    expect(findAll).toHaveBeenCalledWith(
      expect.objectContaining({
        currency: 'EUR',
        merchant: 'Tesco',
        from: '2026-10-01',
        to: '2026-10-31',
      }),
    );
    expect(byMerchant).toHaveBeenCalledWith({
      from: '2026-10-01',
      to: '2026-10-31',
    });
    expect(create.mock.calls[1][0].input).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'function_call_output',
          output: expect.stringContaining('merchantTotals'),
        }),
      ]),
    );
  });

  it.each([
    ['get_monthly_summary', '{"year":2026,"month":13}'],
    ['get_monthly_summary', '{"year":"2026","month":10}'],
    ['get_monthly_summary', '{"year":2026,"month":10,"sql":"secret"}'],
    ['get_expenses', '{"currency":"USD"}'],
    ['get_expenses', '{"from":"bad"}'],
    ['create_expense', '{}'],
    ['get_expenses', 'not-json'],
    ['get_expenses', '[]'],
  ])(
    'rejects unsafe tool %s %s without calling domain services',
    async (name, args) => {
      create
        .mockResolvedValueOnce(call(name, args))
        .mockResolvedValueOnce(final);
      const response = await service.chat({ message: 'Show spending' });
      expect(monthlySummary).not.toHaveBeenCalled();
      expect(findAll).not.toHaveBeenCalled();
      expect(byMerchant).not.toHaveBeenCalled();
      expect(response.answer).toContain('No financial data');
      expect(create.mock.calls[1][0].input).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            output: expect.stringContaining('Invalid tool arguments'),
          }),
        ]),
      );
    },
  );

  it.each([
    'No Amazon expenses found in January 2025.',
    'No Tesco expenses found from October 1 to October 31, 2026.',
    'No expenses found. There are 0 matching transactions.',
  ])(
    'allows dates, years and counts in empty-result answers: %s',
    async (answer) => {
      findAll.mockResolvedValue([]);
      byMerchant.mockResolvedValue([]);
      create
        .mockResolvedValueOnce(
          call(
            'get_expenses',
            '{"merchant":"Amazon","from":"2025-01-01","to":"2025-01-31"}',
          ),
        )
        .mockResolvedValueOnce({ ...final, output_text: answer });
      expect(
        await service.chat({ message: 'Show my merchant expenses' }),
      ).toEqual({ conversationId, answer });
      const result = create.mock.calls[1][0].input.find(
        (item: { type?: string }) => item.type === 'function_call_output',
      );
      expect(JSON.parse(result.output)).toEqual({
        expenses: [],
        merchantTotals: [],
      });
    },
  );

  it('allows date ranges and counts with nonempty financial results', async () => {
    const answer =
      '1 Tesco expense from October 1 to October 31, 2026: EUR 78.50.';
    create
      .mockResolvedValueOnce(
        call(
          'get_expenses',
          '{"merchant":"Tesco","from":"2026-10-01","to":"2026-10-31"}',
        ),
      )
      .mockResolvedValueOnce({ ...final, output_text: answer });
    expect(
      await service.chat({
        message:
          'Show my Tesco expenses from October 1st to October 31st 2026.',
      }),
    ).toEqual({ conversationId, answer });
  });

  it('retains monthly-summary answers with localized decimals and separate currencies', async () => {
    const answer = 'Este mês, você gastou 78,50 EUR e 119,90 BRL.';
    create
      .mockResolvedValueOnce(
        call('get_monthly_summary', '{"year":2026,"month":10}'),
      )
      .mockResolvedValueOnce({ ...final, output_text: answer });
    expect(
      await service.chat({ message: 'How much did I spend this month?' }),
    ).toEqual({ conversationId, answer });
    expect(create.mock.calls[0][0].instructions).toContain(
      'Never combine different currencies',
    );
    expect(create.mock.calls[0][0].instructions).toContain(
      'quote only backend totals or individual expense amounts',
    );
  });

  it('hides provider errors and secrets', async () => {
    create.mockRejectedValue(new Error('test-key upstream trace'));
    await expect(service.chat({ message: 'this month' })).rejects.toThrow(
      'Unable to complete the finance request',
    );
    await expect(
      service.chat({ message: 'this month' }),
    ).rejects.toBeInstanceOf(BadGatewayException);
  });

  it('does not expose domain 400 stack traces', async () => {
    const { BadRequestException } = await import('@nestjs/common');
    findAll.mockRejectedValue(new BadRequestException('private stack trace'));
    create
      .mockResolvedValueOnce(call('get_expenses', '{}'))
      .mockResolvedValueOnce(final);
    await service.chat({ message: 'expenses' });
    expect(JSON.stringify(create.mock.calls[1][0].input)).not.toContain(
      'private stack trace',
    );
  });

  it('requires configuration only when chat is called', async () => {
    vi.stubEnv('OPENAI_API_KEY', '');
    await expect(
      service.chat({ message: 'this month' }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(create).not.toHaveBeenCalled();
  });

  it('bounds tool loops', async () => {
    create.mockResolvedValue(
      call('get_monthly_summary', '{"year":2026,"month":10}'),
    );
    await expect(service.chat({ message: 'this month' })).rejects.toThrow(
      'AI tool limit exceeded',
    );
    expect(create).toHaveBeenCalledTimes(4);
  });

  it('supplies a UTC reference and requires explicit dates to take precedence', async () => {
    create.mockResolvedValue(final);
    await service.chat({ message: 'October 2026' });
    expect(create.mock.calls[0][0].instructions).toContain(
      new Date().toISOString().slice(0, 10),
    );
    expect(create.mock.calls[0][0].instructions).toContain(
      'Explicit dates always take precedence',
    );
  });

  it('creates a new conversation and persists only visible content', async () => {
    create
      .mockResolvedValueOnce(
        call('get_monthly_summary', '{"year":2026,"month":10}'),
      )
      .mockResolvedValueOnce(final);
    await service.chat({ message: 'October 2026?' });
    expect(conversations.create).toHaveBeenCalledOnce();
    expect(conversations.recentMessages).not.toHaveBeenCalled();
    expect(conversations.saveTurn).toHaveBeenCalledWith(
      conversationId,
      'October 2026?',
      final.output_text,
    );
  });

  it('reuses conversation context for September but obtains fresh merchant figures', async () => {
    conversations.recentMessages.mockResolvedValue([
      { role: 'USER', content: 'How much at Tesco in October 2026?' },
      { role: 'ASSISTANT', content: 'You spent EUR 999.00.' },
    ]);
    create
      .mockResolvedValueOnce(
        call(
          'get_expenses',
          '{"merchant":"Tesco","from":"2026-09-01","to":"2026-09-30"}',
        ),
      )
      .mockResolvedValueOnce({
        ...final,
        output_text: 'In September, EUR 78.50 at Tesco.',
      });
    const result = await service.chat({
      conversationId,
      message: 'And in September?',
    });
    expect(result.conversationId).toBe(conversationId);
    expect(result.answer).not.toContain('999.00');
    expect(conversations.create).not.toHaveBeenCalled();
    expect(conversations.recentMessages).toHaveBeenCalledWith(conversationId);
    expect(create.mock.calls[0][0].input.slice(0, 3)).toEqual([
      { role: 'user', content: 'How much at Tesco in October 2026?' },
      { role: 'assistant', content: 'You spent EUR 999.00.' },
      { role: 'user', content: 'And in September?' },
    ]);
    expect(findAll).toHaveBeenCalledWith(
      expect.objectContaining({
        merchant: 'Tesco',
        from: '2026-09-01',
        to: '2026-09-30',
      }),
    );
    expect(create.mock.calls[0][0].instructions).toContain(
      'retrieve fresh data',
    );
  });

  it('does not accept historical assistant figures without a successful tool in the current turn', async () => {
    conversations.recentMessages.mockResolvedValue([
      { role: 'ASSISTANT', content: 'EUR 999.00 and BRL 111.00' },
    ]);
    create.mockResolvedValue({
      ...final,
      output_text: 'EUR 999.00 and BRL 111.00',
    });
    const result = await service.chat({
      conversationId,
      message: 'And in BRL?',
    });
    expect(result.answer).toContain('No financial data');
    expect(result.answer).not.toContain('111.00');
  });

  it('does not persist an unsuccessful OpenAI turn', async () => {
    create.mockRejectedValue(new Error('upstream failure'));
    await expect(
      service.chat({ conversationId, message: 'follow-up' }),
    ).rejects.toBeInstanceOf(BadGatewayException);
    expect(conversations.saveTurn).not.toHaveBeenCalled();
  });

  it('compares a successfully queried empty period as zero in the relevant currency', async () => {
    conversations.recentMessages.mockResolvedValue([
      { role: 'USER', content: 'How much at Tesco in October 2026 in EUR?' },
      { role: 'ASSISTANT', content: 'EUR 78.50' },
    ]);
    findAll
      .mockResolvedValueOnce([
        { merchant: 'Tesco', currency: 'EUR', amount: '78.5000' },
      ])
      .mockResolvedValueOnce([]);
    byMerchant
      .mockResolvedValueOnce([
        { merchant: 'Tesco', currency: 'EUR', total: '78.50' },
      ])
      .mockResolvedValueOnce([]);
    const answer =
      'October: EUR 78.50. September: EUR 0.00, with no matching expenses.';
    create
      .mockResolvedValueOnce(
        call(
          'get_expenses',
          '{"currency":"EUR","merchant":"Tesco","from":"2026-10-01","to":"2026-10-31"}',
        ),
      )
      .mockResolvedValueOnce(
        call(
          'get_expenses',
          '{"currency":"EUR","merchant":"Tesco","from":"2026-09-01","to":"2026-09-30"}',
        ),
      )
      .mockResolvedValueOnce({ ...final, output_text: answer });
    expect(
      await service.chat({
        conversationId,
        message: 'Compare that with September.',
      }),
    ).toEqual({ conversationId, answer });
    expect(findAll).toHaveBeenCalledTimes(2);
    expect(byMerchant).toHaveBeenCalledTimes(2);
    const instructions = create.mock.calls[0][0].instructions;
    expect(instructions).toContain(
      "treat that period's total as 0.00 for the relevant currency",
    );
    expect(instructions).toContain(
      'never treat tool errors or unavailable data as zero',
    );
    const results = create.mock.calls[2][0].input.filter(
      (item: { type?: string }) => item.type === 'function_call_output',
    );
    expect(JSON.parse(results[1].output)).toEqual({
      expenses: [],
      merchantTotals: [],
    });
  });

  it('keeps Prisma out of the AI service and module', () => {
    for (const name of ['ai.service.ts', 'ai.module.ts', 'ai.controller.ts']) {
      const source = readFileSync(new URL(name, import.meta.url), 'utf8');
      expect(source).not.toMatch(/Prisma|prisma\//);
    }
  });
});

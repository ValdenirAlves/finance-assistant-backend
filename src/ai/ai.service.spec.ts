import {
  BadGatewayException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { AiService } from './ai.service.js';
import { AnalyticsService } from '../analytics/analytics.service.js';
import { ExpensesService } from '../expenses/expenses.service.js';
import { ConversationService } from '../conversations/conversation.service.js';
import { PendingExpenseService } from '../pending-expenses/pending-expense.service.js';

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
  const spendingPace = vi.fn();
  const byCategory = vi.fn();
  const findAll = vi.fn();
  const pendingExpenses = { get: vi.fn() };
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
    vi.stubEnv('OPENAI_CHAT_MODEL', 'gpt-6-luna');
    vi.stubEnv('OPENAI_CLASSIFICATION_MODEL', 'gpt-6-luna');
    pendingExpenses.get.mockResolvedValue(null);
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
      {
        monthlySummary,
        byMerchant,
        spendingPace,
        byCategory,
      } as unknown as AnalyticsService,
      { findAll } as unknown as ExpensesService,
      conversations as unknown as ConversationService,
      pendingExpenses as unknown as PendingExpenseService,
    );
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it.each([
    ['Quanto gastei com supermercados?', 'GROCERIES'],
    ['Quanto gastei com pets?', 'PETS'],
    ['Quanto gastei em outros gastos?', 'OTHER'],
  ])(
    'resolves missing period on the backend and requires a category tool: %s',
    async (message, category) => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-10-15T12:00:00Z'));
      byCategory.mockResolvedValue([
        { category, currency: 'EUR', total: '20.00' },
      ]);
      create
        .mockResolvedValueOnce(
          call(
            'get_by_category',
            JSON.stringify({
              from: '1999-01-01',
              to: '1999-01-31',
              category: null,
              excludeCategories: null,
            }),
          ),
        )
        .mockResolvedValueOnce({
          ...final,
          output_text: 'Você gastou 20.00 EUR.',
        });
      const result = await service.chat({ message });
      expect(create.mock.calls[0][0].tool_choice).toEqual({
        type: 'function',
        name: 'get_by_category',
      });
      expect(byCategory).toHaveBeenCalledWith(
        expect.objectContaining({
          from: '2026-10-01',
          to: '2026-10-15',
          category,
        }),
      );
      expect(result.answer).toBe('Você gastou 20.00 EUR.');
    },
  );
  it('uses exclusions rather than OTHER for the exact reported query', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-15T12:00:00Z'));
    byCategory.mockResolvedValue([
      { category: 'TRANSPORT', currency: 'EUR', total: '20.00' },
    ]);
    create
      .mockResolvedValueOnce(
        call(
          'get_by_category',
          JSON.stringify({
            from: '2026-01-01',
            to: '2026-01-31',
            category: 'OTHER',
          }),
        ),
      )
      .mockResolvedValueOnce({
        ...final,
        output_text: 'Transporte: 20.00 EUR.',
      });
    await service.chat({
      message: 'Quanto eu gastei em outras despesas, além de mercado e pets?',
    });
    expect(byCategory).toHaveBeenCalledWith(
      expect.objectContaining({
        from: '2026-10-01',
        to: '2026-10-15',
        category: undefined,
        excludeCategories: ['GROCERIES', 'PETS'],
      }),
    );
  });
  it.each([
    ['Quanto gastei ontem?', '2026-10-14', '2026-10-14'],
    ['Quanto gastei em setembro?', '2026-09-01', '2026-09-30'],
    ['Quanto gastei entre 1 e 10 de outubro?', '2026-10-01', '2026-10-10'],
    ['Quanto gastei este ano?', '2026-01-01', '2026-12-31'],
  ])('preserves explicit dates for %s', async (message, from, to) => {
    create
      .mockResolvedValueOnce(call('get_expenses', JSON.stringify({ from, to })))
      .mockResolvedValueOnce(final);
    await service.chat({ message });
    expect(findAll).toHaveBeenCalledWith(expect.objectContaining({ from, to }));
  });
  it('defaults direct merchant spending to the same UTC period', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-15T12:00:00Z'));
    create
      .mockResolvedValueOnce(call('get_expenses', '{"merchant":"Tesco"}'))
      .mockResolvedValueOnce(final);
    await service.chat({ message: 'How much did I spend at Tesco?' });
    expect(findAll).toHaveBeenCalledWith(
      expect.objectContaining({
        merchant: 'Tesco',
        from: '2026-10-01',
        to: '2026-10-15',
      }),
    );
  });
  it.each([
    'Você estava pensando no intervalo da viagem ou no período depois dela?',
    'Me diga se devo olhar só o feriado ou também os dias seguintes',
    'Would you like me to check the trip itself or the days afterwards?',
    '¿Te refieres al viaje o también a los días posteriores?',
  ])(
    'returns a semantic clarification without matching its language or punctuation: %s',
    async (answer) => {
      create.mockResolvedValueOnce(
        call('ask_clarification', JSON.stringify({ question: answer })),
      );
      expect((await service.chat({ message: 'Could you help?' })).answer).toBe(
        answer,
      );
      expect(create).toHaveBeenCalledOnce();
      expect(create.mock.calls[0][0].tools).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: 'ask_clarification',
            strict: true,
            parameters: expect.objectContaining({
              additionalProperties: false,
              required: ['question'],
            }),
          }),
        ]),
      );
      expect(monthlySummary).not.toHaveBeenCalled();
      expect(byCategory).not.toHaveBeenCalled();
      expect(findAll).not.toHaveBeenCalled();
      expect(conversations.saveTurn).toHaveBeenCalledWith(
        conversationId,
        'Could you help?',
        answer,
      );
    },
  );
  it.each([
    'not-json',
    'null',
    '[]',
    '{}',
    '{"question":null}',
    '{"question":42}',
    '{"question":"   "}',
    '{"question":"Which scope?","confirmed":true}',
    JSON.stringify({ question: 'x'.repeat(1001) }),
  ])(
    'rejects malformed control arguments without calling domain tools: %s',
    async (args) => {
      create.mockResolvedValueOnce(call('ask_clarification', args));
      await expect(
        service.chat({ message: 'Could you help?' }),
      ).rejects.toThrow();
      expect(byCategory).not.toHaveBeenCalled();
      expect(findAll).not.toHaveBeenCalled();
      expect(conversations.saveTurn).not.toHaveBeenCalled();
    },
  );
  it('does not treat question-shaped direct prose as a control action', async () => {
    create.mockResolvedValueOnce({
      ...final,
      output_text: 'Which part of the trip did you mean?',
    });
    expect(
      (await service.chat({ message: 'Could you help?' })).answer,
    ).toContain('No financial data');
  });
  it('uses only the control question and discards accompanying financial prose', async () => {
    const question = 'Which part of the trip did you mean?';
    create.mockResolvedValueOnce({
      ...call('ask_clarification', JSON.stringify({ question })),
      output_text: 'You spent EUR 999.00.',
    });
    expect((await service.chat({ message: 'Could you help?' })).answer).toBe(
      question,
    );
  });
  it('rejects mixed control/financial tool batches before any financial execution', async () => {
    const financial = call('get_monthly_summary', '{"year":2026,"month":10}');
    const control = call('ask_clarification', '{"question":"Which scope?"}');
    create.mockResolvedValueOnce({
      ...financial,
      output: [...financial.output, ...control.output],
    });
    await expect(service.chat({ message: 'Could you help?' })).rejects.toThrow(
      'Clarification must be requested separately',
    );
    expect(monthlySummary).not.toHaveBeenCalled();
    expect(conversations.saveTurn).not.toHaveBeenCalled();
  });
  it('does not authorize balance disclosure through clarification arguments', async () => {
    create.mockResolvedValueOnce(
      call(
        'ask_clarification',
        '{"question":"Seu saldo é 999 EUR. Qual período deseja?"}',
      ),
    );
    const result = await service.chat({
      message: 'Quanto gastei naquela viagem?',
    });
    expect(result.answer).not.toContain('999');
    expect(result.answer).toContain('Consulte o saldo explicitamente');
  });
  it('keeps failed financial tools unverified when they are followed by clarification', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    try {
      create
        .mockResolvedValueOnce(
          call('get_monthly_summary', '{"year":2026,"month":13}'),
        )
        .mockResolvedValueOnce(
          call(
            'ask_clarification',
            '{"question":"Which month did you have in mind?"}',
          ),
        );
      expect((await service.chat({ message: 'Could you help?' })).answer).toBe(
        'Which month did you have in mind?',
      );
      expect(debug).toHaveBeenCalledWith(
        expect.stringContaining('"financialToolSucceeded":false'),
      );
      expect(monthlySummary).not.toHaveBeenCalled();
    } finally {
      debug.mockRestore();
    }
  });
  it('does not let clarification authorize financial prose in a later turn', async () => {
    create
      .mockResolvedValueOnce(
        call('ask_clarification', '{"question":"Which trip do you mean?"}'),
      )
      .mockResolvedValueOnce({
        ...final,
        output_text: 'You spent EUR 999.00.',
      });
    await service.chat({ message: 'Could you help?' });
    expect(
      (await service.chat({ message: 'The last trip', conversationId })).answer,
    ).toContain('No financial data');
    expect(monthlySummary).not.toHaveBeenCalled();
  });
  it.each([
    'Você gastou 99 EUR.',
    'Você não gastou nada.',
    'Você gastou vinte euros?',
    'De qual período você quer saber? Você gastou 99 EUR.',
  ])(
    'does not publish unverified financial claims: %s',
    async (output_text) => {
      create.mockResolvedValueOnce({ ...final, output_text });
      const result = await service.chat({ message: 'Quanto gastei?' });
      expect(result.answer).toContain('Não foi possível verificar');
      expect(result.answer).not.toBe(output_text);
    },
  );
  it('blocks invented financial answers after a rejected exclusion argument', async () => {
    create
      .mockResolvedValueOnce(
        call(
          'get_by_category',
          '{"from":"2026-10-01","to":"2026-10-15","category":null,"excludeCategories":["INVALID"]}',
        ),
      )
      .mockResolvedValueOnce({ ...final, output_text: 'Você gastou 99 EUR.' });
    expect(
      (await service.chat({ message: 'Quanto gastei?' })).answer,
    ).toContain('Não foi possível verificar');
    expect(byCategory).not.toHaveBeenCalled();
  });
  it('does not hide invalid date ranges behind the default period', async () => {
    create
      .mockResolvedValueOnce(
        call(
          'get_by_category',
          '{"from":"2026-10-20","to":"2026-10-01","category":"PETS"}',
        ),
      )
      .mockResolvedValueOnce(final);
    expect(
      (await service.chat({ message: 'Quanto gastei com pets?' })).answer,
    ).toContain('Não foi possível verificar');
    expect(byCategory).not.toHaveBeenCalled();
  });
  it('preserves OTHER without exclusions for an explicit current-month query', async () => {
    byCategory.mockResolvedValue([]);
    create
      .mockResolvedValueOnce(
        call(
          'get_by_category',
          '{"from":"2026-10-01","to":"2026-10-15","category":"OTHER","excludeCategories":null}',
        ),
      )
      .mockResolvedValueOnce(final);
    await service.chat({
      message: 'Quanto gastei com outros gastos este mês?',
    });
    expect(byCategory).toHaveBeenCalledWith(
      expect.objectContaining({
        category: 'OTHER',
        excludeCategories: undefined,
      }),
    );
  });

  it.each([
    'What is my weekly average at Tesco this month?',
    'How much am I projected to spend this month?',
  ])('uses backend pace figures for %s', async (message) => {
    const pace = {
      period: { daysElapsed: 13 },
      results: [
        {
          currency: 'EUR',
          weeklyAverage: '136.07',
          projectedMonthTotal: '602.59',
        },
      ],
    };
    spendingPace.mockResolvedValue(pace);
    create
      .mockResolvedValueOnce(
        call(
          'get_spending_pace',
          JSON.stringify({
            year: 2026,
            month: 10,
            merchant: 'Tesco',
            currency: 'EUR',
          }),
        ),
      )
      .mockResolvedValueOnce(final);
    await service.chat({ message });
    expect(spendingPace).toHaveBeenCalledExactlyOnceWith({
      year: '2026',
      month: '10',
      merchant: 'Tesco',
      currency: 'EUR',
    });
    expect(create.mock.calls[0][0].instructions).toContain(
      'Never invent week counts or compute projections',
    );
    expect(JSON.stringify(create.mock.calls[1][0].input)).toContain('602.59');
  });

  it('calls monthly service and returns tool results to the SDK without mixing currencies', async () => {
    create
      .mockResolvedValueOnce(
        call('get_monthly_summary', '{"year":2026,"month":10}'),
      )
      .mockResolvedValueOnce(final);
    expect(
      await service.chat({ message: 'How much in October 2026?' }),
    ).toEqual({ conversationId, answer: final.output_text });
    expect(create.mock.calls.map(([payload]) => payload.model)).toEqual([
      'gpt-6-luna',
      'gpt-6-luna',
    ]);
    expect(monthlySummary).toHaveBeenCalledWith({ year: '2026', month: '10' });
    const result = create.mock.calls[1][0].input.find(
      (item: { type?: string }) => item.type === 'function_call_output',
    );
    expect(JSON.parse(result.output)).toEqual(summary);
    expect(result.call_id).toBe('call1');
  });

  it.each(['groceries', 'pets', 'restaurants', 'subscriptions', 'transport'])(
    'sends natural category wording instructions for %s',
    async (category) => {
      create
        .mockResolvedValueOnce(
          call('get_monthly_summary', '{"year":2026,"month":10}'),
        )
        .mockResolvedValueOnce(final);
      await service.chat({
        message: `How much did I spend on ${category} this month?`,
      });
      expect(create.mock.calls[0][0].instructions).toContain(
        'Use natural-language category labels in the sentence. Do not append the category label or enum in parentheses unless the user explicitly asks for the internal category.',
      );
      expect(create.mock.calls[0][0].instructions).toContain(
        "Apply this to groceries, pets, restaurants, subscriptions and transport, using natural grammatical inflections in the user's language.",
      );
    },
  );

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

import {
  RealtimeTurnFilterService,
  TURN_FILTER_TIMEOUT_MS,
} from './realtime-turn-filter.service.js';
import type { TurnFilterInput } from './realtime-turn-filter.service.js';
import { RealtimeConfig, resolveRealtimeConfig } from '../openai.config.js';
import type { ConversationService } from '../../conversations/conversation.service.js';
import type { PendingExpenseService } from '../../pending-expenses/pending-expense.service.js';
import type { BudgetsService } from '../../budgets/budgets.service.js';
import type { BankAccountsService } from '../../bank-accounts/bank-accounts.service.js';
const { create } = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('openai', () => ({
  default: class {
    responses = { create };
  },
}));
describe('semantic realtime directionality classifier', () => {
  let service: RealtimeTurnFilterService;
  const recentMessages = vi.fn(),
    expense = vi.fn(),
    budget = vi.fn(),
    bank = vi.fn();
  const input: TurnFilterInput = {
    conversationId: 'conversation',
    transcript: 'E com pets?',
    assistantState: 'listening',
    conversationState: {
      acceptedTurns: 1,
      resumed: false,
      arrivedDuringTool: false,
    },
  };
  const decision = (
    classification: string,
    reasonCode: string,
    pendingAction: string | null = null,
  ) => ({
    status: 'completed',
    output: [],
    output_text: JSON.stringify({ classification, reasonCode, pendingAction }),
  });
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv('OPENAI_API_KEY', 'test-key');
    recentMessages.mockResolvedValue([
      { role: 'USER', content: 'Quanto gastei com supermercados?' },
      {
        role: 'ASSISTANT',
        content: 'Você gastou 252.70 EUR com supermercados.',
      },
    ]);
    expense.mockResolvedValue(null);
    budget.mockResolvedValue(null);
    bank.mockResolvedValue(null);
    service = new RealtimeTurnFilterService(
      {
        settings: resolveRealtimeConfig({
          OPENAI_REALTIME_FILTER_MODEL: 'test-filter-model',
        }),
      } as RealtimeConfig,
      { recentMessages } as unknown as ConversationService,
      { get: expense } as unknown as PendingExpenseService,
      { getPending: budget } as unknown as BudgetsService,
      { getPending: bank } as unknown as BankAccountsService,
    );
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });
  // These are mocked semantic outcomes, not production phrase rules. The tests
  // establish input context and enforcement, not live model accuracy.
  it.each([
    [
      'E com pets?',
      'listening',
      'DIRECTED_TO_ASSISTANT',
      'CONTEXTUAL_FOLLOW_UP',
    ],
    [
      'E supermercado?',
      'listening',
      'DIRECTED_TO_ASSISTANT',
      'CONTEXTUAL_FOLLOW_UP',
    ],
    [
      'E no Tesco?',
      'listening',
      'DIRECTED_TO_ASSISTANT',
      'CONTEXTUAL_FOLLOW_UP',
    ],
    [
      'Você vai sair hoje?',
      'listening',
      'LIKELY_INCIDENTAL',
      'UNRELATED_CONVERSATION',
    ],
    [
      'A comida já está pronta na cozinha.',
      'listening',
      'LIKELY_INCIDENTAL',
      'UNRELATED_CONVERSATION',
    ],
    [
      'Quanto você gastou no Tesco?',
      'listening',
      'UNCERTAIN',
      'AMBIGUOUS_DIRECTION',
    ],
    [
      'VAS, consulte meus gastos deste mês.',
      'listening',
      'DIRECTED_TO_ASSISTANT',
      'EXPLICIT_REQUEST',
    ],
    [
      'Qual é o saldo dele?',
      'listening',
      'UNCERTAIN',
      'PRIVATE_CONTEXT_WITHHELD',
    ],
    [
      'Você vai sair hoje?',
      'speaking',
      'LIKELY_INCIDENTAL',
      'UNRELATED_CONVERSATION',
    ],
    [
      'VAS, pare e consulte os gastos com pets.',
      'speaking',
      'DIRECTED_TO_ASSISTANT',
      'EXPLICIT_REQUEST',
    ],
  ])(
    'passes semantic/context signals for %s',
    async (transcript, assistantState, classification, reasonCode) => {
      create.mockResolvedValueOnce(decision(classification, reasonCode));
      expect(
        await service.classify({ ...input, transcript, assistantState }),
      ).toEqual({ classification, reasonCode, pendingStateExists: false });
      const request = create.mock.calls[0][0];
      expect(request).toMatchObject({
        model: 'test-filter-model',
        store: false,
        tools: [],
        tool_choice: 'none',
        max_output_tokens: 256,
      });
      const context = JSON.parse(request.input);
      expect(context.assistantState).toBe(assistantState);
      expect(context.conversationState).toEqual(input.conversationState);
      expect(context.recentMessages[0].content).toBe(
        'Quanto gastei com supermercados?',
      );
      expect(request.input).not.toContain('252.70');
      expect(request.instructions).not.toContain(transcript);
    },
  );
  it.each(['Pode salvar.', 'Cancela.', 'Sim.', 'Não.'])(
    'supplies active pending metadata for contextual replies: %s',
    async (transcript) => {
      expense.mockResolvedValue({
        status: 'PENDING',
        confirmationRequested: true,
        amount: '999.99',
        merchant: 'Private merchant',
      });
      create.mockResolvedValueOnce(
        decision('DIRECTED_TO_ASSISTANT', 'PENDING_RESPONSE', 'CONFIRM'),
      );
      expect(await service.classify({ ...input, transcript })).toMatchObject({
        classification: 'DIRECTED_TO_ASSISTANT',
        pendingStateExists: true,
      });
      const context = JSON.parse(create.mock.calls[0][0].input);
      expect(context.pendingState).toEqual([
        { kind: 'EXPENSE', confirmationRequested: true },
      ]);
      expect(JSON.stringify(context)).not.toContain('999.99');
      expect(JSON.stringify(context)).not.toContain('Private merchant');
    },
  );
  it('omits full bank interactions, including spelled-out values, and passes status metadata only', async () => {
    recentMessages.mockResolvedValue([
      { role: 'ASSISTANT', content: 'Seu saldo é três mil euros.' },
    ]);
    bank.mockResolvedValue({
      status: 'PENDING',
      confirmationRequested: true,
      currentBalance: '3208.00',
    });
    budget.mockResolvedValue({
      status: 'PENDING',
      confirmationRequested: false,
      amount: '999.99',
    });
    create.mockResolvedValueOnce(
      decision('UNCERTAIN', 'PRIVATE_CONTEXT_WITHHELD', 'UNCERTAIN'),
    );
    await service.classify({
      ...input,
      transcript: 'Meu saldo é 3208.00 EUR.',
    });
    const text = create.mock.calls[0][0].input;
    expect(text).not.toContain('3208');
    expect(text).not.toContain('três mil');
    expect(text).not.toContain('999.99');
    expect(JSON.parse(text)).toMatchObject({
      privateIntent: 'BALANCE_WRITE',
      pendingState: [
        { kind: 'BUDGET', confirmationRequested: false },
        { kind: 'BANK_BALANCE', confirmationRequested: true },
      ],
    });
  });
  it('bounds history and excludes cancelled/confirmed drafts from pending context', async () => {
    recentMessages.mockResolvedValue(
      Array.from({ length: 20 }, () => ({
        role: 'USER',
        content: 'Context '.repeat(200),
      })),
    );
    expense.mockResolvedValue({ status: 'CANCELLED' });
    budget.mockResolvedValue({ status: 'CONFIRMED' });
    create.mockResolvedValueOnce(decision('UNCERTAIN', 'AMBIGUOUS_DIRECTION'));
    const result = await service.classify(input);
    const context = JSON.parse(create.mock.calls[0][0].input);
    expect(context.recentMessages).toHaveLength(6);
    expect(context.recentMessages[0].content.length).toBeLessThanOrEqual(600);
    expect(result.pendingStateExists).toBe(false);
  });
  it.each([
    'not-json',
    '{"classification":"ACCEPT","reasonCode":"EXPLICIT_REQUEST"}',
    '{"classification":"DIRECTED_TO_ASSISTANT","reasonCode":"private free text"}',
    '{"classification":"DIRECTED_TO_ASSISTANT","reasonCode":"EXPLICIT_REQUEST","answer":"secret"}',
  ])(
    'reports unavailable rather than semantic uncertainty on invalid structured output',
    async (output_text) => {
      create.mockResolvedValueOnce({
        status: 'completed',
        output: [],
        output_text,
      });
      expect(await service.classify(input)).toMatchObject({
        classification: null,
        reasonCode: 'FILTER_UNAVAILABLE',
      });
    },
  );
  it('does not accept a model tool call as a classification', async () => {
    create.mockResolvedValueOnce({
      ...decision('DIRECTED_TO_ASSISTANT', 'EXPLICIT_REQUEST'),
      output: [{ type: 'function_call', name: 'finance_turn' }],
    });
    expect(await service.classify(input)).toMatchObject({
      classification: null,
      reasonCode: 'FILTER_UNAVAILABLE',
    });
  });
  it('reports provider unavailability without leaking provider errors', async () => {
    create.mockRejectedValueOnce(new Error('private provider details'));
    expect(await service.classify(input)).toEqual({
      classification: null,
      reasonCode: 'FILTER_UNAVAILABLE',
      pendingStateExists: false,
    });
  });
  it('aborts a slow classifier without retries', async () => {
    vi.useFakeTimers();
    create.mockImplementationOnce(() => new Promise(() => {}));
    const result = service.classify(input);
    await vi.advanceTimersByTimeAsync(TURN_FILTER_TIMEOUT_MS);
    expect(await result).toMatchObject({
      classification: null,
      reasonCode: 'FILTER_TIMEOUT',
    });
    expect(create).toHaveBeenCalledOnce();
    expect(create.mock.calls[0][1].signal.aborted).toBe(true);
  });
  it('bounds context loading too and never starts the model after that timeout', async () => {
    vi.useFakeTimers();
    recentMessages.mockImplementationOnce(() => new Promise(() => {}));
    const result = service.classify(input);
    await vi.advanceTimersByTimeAsync(TURN_FILTER_TIMEOUT_MS);
    expect(await result).toMatchObject({
      classification: null,
      reasonCode: 'FILTER_TIMEOUT',
    });
    expect(create).not.toHaveBeenCalled();
  });
  it('cancels classifier work when the runtime aborts the turn', async () => {
    const controller = new AbortController();
    create.mockImplementationOnce(() => new Promise(() => {}));
    const result = service.classify(input, controller.signal);
    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
    controller.abort();
    expect(await result).toMatchObject({
      classification: null,
      reasonCode: 'FILTER_CANCELLED',
    });
    expect(create.mock.calls[0][1].signal.aborted).toBe(true);
  });
  it('distinguishes an SDK timeout arriving before the outer deadline', async () => {
    const error = new Error('private provider error');
    error.name = 'APIConnectionTimeoutError';
    create.mockRejectedValueOnce(error);
    expect(await service.classify(input)).toMatchObject({
      classification: null,
      reasonCode: 'FILTER_TIMEOUT',
    });
  });
  it('never treats a pre-cancelled turn as an availability fallback', async () => {
    expect(await service.classify(input, AbortSignal.abort())).toMatchObject({
      classification: null,
      reasonCode: 'FILTER_CANCELLED',
    });
    expect(create).not.toHaveBeenCalled();
  });
  it.each(['CONFIRM', 'CANCEL', 'EDIT_PENDING', 'UNRELATED', 'UNCERTAIN'])(
    'returns structured pending action %s without interpreting sentence patterns in the backend',
    async (action) => {
      expense.mockResolvedValue({
        status: 'PENDING',
        confirmationRequested: true,
      });
      create.mockResolvedValueOnce(
        decision('DIRECTED_TO_ASSISTANT', 'PENDING_RESPONSE', action),
      );
      expect(
        await service.classify({
          ...input,
          transcript: 'A context-dependent utterance',
        }),
      ).toMatchObject({
        awaitingConfirmation: true,
        pendingAction: action,
        pendingStateExists: true,
      });
      const request = create.mock.calls[0][0];
      expect(request.text.format.schema.properties.pendingAction.enum).toEqual([
        'CONFIRM',
        'CANCEL',
        'EDIT_PENDING',
        'UNRELATED',
        'UNCERTAIN',
        null,
      ]);
      expect(request.instructions).toContain(
        'Mere acknowledgement is not save authorization',
      );
    },
  );
  it.each([null, 'SAVE'])(
    'rejects missing/invalid semantic pending action %s',
    async (action) => {
      expense.mockResolvedValue({
        status: 'PENDING',
        confirmationRequested: true,
      });
      create.mockResolvedValueOnce(
        decision('DIRECTED_TO_ASSISTANT', 'PENDING_RESPONSE', action),
      );
      expect(await service.classify(input)).toMatchObject({
        classification: null,
        reasonCode: 'FILTER_UNAVAILABLE',
        awaitingConfirmation: true,
      });
    },
  );
  it('retains a closed pending gate on timeout, including unknown context', async () => {
    vi.useFakeTimers();
    expense.mockResolvedValue({
      status: 'PENDING',
      confirmationRequested: true,
    });
    create.mockImplementationOnce(() => new Promise(() => {}));
    const first = service.classify(input);
    await vi.advanceTimersByTimeAsync(3000);
    expect(await first).toMatchObject({
      reasonCode: 'FILTER_TIMEOUT',
      awaitingConfirmation: true,
    });
    recentMessages.mockImplementationOnce(() => new Promise(() => {}));
    const second = service.classify(input);
    await vi.advanceTimersByTimeAsync(3000);
    expect(await second).toMatchObject({
      reasonCode: 'FILTER_TIMEOUT',
      awaitingConfirmation: 'unknown',
    });
  });
});

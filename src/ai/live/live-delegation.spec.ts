import type { ConnectServerEvent } from 'openai/resources/live/sideband/sideband';
import {
  LiveDelegation,
  LIVE_TURN_SETTLE_MS,
  resultEvents,
} from './live-delegation.js';
import type { LiveFinanceAdapter } from './live-finance.adapter.js';
import type { FinancialReadResult } from '../financial-read.js';

describe('client Live delegation correlation', () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const result: FinancialReadResult = {
    type: 'FINANCIAL_READ_RESULT',
    conversationId: id,
    balanceDisclosureAllowed: false,
    data: [
      {
        tool: 'get_monthly_summary',
        result: { totals: { EUR: '156.83', BRL: '97.00' } },
      },
    ],
  };
  const execute = vi.fn(),
    send = vi.fn(),
    log = vi.fn(),
    work = vi.fn();
  let delegation: LiveDelegation;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetAllMocks();
    execute.mockResolvedValue(result);
    delegation = new LiveDelegation({
      sessionId: 'session',
      conversationId: id,
      finance: { execute } as unknown as LiveFinanceAdapter,
      send,
      log,
      work,
    });
  });
  afterEach(() => {
    delegation.close();
    vi.useRealTimers();
  });
  const event = (value: object) =>
    delegation.accept(value as ConnectServerEvent);
  const input = (text: string, start: number, end: number) =>
    event({
      type: 'session.input_transcript.delta',
      delta: text,
      start_ms: start,
      end_ms: end,
      event_id: `u${start}`,
    });
  const request = (id = 'delegation1', offset = 1100, target = 'client') =>
    event({
      type: 'session.delegation.created',
      delegation: { id, type: 'delegation', target },
      offset_ms: offset,
      event_id: id,
    });
  const settle = () => vi.advanceTimersByTimeAsync(LIVE_TURN_SETTLE_MS);
  it('waits for all fragments and correlates complete text to the server session/conversation/delegation', async () => {
    input('Quanto eu ', 0, 500);
    request();
    await vi.advanceTimersByTimeAsync(500);
    expect(execute).not.toHaveBeenCalled();
    input('gastei este mês?', 501, 1100);
    await vi.advanceTimersByTimeAsync(1499);
    expect(execute).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(execute).toHaveBeenCalledExactlyOnceWith(
      {
        sessionId: 'session',
        conversationId: id,
        delegationId: 'delegation1',
        userTurn: 'Quanto eu gastei este mês?',
      },
      expect.any(AbortSignal),
      expect.objectContaining({ confirmationAllowed: true }),
    );
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'session.commentary.append',
        delegation_id: 'delegation1',
        content: JSON.stringify(result),
      }),
    );
  });
  it('can receive a delegation before its transcript and does not reuse older speech', async () => {
    input('Olá', 0, 100);
    await settle();
    request('future', 10000);
    await vi.advanceTimersByTimeAsync(500);
    expect(execute).not.toHaveBeenCalled();
    input('Quanto gastei no Tesco?', 9000, 9900);
    await settle();
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        delegationId: 'future',
        userTurn: 'Quanto gastei no Tesco?',
      }),
      expect.anything(),
      expect.anything(),
    );
  });
  it('preserves spaces delivered as separate transcript fragments', async () => {
    input('Quanto', 0, 400);
    input(' ', 401, 402);
    input('gastei?', 403, 1000);
    request();
    await settle();
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ userTurn: 'Quanto gastei?' }),
      expect.anything(),
      expect.anything(),
    );
  });
  it('never runs finance from transcript alone or Responses-owned delegations', async () => {
    input('Uma pergunta', 0, 1000);
    request('responses1', 1100, 'responses');
    await settle();
    expect(execute).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
  it('deduplicates events, delegation IDs and equivalent delegations for one turn', async () => {
    input('Quanto gastei?', 0, 1000);
    request();
    request();
    request('duplicate', 1200);
    await settle();
    expect(execute).toHaveBeenCalledOnce();
    request();
    await settle();
    expect(execute).toHaveBeenCalledOnce();
  });
  it('keeps the same conversation for contextual follow-ups', async () => {
    input('Quanto gastei este mês?', 0, 1000);
    request();
    await settle();
    input('E com pets?', 5000, 6000);
    request('pets', 6100);
    await settle();
    expect(execute).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        conversationId: id,
        userTurn: 'E com pets?',
        delegationId: 'pets',
      }),
      expect.anything(),
      expect.anything(),
    );
  });
  it('discards a late result after newer input and never attaches it to the new delegation', async () => {
    let finish!: (value: FinancialReadResult) => void;
    execute.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    input('Qual é meu saldo?', 0, 1000);
    request();
    await settle();
    const firstSignal = execute.mock.calls[0][1] as AbortSignal;
    input('E no Tesco?', 5000, 6000);
    request('tesco', 6100);
    await settle();
    expect(firstSignal.aborted).toBe(true);
    finish({ ...result, balanceDisclosureAllowed: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(send.mock.calls.map((call) => call[0].delegation_id)).not.toContain(
      'delegation1',
    );
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ delegation_id: 'tesco' }),
    );
  });
  it('reports a safe failure without closing the session and the next delegation succeeds', async () => {
    execute.mockRejectedValueOnce(new Error('sensitive database error'));
    input('Quanto gastei?', 0, 1000);
    request();
    await settle();
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('FINANCIAL_READ_UNAVAILABLE'),
      }),
    );
    expect(JSON.stringify(send.mock.calls)).not.toContain('sensitive');
    input('E com pets?', 5000, 6000);
    request('pets', 6100);
    await settle();
    expect(send).toHaveBeenLastCalledWith(
      expect.objectContaining({
        delegation_id: 'pets',
        content: JSON.stringify(result),
      }),
    );
  });
  it('asks safely when no correlated complete transcript arrives; does not guess', async () => {
    request();
    await vi.advanceTimersByTimeAsync(6000);
    expect(execute).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('TURN_UNAVAILABLE'),
      }),
    );
  });
  it('does not accept stale delegation offsets for a newer utterance', async () => {
    input('E com pets?', 5000, 6000);
    request('old', 1000);
    await settle();
    expect(execute).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
  it('cleanup cancels queued work and stops results after session close', async () => {
    input('Quanto gastei?', 0, 1000);
    request();
    delegation.close();
    await settle();
    expect(execute).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
  it('bounds an unresponsive read and allows a subsequent turn without replay', async () => {
    execute.mockImplementationOnce(() => new Promise(() => {}));
    input('Quanto gastei?', 0, 1000);
    request();
    await settle();
    await vi.advanceTimersByTimeAsync(35000);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('FINANCE_UNAVAILABLE'),
      }),
    );
    expect(execute.mock.calls[0][1].aborted).toBe(true);
    input('E com pets?', 40000, 41000);
    request('pets', 41100);
    await settle();
    expect(send).toHaveBeenLastCalledWith(
      expect.objectContaining({ delegation_id: 'pets' }),
    );
    expect(execute).toHaveBeenCalledTimes(2);
  });
  it('uses official, correlated append events with byte-safe token budgets and lossless financial values', () => {
    const large: FinancialReadResult = {
      ...result,
      type: 'FINANCIAL_READ_RESULT',
      data: [
        {
          tool: 'get_expenses',
          result: Array.from({ length: 12 }, () => ({
            merchant: 'Animais 🐶',
            amount: '33.33',
            currency: 'EUR',
          })),
        },
      ],
    };
    const events = resultEvents('d', large);
    expect(events.at(-1)?.type).toBe('session.commentary.append');
    const parts = events
      .slice(0, -1)
      .map(
        (event) => JSON.parse((event as { content: string }).content).fragment,
      )
      .join('');
    expect(JSON.parse(parts)).toEqual(large);
    for (const event of events) {
      expect(event).toMatchObject({ delegation_id: 'd' });
      expect(
        Buffer.byteLength((event as { content: string }).content),
      ).toBeLessThanOrEqual(500);
    }
  });
});

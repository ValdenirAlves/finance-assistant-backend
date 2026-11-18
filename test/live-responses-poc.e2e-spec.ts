import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { ConnectServerEvent } from 'openai/resources/live/sideband/sideband';
import { PocModule } from '../src/ai/live-responses-poc/poc.module.js';
import { PocTransport } from '../src/ai/live-responses-poc/poc.transport.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { Prisma } from '../src/generated/prisma/client.js';
import { AiService } from '../src/ai/ai.service.js';
import { LiveFinanceAdapter } from '../src/ai/live/live-finance.adapter.js';
import { pendingDatabase } from './helpers/pending-database.js';

describe('isolated managed Responses development endpoints', () => {
  let app: INestApplication,
    store: ReturnType<typeof pendingDatabase>,
    emit: (event: ConnectServerEvent) => void;
  const create = vi.fn(),
    send = vi.fn(),
    closeGracefully = vi.fn(),
    hangup = vi.fn();
  async function start(NODE_ENV = 'development', flag = 'true') {
    vi.stubEnv('NODE_ENV', NODE_ENV);
    vi.stubEnv('GPT_LIVE_RESPONSES_DELEGATION_EXPERIMENT', flag);
    const module = await Test.createTestingModule({ imports: [PocModule] })
      .overrideProvider(PrismaService)
      .useValue(store.database)
      .overrideProvider(PocTransport)
      .useValue({
        create,
        attach: vi.fn(async (_id, callback) => {
          emit = callback;
          return { send, closeGracefully };
        }),
        hangup,
      })
      .compile();
    expect(() => module.get(AiService)).toThrow();
    expect(() => module.get(LiveFinanceAdapter)).toThrow();
    app = module.createNestApplication();
    await app.init();
  }
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-28T12:00:00Z'));
    store = pendingDatabase();
    create.mockResolvedValue({ liveId: 'poc_live', sdp: 'answer' });
    const rows = [
      {
        currency: 'EUR',
        category: 'GROCERIES',
        merchant: 'Tesco',
        amount: new Prisma.Decimal('45.00'),
      },
      {
        currency: 'EUR',
        category: 'PETS',
        merchant: 'PetStop',
        amount: new Prisma.Decimal('14.90'),
      },
      {
        currency: 'BRL',
        category: 'PETS',
        merchant: 'PetShop',
        amount: new Prisma.Decimal('97.00'),
      },
    ];
    store.database.expense.findMany.mockImplementation(async (args?: any) =>
      rows.filter(
        (row) =>
          (!args?.where?.category || args.where.category === row.category) &&
          (!args?.where?.currency || args.where.currency === row.currency) &&
          (!args?.where?.merchant ||
            row.merchant
              .toLowerCase()
              .includes(
                (
                  args.where.merchant.contains ?? args.where.merchant.equals
                ).toLowerCase(),
              )),
      ),
    );
  });
  afterEach(async () => {
    await app?.close();
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });
  it.each([
    ['development', 'false'],
    ['production', 'true'],
    ['test', 'true'],
  ])('refuses creation for NODE_ENV=%s flag=%s', async (env, flag) => {
    await start(env, flag);
    expect(
      (await request(app.getHttpServer()).get('/ai/live-responses-poc/config'))
        .body,
    ).toEqual({ enabled: false, readOnly: true });
    await request(app.getHttpServer())
      .post('/ai/live-responses-poc/sessions')
      .send({ sdp: 'v=0\r\noffer' })
      .expect(503);
    expect(create).not.toHaveBeenCalled();
  });
  it('negotiates and handles monthly, category and merchant calls without transcripts or the old agent', async () => {
    await start();
    const { body: session } = await request(app.getHttpServer())
      .post('/ai/live-responses-poc/sessions')
      .send({ sdp: 'v=0\r\noffer' })
      .expect(201);
    await request(app.getHttpServer())
      .get(`/ai/live-responses-poc/sessions/${session.sessionId}`)
      .expect(403);
    await request(app.getHttpServer())
      .get(`/ai/live-responses-poc/sessions/${session.sessionId}`)
      .set('X-Live-Poc-Token', 'é'.repeat(session.token.length))
      .expect(403);
    const run = async (index: number, fields: object) => {
      const delegationId = `d${index}`,
        responseId = `r${index}`,
        callId = `c${index}`;
      emit({
        type: 'session.delegation.created',
        event_id: `d${index}`,
        offset_ms: 0,
        delegation: {
          id: delegationId,
          type: 'delegation',
          target: 'responses',
          response_id: responseId,
        },
      });
      emit({
        type: 'response.event',
        event_id: `created${index}`,
        delegation_id: delegationId,
        event: { type: 'response.created', response: { id: responseId } },
      });
      emit({
        type: 'response.event',
        event_id: `call${index}`,
        delegation_id: delegationId,
        event: {
          type: 'response.output_item.done',
          sequence_number: 1,
          output_index: 0,
          item: {
            type: 'function_call',
            call_id: callId,
            id: `fc${index}`,
            name: 'get_spending',
            arguments: JSON.stringify({
              year: 2026,
              month: 10,
              currency: null,
              merchant: null,
              category: null,
              ...fields,
            }),
            status: 'completed',
          },
        },
      });
      emit({
        type: 'response.event',
        event_id: `end${index}`,
        delegation_id: delegationId,
        event: {
          type: 'response.completed',
          response: { id: responseId, output: [] },
        },
      });
      await vi.waitFor(() =>
        expect(send).toHaveBeenCalledWith(
          expect.objectContaining({
            item: expect.objectContaining({ call_id: callId }),
          }),
        ),
      );
      return JSON.parse(
        send.mock.calls
          .map(([event]) => event)
          .find((event) => event.item?.call_id === callId).item.output,
      );
    };
    expect((await run(1, {})).totals).toEqual({ EUR: '59.90', BRL: '97.00' });
    expect((await run(2, { category: 'PETS' })).totals).toEqual({
      EUR: '14.90',
      BRL: '97.00',
    });
    expect((await run(3, { merchant: 'Tesco' })).totals).toEqual({
      EUR: '45.00',
      BRL: '0.00',
    });
    expect(store.database.expense.create).not.toHaveBeenCalled();
    expect(store.database.pendingExpense.upsert).not.toHaveBeenCalled();
    expect(store.database.bankAccount.findMany).not.toHaveBeenCalled();
    expect(store.database.bankAccount.upsert).not.toHaveBeenCalled();
    expect(store.database.pendingBankBalance.upsert).not.toHaveBeenCalled();
    await request(app.getHttpServer())
      .post(`/ai/live-responses-poc/sessions/${session.sessionId}/stop`)
      .set('X-Live-Poc-Token', session.token)
      .expect(201);
    expect(hangup).toHaveBeenCalledOnce();
  });
  it('rejects old client/delegation or financial fields in the offer', async () => {
    await start();
    await request(app.getHttpServer())
      .post('/ai/live-responses-poc/sessions')
      .send({
        sdp: 'v=0\r\noffer',
        conversationId: 'old',
        currentBalance: '2000.00',
      })
      .expect(400);
    expect(create).not.toHaveBeenCalled();
  });
});

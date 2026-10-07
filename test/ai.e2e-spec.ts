import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { AnalyticsService } from '../src/analytics/analytics.service.js';
import { ExpensesService } from '../src/expenses/expenses.service.js';
import { ConversationService } from '../src/conversations/conversation.service.js';
import { NotFoundException } from '@nestjs/common';

const { create } = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('openai', () => ({
  default: class {
    responses = { create };
  },
}));

describe('POST /ai/chat (mocked SDK)', () => {
  let app: INestApplication;
  const monthlySummary = vi.fn();
  const byMerchant = vi.fn();
  const findAll = vi.fn();
  const conversationId = '11111111-1111-4111-8111-111111111111';
  const conversations = {
    create: vi.fn(),
    recentMessages: vi.fn(),
    saveTurn: vi.fn(),
  };
  const final = {
    status: 'completed',
    output: [],
    output_text: 'You spent EUR 78.50 and BRL 119.90.',
  };
  const call = (name: string, args: object) => ({
    status: 'completed',
    output: [
      {
        type: 'function_call',
        name,
        arguments: JSON.stringify(args),
        call_id: 'call1',
        id: 'fc1',
      },
    ],
    output_text: '',
  });
  beforeEach(async () => {
    vi.resetAllMocks();
    vi.stubEnv('OPENAI_API_KEY', 'test-key');
    conversations.create.mockResolvedValue({ id: conversationId });
    conversations.recentMessages.mockResolvedValue([]);
    conversations.saveTurn.mockResolvedValue(undefined);
    monthlySummary.mockResolvedValue({
      period: { year: 2026, month: 10 },
      totals: { EUR: '78.50', BRL: '119.90' },
    });
    findAll.mockResolvedValue([]);
    byMerchant.mockResolvedValue([
      { merchant: 'Tesco', currency: 'EUR', total: '78.50' },
      { merchant: 'Tesco', currency: 'BRL', total: '119.90' },
    ]);
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue({})
      .overrideProvider(AnalyticsService)
      .useValue({ monthlySummary, byMerchant })
      .overrideProvider(ExpensesService)
      .useValue({ findAll })
      .overrideProvider(ConversationService)
      .useValue(conversations)
      .compile();
    app = module.createNestApplication();
    await app.init();
  });
  afterEach(async () => {
    await app?.close();
    vi.unstubAllEnvs();
  });

  it('accepts a valid monthly question and returns a tool-grounded response', async () => {
    create
      .mockResolvedValueOnce(
        call('get_monthly_summary', { year: 2026, month: 10 }),
      )
      .mockResolvedValueOnce(final);
    await request(app.getHttpServer())
      .post('/ai/chat')
      .send({ message: 'How much did I spend in October 2026?' })
      .expect(201)
      .expect({ conversationId, answer: final.output_text });
    expect(monthlySummary).toHaveBeenCalledWith({ year: '2026', month: '10' });
  });

  it('uses filtered expenses for a merchant question', async () => {
    create
      .mockResolvedValueOnce(
        call('get_expenses', {
          currency: null,
          merchant: 'Tesco',
          from: null,
          to: null,
        }),
      )
      .mockResolvedValueOnce(final);
    await request(app.getHttpServer())
      .post('/ai/chat')
      .send({ message: 'How much at Tesco?' })
      .expect(201);
    expect(findAll).toHaveBeenCalledWith(
      expect.objectContaining({ merchant: 'Tesco' }),
    );
    expect(byMerchant).toHaveBeenCalled();
  });

  it.each([
    [
      'How much did I spend at Amazon in January 2025?',
      'Amazon',
      '2025-01-01',
      '2025-01-31',
      'No Amazon expenses found in January 2025.',
    ],
    [
      'Show my Tesco expenses from October 1st to October 31st 2026.',
      'Tesco',
      '2026-10-01',
      '2026-10-31',
      'No Tesco expenses found from October 1 to October 31, 2026. There are 0 matching expenses.',
    ],
  ])(
    'accepts an empty-result answer for %s',
    async (message, merchant, from, to, answer) => {
      findAll.mockResolvedValue([]);
      byMerchant.mockResolvedValue([]);
      create
        .mockResolvedValueOnce(
          call('get_expenses', { currency: null, merchant, from, to }),
        )
        .mockResolvedValueOnce({ ...final, output_text: answer });
      await request(app.getHttpServer())
        .post('/ai/chat')
        .send({ message })
        .expect(201)
        .expect({ conversationId, answer });
      expect(findAll).toHaveBeenCalledWith(
        expect.objectContaining({ merchant, from, to }),
      );
    },
  );

  it.each([
    {},
    { message: '' },
    { message: '  ' },
    { message: 42 },
    { message: 'ok', secret: 'extra' },
  ])('rejects invalid body %j', async (body) => {
    await request(app.getHttpServer()).post('/ai/chat').send(body).expect(400);
    expect(create).not.toHaveBeenCalled();
  });

  it('reuses the returned conversation id in a second request', async () => {
    create
      .mockResolvedValueOnce(
        call('get_monthly_summary', { year: 2026, month: 10 }),
      )
      .mockResolvedValueOnce(final);
    const first = await request(app.getHttpServer())
      .post('/ai/chat')
      .send({ message: 'October 2026?' })
      .expect(201);
    expect(first.body.conversationId).toBe(conversationId);
    conversations.recentMessages.mockResolvedValue([
      { role: 'USER', content: 'October 2026?' },
      { role: 'ASSISTANT', content: final.output_text },
    ]);
    create
      .mockResolvedValueOnce(
        call('get_monthly_summary', { year: 2026, month: 9 }),
      )
      .mockResolvedValueOnce(final);
    await request(app.getHttpServer())
      .post('/ai/chat')
      .send({
        conversationId: first.body.conversationId,
        message: 'And in September?',
      })
      .expect(201)
      .expect({ conversationId, answer: final.output_text });
    expect(conversations.create).toHaveBeenCalledTimes(1);
    expect(conversations.recentMessages).toHaveBeenCalledWith(conversationId);
    expect(monthlySummary).toHaveBeenLastCalledWith({
      year: '2026',
      month: '9',
    });
  });

  it('returns 404 for an unknown conversation without invoking OpenAI', async () => {
    conversations.recentMessages.mockRejectedValue(
      new NotFoundException('Conversation not found'),
    );
    await request(app.getHttpServer())
      .post('/ai/chat')
      .send({ conversationId, message: 'follow-up' })
      .expect(404);
    expect(create).not.toHaveBeenCalled();
  });

  it.each(['not-a-uuid', '', null, 123])(
    'returns 400 for invalid conversationId %j',
    async (invalidId) => {
      await request(app.getHttpServer())
        .post('/ai/chat')
        .send({ conversationId: invalidId, message: 'follow-up' })
        .expect(400);
      expect(conversations.recentMessages).not.toHaveBeenCalled();
      expect(create).not.toHaveBeenCalled();
    },
  );

  it('returns a safe upstream error', async () => {
    create.mockRejectedValue(new Error('secret upstream trace'));
    const response = await request(app.getHttpServer())
      .post('/ai/chat')
      .send({ message: 'this month' })
      .expect(502);
    expect(JSON.stringify(response.body)).not.toMatch(/secret|trace/);
  });
});

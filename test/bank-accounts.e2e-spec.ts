import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { ConversationService } from '../src/conversations/conversation.service.js';
import { AnalyticsService } from '../src/analytics/analytics.service.js';
import { AudioService } from '../src/ai/voice/audio.service.js';
import { pendingDatabase } from './helpers/pending-database.js';
const { create } = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('openai', () => ({
  default: class {
    responses = { create };
  },
}));
const tool = (name: string, args: object) => ({
  status: 'completed',
  output: [
    {
      type: 'function_call',
      name,
      arguments: JSON.stringify(args),
      call_id: '1',
      id: 'fc1',
    },
  ],
  output_text: '',
});
const final = (output_text: string) => ({
  status: 'completed',
  output: [],
  output_text,
});
describe('personal bank balance, payer and privacy HTTP/voice flow', () => {
  let app: INestApplication;
  let store: ReturnType<typeof pendingDatabase>;
  let history: Array<{ role: string; content: string }>;
  const id = '11111111-1111-4111-8111-111111111111';
  const speak = vi.fn();
  const transcribe = vi.fn();
  const post = (message: string) =>
    request(app.getHttpServer())
      .post('/ai/chat')
      .send({ conversationId: id, message });
  const bankRead = () =>
    request(app.getHttpServer()).get('/bank-accounts').expect(200);
  const expenseInput = {
    paymentMethod: 'CARD',
    amount: '42.00',
    currency: 'EUR',
    merchant: 'Tesco',
    transactionDate: '2026-10-15',
    language: 'pt',
    description: null,
  };
  beforeEach(async () => {
    vi.resetAllMocks();
    vi.stubEnv('OPENAI_API_KEY', 'test');
    store = pendingDatabase();
    history = [];
    speak.mockResolvedValue('AQI=');
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(store.database)
      .overrideProvider(ConversationService)
      .useValue({
        create: vi.fn().mockResolvedValue({ id }),
        recentMessages: vi.fn(async () => history),
        saveTurn: vi.fn(
          async (_id: string, user: string, assistant: string) => {
            history.push(
              { role: 'USER', content: user },
              { role: 'ASSISTANT', content: assistant },
            );
          },
        ),
      })
      .overrideProvider(AnalyticsService)
      .useValue({
        monthlySummary: vi
          .fn()
          .mockResolvedValue({ totals: { EUR: '42.00', BRL: '0.00' } }),
      })
      .overrideProvider(AudioService)
      .useValue({ transcribe, speak })
      .compile();
    app = module.createNestApplication();
    await app.init();
  });
  afterEach(async () => {
    await app.close();
    vi.unstubAllEnvs();
  });
  async function setBalance() {
    create.mockResolvedValueOnce(
      tool('prepare_bank_balance_update', {
        currentBalance: '3250.00',
        currency: 'EUR',
        name: 'AIB',
      }),
    );
    const draft = await post('Meu saldo no AIB é 3250 euros.').expect(201);
    expect(draft.body.answer).toContain('Saldo pendente: 3250.00 EUR');
    expect((await bankRead()).body).toHaveLength(0);
    const response = await post('Pode salvar.').expect(201);
    expect(response.body.answer).toBe('Saldo atualizado.');
    expect(response.body.answer).not.toContain('3250');
  }
  it('prepares/sets a balance, reads explicitly and keeps amounts out of future model context', async () => {
    await setBalance();
    const response = await post('Qual meu saldo?').expect(201);
    expect(response.body.answer).toContain('3250.00 EUR');
    expect(create).toHaveBeenCalledOnce();
    create
      .mockResolvedValueOnce(
        tool('get_monthly_summary', { year: 2026, month: 10 }),
      )
      .mockResolvedValueOnce(final('Você gastou 42.00 EUR.'));
    const expenses = await post('Quanto gastei este mês?').expect(201);
    expect(expenses.body.answer).not.toMatch(/saldo|3250/i);
    const input = JSON.stringify(create.mock.calls.at(-1)![0].input);
    expect(input).not.toContain('3250');
    expect(
      create.mock.calls.at(-1)![0].tools.map((item: any) => item.name),
    ).not.toContain('get_bank_balance');
  });
  it.each([
    ['SELF', 'no meu cartão', '3208.00'],
    ['SPOUSE', 'no cartão da minha esposa', '3250.00'],
  ])(
    'confirmed %s expense has correct balance impact',
    async (payer, wording, expected) => {
      await setBalance();
      create.mockResolvedValueOnce(
        tool('prepare_expense', { ...expenseInput, payer }),
      );
      await post(`Gastei 42 euros no Tesco ${wording}.`).expect(201);
      expect(store.expenses.size).toBe(0);
      const saved = await post('Pode salvar').expect(201);
      expect(saved.body.answer).toContain('Salvo');
      expect(saved.body.answer).not.toMatch(/saldo|3208|3250/i);
      await post('Pode salvar').expect(201);
      expect(store.expenses.size).toBe(1);
      expect((await bankRead()).body[0].currentBalance).toBe(expected);
      expect([...store.expenses.values()][0].payer).toBe(payer);
    },
  );
  it('does not trust a model-invented SELF payer and requires clarification then separate confirmation', async () => {
    await setBalance();
    create.mockResolvedValueOnce(
      tool('prepare_expense', { ...expenseInput, payer: 'SELF' }),
    );
    const draft = await post('Gastei 35 euros no Tesco.').expect(201);
    expect(draft.body.answer).toContain('Foi no seu cartão');
    expect(store.pending.get(id)?.payer).toBeNull();
    await post('Pode salvar').expect(201);
    expect(store.expenses.size).toBe(0);
    create.mockResolvedValueOnce(
      tool('patch_pending_expense', {
        changes: [{ field: 'payer', value: 'SELF' }],
        language: 'pt',
      }),
    );
    const clarified = await post('Foi no meu cartão.').expect(201);
    expect(clarified.body.answer).toContain('Deseja salvar?');
    expect(store.expenses.size).toBe(0);
    await post('Pode salvar').expect(201);
    expect(store.expenses.size).toBe(1);
  });
  it.each([
    'Quanto gastei no Tesco?',
    'Como está meu orçamento?',
    'Quais despesas recorrentes tenho?',
    'Quanto vou gastar neste ritmo?',
    'Tem algum insight este mês?',
  ])(
    'suppresses volunteered balance for %s even after a balance query',
    async (message) => {
      await setBalance();
      await post('Qual meu saldo?').expect(201);
      create
        .mockResolvedValueOnce(
          tool('get_monthly_summary', { year: 2026, month: 10 }),
        )
        .mockResolvedValueOnce(
          final('Você gastou 42.00 EUR e seu saldo é 3250.00 EUR.'),
        );
      const response = await post(message).expect(201);
      expect(response.body.answer).not.toContain('3250');
      expect(response.body.answer).not.toContain('42.00');
      expect(store.database.bankAccount.findMany).toHaveBeenCalledTimes(2); // explicit read + setup assertion
    },
  );
  it('denies an unauthorized model balance-tool call', async () => {
    create
      .mockResolvedValueOnce(
        tool('get_bank_balance', { currency: null, account: null }),
      )
      .mockResolvedValueOnce(final('Saldo: 123.00 EUR.'));
    const result = await post('Quanto gastei no Tesco?').expect(201);
    expect(result.body.answer).not.toContain('123.00');
    expect(store.database.bankAccount.findMany).not.toHaveBeenCalled();
  });
  it.each([
    'Você tem 3250.00 EUR na conta.',
    'Your account holds 3250.00 EUR.',
    'Fundos disponíveis: 3250.00 EUR.',
  ])('withholds unsolicited account-balance wording: %s', async (answer) => {
    create
      .mockResolvedValueOnce(
        tool('get_monthly_summary', { year: 2026, month: 10 }),
      )
      .mockResolvedValueOnce(final(answer));
    const response = await post('Quanto gastei este mês?').expect(201);
    expect(response.body.answer).not.toContain('3250');
    expect(store.database.bankAccount.findMany).not.toHaveBeenCalled();
  });
  it('API balance writes require a draft and separate confirmation; cancel leaves it unchanged', async () => {
    const draft = await request(app.getHttpServer())
      .post('/bank-accounts/balance-updates')
      .send({
        conversationId: id,
        currentBalance: '97.01',
        currency: 'BRL',
        name: 'Personal',
      })
      .expect(201);
    expect((await bankRead()).body).toHaveLength(0);
    await request(app.getHttpServer())
      .post('/bank-accounts/balance-updates/confirm')
      .send({ conversationId: id, revision: draft.body.revision })
      .expect(201);
    const rows = (await bankRead()).body;
    expect(rows[0]).toMatchObject({ currentBalance: '97.01', currency: 'BRL' });
    await request(app.getHttpServer())
      .get(`/bank-accounts/${rows[0].id}`)
      .expect(200);
    const changed = await request(app.getHttpServer())
      .post('/bank-accounts/balance-updates')
      .send({ conversationId: id, currentBalance: '1.00', currency: 'BRL' })
      .expect(201);
    await request(app.getHttpServer())
      .post('/bank-accounts/balance-updates/cancel')
      .send({ conversationId: id, revision: changed.body.revision })
      .expect(201);
    await request(app.getHttpServer())
      .post('/bank-accounts/balance-updates/confirm')
      .send({ conversationId: id, revision: changed.body.revision })
      .expect(400);
    expect((await bankRead()).body[0].currentBalance).toBe('97.01');
  });
  it('voice uses the same private response for TTS and never speaks a previous balance', async () => {
    await setBalance();
    await post('Qual meu saldo?').expect(201);
    transcribe.mockResolvedValue('Quanto gastei no Tesco?');
    create
      .mockResolvedValueOnce(
        tool('get_monthly_summary', { year: 2026, month: 10 }),
      )
      .mockResolvedValueOnce(final('Seu saldo é 3250.00 EUR.'));
    const file = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 1]);
    const response = await request(app.getHttpServer())
      .post('/ai/voice')
      .field('conversationId', id)
      .attach('audio', file, {
        filename: 'recording.webm',
        contentType: 'audio/webm',
      })
      .expect(201);
    expect(response.body.answer).not.toContain('3250');
    expect(speak).toHaveBeenCalledOnce();
    expect(speak.mock.calls[0][0]).not.toContain('3250');
  });
  it('prepares, confirms and explicitly reads balance through the existing voice service', async () => {
    create.mockResolvedValueOnce(
      tool('prepare_bank_balance_update', {
        currentBalance: '3250.00',
        currency: 'EUR',
        name: 'AIB',
      }),
    );
    const voice = (message: string) => {
      transcribe.mockResolvedValueOnce(message);
      return request(app.getHttpServer())
        .post('/ai/voice')
        .field('conversationId', id)
        .attach('audio', Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 1]), {
          filename: 'recording.webm',
          contentType: 'audio/webm',
        })
        .expect(201);
    };
    await voice('Meu saldo no AIB é 3250 euros.');
    expect(store.accounts.size).toBe(0);
    await voice('Pode salvar.');
    expect(speak.mock.calls[1][0]).toBe('Saldo atualizado.');
    expect(store.accounts.size).toBe(1);
    const query = await voice('Qual meu saldo?');
    expect(query.body.answer).toContain('3250.00 EUR');
    expect(speak.mock.calls[2][0]).toContain('3250');
    expect(create).toHaveBeenCalledOnce();
  });
  it('balance reads disarm an expense confirmation instead of saving on a stale yes', async () => {
    await setBalance();
    create.mockResolvedValueOnce(
      tool('prepare_expense', { ...expenseInput, payer: 'SELF' }),
    );
    await post('Gastei 42 euros no Tesco no meu cartão.').expect(201);
    await post('Qual meu saldo?').expect(201);
    await post('Pode salvar').expect(201);
    expect(store.expenses.size).toBe(0);
    await post('Pode salvar').expect(201);
    expect(store.expenses.size).toBe(1);
  });
  it('unrelated read disarms a balance update without disclosing it on the next yes', async () => {
    create.mockResolvedValueOnce(
      tool('prepare_bank_balance_update', {
        currentBalance: '3250.00',
        currency: 'EUR',
        name: 'AIB',
      }),
    );
    await post('Meu saldo no AIB é 3250 euros.').expect(201);
    create
      .mockResolvedValueOnce(
        tool('get_monthly_summary', { year: 2026, month: 10 }),
      )
      .mockResolvedValueOnce(final('Você gastou 42.00 EUR.'));
    await post('Quanto gastei este mês?').expect(201);
    const review = await post('Pode salvar').expect(201);
    expect(review.body.answer).not.toContain('3250');
    expect(store.accounts.size).toBe(0);
    await post('Pode salvar').expect(201);
    expect(store.accounts.size).toBe(1);
  });
  it('new final expenses reject missing/invalid payer and a SELF currency with no matching account', async () => {
    const domainInput = {
      paymentMethod: 'CARD',
      amount: '42.00',
      currency: 'EUR',
      merchant: 'Tesco',
      transactionDate: '2026-10-15',
    };
    for (const payer of [undefined, 'UNKNOWN', 'SELF']) {
      await request(app.getHttpServer())
        .post('/expenses')
        .send({ ...domainInput, payer })
        .expect(400);
    }
    expect(store.expenses.size).toBe(0);
    await request(app.getHttpServer())
      .post('/expenses')
      .send({ ...domainInput, payer: 'SPOUSE' })
      .expect(201);
    expect(store.expenses.size).toBe(1);
    await request(app.getHttpServer())
      .get('/bank-accounts?currency=USD')
      .expect(400);
    await request(app.getHttpServer())
      .get('/bank-accounts/22222222-2222-4222-8222-222222222222')
      .expect(404);
  });
  it('manual balance preparation can start its own confirmation context without OpenAI', async () => {
    const prepared = await request(app.getHttpServer())
      .post('/bank-accounts/balance-updates')
      .send({ currency: 'EUR', currentBalance: '0.00' })
      .expect(201);
    expect(prepared.body.conversationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(store.accounts.size).toBe(0);
    await request(app.getHttpServer())
      .post('/bank-accounts/balance-updates/confirm')
      .send({
        conversationId: prepared.body.conversationId,
        revision: prepared.body.revision,
      })
      .expect(201);
    expect((await bankRead()).body[0].currentBalance).toBe('0.00');
    expect(create).not.toHaveBeenCalled();
  });
});

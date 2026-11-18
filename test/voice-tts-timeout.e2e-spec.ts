import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AudioService, TTS_TIMEOUT_MS } from '../src/ai/voice/audio.service.js';
import { VoiceService } from '../src/ai/voice/voice.service.js';
import { VoiceController } from '../src/ai/voice/voice.controller.js';
import { AiService } from '../src/ai/ai.service.js';
import { OpenAIConfig, resolveOpenAIConfig } from '../src/ai/openai.config.js';
const { speech, transcribe } = vi.hoisted(() => ({
  speech: vi.fn(),
  transcribe: vi.fn(),
}));
vi.mock('openai', () => ({
  toFile: vi.fn(async () => ({})),
  default: class {
    audio = {
      speech: { create: speech },
      transcriptions: { create: transcribe },
    };
  },
}));
describe('voice TTS fallback at the HTTP boundary', () => {
  let app: INestApplication;
  const financialTool = vi.fn();
  const chat = vi.fn();
  const id = '11111111-1111-4111-8111-111111111111';
  const answer = 'Saved: 45.00 EUR.';
  beforeEach(async () => {
    vi.resetAllMocks();
    vi.stubEnv('OPENAI_API_KEY', 'test-key');
    transcribe.mockResolvedValue({ text: 'Yes, save it.' });
    chat.mockImplementation(async () => {
      await financialTool();
      return { conversationId: id, answer };
    });
    const module = await Test.createTestingModule({
      controllers: [VoiceController],
      providers: [
        VoiceService,
        AudioService,
        { provide: AiService, useValue: { chat } },
        {
          provide: OpenAIConfig,
          useValue: { models: resolveOpenAIConfig({}) },
        },
      ],
    }).compile();
    app = module.createNestApplication();
    await app.init();
  });
  afterEach(async () => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    await app.close();
  });
  const post = () =>
    request(app.getHttpServer())
      .post('/ai/voice')
      .field('conversationId', id)
      .attach('audio', Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 1]), {
        filename: 'recording.webm',
        contentType: 'audio/webm',
      });
  it('keeps successful audio and text unchanged', async () => {
    speech.mockResolvedValue({
      arrayBuffer: async () => new Uint8Array([1, 2]).buffer,
    });
    const response = await post().expect(201);
    expect(response.body).toMatchObject({
      conversationId: id,
      answer,
      audio: { mimeType: 'audio/mpeg', data: 'AQI=' },
      audioError: null,
    });
    expect(chat).toHaveBeenCalledOnce();
    expect(financialTool).toHaveBeenCalledOnce();
  });
  it('returns the committed text on immediate TTS failure without repeating financial work', async () => {
    speech.mockRejectedValue(
      Object.assign(new Error('upstream private failure'), { status: 503 }),
    );
    const response = await post().expect(201);
    expect(response.body).toMatchObject({
      conversationId: id,
      answer,
      audio: null,
      audioError: 'Speech unavailable. Read the assistant answer.',
    });
    expect(chat).toHaveBeenCalledOnce();
    expect(financialTool).toHaveBeenCalledOnce();
    expect(speech).toHaveBeenCalledOnce();
    expect(JSON.stringify(response.body)).not.toContain('private failure');
  });
  it('returns text without audio at 15 seconds and aborts TTS without re-running chat/tools', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let started!: () => void;
    const speechStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    speech.mockImplementation(() => {
      started();
      return new Promise(() => {});
    });
    const responsePromise = post()
      .expect(201)
      .then((response) => response);
    await speechStarted;
    await vi.advanceTimersByTimeAsync(TTS_TIMEOUT_MS);
    const response = await responsePromise;
    expect(response.body).toMatchObject({
      conversationId: id,
      answer,
      audio: null,
      audioError: 'Speech unavailable. Read the assistant answer.',
    });
    expect(speech.mock.calls[0][1].signal.aborted).toBe(true);
    expect(chat).toHaveBeenCalledOnce();
    expect(financialTool).toHaveBeenCalledOnce();
    expect(speech).toHaveBeenCalledOnce();
    expect(transcribe).toHaveBeenCalledOnce();
  });
});

import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { VoiceController } from '../src/ai/voice/voice.controller.js';
import { VoiceService } from '../src/ai/voice/voice.service.js';
import { AudioService } from '../src/ai/voice/audio.service.js';
import { AiService } from '../src/ai/ai.service.js';
const file = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 1]);
describe('POST /ai/voice', () => {
  let app: INestApplication;
  const chat = vi.fn();
  const transcribe = vi.fn();
  const speak = vi.fn();
  const id = '11111111-1111-4111-8111-111111111111';
  beforeEach(async () => {
    vi.resetAllMocks();
    transcribe.mockResolvedValue('Yes, save it.');
    chat.mockResolvedValue({ conversationId: id, answer: 'Saved: 45.00 EUR.' });
    speak.mockResolvedValue('AQI=');
    const module = await Test.createTestingModule({
      controllers: [VoiceController],
      providers: [
        VoiceService,
        { provide: AiService, useValue: { chat } },
        { provide: AudioService, useValue: { transcribe, speak } },
      ],
    }).compile();
    app = module.createNestApplication();
    await app.init();
  });
  afterEach(async () => {
    await app.close();
  });
  it('requires audio', async () => {
    await request(app.getHttpServer()).post('/ai/voice').expect(400);
    expect(chat).not.toHaveBeenCalled();
  });
  it('correlates two voice turns in the same conversation without changing responses', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    const log = vi.spyOn(console, 'debug').mockImplementation(() => {});
    try {
      for (const turn of [1, 2]) {
        await request(app.getHttpServer())
          .post('/ai/voice')
          .set('X-Voice-Turn', String(turn))
          .set(
            'X-Voice-Request-Id',
            `00000000-0000-0000-0000-00000000000${turn}`,
          )
          .field('conversationId', id)
          .attach('audio', file, {
            filename: 'recording.webm',
            contentType: 'audio/webm',
          })
          .expect(201);
      }
      const rows = log.mock.calls.map((call) => JSON.parse(call[0] as string));
      for (const turn of [1, 2]) {
        const events = rows.filter((row) => row.voiceTurn === turn);
        expect(
          events.find((row) => row.event === 'voice.request:received'),
        ).toMatchObject({
          conversationId: id,
          audioBytes: file.length,
          mimeType: 'audio/webm',
          pid: process.pid,
        });
        expect(events.map((row) => row.event)).toEqual(
          expect.arrayContaining([
            'voice.transcription:start',
            'voice.transcription:end',
            'voice.ai_total:start',
            'voice.ai_total:end',
            'voice.tts_total:start',
            'voice.tts_total:end',
            'voice.response:ready',
            'voice.backend_total',
          ]),
        );
        expect(events.at(-1)).toMatchObject({
          conversationId: id,
          status: 'success',
          totalDurationMs: expect.any(Number),
        });
      }
      expect(chat).toHaveBeenCalledTimes(2);
      expect(JSON.stringify(rows)).not.toContain('Yes, save it.');
    } finally {
      log.mockRestore();
      vi.unstubAllEnvs();
    }
  });
  it('accepts multipart and forwards conversation ID', async () => {
    const response = await request(app.getHttpServer())
      .post('/ai/voice')
      .field('conversationId', id)
      .attach('audio', file, {
        filename: 'recording.webm',
        contentType: 'audio/webm',
      })
      .expect(201);
    expect(response.body).toMatchObject({
      conversationId: id,
      transcript: 'Yes, save it.',
      answer: 'Saved: 45.00 EUR.',
      audio: { mimeType: 'audio/mpeg', data: 'AQI=' },
    });
    expect(chat).toHaveBeenCalledExactlyOnceWith({
      message: 'Yes, save it.',
      conversationId: id,
    });
  });
  it('rejects invalid UUID', async () => {
    await request(app.getHttpServer())
      .post('/ai/voice')
      .field('conversationId', 'bad')
      .attach('audio', file, {
        filename: 'recording.webm',
        contentType: 'audio/webm',
      })
      .expect(400);
    expect(chat).not.toHaveBeenCalled();
  });
  it('rejects oversized upload', async () => {
    await request(app.getHttpServer())
      .post('/ai/voice')
      .attach('audio', Buffer.alloc(10 * 1024 * 1024 + 1), {
        filename: 'recording.webm',
        contentType: 'audio/webm',
      })
      .expect(413);
    expect(chat).not.toHaveBeenCalled();
  });
  it('rejects mismatched content', async () => {
    await request(app.getHttpServer())
      .post('/ai/voice')
      .attach('audio', Buffer.from('fake'), {
        filename: 'recording.webm',
        contentType: 'audio/webm',
      })
      .expect(400);
  });
});

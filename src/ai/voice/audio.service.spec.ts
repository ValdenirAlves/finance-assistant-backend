import { AudioService, TTS_TIMEOUT_MS } from './audio.service.js';
import { resolveOpenAIConfig } from '../openai.config.js';
import { MAX_AUDIO_BYTES } from './audio.js';
import { VoiceService } from './voice.service.js';
import type { AiService } from '../ai.service.js';
import * as voiceTiming from './voice-timing.js';
const { transcribe, speech } = vi.hoisted(() => ({
  transcribe: vi.fn(),
  speech: vi.fn(),
}));
vi.mock('openai', () => ({
  toFile: vi.fn(async (buffer, name, options) => ({ buffer, name, options })),
  default: class {
    audio = {
      transcriptions: { create: transcribe },
      speech: { create: speech },
    };
  },
}));
const file = {
  buffer: Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 1]),
  size: 5,
  mimetype: 'audio/webm;codecs=opus',
};
describe('voice audio SDK adapter', () => {
  const service = new AudioService({ models: resolveOpenAIConfig({}) });
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv('OPENAI_API_KEY', 'test-key');
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });
  it('transcribes valid browser audio with automatic language detection', async () => {
    transcribe.mockResolvedValue({ text: 'I spent 45 EUR at Tesco today.' });
    expect(await service.transcribe(file)).toBe(
      'I spent 45 EUR at Tesco today.',
    );
    expect(transcribe.mock.calls[0][0]).toMatchObject({
      model: 'gpt-transcribe',
    });
    expect(transcribe.mock.calls[0][0]).not.toHaveProperty('language');
  });
  it('sanitizes transcription failures', async () => {
    transcribe.mockRejectedValue(new Error('secret'));
    await expect(service.transcribe(file)).rejects.toThrow(
      'Unable to transcribe audio',
    );
  });
  it('uses centralized audio model and voice overrides', async () => {
    const configured = new AudioService({
      models: resolveOpenAIConfig({
        OPENAI_TRANSCRIBE_MODEL: 'transcription-override',
        OPENAI_TTS_MODEL: 'tts-override',
        OPENAI_VOICE: 'coral',
      }),
    });
    transcribe.mockResolvedValue({ text: 'Hello' });
    speech.mockResolvedValue({
      arrayBuffer: async () => new Uint8Array([1, 2]).buffer,
    });
    await configured.transcribe(file);
    await configured.speak('Hello');
    expect(transcribe.mock.calls[0][0].model).toBe('transcription-override');
    expect(speech.mock.calls[0][0]).toMatchObject({
      model: 'tts-override',
      voice: 'coral',
      input: 'Hello',
      response_format: 'mp3',
    });
  });
  it.each([
    { ...file, buffer: Buffer.alloc(0) },
    { ...file, size: MAX_AUDIO_BYTES + 1 },
    { ...file, mimetype: 'text/plain' },
    { ...file, buffer: Buffer.from('fake audio') },
  ])('rejects invalid upload without OpenAI', async (input) => {
    await expect(service.transcribe(input)).rejects.toThrow();
    expect(transcribe).not.toHaveBeenCalled();
  });
  it('rejects an empty transcript', async () => {
    transcribe.mockResolvedValue({ text: ' ' });
    await expect(service.transcribe(file)).rejects.toThrow(
      'No speech was detected',
    );
  });
  it('passes the approved answer unchanged to speech', async () => {
    speech.mockResolvedValue({
      arrayBuffer: async () => new Uint8Array([1, 2]).buffer,
    });
    expect(await service.speak('EUR 45.00; BRL 97.00')).toBe('AQI=');
    expect(speech.mock.calls[0][0]).toMatchObject({
      model: 'gpt-4o-mini-tts',
      input: 'EUR 45.00; BRL 97.00',
      response_format: 'mp3',
    });
  });
  it('preserves every character for long speech answers', async () => {
    speech.mockResolvedValue({
      arrayBuffer: async () => new Uint8Array([1]).buffer,
    });
    const answer = 'a'.repeat(4001);
    await service.speak(answer);
    expect(speech.mock.calls.map((call) => call[0].input).join('')).toBe(
      answer,
    );
  });
  it('sanitizes speech failures', async () => {
    speech.mockRejectedValue(new Error('secret'));
    await expect(service.speak('Answer')).rejects.toThrow(
      'Unable to generate speech',
    );
  });
  it('logs safe provider diagnostics without keys or speech input', async () => {
    const log = vi.spyOn(voiceTiming, 'timing').mockImplementation(() => {});
    speech.mockRejectedValue(
      Object.assign(new Error('test-key Bearer abc sk-private Answer'), {
        status: 503,
        code: 'service_unavailable',
        type: 'server_error',
        request_id: 'req_test',
      }),
    );
    await expect(service.speak('Answer')).rejects.toThrow(
      'Unable to generate speech',
    );
    expect(log).toHaveBeenCalledWith(
      'tts_total:error',
      expect.objectContaining({
        model: 'gpt-4o-mini-tts',
        voice: 'cedar',
        inputLength: 6,
        chunkCount: 1,
        timeoutMs: 15000,
        errorName: 'Error',
        httpStatus: 503,
        errorCode: 'service_unavailable',
        errorType: 'server_error',
        openAIRequestId: 'req_test',
      }),
    );
    const logs = JSON.stringify(log.mock.calls);
    for (const secret of ['test-key', 'Bearer abc', 'sk-private', 'Answer'])
      expect(logs).not.toContain(secret);
  });
  it('passes a TTS-only timeout and cancellable signal with retries disabled', async () => {
    speech.mockResolvedValue({
      arrayBuffer: async () => new Uint8Array([1, 2]).buffer,
    });
    await service.speak('Answer');
    expect(speech.mock.calls[0][1]).toMatchObject({
      timeout: TTS_TIMEOUT_MS,
      maxRetries: 0,
      signal: expect.any(AbortSignal),
    });
    expect(speech.mock.calls[0][1].signal.aborted).toBe(false);
    transcribe.mockResolvedValue({ text: 'Hello' });
    await service.transcribe(file);
    expect(transcribe.mock.calls[0]).toHaveLength(1);
  });
  it.each(['request', 'body'] as const)(
    'aborts a stalled %s at the whole-TTS deadline, even if the transport ignores abort',
    async (stage) => {
      vi.useFakeTimers();
      const log = vi.spyOn(voiceTiming, 'timing').mockImplementation(() => {});
      let finish!: (value: any) => void;
      const stalled = new Promise((resolve) => {
        finish = resolve;
      });
      speech.mockImplementation(() =>
        stage === 'request'
          ? stalled
          : Promise.resolve({ arrayBuffer: () => stalled }),
      );
      const result = service.speak('a'.repeat(4001));
      const assertion = expect(result).rejects.toMatchObject({
        name: 'TtsTimeoutError',
      });
      await vi.advanceTimersByTimeAsync(TTS_TIMEOUT_MS - 1);
      expect(speech.mock.calls[0][1].signal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await assertion;
      expect(log).toHaveBeenCalledWith(
        'tts_total:timeout',
        expect.objectContaining({
          timeoutMs: TTS_TIMEOUT_MS,
          errorName: 'TtsTimeoutError',
        }),
      );
      expect(log.mock.calls.some((call) => call[0] === 'tts_total:error')).toBe(
        false,
      );
      expect(
        log.mock.calls.find((call) => call[0] === 'tts_total:timeout')?.[1]
          ?.httpStatus,
      ).toBeUndefined();
      expect(speech.mock.calls[0][1].signal.aborted).toBe(true);
      finish(
        stage === 'request'
          ? { arrayBuffer: async () => new Uint8Array([1]).buffer }
          : new Uint8Array([1]).buffer,
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(speech).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    },
  );
  it('shares one deadline across chunks instead of granting another 15 seconds per chunk', async () => {
    vi.useFakeTimers();
    speech.mockImplementation(async () => ({
      arrayBuffer: () =>
        new Promise((resolve) =>
          setTimeout(() => resolve(new Uint8Array([1]).buffer), 8000),
        ),
    }));
    const assertion = expect(
      service.speak('a'.repeat(4001)),
    ).rejects.toMatchObject({ name: 'TtsTimeoutError' });
    await vi.advanceTimersByTimeAsync(TTS_TIMEOUT_MS);
    await assertion;
    expect(speech).toHaveBeenCalledTimes(2);
    expect(speech.mock.calls[1][1].signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(speech).toHaveBeenCalledTimes(2);
  });
});
describe('voice delegates all finance behavior to existing chat', () => {
  const chat = vi.fn();
  const transcribeAudio = vi.fn();
  const speak = vi.fn();
  const service = new VoiceService(
    { chat } as unknown as AiService,
    { transcribe: transcribeAudio, speak } as unknown as AudioService,
  );
  beforeEach(() => {
    vi.resetAllMocks();
    transcribeAudio.mockResolvedValue('Yes, save it.');
    chat.mockResolvedValue({
      conversationId: 'returned-id',
      answer: 'Saved: 45.00 EUR.',
    });
    speak.mockResolvedValue('AQI=');
  });
  it('forwards transcript and conversation ID and preserves chat answer', async () => {
    const result = await service.chat(file, { conversationId: 'provided-id' });
    expect(chat).toHaveBeenCalledExactlyOnceWith({
      message: 'Yes, save it.',
      conversationId: 'provided-id',
    });
    expect(speak).toHaveBeenCalledExactlyOnceWith('Saved: 45 euros.');
    expect(result).toMatchObject({
      conversationId: 'returned-id',
      answer: 'Saved: 45.00 EUR.',
      transcript: 'Yes, save it.',
    });
  });
  it('keeps committed chat result on speech failure without repeating chat', async () => {
    speak.mockRejectedValue(new Error('secret'));
    const result = await service.chat(file, {});
    expect(result.audio).toBeNull();
    expect(result.answer).toBe('Saved: 45.00 EUR.');
    expect(chat).toHaveBeenCalledOnce();
  });
  it('changes only speech for a relative transaction date', async () => {
    const answer = 'Salvo: 33.33 EUR; Tesco; 2026-10-10T00:00:00.000Z.';
    transcribeAudio.mockResolvedValue('Ontem eu gastei 33 euros no Tesco.');
    chat.mockResolvedValue({ conversationId: 'returned-id', answer });
    const result = await service.chat(file, {});
    expect(result.answer).toBe(answer);
    expect(speak).toHaveBeenCalledExactlyOnceWith(
      'Salvo: 33 euros e 33 centavos; Tesco; 10 de outubro.',
    );
  });
  it('speaks the same backend category label without voice classification', async () => {
    const answer =
      'Despesa pendente: 43.00 EUR; Lidl; supermercado; 2026-10-13T00:00:00.000Z.';
    transcribeAudio.mockResolvedValue('Gastei 43 euros no Lidl hoje.');
    chat.mockResolvedValue({ conversationId: 'returned-id', answer });
    const result = await service.chat(file, {});
    expect(result.answer).toBe(answer);
    expect(speak).toHaveBeenCalledExactlyOnceWith(
      'Despesa pendente: 43 euros; Lidl; supermercado; 13 de outubro.',
    );
    expect(chat).toHaveBeenCalledOnce();
  });
  it('delegates recurring voice questions to the existing chat', async () => {
    transcribeAudio.mockResolvedValue('Quais despesas recorrentes eu tenho?');
    const answer =
      'Você tem uma cobrança recorrente no Netflix: 17.99 EUR por mês.';
    chat.mockResolvedValue({ conversationId: 'returned-id', answer });
    const result = await service.chat(file, { conversationId: 'provided-id' });
    expect(chat).toHaveBeenCalledExactlyOnceWith({
      message: 'Quais despesas recorrentes eu tenho?',
      conversationId: 'provided-id',
    });
    expect(result.answer).toBe(answer);
    expect(speak).toHaveBeenCalledExactlyOnceWith(
      'Você tem uma cobrança recorrente no Netflix: 17 euros e 99 centavos por mês.',
    );
  });
  it('delegates financial warning questions to the same chat without voice insight logic', async () => {
    transcribeAudio.mockResolvedValue('Existe algum orçamento em risco?');
    const answer = 'Seu orçamento está em risco: projeção de 602.59 EUR.';
    chat.mockResolvedValue({ conversationId: 'returned-id', answer });
    const result = await service.chat(file, { conversationId: 'provided-id' });
    expect(result.answer).toBe(answer);
    expect(chat).toHaveBeenCalledExactlyOnceWith({
      message: 'Existe algum orçamento em risco?',
      conversationId: 'provided-id',
    });
    expect(speak).toHaveBeenCalledExactlyOnceWith(
      'Seu orçamento está em risco: projeção de 602 euros e 59 centavos.',
    );
  });
  it('keeps budget pace follow-ups in the existing conversational flow', async () => {
    const message = 'Quanto posso gastar por dia?';
    transcribeAudio.mockResolvedValue(message);
    const answer = 'No orçamento do Tesco, pode gastar 14.55 EUR por dia.';
    chat.mockResolvedValue({ conversationId: 'returned-id', answer });
    const result = await service.chat(file, { conversationId: 'provided-id' });
    expect(chat).toHaveBeenCalledExactlyOnceWith({
      message,
      conversationId: 'provided-id',
    });
    expect(result.answer).toBe(answer);
    expect(speak).toHaveBeenCalledExactlyOnceWith(
      'No orçamento do Tesco, pode gastar 14 euros e 55 centavos por dia.',
    );
  });
});

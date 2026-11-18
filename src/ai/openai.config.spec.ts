import { resolveOpenAIConfig } from './openai.config.js';

describe('OpenAI model configuration', () => {
  it('uses the migration defaults without obsolete fallbacks', () => {
    expect(resolveOpenAIConfig({})).toEqual({
      chatModel: 'gpt-6-luna',
      classificationModel: 'gpt-6-luna',
      transcribeModel: 'gpt-transcribe',
      ttsModel: 'gpt-4o-mini-tts',
      voice: 'cedar',
    });
  });
  it('inherits the configured chat model for classification', () => {
    expect(
      resolveOpenAIConfig({ OPENAI_CHAT_MODEL: 'chat-model' }),
    ).toMatchObject({
      chatModel: 'chat-model',
      classificationModel: 'chat-model',
    });
  });
  it('honors independent overrides', () => {
    expect(
      resolveOpenAIConfig({
        OPENAI_CHAT_MODEL: 'chat-model',
        OPENAI_CLASSIFICATION_MODEL: 'category-model',
        OPENAI_TRANSCRIBE_MODEL: 'transcribe-model',
        OPENAI_TTS_MODEL: 'speech-model',
        OPENAI_VOICE: 'coral',
      }),
    ).toEqual({
      chatModel: 'chat-model',
      classificationModel: 'category-model',
      transcribeModel: 'transcribe-model',
      ttsModel: 'speech-model',
      voice: 'coral',
    });
  });
  it.each([
    'OPENAI_CHAT_MODEL',
    'OPENAI_CLASSIFICATION_MODEL',
    'OPENAI_TRANSCRIBE_MODEL',
    'OPENAI_TTS_MODEL',
    'OPENAI_VOICE',
  ])('rejects blank or malformed %s instead of silently defaulting', (name) => {
    for (const value of ['', ' ', 'bad model', ' model', 'model\n']) {
      expect(() => resolveOpenAIConfig({ [name]: value })).toThrow(
        `Invalid ${name}`,
      );
    }
  });
  it('fails clearly for legacy configuration even alongside the new key', () => {
    expect(() =>
      resolveOpenAIConfig({
        OPENAI_MODEL: 'gpt-4.1-mini',
        OPENAI_CHAT_MODEL: 'gpt-6-luna',
      }),
    ).toThrow('OPENAI_MODEL is no longer supported');
  });
});

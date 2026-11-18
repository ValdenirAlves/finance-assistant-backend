import { Inject, Injectable } from '@nestjs/common';
import { AiService } from '../ai.service.js';
import { AudioService } from './audio.service.js';
import type { AudioUpload } from './audio.js';
import type { VoiceDto } from './voice.dto.js';
import { speechMoney } from './speech-money.js';
import { speechDate } from './speech-date.js';
import { timeStage, timing, voiceConversation } from './voice-timing.js';
@Injectable()
/** Legacy upload -> chat -> TTS pipeline, retained as the temporary fallback. */
export class VoiceService {
  constructor(
    @Inject(AiService) private readonly ai: AiService,
    @Inject(AudioService) private readonly audio: AudioService,
  ) {}
  async chat(file: AudioUpload, dto: VoiceDto) {
    const transcript = await timeStage('transcription', () =>
      this.audio.transcribe(file),
    );
    if (process.env.VOICE_DIAGNOSTICS_TRANSCRIPT === '1')
      timing('transcript', { transcript });
    const result = await timeStage('ai_total', () =>
      this.ai.chat({
        message: transcript,
        conversationId: dto.conversationId,
      }),
    );
    voiceConversation(result.conversationId);
    try {
      const data = await timeStage('tts_total', () =>
        this.audio.speak(
          speechMoney(speechDate(result.answer, transcript), transcript),
        ),
      );
      timing('response:ready', { audioExists: true });
      return {
        ...result,
        transcript,
        audio: { mimeType: 'audio/mpeg', data },
        audioError: null,
      };
    } catch {
      timing('response:ready', { audioExists: false });
      // The chat may already have saved an expense: keep its result and conversation ID,
      // never retry the financial operation merely because speech synthesis failed.
      return {
        ...result,
        transcript,
        audio: null,
        audioError: 'Speech unavailable. Read the assistant answer.',
      };
    }
  }
}

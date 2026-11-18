import {
  Body,
  Controller,
  Inject,
  Post,
  UploadedFile,
  UseInterceptors,
  ValidationPipe,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { MAX_AUDIO_BYTES, validateAudio } from './audio.js';
import type { AudioUpload } from './audio.js';
import { VoiceDto } from './voice.dto.js';
import { VoiceService } from './voice.service.js';
import {
  VoiceTimingInterceptor,
  timing,
  voiceConversation,
} from './voice-timing.js';
@Controller('ai')
/** Legacy push-to-talk transport. Retain until realtime acceptance is complete. */
export class VoiceController {
  constructor(@Inject(VoiceService) private readonly voice: VoiceService) {}
  @Post('voice')
  @UseInterceptors(
    VoiceTimingInterceptor,
    FileInterceptor('audio', {
      limits: { fileSize: MAX_AUDIO_BYTES, files: 1, fields: 1, parts: 2 },
    }),
  )
  chat(
    @UploadedFile() file: AudioUpload,
    @Body(
      new ValidationPipe({
        expectedType: VoiceDto,
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    )
    dto: VoiceDto,
  ) {
    timing('request:received', {
      conversationId: dto.conversationId ?? null,
      audioBytes: file?.size,
      mimeType: file?.mimetype,
    });
    voiceConversation(dto.conversationId);
    timing('upload_received', {
      audioBytes: file?.size,
      mimeType: file?.mimetype,
    });
    validateAudio(file);
    return this.voice.chat(file, dto);
  }
}

import {
  Body,
  Controller,
  Inject,
  Post,
  Req,
  ValidationPipe,
} from '@nestjs/common';
import type { Request } from 'express';
import { diagnosticsEnabled } from '../common/ai-chat-diagnostics.js';
import { AiService } from './ai.service.js';
import { ChatDto } from './dto/chat.dto.js';

@Controller('ai')
export class AiController {
  constructor(@Inject(AiService) private readonly ai: AiService) {}

  @Post('chat')
  chat(
    @Body(
      new ValidationPipe({
        expectedType: ChatDto,
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    )
    dto: ChatDto,
    @Req() request: Request,
  ) {
    if (diagnosticsEnabled()) {
      return this.ai.chat(dto, {
        requestUrl: `${request.protocol}://${request.get('host')}${request.path}`,
        backendPort: request.socket.localPort,
      });
    }
    return this.ai.chat(dto);
  }
}

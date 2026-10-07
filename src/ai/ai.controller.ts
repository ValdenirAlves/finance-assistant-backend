import { Body, Controller, Inject, Post, ValidationPipe } from '@nestjs/common';
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
  ) {
    return this.ai.chat(dto);
  }
}

import {
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  ValidationPipe,
} from '@nestjs/common';
import { RealtimeService } from './realtime.service.js';
import { RealtimeConfig } from '../openai.config.js';
import { RealtimeOfferDto } from './realtime.dto.js';
@Controller('ai/realtime')
export class RealtimeController {
  constructor(
    @Inject(RealtimeService) private readonly runtime: RealtimeService,
    @Inject(RealtimeConfig) private readonly config: RealtimeConfig,
  ) {}
  @Get('config') configForBrowser() {
    return {
      mode: this.config.settings.mode,
      model: this.config.settings.model,
    };
  }
  @Post('sessions') create(
    @Body(
      new ValidationPipe({
        expectedType: RealtimeOfferDto,
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    )
    dto: RealtimeOfferDto,
  ) {
    return this.runtime.create(dto);
  }
  @Get('sessions/:id') status(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('x-realtime-token') token: string,
  ) {
    return this.runtime.status(id, token);
  }
  @Post('sessions/:id/connected') connected(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('x-realtime-token') token: string,
  ) {
    return this.runtime.connected(id, token);
  }
  @Post('sessions/:id/stop') stop(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('x-realtime-token') token: string,
  ) {
    return this.runtime.stop(id, token);
  }
}

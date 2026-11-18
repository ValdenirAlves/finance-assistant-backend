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
import { LiveConfig } from './live.config.js';
import { LiveOfferDto } from './live.dto.js';
import { LiveService } from './live.service.js';
@Controller('ai/live')
export class LiveController {
  constructor(
    @Inject(LiveService) private readonly live: LiveService,
    @Inject(LiveConfig) private readonly config: LiveConfig,
  ) {}
  @Get('config') configForBrowser() {
    return {
      enabled: this.config.settings.enabled,
      model: this.config.settings.model,
      idleTimeoutMs: this.config.settings.idleTimeoutMs,
    };
  }
  @Post('sessions') create(
    @Body(
      new ValidationPipe({
        expectedType: LiveOfferDto,
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    )
    dto: LiveOfferDto,
  ) {
    return this.live.create(dto);
  }
  @Get('sessions/:id') status(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('x-live-token') token: string,
  ) {
    return this.live.status(id, token);
  }
  @Post('sessions/:id/connected') connected(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('x-live-token') token: string,
  ) {
    return this.live.connected(id, token);
  }
  @Post('sessions/:id/stop') stop(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('x-live-token') token: string,
  ) {
    return this.live.stop(id, token);
  }
}

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
import { IsString, Matches, MaxLength } from 'class-validator';
import { PocConfig } from './poc.config.js';
import { PocService } from './poc.service.js';
class PocOfferDto {
  @IsString() @MaxLength(90000) @Matches(/^v=0\r?\n/) sdp!: string;
}

@Controller('ai/live-responses-poc')
export class PocController {
  constructor(
    @Inject(PocConfig) private readonly config: PocConfig,
    @Inject(PocService) private readonly service: PocService,
  ) {}
  @Get('config') configuration() {
    return { enabled: this.config.settings.enabled, readOnly: true };
  }
  @Post('sessions') create(
    @Body(
      new ValidationPipe({
        expectedType: PocOfferDto,
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    )
    dto: PocOfferDto,
  ) {
    return this.service.create(dto.sdp);
  }
  @Get('sessions/:id') status(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('x-live-poc-token') token: string,
  ) {
    return this.service.status(id, token);
  }
  @Post('sessions/:id/connected') connected(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('x-live-poc-token') token: string,
  ) {
    return this.service.connected(id, token);
  }
  @Post('sessions/:id/stop') stop(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('x-live-poc-token') token: string,
  ) {
    return this.service.stop(id, token);
  }
}

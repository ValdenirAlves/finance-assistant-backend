import { Controller, Get, Inject, Query, ValidationPipe } from '@nestjs/common';
import { InsightsService } from './insights.service.js';
import { InsightsDto } from './insights.dto.js';
const pipe = () =>
  new ValidationPipe({
    expectedType: InsightsDto,
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
  });
@Controller('analytics/insights')
export class InsightsController {
  constructor(
    @Inject(InsightsService) private readonly insights: InsightsService,
  ) {}
  @Get() findAll(@Query(pipe()) dto: InsightsDto) {
    return this.insights.findAll(dto);
  }
  @Get('summary') summary(@Query(pipe()) dto: InsightsDto) {
    return this.insights.summary(dto);
  }
}

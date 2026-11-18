import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  ValidationPipe,
} from '@nestjs/common';
import { BudgetsService } from './budgets.service.js';
import { CreateBudgetDto } from './dto/create-budget.dto.js';
@Controller('budgets')
export class BudgetsController {
  constructor(
    @Inject(BudgetsService) private readonly budgets: BudgetsService,
  ) {}
  @Post() create(
    @Body(
      new ValidationPipe({
        expectedType: CreateBudgetDto,
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    )
    dto: CreateBudgetDto,
  ) {
    return this.budgets.create(dto);
  }
  @Get() findAll() {
    return this.budgets.findAll();
  }
  @Get(':id/status') status(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.budgets.status(id);
  }
  @Get(':id') findById(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.budgets.findById(id);
  }
}

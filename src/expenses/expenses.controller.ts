import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  ValidationPipe,
} from '@nestjs/common';
import { CreateExpenseDto } from './dto/create-expense.dto.js';
import { FilterExpensesDto } from './dto/filter-expenses.dto.js';
import { ExpensesService } from './expenses.service.js';

@Controller('expenses')
export class ExpensesController {
  constructor(
    @Inject(ExpensesService) private readonly expenses: ExpensesService,
  ) {}

  @Post()
  create(
    @Body(
      new ValidationPipe({
        expectedType: CreateExpenseDto,
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    )
    dto: CreateExpenseDto,
  ) {
    return this.expenses.create(dto);
  }

  @Get()
  findAll(
    @Query(
      new ValidationPipe({
        expectedType: FilterExpensesDto,
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    )
    filters: FilterExpensesDto,
  ) {
    return this.expenses.findAll(filters);
  }

  @Get(':id')
  findById(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.expenses.findById(id);
  }
}

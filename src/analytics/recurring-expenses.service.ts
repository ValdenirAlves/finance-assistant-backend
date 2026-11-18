import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { ExpensesService } from '../expenses/expenses.service.js';
import { RecurringExpensesDto } from './dto/recurring-expenses.dto.js';
import {
  detectRecurringExpenses,
  recurringSummary,
} from './recurring-expenses.js';
@Injectable()
export class RecurringExpensesService {
  constructor(
    @Inject(ExpensesService) private readonly expenses: ExpensesService,
  ) {}
  async findAll(input: RecurringExpensesDto = {}) {
    return (await this.analyze(input)).candidates;
  }
  async analyze(input: RecurringExpensesDto = {}) {
    const dto = plainToInstance(RecurringExpensesDto, input);
    if (
      validateSync(dto, { whitelist: true, forbidNonWhitelisted: true }).length
    )
      throw new BadRequestException('Invalid recurring-expense filters');
    const { confidence, ...filters } = dto;
    const rows = await this.expenses.findAll(filters);
    const candidates = detectRecurringExpenses(rows).filter(
      (row) => !confidence || row.confidence === confidence,
    );
    return { candidates, rows };
  }
  async summary(input: RecurringExpensesDto = {}) {
    return recurringSummary(await this.findAll(input));
  }
}

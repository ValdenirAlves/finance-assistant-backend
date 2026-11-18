import { IsEnum, IsOptional } from 'class-validator';
import { FilterExpensesDto } from '../../expenses/dto/filter-expenses.dto.js';
export enum RecurrenceConfidence {
  HIGH = 'HIGH',
  MEDIUM = 'MEDIUM',
  LOW = 'LOW',
}
export class RecurringExpensesDto extends FilterExpensesDto {
  @IsOptional() @IsEnum(RecurrenceConfidence) confidence?: RecurrenceConfidence;
}

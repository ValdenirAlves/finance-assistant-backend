import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Currency, ExpenseCategory } from '../../generated/prisma/enums.js';
export class BudgetScopeDto {
  @IsEnum(Currency) currency!: Currency;
  @IsInt() @Min(1) @Max(9999) year!: number;
  @IsInt() @Min(1) @Max(12) month!: number;
  @IsOptional() @IsString() @MaxLength(200) merchant?: string;
  @IsOptional() @IsEnum(ExpenseCategory) category?: ExpenseCategory;
}
export class CreateBudgetDto extends BudgetScopeDto {
  @IsString() @Matches(/^(0|[1-9]\d{0,16})(\.\d{1,2})?$/) amount!: string;
}

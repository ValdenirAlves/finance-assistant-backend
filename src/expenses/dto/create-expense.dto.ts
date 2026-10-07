import {
  IsEnum,
  IsISO8601,
  IsOptional,
  IsString,
  Matches,
} from 'class-validator';
import { Currency } from '../../generated/prisma/enums.js';

export class CreateExpenseDto {
  @IsString()
  @Matches(/^(?:0|[1-9]\d{0,14})(?:\.\d{1,2})?$/, {
    message:
      'amount must be a decimal string with at most 15 integer and 2 fractional digits',
  })
  amount!: string;

  @IsEnum(Currency)
  currency!: Currency;

  @IsISO8601({ strict: true, strictSeparator: true })
  transactionDate!: string;

  @IsOptional()
  @IsString()
  description?: string | null;

  @IsOptional()
  @IsString()
  merchant?: string | null;
}

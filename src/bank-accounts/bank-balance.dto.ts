import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { Currency } from '../generated/prisma/enums.js';

export class BalanceInputDto {
  @IsString()
  @Matches(/^-?(?:0|[1-9]\d{0,16})(?:\.\d{1,2})?$/)
  currentBalance!: string;
  @IsEnum(Currency) currency!: Currency;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(100) name?: string | null;
}
export class PrepareBalanceDto extends BalanceInputDto {
  @IsOptional() @IsUUID() conversationId?: string;
}
export class BalanceConfirmationDto {
  @IsUUID() conversationId!: string;
  @IsInt() @Min(1) revision!: number;
}
export class BalanceQueryDto {
  @IsOptional() @IsEnum(Currency) currency?: Currency | null;
  @IsOptional() @IsString() @MaxLength(100) account?: string | null;
}

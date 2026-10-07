import { IsString, Matches } from 'class-validator';

export class MonthlySummaryDto {
  @IsString()
  @Matches(/^(?!0000)\d{4}$/, { message: 'year must be between 0001 and 9999' })
  year!: string;

  @IsString()
  @Matches(/^(?:0?[1-9]|1[0-2])$/, {
    message: 'month must be between 1 and 12',
  })
  month!: string;
}

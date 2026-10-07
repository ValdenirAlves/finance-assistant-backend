import { IsISO8601, IsString } from 'class-validator';

export class ByMerchantDto {
  @IsString()
  @IsISO8601({ strict: true, strictSeparator: true })
  from!: string;

  @IsString()
  @IsISO8601({ strict: true, strictSeparator: true })
  to!: string;
}

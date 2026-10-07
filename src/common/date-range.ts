import { BadRequestException } from '@nestjs/common';
import { isISO8601 } from 'class-validator';

export function parseDateRange(fromInput?: string, toInput?: string) {
  const parse = (value: string | undefined) => {
    if (value === undefined) return undefined;
    if (!isISO8601(value, { strict: true, strictSeparator: true })) {
      throw new BadRequestException('from and to must be valid dates');
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      throw new BadRequestException('from and to must be valid dates');
    }
    return date;
  };
  const from = parse(fromInput);
  const to = parse(toInput);
  if (to && /^\d{4}-\d{2}-\d{2}$/.test(toInput!)) {
    to.setUTCHours(23, 59, 59, 999);
  }
  if (from && to && from > to) {
    throw new BadRequestException('from must not be after to');
  }
  return { from, to };
}

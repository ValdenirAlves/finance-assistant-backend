export function merchantFilter(merchant: string) {
  return {
    contains: merchant.replace(/[\\%_]/g, '\\$&'),
    mode: 'insensitive' as const,
  };
}

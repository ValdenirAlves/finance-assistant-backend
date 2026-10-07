import { PrismaService } from './prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';

describe('PrismaService', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('requires a database URL', () => {
    vi.stubEnv('DATABASE_URL', '');
    expect(() => new PrismaService()).toThrow(
      'DATABASE_URL must be configured',
    );
  });

  it('connects and disconnects with the NestJS lifecycle', async () => {
    vi.stubEnv(
      'DATABASE_URL',
      'postgresql://postgres:postgres@localhost:5432/test',
    );
    const service = new PrismaService();
    const connect = vi.spyOn(service, '$connect').mockResolvedValue(undefined);
    const disconnect = vi
      .spyOn(service, '$disconnect')
      .mockResolvedValue(undefined);

    await service.onModuleInit();
    await service.onModuleDestroy();

    expect(connect).toHaveBeenCalledOnce();
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it('preserves exact decimal arithmetic for monetary values', () => {
    expect(new Prisma.Decimal('0.1').plus('0.2').toString()).toBe('0.3');
    expect(new Prisma.Decimal('999999999999999.9999').toFixed(4)).toBe(
      '999999999999999.9999',
    );
  });
});

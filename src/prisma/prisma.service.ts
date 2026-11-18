import 'dotenv/config';
import { Injectable } from '@nestjs/common';
import type { OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';
import type { Prisma } from '../generated/prisma/client.js';
import {
  diagnosticsEnabled,
  diagnosticQuery,
} from '../common/ai-chat-diagnostics.js';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  constructor() {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error(
        'DATABASE_URL must be configured before starting the backend.',
      );
    }
    super({
      adapter: new PrismaPg({ connectionString }),
      ...(diagnosticsEnabled()
        ? { log: [{ emit: 'event', level: 'query' }] }
        : {}),
    });
    if (diagnosticsEnabled()) {
      const events = this as unknown as {
        $on(event: 'query', callback: (event: Prisma.QueryEvent) => void): void;
      };
      events.$on('query', (event) =>
        diagnosticQuery(event.duration, event.query.trim().split(/\s+/)[0]),
      );
    }
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}

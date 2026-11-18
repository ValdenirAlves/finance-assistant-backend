import {
  BadGatewayException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { OnModuleDestroy } from '@nestjs/common';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { ConnectClientEvent } from 'openai/resources/live/sideband/sideband';
import type { LiveConnection } from '../live/live.transport.js';
import { PocConfig } from './poc.config.js';
import { PocTransport } from './poc.transport.js';
import { PocSpendingService } from './poc-spending.service.js';
import { PocProtocol } from './poc.protocol.js';
import { pocLog } from './poc.config.js';
import { liveErrorDetails } from '../live/live.config.js';

type Session = {
  id: string;
  liveId: string;
  token: string;
  closed: boolean;
  connected: boolean;
  protocol: PocProtocol;
  connection?: LiveConnection;
  max?: ReturnType<typeof setTimeout>;
  handshake?: ReturnType<typeof setTimeout>;
  retention?: ReturnType<typeof setTimeout>;
};
@Injectable()
export class PocService implements OnModuleDestroy {
  private readonly sessions = new Map<string, Session>();
  private creating = 0;
  private stopping = false;
  constructor(
    @Inject(PocConfig) private readonly config: PocConfig,
    @Inject(PocTransport) private readonly transport: PocTransport,
    @Inject(PocSpendingService) private readonly spending: PocSpendingService,
  ) {}
  async create(sdp: string) {
    if (!this.config.settings.enabled || this.stopping)
      throw new ServiceUnavailableException('Managed Live POC is disabled');
    if (
      this.creating +
        [...this.sessions.values()].filter((s) => !s.closed).length >=
      3
    )
      throw new ServiceUnavailableException('POC capacity reached');
    this.creating++;
    let session: Session | undefined;
    try {
      const offer = await this.transport.create(sdp);
      const id = randomUUID();
      const buffered: ConnectClientEvent[] = [];
      const protocol = new PocProtocol(id, this.spending, (command) => {
        if (!session || session.closed) return;
        if (session.connection) session.connection.send(command);
        else {
          if (buffered.length >= 128)
            throw new Error('POC startup buffer limit');
          buffered.push(command);
        }
      });
      session = {
        id,
        liveId: offer.liveId,
        token: randomBytes(32).toString('base64url'),
        closed: false,
        connected: false,
        protocol,
      };
      const active = session;
      this.sessions.set(id, active);
      if (this.stopping) throw new Error('POC is stopping');
      active.connection = await this.transport.attach(
        offer.liveId,
        (event) => {
          try {
            if (event.type === 'session.closed' || event.type === 'error') {
              if (event.type === 'error')
                pocLog('error', {
                  sessionId: active.id,
                  code: event.error.code,
                  errorType: event.error.type,
                });
              void this.close(active);
              return;
            }
            protocol.accept(event);
          } catch {
            void this.close(active);
          }
        },
        () => {
          void this.close(active);
        },
      );
      if (active.closed) {
        await active.connection.closeGracefully();
        throw new Error('POC closed during setup');
      }
      buffered.forEach((command) => active.connection!.send(command));
      buffered.length = 0;
      active.handshake = setTimeout(() => {
        void this.close(active);
      }, 30000);
      active.handshake.unref();
      active.max = setTimeout(
        () => {
          void this.close(active);
        },
        Math.min(this.config.settings.live.maxSessionMs, 600000),
      );
      active.max.unref();
      return { sessionId: id, token: active.token, sdp: offer.sdp };
    } catch (error) {
      const details = liveErrorDetails(error);
      pocLog('error', {
        sessionId: session?.id,
        status: details.status,
        code: details.code,
        errorName: details.errorName,
      });
      if (session) await this.close(session);
      throw new BadGatewayException('Unable to start managed Live POC');
    } finally {
      this.creating--;
    }
  }
  private authorized(id: string, token: unknown) {
    const session = this.sessions.get(id);
    if (!session) throw new NotFoundException('POC session not found');
    if (
      typeof token !== 'string' ||
      Buffer.byteLength(token) !== Buffer.byteLength(session.token) ||
      !timingSafeEqual(Buffer.from(token), Buffer.from(session.token))
    )
      throw new ForbiddenException('Invalid POC session token');
    return session;
  }
  status(id: string, token: unknown) {
    const session = this.authorized(id, token);
    return {
      state: session.closed
        ? 'disconnected'
        : session.connected
          ? 'connected'
          : 'connecting',
    };
  }
  connected(id: string, token: unknown) {
    const session = this.authorized(id, token);
    if (session.closed) throw new NotFoundException('POC session closed');
    session.connected = true;
    clearTimeout(session.handshake);
    return { state: 'connected' };
  }
  async stop(id: string, token: unknown) {
    await this.close(this.authorized(id, token));
    return { state: 'disconnected' };
  }
  private async close(session: Session) {
    if (session.closed) return;
    session.closed = true;
    session.protocol.close();
    clearTimeout(session.max);
    clearTimeout(session.handshake);
    session.retention = setTimeout(
      () => this.sessions.delete(session.id),
      30000,
    );
    session.retention.unref();
    try {
      await session.connection?.closeGracefully();
    } catch {
      /* No financial operations to replay. */
    } finally {
      await this.transport.hangup(session.liveId);
    }
  }
  async onModuleDestroy() {
    this.stopping = true;
    await Promise.all([...this.sessions.values()].map((s) => this.close(s)));
    for (const s of this.sessions.values()) clearTimeout(s.retention);
    this.sessions.clear();
  }
}

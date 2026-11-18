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
import type { ConnectServerEvent } from 'openai/resources/live/sideband/sideband';
import { LiveConfig, liveErrorDetails, liveLog } from './live.config.js';
import { LiveTransport } from './live.transport.js';
import type { LiveConnection } from './live.transport.js';
import type { LiveOfferDto } from './live.dto.js';
import { LiveFinanceAdapter } from './live-finance.adapter.js';
import { LiveDelegation } from './live-delegation.js';

type Session = {
  id: string;
  liveId: string;
  token: string;
  conversationId?: string;
  created: number;
  state: 'connecting' | 'listening' | 'speaking' | 'disconnected' | 'error';
  closed: boolean;
  connection?: LiveConnection;
  delegation?: LiveDelegation;
  idle?: ReturnType<typeof setTimeout>;
  max?: ReturnType<typeof setTimeout>;
  handshake?: ReturnType<typeof setTimeout>;
  retention?: ReturnType<typeof setTimeout>;
  speechEnd?: ReturnType<typeof setTimeout>;
  userEnd?: ReturnType<typeof setTimeout>;
  userSpeaking: boolean;
  error?: ReturnType<typeof liveErrorDetails>;
  seen: Set<string>;
};
@Injectable()
export class LiveService implements OnModuleDestroy {
  private readonly sessions = new Map<string, Session>();
  private creating = 0;
  private stopping = false;
  constructor(
    @Inject(LiveConfig) private readonly config: LiveConfig,
    @Inject(LiveTransport) private readonly transport: LiveTransport,
    @Inject(LiveFinanceAdapter) private readonly finance: LiveFinanceAdapter,
  ) {}
  private log(event: string, s: Session, fields: Record<string, unknown> = {}) {
    liveLog(event, {
      sessionId: s.id,
      conversationId: s.conversationId,
      durationMs: Date.now() - s.created,
      ...fields,
    });
  }
  async create(dto: LiveOfferDto) {
    if (!this.config.settings.enabled)
      throw new ServiceUnavailableException(
        'GPT-Live experimental mode is disabled',
      );
    if (
      this.stopping ||
      this.creating +
        [...this.sessions.values()].filter((s) => !s.closed).length >=
        20
    )
      throw new ServiceUnavailableException('GPT-Live capacity unavailable');
    this.creating++;
    let session: Session | undefined;
    try {
      const conversationId = await this.finance.openConversation(
        dto.conversationId,
      );
      const offer = await this.transport.offer(dto.sdp);
      if (this.stopping) {
        await this.transport.hangup(offer.liveId);
        throw new Error('GPT-Live is stopping');
      }
      session = {
        id: randomUUID(),
        liveId: offer.liveId,
        token: randomBytes(32).toString('base64url'),
        conversationId,
        created: Date.now(),
        state: 'connecting',
        closed: false,
        userSpeaking: false,
        seen: new Set(),
      };
      const s = session;
      s.delegation = new LiveDelegation({
        sessionId: s.id,
        conversationId,
        finance: this.finance,
        send: (event) => {
          if (!s.connection || s.closed)
            throw new Error('Live connection unavailable');
          s.connection.send(event);
        },
        log: (event, fields) => this.log(event, s, fields),
        work: (active) => {
          if (active) clearTimeout(s.idle);
          else this.renewIdle(s);
        },
      });
      this.sessions.set(s.id, s);
      s.connection = await this.transport.attach(
        s.liveId,
        (event) => this.event(s, event),
        (error) => this.fail(s, error),
      );
      if (s.closed) {
        await s.connection.closeGracefully();
        throw new Error('GPT-Live closed during setup');
      }
      s.handshake = setTimeout(() => {
        void this.close(s, 'disconnected', 'connection_timeout');
      }, 30000);
      s.handshake.unref();
      s.max = setTimeout(() => {
        void this.close(s, 'disconnected', 'max_session');
      }, this.config.settings.maxSessionMs);
      s.max.unref();
      this.renewIdle(s);
      this.log('session_created', s, {
        model: this.config.settings.model,
        idleTimeoutMs: this.config.settings.idleTimeoutMs,
      });
      return {
        sessionId: s.id,
        token: s.token,
        conversationId: s.conversationId,
        sdp: offer.sdp,
      };
    } catch (error) {
      const details = session?.error ?? liveErrorDetails(error);
      liveLog('error', { sessionId: session?.id, ...details });
      if (session) await this.close(session, 'error', 'setup_error');
      throw new BadGatewayException({
        message:
          'Unable to connect GPT-Live. Check model access and configuration.',
        ...(process.env.NODE_ENV === 'development'
          ? { diagnostics: details }
          : {}),
      });
    } finally {
      this.creating--;
    }
  }
  private authorize(id: string, token: unknown) {
    const s = this.sessions.get(id);
    if (!s) throw new NotFoundException('GPT-Live session not found');
    if (
      typeof token !== 'string' ||
      Buffer.byteLength(token) !== Buffer.byteLength(s.token) ||
      !timingSafeEqual(Buffer.from(token), Buffer.from(s.token))
    )
      throw new ForbiddenException('Invalid GPT-Live session token');
    return s;
  }
  status(id: string, token: unknown) {
    const s = this.authorize(id, token);
    return {
      state: s.state,
      conversationId: s.conversationId,
      elapsedMs: Date.now() - s.created,
      ...(process.env.NODE_ENV === 'development' && s.error
        ? { diagnostics: s.error }
        : {}),
    };
  }
  connected(id: string, token: unknown) {
    const s = this.authorize(id, token);
    if (s.closed) throw new BadGatewayException('GPT-Live session closed');
    clearTimeout(s.handshake);
    s.state = 'listening';
    this.log('connection_established', s);
    return { state: s.state };
  }
  async stop(id: string, token: unknown) {
    await this.close(this.authorize(id, token), 'disconnected', 'manual_stop');
    return { state: 'disconnected' };
  }
  private renewIdle(s: Session) {
    clearTimeout(s.idle);
    if (s.closed) return;
    s.idle = setTimeout(() => {
      this.log('idle_close', s);
      void this.close(s, 'disconnected', 'idle');
    }, this.config.settings.idleTimeoutMs);
    s.idle.unref();
  }
  private event(s: Session, event: ConnectServerEvent) {
    if (s.closed) return;
    s.delegation?.accept(event);
    if (event.type === 'session.closed') {
      void this.close(s, 'disconnected', 'provider_closed');
      return;
    }
    if (event.type === 'error') {
      this.fail(s, event.error);
      return;
    }
    // Reflected raw audio and unrelated events never count as activity or get logged.
    if (
      event.type !== 'session.input_transcript.delta' &&
      event.type !== 'session.output_transcript.delta'
    )
      return;
    if (!event.delta.trim() || s.seen.has(event.event_id)) return;
    s.seen.add(event.event_id);
    if (s.seen.size > 500) s.seen.delete(s.seen.values().next().value!);
    this.renewIdle(s);
    if (event.type === 'session.input_transcript.delta') {
      if (!s.userSpeaking) {
        this.log('user_speech_started', s, {
          source: 'transcript_activity',
          estimated: true,
        });
        if (s.state === 'speaking')
          this.log('barge_in', s, {
            source: 'overlapping_transcripts',
            estimated: true,
          });
      }
      s.userSpeaking = true;
      clearTimeout(s.userEnd);
      s.userEnd = setTimeout(() => {
        s.userSpeaking = false;
        this.log('user_speech_stopped', s, {
          source: 'transcript_gap',
          estimated: true,
        });
      }, 1000);
      s.userEnd.unref();
    } else {
      if (s.state !== 'speaking')
        this.log('response_started', s, {
          source: 'transcript_activity',
          estimated: true,
        });
      s.state = 'speaking';
      clearTimeout(s.speechEnd);
      s.speechEnd = setTimeout(() => {
        if (!s.closed) {
          s.state = 'listening';
          this.log('response_completed', s, {
            source: 'transcript_gap',
            estimated: true,
          });
        }
      }, 1500);
      s.speechEnd.unref();
    }
  }
  private fail(s: Session, error: unknown) {
    if (s.closed) return;
    s.error = liveErrorDetails(error);
    this.log('error', s, s.error);
    void this.close(s, 'error', 'connection_error');
  }
  private async close(
    s: Session,
    state: 'disconnected' | 'error',
    reason: string,
  ) {
    if (s.closed) return;
    s.closed = true;
    s.delegation?.close();
    s.state = state;
    for (const timer of [s.idle, s.max, s.handshake, s.userEnd, s.speechEnd])
      clearTimeout(timer);
    this.log('connection_closed', s, { reason, conversationIdPreserved: true });
    s.retention = setTimeout(() => this.sessions.delete(s.id), 30000);
    s.retention.unref();
    try {
      await s.connection?.closeGracefully();
    } catch (error) {
      this.log('error', s, {
        reason: 'close_finalization_failed',
        ...liveErrorDetails(error),
      });
    } finally {
      await this.transport.hangup(s.liveId);
    }
  }
  async onModuleDestroy() {
    this.stopping = true;
    await Promise.all(
      [...this.sessions.values()].map((s) =>
        this.close(s, 'disconnected', 'shutdown'),
      ),
    );
    for (const s of this.sessions.values()) clearTimeout(s.retention);
    this.sessions.clear();
  }
}

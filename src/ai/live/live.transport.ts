import {
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import OpenAI from 'openai';
import { SidebandWS } from 'openai/resources/live/sideband/ws';
import type {
  ConnectServerEvent,
  ConnectClientEvent,
} from 'openai/resources/live/sideband/sideband';
import { LiveConfig } from './live.config.js';
import { LIVE_INSTRUCTIONS } from './live.prompt.js';

export interface LiveConnection {
  send(event: ConnectClientEvent): void;
  closeGracefully(): Promise<void>;
}
@Injectable()
export class LiveTransport {
  constructor(@Inject(LiveConfig) private readonly config: LiveConfig) {}
  private client() {
    if (!process.env.OPENAI_API_KEY)
      throw new ServiceUnavailableException('OPENAI_API_KEY is not configured');
    return new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      timeout: 20000,
      maxRetries: 0,
    });
  }
  async offer(sdp: string) {
    const result = await this.client().live.create({
      session: {
        model: this.config.settings.model,
        audio: { output: { voice: this.config.settings.voice } },
        store: false,
        instructions: LIVE_INSTRUCTIONS,
        delegation: { type: 'client' },
        client: {
          data_channel: {
            allowed_client_events: [],
            allowed_server_events: [
              'session.started',
              'session.closed',
              'session.input_transcript.delta',
              'session.output_transcript.delta',
              'error',
              'info',
            ].map((type) => ({ type })),
          },
        },
      },
      transport: { type: 'webrtc', sdp },
    });
    if (!result.session.id || !result.transport.sdp) {
      if (result.session.id) await this.hangup(result.session.id);
      throw new Error('Invalid GPT-Live session response');
    }
    return { liveId: result.session.id, sdp: result.transport.sdp };
  }
  async attach(
    liveId: string,
    event: (event: ConnectServerEvent) => void,
    failed: (error: unknown) => void,
  ): Promise<LiveConnection> {
    const ws = new SidebandWS(this.client(), { session_id: liveId });
    let finalized = false;
    let resolveClosed!: () => void;
    const closed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    ws.on('session.closed', () => {
      finalized = true;
      resolveClosed();
    });
    ws.on('event', (value) => {
      if (value.type === 'session.closed') {
        finalized = true;
        resolveClosed();
      }
      event(value);
    });
    ws.on('error', failed);
    ws.on('close', () => {
      resolveClosed();
      if (!finalized) failed(new Error('GPT-Live sideband connection lost'));
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          clean();
          reject(new Error('GPT-Live sideband timeout'));
        }, 10000);
        const clean = () => {
          clearTimeout(timer);
          ws.socket.off('open', opened);
          ws.socket.off('error', error);
          ws.socket.off('close', error);
        };
        const opened = () => {
          clean();
          resolve();
        };
        const error = () => {
          clean();
          reject(new Error('GPT-Live sideband unavailable'));
        };
        ws.socket.once('open', opened);
        ws.socket.once('error', error);
        ws.socket.once('close', error);
        if (ws.socket.readyState === 1) opened();
      });
    } catch (error) {
      ws.close();
      throw error;
    }
    return {
      send: (event) => ws.send(event),
      closeGracefully: async () => {
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
          if (!finalized && ws.socket.readyState === 1) {
            ws.send({ type: 'session.close' });
            await Promise.race([
              closed,
              new Promise<void>((resolve) => {
                timeout = setTimeout(resolve, 1500);
              }),
            ]);
          }
        } finally {
          clearTimeout(timeout);
          ws.close();
        }
      },
    };
  }
  async hangup(liveId: string) {
    try {
      await this.client().live.sessions.hangup(liveId, {
        timeout: 5000,
        maxRetries: 0,
      });
    } catch {
      /* Cleanup never retries a user operation. */
    }
  }
}

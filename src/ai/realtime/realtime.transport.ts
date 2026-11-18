import {
  BadGatewayException,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import OpenAI from 'openai';
import { OpenAIRealtimeWS } from 'openai/realtime/ws';
import type {
  RealtimeClientEvent,
  RealtimeServerEvent,
} from 'openai/resources/realtime/realtime';
import { RealtimeConfig } from '../openai.config.js';

export interface RealtimeConnection {
  send(event: RealtimeClientEvent): void;
  close(): void;
}
@Injectable()
export class RealtimeTransport {
  constructor(
    @Inject(RealtimeConfig) private readonly config: RealtimeConfig,
  ) {}
  private client() {
    if (!process.env.OPENAI_API_KEY)
      throw new ServiceUnavailableException('AI service is not configured');
    return new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      timeout: 20000,
      maxRetries: 0,
    });
  }
  async offer(sdp: string) {
    const body = new FormData();
    body.set('sdp', sdp);
    body.set(
      'session',
      JSON.stringify({
        type: 'realtime',
        model: this.config.settings.model,
        instructions:
          'Never answer financial questions independently. The server controls every turn. Never volunteer bank balance. Only speak the current server-approved response.',
        output_modalities: ['audio'],
        tools: [],
        audio: {
          input: {
            transcription: { model: 'gpt-4o-mini-transcribe' },
            turn_detection: {
              type: 'server_vad',
              create_response: false,
              interrupt_response: true,
            },
          },
          output: { voice: this.config.settings.voice },
        },
      }),
    );
    let response: Response;
    try {
      response = await fetch('https://api.openai.com/v1/realtime/calls', {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.client().apiKey}` },
        body,
        signal: AbortSignal.timeout(20000),
      });
    } catch {
      throw new BadGatewayException('Unable to create realtime session');
    }
    if (!response.ok)
      throw new BadGatewayException('Unable to create realtime session');
    const callId = response.headers.get('location')?.split('/').at(-1);
    if (!callId || !/^rtc_[a-zA-Z0-9_-]+$/.test(callId))
      throw new BadGatewayException('Invalid realtime session response');
    try {
      return { callId, sdp: await response.text() };
    } catch {
      await this.hangup(callId);
      throw new BadGatewayException('Unable to read realtime session');
    }
  }
  async attach(
    callId: string,
    event: (event: RealtimeServerEvent) => void,
    closed: () => void,
    failed: () => void,
  ): Promise<RealtimeConnection> {
    const ws = new OpenAIRealtimeWS({ callID: callId }, this.client());
    ws.on('error', (error) => {
      // VAD/client/server cancellation can race after generation has finished.
      // These two no-op playback errors must not tear down a healthy session.
      if (
        ['response_cancel_not_active', 'output_audio_buffer_empty'].includes(
          error.error?.code ?? '',
        )
      )
        return;
      if (process.env.NODE_ENV === 'development')
        console.debug(
          JSON.stringify({
            event: 'realtime.transport_error',
            errorName: error.name,
            errorCode: error.error?.code,
            errorType: error.error?.type,
            param: error.error?.param,
          }),
        );
      failed();
    });
    ws.on('event', event);
    ws.socket.addEventListener('close', closed);
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('Sideband timeout')),
          10000,
        );
        const clean = () => {
          clearTimeout(timer);
          ws.socket.removeEventListener('open', opened);
          ws.socket.removeEventListener('error', error);
          ws.socket.removeEventListener('close', error);
        };
        const opened = () => {
          clean();
          resolve();
        };
        const error = () => {
          clean();
          reject(new Error('Sideband unavailable'));
        };
        ws.socket.addEventListener('open', opened, { once: true });
        ws.socket.addEventListener('error', error, { once: true });
        ws.socket.addEventListener('close', error, { once: true });
      });
    } catch {
      ws.close();
      throw new BadGatewayException('Realtime control connection unavailable');
    }
    return ws;
  }
  async hangup(callId: string) {
    try {
      await this.client().realtime.calls.hangup(callId, {
        timeout: 5000,
        maxRetries: 0,
      });
    } catch {
      /* Never replay a financial turn to recover transport. */
    }
  }
}

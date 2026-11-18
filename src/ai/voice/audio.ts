import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';

export const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
export interface AudioUpload {
  buffer: Buffer;
  size: number;
  mimetype: string;
}
const formats: Record<string, string> = {
  'audio/webm': 'webm',
  'video/webm': 'webm',
  'audio/mp4': 'mp4',
  'video/mp4': 'mp4',
  'audio/x-m4a': 'm4a',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/mpga': 'mpga',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
};
export function validateAudio(file?: AudioUpload) {
  if (!file?.buffer?.length)
    throw new BadRequestException('Audio is required and must not be empty');
  if (file.size > MAX_AUDIO_BYTES || file.buffer.length > MAX_AUDIO_BYTES)
    throw new PayloadTooLargeException('Audio must be at most 10 MiB');
  const mime = file.mimetype.split(';')[0].trim().toLowerCase();
  const extension = formats[mime];
  if (!extension) throw new BadRequestException('Unsupported audio format');
  const b = file.buffer;
  const valid =
    extension === 'webm'
      ? b.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))
      : ['mp4', 'm4a'].includes(extension)
        ? b.toString('ascii', 4, 8) === 'ftyp'
        : extension === 'wav'
          ? b.toString('ascii', 0, 4) === 'RIFF' &&
            b.toString('ascii', 8, 12) === 'WAVE'
          : b.toString('ascii', 0, 3) === 'ID3' ||
            (b[0] === 0xff && (b[1] & 0xe0) === 0xe0);
  if (!valid)
    throw new BadRequestException('Audio content does not match its format');
  return { mime, extension };
}

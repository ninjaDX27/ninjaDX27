/**
 * Protocolo AudioSocket do Asterisk (app_audiosocket).
 * Cada mensagem: tipo (1 byte) + comprimento (2 bytes, big-endian) + dados.
 * O áudio é PCM linear de 16 bits, mono, 8 kHz (320 bytes = 20 ms).
 */
export const KIND = {
  HANGUP: 0x00,
  UUID: 0x01,
  DTMF: 0x03,
  AUDIO: 0x10,
  ERROR: 0xff,
} as const;

export const SAMPLE_RATE = 8000;
export const FRAME_BYTES = 320; // 20 ms
export const FRAME_MS = 20;

export interface Frame {
  kind: number;
  payload: Buffer;
}

/** Junta os bytes recebidos do socket e devolve as mensagens completas. */
export class FrameParser {
  private buf: Buffer = Buffer.alloc(0);

  constructor(private readonly maxPayload = 65_535) {}

  push(chunk: Buffer): Frame[] {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    if (this.buf.length > 1_000_000) throw new Error("buffer AudioSocket demasiado grande");
    const frames: Frame[] = [];
    while (this.buf.length >= 3) {
      const kind = this.buf[0]!;
      const len = this.buf.readUInt16BE(1);
      if (len > this.maxPayload) throw new Error("mensagem AudioSocket inválida");
      if (this.buf.length < 3 + len) break;
      frames.push({ kind, payload: this.buf.subarray(3, 3 + len) });
      this.buf = this.buf.subarray(3 + len);
    }
    return frames;
  }
}

export function encodeFrame(kind: number, payload: Buffer = Buffer.alloc(0)): Buffer {
  const header = Buffer.alloc(3);
  header[0] = kind;
  header.writeUInt16BE(payload.length, 1);
  return Buffer.concat([header, payload]);
}

/** O identificador da chamada vem em 16 bytes binários; converte para o formato habitual. */
export function uuidFromBytes(b: Buffer): string | null {
  if (b.length !== 16) return null;
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Energia (RMS) de um bloco PCM 16 bits, de 0 a 32767. */
export function rms(pcm: Buffer): number {
  const n = Math.floor(pcm.length / 2);
  if (n === 0) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const s = pcm.readInt16LE(i * 2);
    sum += s * s;
  }
  return Math.sqrt(sum / n);
}

/** Cliente do serviço de voz interno (Whisper + Piper). */
export interface SttResult {
  text: string;
  language: string;
  probability: number;
}
export interface SpeechClient {
  stt(pcm: Buffer, rate: number, lang?: string | null): Promise<SttResult>;
  tts(text: string, lang: string, rate: number): Promise<Buffer>;
}

export class HttpSpeechClient implements SpeechClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string | undefined,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private headers(contentType: string): Record<string, string> {
    return { "content-type": contentType, ...(this.token ? { "x-speech-token": this.token } : {}) };
  }

  async stt(pcm: Buffer, rate: number, lang?: string | null): Promise<SttResult> {
    const url = new URL("/stt", this.baseUrl);
    url.searchParams.set("rate", String(rate));
    if (lang) url.searchParams.set("lang", lang.slice(0, 2));
    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: this.headers("application/octet-stream"),
      body: new Uint8Array(pcm),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`stt ${res.status}`);
    const data = (await res.json()) as Partial<SttResult>;
    return { text: String(data.text ?? ""), language: String(data.language ?? ""), probability: Number(data.probability ?? 0) };
  }

  async tts(text: string, lang: string, rate: number): Promise<Buffer> {
    const url = new URL("/tts", this.baseUrl);
    url.searchParams.set("lang", lang);
    url.searchParams.set("rate", String(rate));
    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: this.headers("text/plain; charset=utf-8"),
      body: text,
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`tts ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }
}

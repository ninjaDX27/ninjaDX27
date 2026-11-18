"""Serviço de voz do Atendia: transcrição (faster-whisper) e síntese (Piper).

Corre na rede interna, ao lado do Atendia; não deve ser exposto à Internet.

  POST /stt?rate=8000[&lang=pt]   corpo: PCM s16le mono      -> {"text", "language", "probability"}
  POST /tts?lang=pt-PT&rate=8000  corpo: texto UTF-8          -> PCM s16le mono à taxa pedida
  GET  /healthz
"""

from __future__ import annotations

import hmac
import json
import logging
import re
import unicodedata
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from math import gcd
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

import numpy as np
from faster_whisper import WhisperModel
from piper import PiperVoice
from scipy.signal import resample_poly

MODELS = Path(os.environ.get("MODELS_DIR", "/models"))
TOKEN = os.environ.get("SPEECH_TOKEN", "")
WHISPER_MODEL = os.environ.get("WHISPER_MODEL", "small")
WHISPER_THREADS = int(os.environ.get("WHISPER_THREADS", "0"))  # 0 = automático
MAX_AUDIO_SECONDS = 30
MAX_TEXT_CHARS = 1000

VOICES = {
    "pt": "pt_PT-tugão-medium",
    "en": "en_GB-alba-medium",
    "es": "es_ES-davefx-medium",
    "fr": "fr_FR-siwis-medium",
    "de": "de_DE-thorsten-medium",
}

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("speech")

whisper = WhisperModel(
    WHISPER_MODEL,
    device="cpu",
    compute_type="int8",
    cpu_threads=WHISPER_THREADS,
    num_workers=2,
    download_root=str(MODELS / "whisper"),
)
voices: dict[str, PiperVoice] = {}
voice_lock = threading.Lock()


def voice_for(lang: str) -> PiperVoice:
    key = lang[:2].lower()
    if key not in VOICES:
        key = "pt"
    with voice_lock:
        if key not in voices:
            voices[key] = PiperVoice.load(MODELS / "piper" / f"{VOICES[key]}.onnx")
        return voices[key]


def resample(audio: np.ndarray, src: int, dst: int) -> np.ndarray:
    if src == dst:
        return audio
    g = gcd(src, dst)
    return resample_poly(audio, dst // g, src // g)


def _words(s: str) -> list[str]:
    s = unicodedata.normalize("NFD", s.lower())
    return re.findall(r"[a-z0-9]+", "".join(c for c in s if unicodedata.category(c) != "Mn"))


def echoes_prompt(text: str, prompt: str | None) -> bool:
    """O Whisper às vezes devolve o próprio vocabulário em vez do que foi dito: descarta-se."""
    if not prompt:
        return False
    words, vocab = _words(text), set(_words(prompt))
    return len(words) >= 4 and sum(w in vocab for w in words) / len(words) > 0.85


def transcribe(pcm: bytes, rate: int, lang: str | None, prompt: str | None = None) -> dict:
    audio = np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768.0
    audio = resample(audio, rate, 16000).astype(np.float32)
    segments, info = whisper.transcribe(
        audio,
        language=lang,
        beam_size=1,
        condition_on_previous_text=False,
        vad_filter=False,
        without_timestamps=True,
        initial_prompt=prompt or None,
    )
    text = " ".join(s.text.strip() for s in segments).strip()
    if echoes_prompt(text, prompt):
        text = ""
    return {"text": text, "language": info.language, "probability": round(float(info.language_probability), 3)}


def synthesize(text: str, lang: str, rate: int) -> bytes:
    voice = voice_for(lang)
    parts = []
    src_rate = 22050
    for chunk in voice.synthesize(text):
        src_rate = chunk.sample_rate
        parts.append(chunk.audio_float_array)
    if not parts:
        return b""
    audio = resample(np.concatenate(parts), src_rate, rate)
    return (np.clip(audio, -1.0, 1.0) * 32767).astype("<i2").tobytes()


class Handler(BaseHTTPRequestHandler):
    server_version = "speech"
    sys_version = ""

    def log_message(self, *_args):  # sem registo de pedidos (podem conter dados pessoais)
        pass

    def _send(self, code: int, body: bytes, ctype: str = "application/json"):
        self.send_response(code)
        self.send_header("content-type", ctype)
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _authorized(self) -> bool:
        return not TOKEN or hmac.compare_digest(self.headers.get("x-speech-token", ""), TOKEN)

    def do_GET(self):
        if urlparse(self.path).path == "/healthz":
            return self._send(200, b'{"status":"ok"}')
        self._send(404, b'{"error":"not found"}')

    def do_POST(self):
        if not self._authorized():
            return self._send(401, b'{"error":"unauthorized"}')
        url = urlparse(self.path)
        q = parse_qs(url.query)
        try:
            rate = int(q.get("rate", ["8000"])[0])
            if rate not in (8000, 16000, 22050, 24000, 48000):
                raise ValueError("rate")
            length = int(self.headers.get("content-length", "0"))
        except ValueError:
            return self._send(400, b'{"error":"bad request"}')

        if url.path == "/stt":
            if length <= 0 or length > rate * 2 * MAX_AUDIO_SECONDS:
                return self._send(413, b'{"error":"audio too long"}')
            lang = (q.get("lang", [""])[0][:2] or None)
            if lang and lang not in VOICES:
                lang = None
            # Vocabulário do resort (nomes de quartos, etc.), URL-encoded, para melhorar a transcrição.
            prompt = unquote(self.headers.get("x-stt-prompt", ""))[:600] or None
            result = transcribe(self.rfile.read(length), rate, lang, prompt)
            return self._send(200, json.dumps(result).encode())

        if url.path == "/tts":
            if length <= 0 or length > MAX_TEXT_CHARS * 4:
                return self._send(413, b'{"error":"text too long"}')
            text = self.rfile.read(length).decode("utf-8", "replace").strip()[:MAX_TEXT_CHARS]
            lang = q.get("lang", ["pt-PT"])[0]
            return self._send(200, synthesize(text, lang, rate), "application/octet-stream")

        self._send(404, b'{"error":"not found"}')


def main():
    for key in VOICES:  # carrega já as vozes, para a primeira chamada não esperar
        try:
            voice_for(key)
        except Exception as err:  # voz em falta: aviso, as outras continuam
            log.warning("voz %s indisponível: %s", key, err)
    host = os.environ.get("HOST", "0.0.0.0")
    port = int(os.environ.get("PORT", "8000"))
    if not TOKEN:
        log.warning("SPEECH_TOKEN não definido: o serviço aceita pedidos de qualquer cliente da rede interna")
    log.info("serviço de voz pronto em %s:%d (whisper=%s)", host, port, WHISPER_MODEL)
    ThreadingHTTPServer((host, port), Handler).serve_forever()


if __name__ == "__main__":
    main()

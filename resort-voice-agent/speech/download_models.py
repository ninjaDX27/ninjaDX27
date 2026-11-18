"""Descarrega os modelos (Whisper + vozes Piper) para MODELS_DIR. Corre no build da imagem."""
import os
import urllib.parse
import urllib.request
from pathlib import Path

from faster_whisper import WhisperModel

MODELS = Path(os.environ.get("MODELS_DIR", "/models"))
BASE = "https://huggingface.co/rhasspy/piper-voices/resolve/main/"
VOICES = [
    "pt/pt_PT/tugão/medium/pt_PT-tugão-medium",
    "en/en_GB/alba/medium/en_GB-alba-medium",
    "es/es_ES/davefx/medium/es_ES-davefx-medium",
    "fr/fr_FR/siwis/medium/fr_FR-siwis-medium",
    "de/de_DE/thorsten/medium/de_DE-thorsten-medium",
]

(MODELS / "piper").mkdir(parents=True, exist_ok=True)
for v in VOICES:
    for ext in (".onnx", ".onnx.json"):
        dest = MODELS / "piper" / (v.rsplit("/", 1)[1] + ext)
        if not dest.exists():
            urllib.request.urlretrieve(BASE + urllib.parse.quote(v) + ext, dest)
WhisperModel(os.environ.get("WHISPER_MODEL", "small"), device="cpu", compute_type="int8", download_root=str(MODELS / "whisper"))
print("modelos prontos em", MODELS)

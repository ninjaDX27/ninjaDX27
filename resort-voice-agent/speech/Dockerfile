FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 MODELS_DIR=/models WHISPER_MODEL=small HF_HUB_OFFLINE=0
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY download_models.py server.py ./
# Os modelos ficam dentro da imagem: o serviço arranca sem acesso à Internet.
RUN python download_models.py && useradd --system --uid 10001 speech && chown -R speech /models
ENV HF_HUB_OFFLINE=1
USER speech
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD python -c "import urllib.request;urllib.request.urlopen('http://127.0.0.1:8000/healthz')"
CMD ["python", "-I", "server.py"]

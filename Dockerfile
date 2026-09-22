FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

# Deps on their own layer so a source edit doesn't reinstall them.
COPY pyproject.toml ./
RUN python -c "import tomllib; print(chr(10).join(tomllib.load(open('pyproject.toml','rb'))['project']['dependencies']))" > /tmp/requirements.txt \
    && pip install -r /tmp/requirements.txt \
    && rm /tmp/requirements.txt

# Editable install keeps the source in /app so main.py can find web/ next to it.
COPY . .
RUN pip install --no-deps -e .

RUN useradd --create-home --uid 1000 printdeck && chown -R printdeck:printdeck /app
USER printdeck

# Where compose mounts the data directory.
ENV PRINTDECK_PRINTERS=/data/printers.yaml \
    PRINTDECK_USERS=/data/users.yaml

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/api/session', timeout=4).status == 200 else 1)"

CMD ["uvicorn", "--factory", "app.main:create_app", "--host", "0.0.0.0", "--port", "8000"]

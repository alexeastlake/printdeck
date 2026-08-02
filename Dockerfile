# PrintDeck — one small FastAPI process, so one small image.
FROM python:3.12-slim

WORKDIR /app

# Copy the project and install it. We use an *editable* install (-e) on purpose:
# it leaves the source in /app so the app can find the web/ folder next to it
# (main.py locates web/ relative to the package). A normal install would put the
# package under site-packages and lose track of web/.
COPY . .
RUN pip install --no-cache-dir -e .

EXPOSE 8000

# Bind to all interfaces so it's reachable from other devices on your LAN.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]

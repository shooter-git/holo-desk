# HO[LO] Desk's recognition engines: a second reader of scanned sheet music (optional).
# `pnpm omr on` builds and starts it; HO[LO]'s server reaches it on a network with no way out.
#
# Audiveris (https://github.com/Audiveris/audiveris) and homr (https://github.com/liebharc/homr) are
# AGPL-3.0 programs. They are built from their published sources at the versions pinned below, used
# unmodified, and run as separate programs by server.py (MIT, part of HO[LO] Desk), which only
# hands them a page and reads back the MusicXML they write.

# ---- Audiveris, built from its source (its Linux packages are x86-64 only) ----
FROM eclipse-temurin:25-jdk AS audiveris
ARG AUDIVERIS_REF=5.11.0
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*
RUN git clone --depth 1 --branch "${AUDIVERIS_REF}" https://github.com/Audiveris/audiveris.git /src
WORKDIR /src
RUN ./gradlew --no-daemon :app:installDist \
 && mkdir -p /opt \
 && cp -r "$(find /src/app/build/install -mindepth 1 -maxdepth 1 -type d | head -1)" /opt/audiveris

# ---- the engines' server ----
FROM python:3.12-slim
ARG HOMR_VERSION=0.7.0
# Audiveris's Java, its OCR's language data
COPY --from=audiveris /opt/java/openjdk /opt/java
COPY --from=audiveris /opt/audiveris /opt/audiveris
RUN apt-get update \
 && apt-get install -y --no-install-recommends tesseract-ocr-eng libgl1 libglib2.0-0 \
 && rm -rf /var/lib/apt/lists/*
ENV JAVA_HOME=/opt/java \
    PATH=/opt/java/bin:/opt/audiveris/bin:$PATH \
    TESSDATA_PREFIX=/usr/share/tesseract-ocr/5/tessdata \
    AUDIVERIS=/opt/audiveris/bin/Audiveris \
    HOMR=/opt/homr/bin/homr
# homr in its own environment, its models fetched now (the running container can't reach the internet)
RUN python -m venv /opt/homr \
 && /opt/homr/bin/pip install --no-cache-dir "homr==${HOMR_VERSION}" \
 && /opt/homr/bin/homr --init
RUN useradd --create-home --uid 1000 reader
COPY server.py /app/server.py
USER reader
EXPOSE 8070
HEALTHCHECK --interval=30s --timeout=3s CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8070/health', timeout=2)"
CMD ["python", "/app/server.py"]

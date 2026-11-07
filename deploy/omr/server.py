#!/usr/bin/env python3
"""HO[LO] Desk's recognition engines' server (MIT, part of HO[LO] Desk).

POST /read with a page image (PNG, JPEG or WebP) answers {"readings": [{"engine", "musicxml" | "error"}]}:
each engine (Audiveris, homr) run as its own program on the page, its MusicXML read back. GET /health
answers {"engines": [...]} with the engines that are here. Nothing else is served, and nothing is kept.
"""
import json
import os
import shutil
import subprocess
import tempfile
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

AUDIVERIS = os.environ.get("AUDIVERIS", "/opt/audiveris/bin/Audiveris")
HOMR = os.environ.get("HOMR", "/opt/homr/bin/homr")
LIMIT_S = int(os.environ.get("OMR_LIMIT_S", "300"))
MAX_BYTES = 40 * 1024 * 1024
TYPES = {"image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp"}


def engines():
    return [name for name, path in (("audiveris", AUDIVERIS), ("homr", HOMR)) if shutil.which(path) or os.path.exists(path)]


def score_in(folder):
    """The MusicXML an engine wrote somewhere in a folder (an .mxl unzipped)."""
    for root, _, files in os.walk(folder):
        for name in sorted(files):
            path = os.path.join(root, name)
            if name.endswith(".mxl"):
                with zipfile.ZipFile(path) as z:
                    for inner in z.namelist():
                        if inner.endswith((".xml", ".musicxml")) and not inner.startswith("META-INF/"):
                            return z.read(inner).decode("utf-8", "replace")
            if name.endswith((".musicxml", ".xml")):
                with open(path, encoding="utf-8", errors="replace") as f:
                    return f.read()
    return None


def run(cmd, cwd):
    done = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=LIMIT_S)
    return done.returncode, (done.stderr or done.stdout or "")[-400:]


def audiveris(page, work):
    out = os.path.join(work, "audiveris")
    os.makedirs(out)
    code, said = run([AUDIVERIS, "-batch", "-export", "-output", out, "--", page], work)
    text = score_in(out)
    return {"engine": "audiveris", "musicxml": text} if text else {"engine": "audiveris", "error": said.strip() or f"exit {code}"}


def homr(page, work):
    copy = os.path.join(work, "homr" + os.path.splitext(page)[1])
    shutil.copy(page, copy)
    code, said = run([HOMR, copy], work)
    path = os.path.splitext(copy)[0] + ".musicxml"
    if os.path.exists(path):
        with open(path, encoding="utf-8", errors="replace") as f:
            return {"engine": "homr", "musicxml": f.read()}
    return {"engine": "homr", "error": said.strip() or f"exit {code}"}


class Handler(BaseHTTPRequestHandler):
    def reply(self, status, body):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/health":
            self.reply(200, {"engines": engines()})
        else:
            self.reply(404, {"error": "not found"})

    def do_POST(self):
        if self.path.split("?")[0] != "/read":
            return self.reply(404, {"error": "not found"})
        kind = (self.headers.get("content-type") or "").split(";")[0].strip()
        size = int(self.headers.get("content-length") or 0)
        if kind not in TYPES or not 0 < size <= MAX_BYTES:
            return self.reply(400, {"error": "a PNG, JPEG or WebP page, at most 40 MB"})
        body = self.rfile.read(size)
        with tempfile.TemporaryDirectory() as work:
            page = os.path.join(work, "page" + TYPES[kind])
            with open(page, "wb") as f:
                f.write(body)
            readings = []
            for name, read in (("audiveris", audiveris), ("homr", homr)):
                if name not in engines():
                    continue
                try:
                    readings.append(read(page, work))
                except subprocess.TimeoutExpired:
                    readings.append({"engine": name, "error": f"took longer than {LIMIT_S} s"})
                except Exception as e:  # an engine failing is a reading that failed, not the server
                    readings.append({"engine": name, "error": str(e)[:300]})
        self.reply(200, {"readings": readings})

    def log_message(self, *_):
        pass


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", 8070), Handler).serve_forever()

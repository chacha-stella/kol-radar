"""Small local LibreTranslate-compatible bridge backed by Argos Translate."""

import json
from http.server import BaseHTTPRequestHandler, HTTPServer

import argostranslate.translate


class Handler(BaseHTTPRequestHandler):
    def _json(self, status, payload):
        raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        if self.path == "/languages":
            languages = [
                {"code": "en", "name": "English"},
                {"code": "zh", "name": "Chinese"},
            ]
            self._json(200, languages)
            return
        self._json(404, {"error": "not_found"})

    def do_POST(self):
        if self.path != "/translate":
            self._json(404, {"error": "not_found"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            payload = json.loads(self.rfile.read(length) or b"{}")
            text = str(payload.get("q", "")).strip()
            target = str(payload.get("target", "zh")).strip().lower()
            source = str(payload.get("source", "auto")).strip().lower()
            if not text:
                self._json(200, {"translatedText": ""})
                return
            if source == "auto":
                source = "zh" if any("\u4e00" <= char <= "\u9fff" for char in text) else "en"
            if source not in {"en", "zh"} or target not in {"en", "zh"}:
                raise ValueError("only en and zh are supported")
            translated = argostranslate.translate.translate(text, source, target)
            self._json(200, {"translatedText": translated})
        except Exception as exc:
            self._json(400, {"error": str(exc)})

    def log_message(self, _format, *_args):
        return


HTTPServer(("127.0.0.1", 5000), Handler).serve_forever()

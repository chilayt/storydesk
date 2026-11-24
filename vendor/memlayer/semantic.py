"""Semantic retrieval backend for memlayer (optional, default off).

Embedding via an OpenAI-compatible endpoint (DashScope text-embedding-v3 by
default). Designed for SHADOW comparison first: it never blocks or expands the
lexical result on failure. Data-egress note: enabling this sends query + fact
text to the embedding provider; keep it off unless the operator opts in.

Cache key = (fact_id, text_hash, model, dim). Update/retract/delete must
invalidate. Vectors are validated (dim, finite, non-zero) before use.
"""
from __future__ import annotations
import json, math, hashlib, time, urllib.request
from pathlib import Path

DEFAULT_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings"
DEFAULT_MODEL = "text-embedding-v3"
DEFAULT_DIM = 1024

class EmbeddingError(Exception):
    pass

def _valid_vec(v, dim):
    if not isinstance(v, list) or len(v) != dim:
        return False
    s = 0.0
    for x in v:
        if not isinstance(x, (int, float)) or not math.isfinite(x):
            return False
        s += x * x
    return s > 0.0  # reject zero vector

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, new_url):
        return None

class Embedder:
    def __init__(self, api_key, url=DEFAULT_URL, model=DEFAULT_MODEL, dim=DEFAULT_DIM,
                 timeout=8.0, batch=6):
        self.api_key = api_key; self.url = url; self.model = model
        self.dim = dim; self.timeout = timeout; self.batch = batch
        self.opener = urllib.request.build_opener(NoRedirect())

    def embed(self, texts):
        """Return list of vectors; raise EmbeddingError on any failure."""
        if not self.api_key:
            raise EmbeddingError("no api key")
        out = []
        for i in range(0, len(texts), self.batch):
            batch = texts[i:i+self.batch]
            body = json.dumps({"model": self.model, "input": batch}).encode()
            req = urllib.request.Request(self.url, data=body, headers={
                "Authorization": "Bearer " + self.api_key, "Content-Type": "application/json"})
            try:
                with self.opener.open(req, timeout=self.timeout) as r:
                    d = json.loads(r.read())
            except Exception as e:
                raise EmbeddingError(str(e))
            data = d.get("data")
            if not isinstance(data, list) or len(data) != len(batch):
                raise EmbeddingError("bad response shape")
            for item in sorted(data, key=lambda x: x.get("index", 0)):
                v = item.get("embedding")
                if not _valid_vec(v, self.dim):
                    raise EmbeddingError("invalid vector")
                out.append(v)
            time.sleep(0.1)
        return out

class EmbedCache:
    def __init__(self, path, model, dim):
        self.path = Path(path); self.model = model; self.dim = dim
        self.data = {}
        if self.path.exists():
            try: self.data = json.loads(self.path.read_text(encoding="utf-8"))
            except Exception: self.data = {}

    def key(self, fact_id, text):
        h = hashlib.sha256(text.encode()).hexdigest()[:16]
        return f"{fact_id}|{h}|{self.model}|{self.dim}"

    def get(self, fact_id, text):
        return self.data.get(self.key(fact_id, text))

    def put(self, fact_id, text, vec):
        self.data[self.key(fact_id, text)] = vec

    def delete_by_fact(self, fact_id):
        """Drop all cached vectors for a retracted fact. Idempotent. Returns count."""
        prefix = fact_id + "|"
        keys = [k for k in self.data if k.startswith(prefix)]
        for k in keys:
            del self.data[k]
        return len(keys)

    def delete_by_facts(self, fact_ids):
        """Cascade-aware batch delete. Idempotent."""
        return sum(self.delete_by_fact(fid) for fid in fact_ids)

    def save(self):
        """Atomic persist: temp file + os.replace. Raises on failure (visible)."""
        import os, tempfile
        self.path.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=str(self.path.parent), suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                json.dump(self.data, fh)
                fh.flush()
                os.fsync(fh.fileno())
            os.replace(tmp, self.path)
        except Exception:
            try: os.unlink(tmp)
            except OSError: pass
            raise

def cosine(a, b):
    dot = 0.0; na = 0.0; nb = 0.0
    for x, y in zip(a, b):
        dot += x*y; na += x*x; nb += y*y
    if na <= 0 or nb <= 0: return 0.0
    return dot / (math.sqrt(na) * math.sqrt(nb))

def rrf_fuse(lex_ids, sem_ids, k=60):
    """Reciprocal rank fusion by fact ID. Returns ids sorted by fused score."""
    score = {}
    for rank, fid in enumerate(lex_ids):
        score[fid] = score.get(fid, 0.0) + 1.0/(k + rank + 1)
    for rank, fid in enumerate(sem_ids):
        score[fid] = score.get(fid, 0.0) + 1.0/(k + rank + 1)
    return [fid for fid, _ in sorted(score.items(), key=lambda x: -x[1])]

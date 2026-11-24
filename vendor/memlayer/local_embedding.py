"""CPU inference for a locally provisioned BGE-small-zh-v1.5 ONNX model."""
from __future__ import annotations

import hashlib
import math
from pathlib import Path
import re
import sys


def load_session(model_path, ort):
    options = ort.SessionOptions()
    options.intra_op_num_threads = 2
    options.inter_op_num_threads = 1
    return ort.InferenceSession(str(model_path), sess_options=options, providers=["CPUExecutionProvider"])


def model_inputs(encoded, names, np):
    inputs = {
        "input_ids": [item.ids for item in encoded],
        "attention_mask": [item.attention_mask for item in encoded],
        "token_type_ids": [item.type_ids for item in encoded],
    }
    return {name: np.array(inputs[name], dtype=np.int64) for name in names}


class LocalEmbedder:
    dim = 512
    batch = 8
    query_prefix = "为这个句子生成表示以用于检索相关文章："

    def __init__(self, directory: str | Path):
        root = Path(directory).resolve(strict=True)
        packages = root / "packages"
        if packages.is_dir() and str(packages) not in sys.path:
            sys.path.append(str(packages))
        import numpy as np
        import onnxruntime as ort
        from tokenizers import Tokenizer

        model_path = root / "model_quantized.onnx"
        tokenizer_path = root / "tokenizer.json"
        digest = hashlib.sha256(tokenizer_path.read_bytes())
        with model_path.open("rb") as model:
            for chunk in iter(lambda: model.read(1024 * 1024), b""):
                digest.update(chunk)
        self.model = "local-bge-small-zh-v1.5:" + digest.hexdigest()
        self.np = np
        self.tokenizer = Tokenizer.from_file(str(tokenizer_path))
        self.tokenizer.enable_truncation(max_length=512)
        self.tokenizer.enable_padding(pad_id=self.tokenizer.token_to_id("[PAD]"))
        self.session = load_session(model_path, ort)
        self.input_names = {value.name for value in self.session.get_inputs()}
        if len(self.embed(["本地模型预热"])[0]) != self.dim:
            raise ValueError("unexpected local embedding dimension")

    def embed(self, texts: list[str]) -> list[list[float]]:
        output = []
        for start in range(0, len(texts), self.batch):
            encoded = self.tokenizer.encode_batch(texts[start:start + self.batch])
            data = model_inputs(encoded, self.input_names, self.np)
            vectors = self.session.run(["last_hidden_state"], data)[0][:, 0, :]
            if not self.np.isfinite(vectors).all() or not self.np.any(vectors, axis=1).all():
                raise ValueError("invalid local embedding")
            output.extend(vectors.tolist())
        return output

    def embed_query(self, text: str) -> list[float]:
        return self.embed([self.query_prefix + text])[0]


class LocalReranker:
    """Score a query and each candidate together with BGE's cross-encoder."""

    # Dynamic quantization uses one pair at a time so scores do not
    # change when another candidate is added to the batch.
    batch = 1

    def __init__(self, directory: Path):
        import numpy as np
        import onnxruntime as ort
        from tokenizers import Tokenizer

        self.np = np
        self.tokenizer = Tokenizer.from_file(str(directory / "tokenizer.json"))
        self.tokenizer.enable_truncation(max_length=256)
        self.tokenizer.enable_padding(pad_id=self.tokenizer.token_to_id("<pad>"), pad_token="<pad>")
        self.session = load_session(directory / "model_quantized.onnx", ort)
        self.input_names = {value.name for value in self.session.get_inputs()}
        self.score("模型预热", ["本机重排"])

    def score(self, query: str, texts: list[str]) -> list[float]:
        scores = []
        for start in range(0, len(texts), self.batch):
            pairs = [(query, text) for text in texts[start:start + self.batch]]
            inputs = model_inputs(self.tokenizer.encode_batch(pairs), self.input_names, self.np)
            logits = self.session.run(["logits"], inputs)[0].reshape(-1).tolist()
            if len(logits) != len(pairs) or not all(math.isfinite(score) for score in logits):
                raise ValueError("invalid local reranking score")
            scores.extend(logits)
        return scores

    # Prefer topical evidence over overlap in generic writing or output terms.
    # Logit limits are calibrated for the BGE reranker v2 m3 INT8 model.
    pool_size = 6
    scope_boundary = re.compile(r"固定(?:用|为)|使用|应先|先(?:写|列|说明|交代|展示)|不(?:展开|写|报)|必须")
    clauses = re.compile(r"[，。；！？,;!?]")

    def select(self, query: str, dense: list, lexical: list[dict], limit: int) -> list[dict]:
        ranked = sorted(dense, key=lambda pair: pair[1], reverse=True)
        similarity = {item["id"]: score for item, score in ranked}
        pool = {item["id"]: item for item in lexical[:2]}
        for item, _ in ranked:
            if len(pool) == self.pool_size:
                break
            pool.setdefault(item["id"], item)
        candidates = list(pool.values())
        if not candidates:
            return []

        scores = self.score(query, [item["text"] for item in candidates])
        shortlisted = [(item, score) for item, score in zip(candidates, scores) if score >= -4.4]
        shortlisted.sort(key=lambda pair: pair[1], reverse=True)
        if not shortlisted:
            return []
        shortlisted = shortlisted[:3]
        runner_up = sorted(scores, reverse=True)[1] if len(scores) > 1 else -math.inf
        lexical_ids = {item["id"] for item in lexical}
        scopes = [self.scope_boundary.split(item["text"], maxsplit=1)[0].rstrip(" ，：:")
                  for item, _ in shortlisted]
        scope_scores = self.score(query, scopes)
        parts = [part.strip() for part in self.clauses.split(query) if len(part.strip()) >= 5]

        accepted = []
        for index, ((item, full), scope, topical) in enumerate(zip(shortlisted, scopes, scope_scores)):
            dense_score = similarity.get(item["id"], 0)
            has_scope = scope != item["text"]
            strong = full >= -2.1 and (dense_score >= 0.57 or (has_scope and topical >= -2.48))
            supported_clause = (
                not strong and index == 0 and has_scope and len(parts) > 1
                and dense_score >= 0.48 and full - runner_up >= 0.8
                and self.score(parts[0], [scope])[0] >= -4.15
            )
            if strong or supported_clause:
                accepted.append(item)
        if not accepted:
            return []
        if len(accepted) > 1:
            accepted = [accepted[0], *(item for item in accepted[1:] if item["id"] in lexical_ids)]
        return [{**item, "match": "local-semantic"} if item["id"] not in lexical_ids else item
                for item in accepted[:limit]]

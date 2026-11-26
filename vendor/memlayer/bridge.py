"""Loopback-only HTTP/JSON bridge for memlayer.

Mutations go through one bounded writer queue and one writer thread. Read-only
recall shares a lock with that writer. No third-party packages are required.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import queue
import re
import socket
import threading
import time
import uuid
from concurrent.futures import Future
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

from memlayer import ReviewConflict, Store, fact_review_hash, now_iso, validate_event


VERSION = "0.3.1"
MAX_BODY = 1024 * 1024
LOOPBACK = {"127.0.0.1", "localhost", "::1"}


def terms(text: str) -> set[str]:
    words = re.findall(r"[a-z0-9_]+", text.lower())
    out = set(words)
    for seq in re.findall(r"[\u4e00-\u9fff]+", text):
        if len(seq) <= 12:
            out.add(seq)
        out.update(seq[i:i + 2] for i in range(max(0, len(seq) - 1)))
    return out


class ShadowLog:
    """Idempotent raw-capture journal. It never creates memory facts."""

    def __init__(self, path: Path):
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.ids: set[str] = set()
        self.lock = threading.Lock()
        if path.exists():
            with path.open(encoding="utf-8") as handle:
                for line in handle:
                    try:
                        self.ids.add(json.loads(line)["eventId"])
                    except (ValueError, KeyError, TypeError):
                        pass  # tolerate a truncated final line after a crash

    def get(self, event_id: str) -> dict | None:
        with self.lock:
            if not self.path.exists():
                return None
            with self.path.open(encoding="utf-8") as handle:
                for line in handle:
                    try:
                        row = json.loads(line)
                        if row.get("eventId") == event_id:
                            return row
                    except ValueError:
                        pass
        return None

    def append(self, record: dict) -> dict:
        eid = record["eventId"]
        with self.lock:
            if eid in self.ids:
                return {"duplicate": True, "eventId": eid, "written": False}
            line = json.dumps(record, ensure_ascii=False) + "\n"
            with self.path.open("a", encoding="utf-8", newline="\n") as handle:
                handle.write(line)
                handle.flush()
            self.ids.add(eid)
            return {"duplicate": False, "eventId": eid, "written": True,
                    "journal": str(self.path)}


class MutationWriter:
    def __init__(self, store: Store, lock: threading.RLock, capacity: int = 256):
        self.store = store
        self.lock = lock
        self.jobs: queue.Queue = queue.Queue(maxsize=capacity)
        self.stopping = False
        self.thread = threading.Thread(target=self._run, name="memlayer-writer", daemon=True)
        self.thread.start()

    def submit(self, operation: str, payload: dict, timeout: float = 8.0) -> Any:
        if self.stopping:
            raise RuntimeError("writer is stopping")
        future: Future = Future()
        try:
            self.jobs.put_nowait((operation, payload, future))
        except queue.Full as exc:
            raise OverflowError("writer queue is full") from exc
        return future.result(timeout=timeout)

    @staticmethod
    def _require_scope(row: dict | None, payload: dict) -> None:
        if row is None or any(row[field] != payload[field] for field in ("project", "subject") if field in payload):
            raise KeyError("entry not found in the requested scope")

    def _run(self) -> None:
        while True:
            job = self.jobs.get()
            if job is None:
                self.jobs.task_done()
                return
            operation, payload, future = job
            try:
                with self.lock:
                    if operation == "append":
                        result = self.store.append(payload)
                    elif operation == "supersede":
                        result = self.store.supersede(payload["old_fact_id"], payload["event"])
                    elif operation == "retract":
                        if "project" in payload or "subject" in payload:
                            self._require_scope(self.store.get_fact(payload["fact_id"]), payload)
                        found = self.store.retract(payload["fact_id"], payload.get("reason", ""))
                        if not found:
                            raise KeyError("unknown fact or missing Markdown file")
                        result = {"fact_id": payload["fact_id"], "retracted": True,
                                  "notice": "已停止普通召回。注意：撤回不删除原文/日志/备份/已发上下文，"
                                            "非彻底遗忘；嵌入向量清理若未完成会持久化重试。"}

                    elif operation == "rebuild":
                        result = self.store.rebuild()
                    elif operation == "candidate_create":
                        result = self.store.create_candidate(payload)
                    elif operation in {"candidate_approve", "candidate_reject", "candidate_replace", "candidate_exception"}:
                        if "project" in payload or "subject" in payload:
                            self._require_scope(self.store.get_candidate(payload["candidate_id"]), payload)
                        args = (payload["candidate_id"], payload["expected_hash"], payload.get("note", ""))
                        if operation in {"candidate_replace", "candidate_exception"}:
                            target = payload.get("supersedes_fact_id")
                            if not isinstance(target, str) or not target:
                                raise ValueError("请选择要替换的旧记忆")
                            result = self.store.approve_candidate(
                                *args, supersedes_fact_id=target, add_exception=operation == "candidate_exception",
                                expected_target_hash=payload.get("expected_target_hash"),
                            )
                        else:
                            review = self.store.approve_candidate if operation == "candidate_approve" else self.store.reject_candidate
                            result = review(*args)
                    else:
                        raise ValueError("unknown mutation")
                future.set_result(result)
            except Exception as exc:
                future.set_exception(exc)
            finally:
                self.jobs.task_done()

    def close(self, timeout: float = 5.0) -> None:
        """Stop accepting work and drain within a bounded deadline.

        A timeout is explicit and leaves the store open. Closing SQLite while a
        writer is still active would turn a graceful shutdown into corruption.
        """
        self.stopping = True
        deadline = time.monotonic() + timeout
        while self.thread.is_alive():
            try:
                self.jobs.put_nowait(None)
                break
            except queue.Full:
                if time.monotonic() >= deadline:
                    raise TimeoutError("writer queue did not drain; store left open")
                time.sleep(0.01)
        self.thread.join(timeout=max(0.0, deadline - time.monotonic()))
        if self.thread.is_alive():
            raise TimeoutError("writer did not stop before deadline; store left open")


class BridgeService:
    def __init__(self, root: str | Path, host: str = "127.0.0.1", port: int = 8765,
                 retraction_mirror: str | Path | None = None,
                 local_embedding: str | Path | None = None):
        if host not in LOOPBACK:
            raise ValueError("memlayer bridge is loopback-only")
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        # A mirror outside the store root is mandatory: without it a whole-root
        # backup restore silently resurrects retracted facts.
        if retraction_mirror is None:
            retraction_mirror = self.root.parent / (self.root.name + "-retraction-mirror")
        self.store = Store(self.root, retraction_mirror=retraction_mirror)
        self.lock = threading.RLock()
        self.writer = MutationWriter(self.store, self.lock)
        self.shadow = ShadowLog(self.root / "shadow.jsonl")
        # An explicit local model takes precedence over the optional external backend.
        external_enabled = os.environ.get("MEMLAYER_SEMANTIC", "0") == "1"
        self.semantic_backend = "local" if local_embedding else "external" if external_enabled else "disabled"
        self.semantic_enabled = bool(local_embedding or external_enabled)
        self.semantic_mode = "active" if local_embedding else os.environ.get("MEMLAYER_SEMANTIC_MODE", "shadow")
        self.semantic = None
        self.local_reranker = None
        self.local_reranker_status = "unconfigured"
        self.emb_cache = None
        self.semantic_log_path = self.root / "semantic-compare.jsonl"
        self.semantic_log_lock = threading.Lock()
        self.semantic_status = "disabled"
        self.semantic_reconcile_warning = None
        if self.semantic_enabled:
            try:
                import semantic as sem
                if local_embedding:
                    from local_embedding import LocalEmbedder, LocalReranker
                    self.semantic = LocalEmbedder(local_embedding)
                    reranker_dir = Path(local_embedding) / "reranker"
                    if reranker_dir.is_dir():
                        try:
                            self.local_reranker = LocalReranker(reranker_dir)
                            self.local_reranker_status = "ready"
                        except Exception as exc:
                            self.local_reranker_status = "init-failed"
                            sys.stderr.write("[memlayer] LOCAL RERANKER INIT FAILED: %s\n" % exc)
                else:
                    key = os.environ.get("MEMLAYER_EMB_KEY", "").strip()
                    if not key:
                        raise ValueError("external embeddings require an explicit MEMLAYER_EMB_KEY")
                    self.semantic = sem.Embedder(
                        key,
                        url=os.environ.get("MEMLAYER_EMB_URL", sem.DEFAULT_URL),
                        model=os.environ.get("MEMLAYER_EMB_MODEL", sem.DEFAULT_MODEL),
                        dim=int(os.environ.get("MEMLAYER_EMB_DIM", str(sem.DEFAULT_DIM))),
                        timeout=float(os.environ.get("MEMLAYER_EMB_TIMEOUT", "8")))
                self.emb_cache = sem.EmbedCache(self.root / "emb-cache.json",
                                                self.semantic.model, self.semantic.dim)
                self._sem = sem
                self._emb_lock = threading.Lock()
                self._emb_pending_path = self.root / "emb-cleanup-pending.json"
                self.store.on_retract(self._emb_on_retract)
                self.semantic_status = "ok"
            except Exception as exc:
                # Visible failure: do NOT silently disable. Log + record status.
                self.semantic_enabled = False
                self.semantic_status = "init-failed: " + str(exc)[:160]
                sys.stderr.write("[memlayer] SEMANTIC INIT FAILED: %s\n" % exc)
            if self.semantic_enabled:
                # Reconciliation failure is visible but does not disable semantic.
                try:
                    self._emb_reconcile()
                except Exception as exc:
                    self.semantic_reconcile_warning = str(exc)[:160]
                    self.semantic_status = "ok-reconcile-warning"
                    sys.stderr.write("[memlayer] SEMANTIC RECONCILE WARNING: %s\n" % exc)
        service = self

        class Handler(BaseHTTPRequestHandler):
            server_version = "memlayer/" + VERSION

            def log_message(self, fmt: str, *args: Any) -> None:
                pass

            def _send(self, status: int, value: Any) -> None:
                body = json.dumps(value, ensure_ascii=False).encode("utf-8")
                self.send_response(status)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(body)

            def _allow_request(self) -> bool:
                host = self.headers.get("Host", "")
                try:
                    target = urlparse("//" + host)
                    is_local = (target.hostname in LOOPBACK and not target.username and not target.password
                                and not target.path and not target.params and not target.query and not target.fragment
                                and (target.port is None or target.port == self.server.server_port))
                except ValueError:
                    is_local = False
                if not is_local or self.headers.get("Origin") or self.headers.get("Sec-Fetch-Site") == "cross-site":
                    self._send(403, {"ok": False, "error": {"code": "forbidden", "message": "only local native clients are accepted"}})
                    return False
                return True

            def _body(self) -> dict:
                if self.headers.get_content_type() != "application/json":
                    raise ValueError("Content-Type must be application/json")
                try:
                    size = int(self.headers.get("Content-Length", "0"))
                except ValueError as exc:
                    raise ValueError("invalid Content-Length") from exc
                if size <= 0 or size > MAX_BODY:
                    raise ValueError("body must be 1 byte to 1 MiB")
                value = json.loads(self.rfile.read(size).decode("utf-8"))
                if not isinstance(value, dict):
                    raise ValueError("JSON body must be an object")
                return value

            def _error(self, exc: Exception) -> None:
                if isinstance(exc, (ValueError, json.JSONDecodeError)):
                    status, code = 400, "bad_request"
                elif isinstance(exc, KeyError):
                    status, code = 404, "not_found"
                elif isinstance(exc, ReviewConflict):
                    status, code = 409, "review_conflict"
                elif isinstance(exc, OverflowError):
                    status, code = 503, "queue_full"
                elif isinstance(exc, TimeoutError):
                    status, code = 504, "writer_timeout"
                else:
                    status, code = 500, "internal"
                self._send(status, {"ok": False, "error": {"code": code, "message": str(exc)}})

            def do_GET(self) -> None:
                if not self._allow_request():
                    return
                try:
                    parsed = urlparse(self.path)
                    if parsed.path == "/health":
                        result = {"ok": True, "version": VERSION,
                                  "writerQueue": service.writer.jobs.qsize()}
                        # Do not block health during embedding egress (lock held): try
                        # briefly, else report busy. Semantic state needs no lock.
                        got = service.lock.acquire(timeout=2)
                        try:
                            if got:
                                result["recovery"] = service.store.recovery
                                result["status"] = service.store.status()
                            else:
                                result["status"] = "busy-lock-held"
                        finally:
                            if got:
                                service.lock.release()
                        # Observable semantic/cleanup state (not just HTTP 200).
                        result["semantic"] = {
                            "enabled": service.semantic_enabled,
                            "backend": service.semantic_backend,
                            "reranker": service.local_reranker_status,
                            "mode": service.semantic_mode,
                            "status": service.semantic_status,
                            "reconcileWarning": service.semantic_reconcile_warning,
                            "hookErrors": len(getattr(service.store, "_retract_hook_errors", [])),
                        }
                        try:
                            if service.emb_cache is not None and service._emb_pending_path.exists():
                                result["semantic"]["pendingCleanup"] = len(service._emb_pending_load())
                        except Exception as exc:
                            result["semantic"]["pendingCleanup"] = "unreadable: " + str(exc)[:80]
                        self._send(200, result)
                        return
                    if parsed.path == "/v1/status":
                        with service.lock:
                            self._send(200, {"ok": True, "status": service.store.status()})
                        return
                    if parsed.path == "/v1/fact-status":
                        # Trusted retraction confirmation: returns the fact's ACTUAL
                        # status (incl. retracted), unlike recall which filters it.
                        # Callers use this after a 504/timeout to confirm retraction.
                        params = parse_qs(parsed.query)
                        fid = params.get("id", [""])[0]
                        with service.lock:
                            fact = service.store.get_fact(fid) if fid else None
                        if fact is None:
                            self._send(404, {"ok": False, "error": {"code": "not_found", "message": "unknown fact id"}})
                        else:
                            self._send(200, {"ok": True, "id": fid, "status": fact.get("status"),
                                             "retracted": fact.get("status") == "retracted"})
                        return
                    if parsed.path == "/v1/candidates":
                        params = parse_qs(parsed.query)
                        with service.lock:
                            rows = service.store.list_candidates(
                                params.get("status", [None])[0], params.get("project", [None])[0])
                        self._send(200, {"ok": True, "candidates": rows})
                        return
                    if parsed.path == "/v1/facts":
                        params = parse_qs(parsed.query)
                        project = params.get("project", [""])[0]
                        subject = params.get("subject", [None])[0]
                        mode = params.get("mode", ["current"])[0]
                        query = params.get("q", [""])[0]
                        semantic_query = params.get("semantic_q", [""])[0][:500]
                        limit = min(20, max(1, int(params.get("limit", ["5"])[0])))
                        include_inferred = params.get("include_inferred", ["false"])[0] == "true"
                        confirmed_only = params.get("confirmed_only", ["true"])[0] != "false"
                        if "offset" in params:
                            if query.strip():
                                raise ValueError("offset is available for listing only")
                            offset = int(params["offset"][0])
                            if offset < 0:
                                raise ValueError("offset must be non-negative")
                            search = params.get("filter", [""])[0].strip().casefold()
                            if len(search) > 200:
                                raise ValueError("filter is limited to 200 characters")
                            with service.lock:
                                items = service.store.query(project, subject, mode, include_inferred, confirmed_only)
                                if search:
                                    items = [item for item in items if search in item["id"].casefold()
                                             or search in item["text"].casefold()
                                             or any(search in source.casefold() for source in item["source_ids"])]
                                items.sort(key=lambda item: (item["recorded_at"], item["id"]), reverse=True)
                                page = items[offset:offset + limit]
                                if params.get("review_hash") == ["true"]:
                                    page = [{**item, "review_hash": fact_review_hash(item)} for item in page]
                                result = {"ok": True, "facts": page, "total": len(items)}
                            self._send(200, result)
                        else:
                            self._send(200, {"ok": True, "facts": service.recall(
                                project, subject, query, limit, include_inferred, confirmed_only, mode, semantic_query)})
                        return
                    self._send(404, {"ok": False, "error": {"code": "not_found", "message": self.path}})
                except Exception as exc:
                    self._error(exc)

            def do_POST(self) -> None:
                if not self._allow_request():
                    return
                try:
                    path = urlparse(self.path).path
                    body = self._body()
                    if path == "/v1/events":
                        # Direct writes land as confirmed facts and bypass candidate
                        # review. Require an explicit trust declaration so that "the
                        # HTTP endpoint answers" is never mistaken for "a human
                        # approved this". UI capture must use /v1/candidates.
                        if body.get("trust") != "direct":
                            raise ValueError(
                                "direct fact writes require trust='direct'; use /v1/candidates for the review flow")
                        if not isinstance(body.get("confirmed"), bool):
                            raise ValueError("direct fact writes must state confirmed true or false explicitly")
                        result = service.writer.submit("append", body)
                    elif path == "/v1/facts/supersede":
                        result = service.writer.submit("supersede", body)
                    elif path == "/v1/facts/retract":
                        result = service.writer.submit("retract", body)
                    elif path == "/v1/rebuild":
                        result = service.writer.submit("rebuild", body)
                    elif path == "/v1/shadow":
                        result = service.capture_shadow(body)
                    elif path == "/v1/candidates":
                        result = service.writer.submit("candidate_create", body)
                    elif path == "/v1/candidates/from-shadow":
                        result = service.candidate_from_shadow(body)
                    elif path == "/v1/candidates/approve":
                        result = service.writer.submit("candidate_approve", body)
                    elif path == "/v1/candidates/approve-replacement":
                        result = service.writer.submit("candidate_replace", body)
                    elif path == "/v1/candidates/approve-exception":
                        result = service.writer.submit("candidate_exception", body)
                    elif path == "/v1/candidates/reject":
                        result = service.writer.submit("candidate_reject", body)
                    else:
                        self._send(404, {"ok": False, "error": {"code": "not_found", "message": path}})
                        return
                    self._send(200, {"ok": True, "result": result})
                except Exception as exc:
                    self._error(exc)

        class IPv6Server(ThreadingHTTPServer):
            address_family = socket.AF_INET6

        server_class = IPv6Server if host == "::1" else ThreadingHTTPServer
        self.server = server_class((host, port), Handler)
        self.server.daemon_threads = True
        self.thread = threading.Thread(target=self.server.serve_forever,
                                       name="memlayer-http", daemon=True)
        self.started = False

    @property
    def url(self) -> str:
        host, port = self.server.server_address[:2]
        return f"http://[{host}]:{port}" if ":" in host else f"http://{host}:{port}"

    def start(self) -> "BridgeService":
        self.thread.start()
        self.started = True
        return self

    def _emb_pending_load(self) -> list:
        if not self._emb_pending_path.exists():
            return []
        # Do NOT mask corruption as empty: a corrupt/invalid pending file must surface.
        data = json.loads(self._emb_pending_path.read_text(encoding="utf-8"))
        if not isinstance(data, list) or not all(isinstance(x, str) for x in data):
            raise ValueError("pending cleanup file must be a list of fact-id strings")
        return data

    def _emb_pending_save(self, pending: list) -> None:
        import os, tempfile
        fd, tmp = tempfile.mkstemp(dir=str(self.root), suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                json.dump(pending, fh)
                fh.flush()
                os.fsync(fh.fileno())
            os.replace(tmp, self._emb_pending_path)
        except Exception:
            try: os.unlink(tmp)
            except OSError: pass
            raise

    def _emb_on_retract(self, fact_id: str) -> None:
        """Retraction hook: drop the fact's cached embedding (cascade handled per-fact).
        On failure, persist a durable pending-cleanup task (survives process exit) and
        raise so the Store records 'retraction effective, cleanup incomplete'."""
        if self.emb_cache is None:
            return
        try:
            with self._emb_lock:
                self.emb_cache.delete_by_fact(fact_id)
                self.emb_cache.save()
        except Exception:
            with self._emb_lock:
                pending = self._emb_pending_load()
                if fact_id not in pending:
                    pending.append(fact_id)
                self._emb_pending_save(pending)
            raise

    def _emb_drain_pending(self) -> int:
        """Retry durable pending cleanups; remove entries once cleaned. Idempotent."""
        if self.emb_cache is None:
            return 0
        cleaned = 0
        with self._emb_lock:
            pending = self._emb_pending_load()
            if not pending:
                return 0
            remaining = []
            for fid in pending:
                try:
                    self.emb_cache.delete_by_fact(fid)
                    cleaned += 1
                except Exception as exc:
                    remaining.append(fid)
                    sys.stderr.write("[memlayer] PENDING CLEANUP ITEM FAILED %s: %s\n" % (fid, exc))
            self.emb_cache.save()
            self._emb_pending_save(remaining)
            if remaining:
                self.semantic_reconcile_warning = "pending-items-failed: %d" % len(remaining)
        return cleaned

    def _emb_reconcile(self) -> int:
        """Drop cached vectors for facts no longer current (covers retractions while
        the bridge was down) and drain any durable pending cleanups. Cache retention
        rule: only current facts keep vectors (superseded/retracted are removed)."""
        if self.emb_cache is None:
            return 0
        self._emb_drain_pending()
        removed = 0
        with self._emb_lock:
            for key in list(self.emb_cache.data.keys()):
                fid = key.split("|")[0]
                fact = self.store.get_fact(fid)
                if fact is None or fact.get("status") != "current":
                    del self.emb_cache.data[key]
                    removed += 1
            if removed:
                self.emb_cache.save()
        return removed

    def recall(self, project: str, subject: str | None, query: str, limit: int = 5,
               include_inferred: bool = False, confirmed_only: bool = True,
               mode: str = "current", semantic_query: str = "") -> list[dict]:
        with self.lock:
            items = self.store.query(project, subject, mode, include_inferred, confirmed_only)
        ranked = self._lexical_rank(items, query)
        lex_items = [item for _, _, item in ranked][:limit]
        # Semantic layer only for current-mode recall; mode=all is a lexical audit path.
        if mode == "current" and self.semantic_enabled and self.semantic is not None and query.strip():
            try:
                if self._emb_pending_path.exists():
                    self._emb_drain_pending()
            except Exception as exc:
                # Visible, not swallowed: pending cleanup retry failed; surface it.
                sys.stderr.write("[memlayer] PENDING CLEANUP RETRY FAILED: %s\n" % exc)
                self.semantic_reconcile_warning = "pending-retry: " + str(exc)[:120]
            hybrid_items = lex_items
            meta: dict = {"mode": self.semantic_mode}
            try:
                embedding_query = (semantic_query or query) if self.semantic_backend == "local" else query
                hybrid_items, meta = self._hybrid_recall(items, ranked, embedding_query, limit)
            except Exception as exc:
                meta = {"mode": self.semantic_mode, "degraded": True, "reason": str(exc)[:120]}
                hybrid_items = lex_items
            if self.semantic_mode == "shadow":
                self._semantic_compare(query, lex_items, hybrid_items, meta)
                result = lex_items
            else:
                result = hybrid_items
        else:
            result = lex_items
        # Concurrency guard on EVERY return path: a retraction may have landed after
        # the query (lock released). Re-validate under the same lock retractions use.
        # mode=current -> only current; mode=all -> keep superseded, drop retracted.
        with self.lock:
            result = [it for it in result if self._is_servable(it["id"], mode)]
            for item in result:
                tags = item.get("tags")
                if item["subject"] == "author-note" and isinstance(tags, list) and "human-approved" in tags:
                    if not self.store.has_approved_candidate(item["id"]):
                        item["tags"] = [tag for tag in tags if tag != "human-approved"]
        return result

    def _is_current(self, fact_id: str) -> bool:
        fact = self.store.get_fact(fact_id)
        return fact is not None and fact.get("status") == "current"

    def _is_servable(self, fact_id: str, mode: str) -> bool:
        fact = self.store.get_fact(fact_id)
        if fact is None:
            return False
        if mode == "current":
            return fact.get("status") == "current"
        return fact.get("status") != "retracted"

    def _lexical_rank(self, items: list, query: str) -> list:
        query_terms = terms(query)
        if not query_terms:
            return [(0.0, it["recorded_at"], it) for it in reversed(items)]
        segments = [] if os.environ.get("MEMLAYER_SUBQUERY", "1") == "0" else [
            s for s in re.split(r"[，。！？；、,.!?;]|\s+(?:and|以及|还有)\s+", query.strip()) if len(s.strip()) >= 2]
        segment_terms = [terms(s) for s in segments] or [query_terms]
        ranked = []
        for item in items:
            text_terms = terms(item["text"])
            score = len(query_terms & text_terms) / max(1, len(query_terms))
            if query and query.lower() in item["text"].lower():
                score += 2.0
            compound = len(segment_terms) > 1 and (
                query.count("？") + query.count("?") >= 2 or bool(re.search(r"(以及|还有|和)", query)))
            if compound:
                covered = sum(1 for st in segment_terms if st & text_terms) / len(segment_terms)
                score += 1.2 * covered
            ranked.append((score, item["recorded_at"], item))
        ranked.sort(key=lambda row: (row[0], row[1]), reverse=True)
        return [row for row in ranked if row[0] > 0]

    # Bound embedding egress to the lexical top-K so the lock hold time is capped
    # regardless of store size (cold cache with N facts would otherwise embed all N).
    EMBED_TOP_K = 32
    # Upper bound on NEW embeddings per query in the independent-candidate mode.
    EMBED_MAX_NEW = 64
    LOCAL_EMBED_MAX_NEW = 16
    LOCAL_SEMANTIC_MIN_SCORE = 0.54

    def _hybrid_recall(self, items: list, ranked: list, query: str, limit: int):
        sem = self._sem
        # Hold self.lock ACROSS the embedding egress: retractions take the same lock,
        # so no retraction interleaves while fact text is sent to the embedding service
        # (retracted text never leaves the process). Egress is bounded to EMBED_TOP_K
        # lexical candidates, capping the lock hold; facts beyond top-K still rank via
        # the lexical side of RRF. Lock order self.lock -> _emb_lock matches the hook.
        local = self.semantic_backend == "local"
        all_candidates = local or os.environ.get("MEMLAYER_SEMANTIC_CANDIDATES", "lex").lower() == "all"
        with self.lock:
            current = [it for it in items if self._is_current(it["id"])]
            current_ids = {it["id"] for it in current}
            lex_ranked = [it for _, _, it in ranked if it["id"] in current_ids]
            if all_candidates:
                # Independent semantic candidates: every current fact may surface
                # even with zero lexical overlap. New embeddings per query are
                # capped so the lock hold stays bounded; the rest fall back to the
                # lexical half of RRF until their vectors exist.
                targets = current
                missing = [it for it in targets if self.emb_cache.get(it["id"], it["text"]) is None]
                missing = missing[:self.LOCAL_EMBED_MAX_NEW if local else self.EMBED_MAX_NEW]
            else:
                targets = lex_ranked[:self.EMBED_TOP_K]
                missing = [it for it in targets if self.emb_cache.get(it["id"], it["text"]) is None]
            with self._emb_lock:
                if missing:
                    vectors = self.semantic.embed([it["text"] for it in missing])
                    for it, v in zip(missing, vectors):
                        self.emb_cache.put(it["id"], it["text"], v)
                qv = self.semantic.embed_query(query) if local else self.semantic.embed([query])[0]
                vecs = {}
                for it in targets:
                    v = self.emb_cache.get(it["id"], it["text"])
                    if v is None:
                        if all_candidates:
                            continue  # not embedded yet: lexical side still applies
                        raise RuntimeError("embedding coverage incomplete")
                    vecs[it["id"]] = v
                if missing:
                    self.emb_cache.save()
            scored = [(it, sem.cosine(qv, vecs[it["id"]])) for it in targets if it["id"] in vecs]
            if local and self.local_reranker is not None:
                try:
                    reranked = self.local_reranker.select(query, scored, lex_ranked, limit)
                    self.local_reranker_status = "ready"
                    ids = [item["id"] for item in reranked]
                    return reranked, {"mode": "active", "candidates": len(current), "embedded": len(vecs),
                                      "candidatePolicy": "local-rerank", "sem_top": ids[:3], "degraded": False}
                except Exception as exc:
                    self.local_reranker_status = "inference-failed"
                    sys.stderr.write("[memlayer] LOCAL RERANKER INFERENCE FAILED: %s\n" % exc)
            if all_candidates:
                # Local BGE scores are calibrated separately from external providers.
                floor = self.LOCAL_SEMANTIC_MIN_SCORE if local else float(os.environ.get("MEMLAYER_SEMANTIC_MIN_SCORE", "0.25"))
                scored = [pair for pair in scored if pair[1] >= floor]
            sem_order = [it for it, _ in sorted(scored, key=lambda pair: pair[1], reverse=True)]
            sem_candidates = sem_order
            sem_ids = [it["id"] for it in sem_order]
            lex_ids = [it["id"] for it in lex_ranked]
            if local:
                # Locally reject weak matches when a vector exists. Keep lexical recall
                # for facts that are still waiting for their first embedding.
                strong_ids = set(sem_ids)
                lexical = [it for it in lex_ranked if it["id"] in strong_ids or it["id"] not in vecs]
                best = [{**sem_order[0], "match": "local-semantic"}] if sem_order and sem_ids[0] not in lex_ids else []
                hybrid = (best + lexical)[:limit]
            else:
                fused_ids = sem.rrf_fuse(lex_ids, sem_ids, k=60)
                by_id = {it["id"]: it for it in current}
                hybrid = [by_id[fid] for fid in fused_ids if fid in by_id][:limit]
        meta = {"mode": self.semantic_mode, "candidates": len(current),
                "embedded": len(sem_candidates), "candidatePolicy": "all" if all_candidates else "lex",
                "sem_top": sem_ids[:3], "degraded": False}
        return hybrid, meta

    def _semantic_compare(self, query: str, lex_items: list, hybrid_items: list, meta: dict) -> None:
        lex_ids = [it["id"] for it in lex_items]
        hyb_ids = [it["id"] for it in hybrid_items]
        added = [i for i in hyb_ids if i not in lex_ids]
        removed = [i for i in lex_ids if i not in hyb_ids]
        try:
            rec = {"at": now_iso(), "query": query[:200],
                   "lexical": lex_ids, "hybrid": hyb_ids,
                   "added": added, "removed": removed, **meta}
            with self.semantic_log_lock:
                with self.semantic_log_path.open("a", encoding="utf-8", newline="\n") as fh:
                    fh.write(json.dumps(rec, ensure_ascii=False) + "\n")
        except Exception:
            pass

    def capture_shadow(self, body: dict) -> dict:
        started = time.perf_counter()
        event = body.get("event")
        validate_event(event)
        eid = event["event_id"]
        error = ""
        recalled: list[dict] = []
        try:
            if body.get("query"):
                recalled = self.recall(event["project"], event.get("subject"), body["query"],
                                       limit=min(20, max(1, int(body.get("limit", 5)))),
                                       include_inferred=False, confirmed_only=True)
        except Exception as exc:
            error = str(exc)
        record = {
            "recordId": uuid.uuid4().hex,
            "recordedAt": datetime.now(timezone.utc).isoformat(),
            "mode": "shadow",
            "eventId": eid,
            "event": event,
            "baselineFactIds": body.get("baselineFactIds", []),
            "recallFactIds": [item["id"] for item in recalled],
            "latencyMs": round((time.perf_counter() - started) * 1000, 3),
            "error": error,
            "injected": False,
            "factsWritten": False,
            "host": body.get("host") or event.get("host", "unknown"),
        }
        result = self.shadow.append(record)
        result["recalled"] = len(recalled)
        result["injected"] = False
        result["factsWritten"] = False
        return result

    def candidate_from_shadow(self, body: dict) -> dict:
        event_id = body.get("event_id")
        if not isinstance(event_id, str) or not event_id:
            raise ValueError("event_id is required")
        row = self.shadow.get(event_id)
        if not row:
            raise KeyError("unknown shadow event")
        event = row["event"]
        payload = {
            "project": event["project"],
            "subject": body.get("subject") or event["subject"],
            "text": body.get("text") or event["text"],
            "perspective": body.get("perspective") or event.get("perspective", "self"),
            "source_event_id": event_id,
        }
        return self.writer.submit("candidate_create", payload)

    def close(self, timeout: float = 5.0) -> None:
        # shutdown()/join() block or fail when serve_forever never started.
        if self.started:
            self.server.shutdown()
        self.server.server_close()
        # If draining fails, MutationWriter raises and deliberately skips the
        # SQLite close. The caller may retry close after the writer settles.
        self.writer.close(timeout=timeout)
        self.store.close()
        if self.started:
            self.thread.join(timeout=timeout)


def main() -> None:
    parser = argparse.ArgumentParser(description="memlayer loopback bridge")
    parser.add_argument("--root", default=str(Path(__file__).parent / "bridge-data"))
    parser.add_argument("--host", default="127.0.0.1", choices=sorted(LOOPBACK))
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--retraction-mirror", default=None,
                        help="directory OUTSIDE --root that mirrors the retraction ledger")
    parser.add_argument("--local-embedding", type=Path,
                        help="directory with a local ONNX embedding model and tokenizer")
    args = parser.parse_args()
    service = BridgeService(args.root, args.host, args.port,
                            retraction_mirror=args.retraction_mirror,
                            local_embedding=args.local_embedding).start()
    print(json.dumps({"ok": True, "url": service.url, "root": args.root,
                      "recovery": service.store.recovery}, ensure_ascii=False), flush=True)
    try:
        threading.Event().wait()
    except KeyboardInterrupt:
        pass
    finally:
        service.close()


if __name__ == "__main__":
    main()

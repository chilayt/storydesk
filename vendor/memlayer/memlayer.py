"""memlayer: Markdown-first shared memory layer.

Design rules:
- Markdown files are the source of truth; SQLite is a rebuildable index.
- Facts are append-only. Changes close old validity; retractions add tombstones.
- Event IDs are idempotency keys scoped by project. The complete event payload is
  stored beside each fact, so the idempotency ledger survives index loss.
- Candidate review is recoverable: rejecting a pending candidate also retracts
  any fact left by an interrupted approval.

Standard library only. Single-user oriented; see PROGRESS.md for maturity and boundaries.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import sqlite3
import uuid
import warnings
from datetime import datetime, timezone
from pathlib import Path

FRONT_KEYS = ("id", "project", "subject", "perspective", "status", "confirmed",
              "valid_from", "valid_to", "recorded_at", "source_ids", "tags", "tombstone",
              "event_id", "event_payload", "supersedes", "superseded_by")
PROJECT_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
PERSPECTIVES = {"self", "relayed", "inferred"}
CANDIDATE_KEYS = ("id", "project", "subject", "perspective", "status", "source_event_id",
                  "content_hash", "created_at", "reviewed_at", "review_note", "fact_id", "suggested_fact_id", "suggested_action")
RETRACTION_KEYS = ("id", "project", "target_fact_id", "target_source_ids", "retracted_at",
                   "cascade_candidate_ids", "cascade_fact_ids", "reason")


class ReviewConflict(RuntimeError):
    """Raised when a review references stale candidate content or state."""


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def validate_event(event: dict) -> None:
    if not isinstance(event, dict):
        raise ValueError("event must be an object")
    for key in ("event_id", "project", "subject", "text"):
        if not isinstance(event.get(key), str) or not event[key].strip():
            raise ValueError(f"{key} must be a non-empty string")
    if len(event["event_id"]) > 512 or len(event["text"]) > 100_000:
        raise ValueError("event_id or text is too large")
    if not PROJECT_RE.fullmatch(event["project"]):
        raise ValueError("project must be a safe storage key (hash external paths first)")
    if len(event["subject"]) > 256 or re.search(r"[\r\n\x00]", event["subject"]):
        raise ValueError("invalid subject")
    if event.get("perspective", "self") not in PERSPECTIVES:
        raise ValueError("perspective must be self, relayed or inferred")
    if not isinstance(event.get("tags", []), list):
        raise ValueError("tags must be an array")
    if event.get("supersedes") is not None and not isinstance(event["supersedes"], str):
        raise ValueError("supersedes must be a fact id")


def parse_md(path: Path) -> dict:
    raw = path.read_text(encoding="utf-8")
    m = re.match(r"^---\r?\n(.*?)\r?\n---\r?\n(.*)$", raw, re.S)
    if not m:
        raise ValueError(f"bad fact file: {path}")
    rec = {}
    for line in m.group(1).splitlines():
        if ":" in line:
            key, value = line.split(":", 1)
            rec[key.strip()] = value.strip()
    rec["text"] = m.group(2).strip()
    for key in ("source_ids", "tags"):
        rec[key] = json.loads(rec.get(key) or "[]")
    rec["confirmed"] = str(rec.get("confirmed", "true")).lower() == "true"
    for key in ("valid_from", "valid_to", "recorded_at", "tombstone",
                "event_id", "event_payload", "supersedes", "reviewed_at",
                "review_note", "fact_id", "suggested_fact_id", "suggested_action"):
        if rec.get(key) in ("", "null", "None"):
            rec[key] = None
    return rec


def render_md(fact: dict) -> str:
    lines = ["---"]
    for key in FRONT_KEYS:
        value = fact.get(key)
        if key in ("source_ids", "tags", "event_payload"):
            value = json.dumps(value if value is not None else ([] if key != "event_payload" else None),
                               ensure_ascii=False)
        elif key == "confirmed":
            value = "true" if value else "false"
        elif value is None:
            value = "null"
        lines.append(f"{key}: {value}")
    lines.extend(("---", fact["text"], ""))
    return "\n".join(lines)


def review_note(value: object) -> str:
    if value is None:
        return ""
    if not isinstance(value, str):
        raise ValueError("review note must be a string")
    return value.replace("\r", " ").replace("\n", " ")[:1000]


def fact_review_hash(fact: dict) -> str:
    snapshot = {key: fact[key] for key in
                ("id", "project", "subject", "text", "source_ids", "status", "confirmed", "perspective")}
    # The Markdown reader uses universal newlines and strips surrounding whitespace.
    snapshot["text"] = snapshot["text"].replace("\r\n", "\n").replace("\r", "\n").strip()
    return hashlib.sha256(json.dumps(snapshot, ensure_ascii=False, sort_keys=True).encode("utf-8")).hexdigest()


class Store:
    def __init__(self, root: str | Path, *, retraction_mirror: str | Path | None = None):
        self.root = Path(root)
        # Mirror lives OUTSIDE the store root: rolling back the whole root
        # (memory + retractions) cannot lose a forget request.
        self.mirror = Path(retraction_mirror).resolve() if retraction_mirror else None
        if self.mirror:
            root_resolved = self.root.resolve()
            if self.mirror == root_resolved or root_resolved in self.mirror.parents:
                raise ValueError("retraction mirror must live outside the store root")
            (self.mirror / "retractions").mkdir(parents=True, exist_ok=True)
        self.read_failure: str | None = None
        self.memory = self.root / "memory"
        self.candidates_dir = self.root / "candidates"
        self.staging = self.root / "staging"
        self.retractions = self.root / "retractions"
        self.memory.mkdir(parents=True, exist_ok=True)
        self.candidates_dir.mkdir(parents=True, exist_ok=True)
        self.staging.mkdir(parents=True, exist_ok=True)
        self.retractions.mkdir(parents=True, exist_ok=True)
        self._retracted_sources: set[tuple[str, str]] = set()
        self._retract_hooks: list = []
        self._retract_hook_errors: list = []
        self.db_path = self.root / "index.db"
        self.db = sqlite3.connect(self.db_path, check_same_thread=False)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA synchronous=NORMAL")
        self._init_schema()
        self.recovery = self._recover_pending()
        self._reconcile_all()
        self.retraction_replay = self._replay_retractions()
        self.staging_recovery = self._recover_staging()

    def on_retract(self, callback) -> None:
        """Register callback(fact_id) fired after a fact is closed as retracted.
        Covers direct retract, cascade, replay, retry (all via _close_fact)."""
        self._retract_hooks.append(callback)

    def _init_schema(self) -> None:
        self.db.executescript("""
        CREATE TABLE IF NOT EXISTS events (
            event_id TEXT PRIMARY KEY,
            fact_id TEXT,
            payload TEXT,
            created_at TEXT
        );
        CREATE TABLE IF NOT EXISTS queue (
            event_id TEXT PRIMARY KEY,
            fact_id TEXT,
            status TEXT,
            updated_at TEXT,
            payload TEXT NOT NULL DEFAULT ''
        );
        CREATE TABLE IF NOT EXISTS facts (
            id TEXT PRIMARY KEY,
            project TEXT, subject TEXT, perspective TEXT,
            status TEXT, confirmed INTEGER,
            valid_from TEXT, valid_to TEXT, recorded_at TEXT,
            source_ids TEXT, tags TEXT, text TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_facts_scope ON facts(project, subject, status);
        CREATE TABLE IF NOT EXISTS candidates (
            id TEXT PRIMARY KEY,
            project TEXT, subject TEXT, perspective TEXT,
            status TEXT, source_event_id TEXT, content_hash TEXT,
            created_at TEXT, reviewed_at TEXT, review_note TEXT,
            fact_id TEXT, text TEXT, suggested_fact_id TEXT, suggested_action TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_candidates_status ON candidates(status, project);
        """)
        columns = {row[1] for row in self.db.execute("PRAGMA table_info(queue)")}
        if "payload" not in columns:
            self.db.execute("ALTER TABLE queue ADD COLUMN payload TEXT NOT NULL DEFAULT ''")
        columns = {row[1] for row in self.db.execute("PRAGMA table_info(candidates)")}
        if "suggested_fact_id" not in columns:
            self.db.execute("ALTER TABLE candidates ADD COLUMN suggested_fact_id TEXT")
        if "suggested_action" not in columns:
            self.db.execute("ALTER TABLE candidates ADD COLUMN suggested_action TEXT")
        self.db.commit()

    @staticmethod
    def _event_key(project: str, event_id: str) -> str:
        return project + "\x00" + event_id

    @staticmethod
    def _event_fact_id(project: str, event_id: str) -> str:
        return "f_" + uuid.uuid5(uuid.NAMESPACE_URL,
                                project + "\x00" + event_id).hex[:16]

    @classmethod
    def _fact_from_event(cls, event: dict, fact_id: str | None = None) -> dict:
        eid = event["event_id"]
        perspective = event.get("perspective", "self")
        return {
            "id": fact_id or cls._event_fact_id(event["project"], eid),
            "project": event["project"],
            "subject": event["subject"],
            "perspective": perspective,
            "status": "current",
            "confirmed": bool(event.get("confirmed", perspective != "inferred")),
            "valid_from": event.get("valid_from") or now_iso(),
            "valid_to": event.get("valid_to"),
            "recorded_at": event.get("at") or now_iso(),
            "source_ids": [event.get("source_msg") or eid],
            "tags": event.get("tags", []),
            "tombstone": None,
            "event_id": eid,
            "event_payload": dict(event),
            "supersedes": event.get("supersedes"),
            "text": event["text"],
        }

    def _path(self, fact: dict) -> Path:
        if not PROJECT_RE.fullmatch(fact["project"]):
            raise ValueError("unsafe project in fact")
        return self.memory / fact["project"] / f"{fact['id']}.md"

    @staticmethod
    def _atomic_write(path: Path, text: str) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(path.name + ".tmp-" + uuid.uuid4().hex)
        try:
            tmp.write_text(text, encoding="utf-8", newline="\n")
            fd = os.open(tmp, os.O_RDWR)
            try:
                os.fsync(fd)
            finally:
                os.close(fd)
            os.replace(tmp, path)
            try:  # best-effort directory durability; Windows may refuse dir fds
                dir_fd = os.open(path.parent, os.O_RDONLY)
                try:
                    os.fsync(dir_fd)
                finally:
                    os.close(dir_fd)
            except OSError:
                pass
        finally:
            if tmp.exists():
                tmp.unlink()

    def _write_fact(self, fact: dict) -> None:
        self._atomic_write(self._path(fact), render_md(fact))

    def _index(self, fact: dict) -> None:
        self.db.execute("INSERT OR REPLACE INTO facts VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                        (fact["id"], fact["project"], fact["subject"], fact["perspective"],
                         fact["status"], 1 if fact["confirmed"] else 0,
                         fact["valid_from"], fact["valid_to"], fact["recorded_at"],
                         json.dumps(fact["source_ids"], ensure_ascii=False),
                         json.dumps(fact["tags"], ensure_ascii=False), fact["text"]))
        self.db.commit()

    @staticmethod
    def _payload_from_fact(fact: dict) -> dict:
        payload = fact.get("event_payload")
        if isinstance(payload, str):
            try:
                payload = json.loads(payload)
            except json.JSONDecodeError:
                payload = None
        if isinstance(payload, dict):
            return payload
        event_id = fact.get("event_id") or (fact.get("source_ids") or ["legacy"])[0]
        return {
            "event_id": event_id,
            "project": fact["project"],
            "subject": fact["subject"],
            "text": fact["text"],
            "perspective": fact.get("perspective", "self"),
            "confirmed": fact.get("confirmed", False),
            "at": fact.get("recorded_at"),
            "source_msg": (fact.get("source_ids") or [event_id])[0],
            "tags": fact.get("tags", []),
            **({"supersedes": fact["supersedes"]} if fact.get("supersedes") else {}),
        }

    def _record_event(self, fact: dict, payload: dict | None = None) -> None:
        event = payload or self._payload_from_fact(fact)
        event_id = event["event_id"]
        key = self._event_key(fact["project"], event_id)
        self.db.execute("INSERT OR REPLACE INTO events VALUES (?,?,?,?)",
                        (key, fact["id"], json.dumps(event, ensure_ascii=False),
                         fact.get("recorded_at") or now_iso()))
        self.db.commit()

    def append(self, event: dict) -> dict:
        validate_event(event)
        project = event["project"]
        _src = event.get("source_msg")
        if _src and (project, _src) in self._retracted_sources:
            return {"blocked": True, "fact_id": None,
                    "reason": "source retracted; requires re-approval"}
        key = self._event_key(project, event["event_id"])
        row = self.db.execute("SELECT fact_id FROM events WHERE event_id=?", (key,)).fetchone()
        if row:
            return {"fact_id": row[0], "duplicate": True}
        fact = self._fact_from_event(event)
        path = self._path(fact)
        if path.exists():
            # A crash may have committed Markdown before the SQLite event row.
            # Re-index and return it without resetting a tombstone.
            existing = parse_md(path)
            self._index(existing)
            self._record_event(existing, event)
            self.db.execute("UPDATE queue SET status='done',updated_at=? WHERE event_id=?",
                            (now_iso(), key))
            self.db.commit()
            return {"fact_id": existing["id"], "duplicate": True}
        payload = json.dumps(event, ensure_ascii=False)
        self.db.execute(
            "INSERT INTO queue(event_id,fact_id,status,updated_at,payload) VALUES (?,?,?,?,?)",
            (key, fact["id"], "pending", now_iso(), payload))
        self.db.commit()
        self._write_fact(fact)
        self._index(fact)
        if event.get("supersedes"):
            self._close_fact(event["supersedes"], "superseded", fact["recorded_at"],
                             expected_project=project)
        self._record_event(fact, event)
        self.db.execute("UPDATE queue SET status='done', updated_at=? WHERE event_id=?",
                        (now_iso(), key))
        self.db.commit()
        return {"fact_id": fact["id"], "duplicate": False}

    def _recover_pending(self) -> dict:
        recovered = 0
        unresolved = []
        rows = self.db.execute(
            "SELECT event_id,fact_id,payload FROM queue WHERE status='pending'").fetchall()
        for key, fact_id, raw_payload in rows:
            try:
                if not raw_payload:
                    old = self.db.execute("SELECT payload FROM events WHERE event_id=?", (key,)).fetchone()
                    raw_payload = old[0] if old else ""
                if not raw_payload:
                    unresolved.append(key)
                    continue
                event = json.loads(raw_payload)
                validate_event(event)
                path = self.memory / event["project"] / f"{fact_id}.md"
                fact = parse_md(path) if path.exists() else self._fact_from_event(event, fact_id)
                if not path.exists():
                    self._write_fact(fact)
                self._index(fact)
                if event.get("supersedes"):
                    self._close_fact(event["supersedes"], "superseded", fact["recorded_at"],
                                     expected_project=event["project"])
                self._record_event(fact, event)
                self.db.execute("UPDATE queue SET status='done',updated_at=? WHERE event_id=?",
                                (now_iso(), key))
                self.db.commit()
                recovered += 1
            except Exception as exc:
                self.db.rollback()
                unresolved.append(key)
                warnings.warn(f"memlayer: cannot recover {key}: {exc}")
        return {"recovered": recovered, "unresolved": unresolved}

    def _reconcile_all(self) -> int:
        self.db.execute("DELETE FROM facts")
        self.db.execute("DELETE FROM candidates")
        self.db.execute("DELETE FROM events")
        self.db.commit()
        count = 0
        for path in self.memory.rglob("*.md"):
            try:
                fact = parse_md(path)
                self._index(fact)
                self._record_event(fact)
                count += 1
            except (OSError, ValueError, json.JSONDecodeError) as exc:
                warnings.warn(f"memlayer: skipping unreadable fact {path}: {exc}")
        for path in self.candidates_dir.rglob("*.md"):
            try:
                candidate = parse_md(path)
                self._index_candidate(candidate)
            except (OSError, ValueError, json.JSONDecodeError) as exc:
                warnings.warn(f"memlayer: skipping unreadable candidate {path}: {exc}")
        self.db.commit()
        return count

    def get_fact(self, fact_id: str) -> dict | None:
        row = self.db.execute("SELECT * FROM facts WHERE id=?", (fact_id,)).fetchone()
        if not row:
            return None
        cols = [c[0] for c in self.db.execute("SELECT * FROM facts LIMIT 0").description]
        item = dict(zip(cols, row))
        item["source_ids"] = json.loads(item["source_ids"])
        item["tags"] = json.loads(item["tags"])
        item["confirmed"] = bool(item["confirmed"])
        return item

    def _close_fact(self, fact_id: str, status: str, at: str,
                    tombstone: str | None = None, expected_project: str | None = None,
                    superseded_by: str | None = None) -> bool:
        row = self.db.execute("SELECT project FROM facts WHERE id=?", (fact_id,)).fetchone()
        if not row:
            return False
        if expected_project is not None and row[0] != expected_project:
            raise ValueError("cannot change a fact from another project")
        path = self.memory / row[0] / f"{fact_id}.md"
        if not path.exists():
            return False
        fact = parse_md(path)
        fact["status"] = status
        fact["valid_to"] = at
        if tombstone is not None:
            fact["tombstone"] = tombstone
        if superseded_by is not None:
            fact["superseded_by"] = superseded_by
        self._write_fact(fact)
        self._index(fact)
        if status in ("retracted", "superseded"):
            for hook in self._retract_hooks:
                try:
                    hook(fact_id)
                except Exception as exc:
                    self._retract_hook_errors.append({"fact_id": fact_id, "error": str(exc)})
        return True

    def supersede(self, old_fact_id: str, new_event: dict) -> dict:
        old = self.get_fact(old_fact_id)
        if not old:
            raise KeyError(f"unknown fact: {old_fact_id}")
        if new_event.get("project") != old["project"]:
            raise ValueError("cannot supersede a fact from another project")
        event = dict(new_event)
        event["supersedes"] = old_fact_id
        return self.append(event)

    # ---------- retraction ledger and cascade ----------
    def _retraction_path(self, project: str, retraction_id: str) -> Path:
        if not PROJECT_RE.fullmatch(project):
            raise ValueError("unsafe project in retraction")
        return self.retractions / project / f"{retraction_id}.md"

    @staticmethod
    def _render_retraction(record: dict) -> str:
        lines = ["---"]
        for key in RETRACTION_KEYS:
            value = record.get(key)
            if key in ("target_source_ids", "cascade_candidate_ids", "cascade_fact_ids"):
                value = json.dumps(value or [], ensure_ascii=False)
            elif value is None:
                value = "null"
            lines.append(f"{key}: {value}")
        lines.extend(("---", record.get("reason") or "", ""))
        return "\n".join(lines)

    @staticmethod
    def _json_list(value: object) -> list:
        if isinstance(value, list):
            return value
        if isinstance(value, str):
            try:
                parsed = json.loads(value)
                return parsed if isinstance(parsed, list) else []
            except json.JSONDecodeError:
                return []
        return []

    @staticmethod
    def _validate_retraction_record(record: dict, path: Path) -> dict:
        """A ledger record with missing/invalid safety fields is corruption.

        Silently treating it as 'no targets' would disable replay, so fail hard.
        """
        project = record.get("project")
        target = record.get("target_fact_id")
        if not isinstance(project, str) or not PROJECT_RE.fullmatch(project):
            raise ValueError(f"corrupt retraction ledger (project): {path}")
        if not isinstance(target, str) or not target:
            raise ValueError(f"corrupt retraction ledger (target_fact_id): {path}")
        for key in ("target_source_ids", "cascade_candidate_ids", "cascade_fact_ids"):
            if key not in record:
                raise ValueError(f"corrupt retraction ledger (missing {key}): {path}")
            raw = record.get(key)
            if isinstance(raw, str):
                try:
                    parsed = json.loads(raw)
                except json.JSONDecodeError as exc:
                    raise ValueError(f"corrupt retraction ledger ({key}): {path}") from exc
            elif isinstance(raw, list):
                parsed = raw
            else:
                raise ValueError(f"corrupt retraction ledger ({key}): {path}")
            if not isinstance(parsed, list):
                raise ValueError(f"corrupt retraction ledger ({key} not a list): {path}")
            if not all(isinstance(item, str) and item for item in parsed):
                raise ValueError(f"corrupt retraction ledger ({key} elements): {path}")
            record[key] = parsed
        return record

    def _ledger_paths(self) -> list[Path]:
        paths = sorted(self.retractions.rglob("*.md"))
        if self.mirror:
            paths += sorted((self.mirror / "retractions").rglob("*.md"))
        return paths

    def _load_retraction_index(self) -> None:
        self._retracted_sources = set()
        for path in self._ledger_paths():
            record = self._validate_retraction_record(parse_md(path), path)
            for source in record["target_source_ids"]:
                self._retracted_sources.add((record["project"], source))

    def _replay_retractions(self, strict: bool = True) -> dict:
        """Re-apply tombstones after an old Markdown backup is restored.

        The ledger lives outside memory/, so restoring memory/ alone cannot
        resurrect a retracted fact: startup replays every ledger record.
        """
        self._load_retraction_index()
        replayed = 0
        for path in self._ledger_paths():
            record = self._validate_retraction_record(parse_md(path), path)
            targets = [record["target_fact_id"]] + record["cascade_fact_ids"]
            for target in targets:
                if not target:
                    continue
                row = self.db.execute("SELECT status, project FROM facts WHERE id=?", (target,)).fetchone()
                if row and row[1] != record["project"]:
                    raise ValueError(f"corrupt retraction ledger (cross-project target): {path}")
                if row and row[0] != "retracted":
                    try:
                        closed = self._close_fact(target, "retracted", record.get("retracted_at") or now_iso(),
                                                  f"[RETRACTED: {record.get('reason') or 'ledger replay'}]")
                    except Exception:
                        if strict:
                            raise
                        closed = False
                    if not closed and strict:
                        raise RuntimeError(f"retraction replay incomplete for {target}; ledger durable")
                    if closed:
                        replayed += 1
        return {"replayed": replayed, "ledger": len(list(self.retractions.rglob("*.md")))}

    def _ledger_for(self, fact_id: str) -> dict | None:
        for path in self.retractions.rglob("*.md"):
            record = self._validate_retraction_record(parse_md(path), path)
            if record["target_fact_id"] == fact_id:
                return record
        return None

    def _ensure_mirror(self, record: dict) -> str | None:
        if not self.mirror:
            return None
        mirror_path = self.mirror / "retractions" / record["project"] / f"{record['id']}.md"
        if mirror_path.exists():
            return None
        try:
            mirror_path.parent.mkdir(parents=True, exist_ok=True)
            self._atomic_write(mirror_path, self._render_retraction(record))
            return None
        except Exception as exc:  # mirror degrades rollback resistance only
            return str(exc)

    def retract(self, fact_id: str, reason: str = "") -> bool:
        fact = self.get_fact(fact_id)
        if fact is None:
            return False
        sources = set(fact.get("source_ids") or [])
        ledger = self._ledger_for(fact_id)
        if fact["status"] == "retracted" and ledger is not None:
            # Retry path: the forget already took effect; only heal a missing mirror.
            mirror_error = self._ensure_mirror(ledger)
            if mirror_error:
                raise RuntimeError(f"retraction applied but mirror write failed: {mirror_error}")
            self._load_retraction_index()
            return True
        # Ledger FIRST: a crash between ledger and tombstone is repaired by
        # startup replay, while the opposite order can resurrect facts when
        # an old memory backup is restored.
        cascade_facts = []
        if fact["status"] != "retracted":
            # Cascade must cover every non-retracted version that shares a source,
            # including superseded ones: otherwise mode=all (audit reads) would keep
            # returning the old text after the source was retracted.
            cascade_facts = [f["id"] for f in self.query(fact["project"], mode="all")
                             if f["id"] != fact_id and f.get("status") != "retracted"
                             and sources & set(f.get("source_ids") or [])]
        cascaded_candidates = [c["id"] for c in self.list_candidates(status="pending")
                               if c["project"] == fact["project"]
                               and c["source_event_id"] in sources]
        existing_record = ledger
        if existing_record is None:
            record = {
                "id": "r_" + uuid.uuid4().hex[:16],
                "project": fact["project"],
                "target_fact_id": fact_id,
                "target_source_ids": sorted(sources),
                "retracted_at": now_iso(),
                "cascade_candidate_ids": cascaded_candidates,
                "cascade_fact_ids": cascade_facts,
                "reason": reason or "requested",
            }
            rendered = self._render_retraction(record)
            self._atomic_write(self._retraction_path(fact["project"], record["id"]), rendered)
            existing_record = record
        mirror_error = self._ensure_mirror(existing_record)
        marker = f"[RETRACTED: {reason or 'requested'}]"
        targets = ([fact_id] if fact["status"] != "retracted" else []) + cascade_facts
        failed = False
        for target in targets:
            try:
                closed = self._close_fact(target, "retracted", now_iso(),
                                          marker if target == fact_id else f"[RETRACTED: cascade of {fact_id}]")
                if not closed:
                    failed = True
            except Exception:
                failed = True
        if failed:
            # Self-heal inside the same call: the ledger is already durable,
            # so replay can close whatever the interrupted pass missed.
            try:
                self._replay_retractions(strict=False)
            except Exception as exc:
                self.read_failure = f"retraction replay failed: {exc}"
                raise RuntimeError(self.read_failure) from exc
            missing = [t for t in targets
                       if (self.get_fact(t) or {}).get("status") != "retracted"]
            if missing:
                # Fail closed: the ledger is durable but this process cannot
                # stop serving the stale fact, so refuse further reads.
                self.read_failure = f"retraction incomplete for {missing}"
                raise RuntimeError(f"{self.read_failure}; ledger durable, replay failed")
        if mirror_error:
            # The forget took effect, but the rollback-proof copy is missing:
            # surface it so an operator can fix the mirror and retry. Refresh
            # the in-process source index first so approval blocking is current.
            self._load_retraction_index()
            raise RuntimeError(f"retraction applied but mirror write failed: {mirror_error}")
        self._load_retraction_index()
        return True

    @staticmethod
    def _ledger_targets(path: Path, fact_id: str) -> bool:
        try:
            return parse_md(path).get("target_fact_id") == fact_id
        except (OSError, ValueError, json.JSONDecodeError):
            return False

    # ---------- candidate review (never recalled before approval) ----------
    @staticmethod
    def _candidate_hash(text: str) -> str:
        return hashlib.sha256(text.strip().encode("utf-8")).hexdigest()

    @staticmethod
    def _candidate_identity(project: str, subject: str, source_event_id: str,
                            content_hash: str) -> str:
        canonical = json.dumps([project, subject, source_event_id, content_hash],
                               ensure_ascii=False, separators=(",", ":"))
        return "c_" + uuid.uuid5(uuid.NAMESPACE_URL, canonical).hex[:16]

    def _candidate_path(self, candidate: dict) -> Path:
        if not PROJECT_RE.fullmatch(candidate["project"]):
            raise ValueError("unsafe project in candidate")
        return self.candidates_dir / candidate["project"] / f"{candidate['id']}.md"

    @staticmethod
    def _render_candidate(candidate: dict) -> str:
        lines = ["---"]
        for key in CANDIDATE_KEYS:
            value = candidate.get(key)
            lines.append(f"{key}: {'null' if value is None else value}")
        lines.extend(("---", candidate["text"], ""))
        return "\n".join(lines)

    def _write_candidate(self, candidate: dict) -> None:
        self._atomic_write(self._candidate_path(candidate), self._render_candidate(candidate))

    def _index_candidate(self, candidate: dict) -> None:
        self.db.execute("INSERT OR REPLACE INTO candidates VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                        (candidate["id"], candidate["project"], candidate["subject"],
                         candidate["perspective"], candidate["status"], candidate["source_event_id"],
                         candidate["content_hash"], candidate["created_at"], candidate.get("reviewed_at"),
                         candidate.get("review_note"), candidate.get("fact_id"), candidate["text"],
                         candidate.get("suggested_fact_id"), candidate.get("suggested_action")))
        self.db.commit()

    def create_candidate(self, payload: dict) -> dict:
        source_event_id = payload.get("source_event_id") or payload.get("event_id")
        event = {"event_id": source_event_id, "project": payload.get("project"),
                 "subject": payload.get("subject"), "text": payload.get("text"),
                 "perspective": payload.get("perspective", "self")}
        validate_event(event)
        content_hash = self._candidate_hash(event["text"])
        cid = self._candidate_identity(event["project"], event["subject"],
                                       source_event_id, content_hash)
        existing = self.get_candidate(cid)
        if existing:
            return {"candidate": existing, "duplicate": True}
        candidate = {
            "id": cid, "project": event["project"], "subject": event["subject"],
            "perspective": event["perspective"], "status": "pending",
            "source_event_id": source_event_id, "content_hash": content_hash,
            "created_at": now_iso(), "reviewed_at": None, "review_note": None,
            "fact_id": None, "text": event["text"].strip(),
            "suggested_fact_id": payload.get("suggested_fact_id") or None,
            "suggested_action": payload.get("suggested_action") or None,
        }
        if candidate["suggested_action"] not in (None, "replace", "exception", "duplicate"):
            raise ValueError("invalid suggested action")
        suggested = candidate["suggested_fact_id"]
        if candidate["suggested_action"] and not suggested:
            raise ValueError("suggested action needs a target")
        if suggested is not None:
            if not isinstance(suggested, str):
                raise ValueError("invalid suggested fact")
            self._replacement_target(candidate, suggested)
        self._write_candidate(candidate)
        self._index_candidate(candidate)
        return {"candidate": candidate, "duplicate": False}

    def get_candidate(self, candidate_id: str) -> dict | None:
        row = self.db.execute("SELECT * FROM candidates WHERE id=?", (candidate_id,)).fetchone()
        if not row:
            return None
        cols = [c[0] for c in self.db.execute("SELECT * FROM candidates LIMIT 0").description]
        candidate = dict(zip(cols, row))
        path = self._candidate_path(candidate)
        if path.exists():
            # Markdown is authoritative. Refresh the index before every review
            # so external edits cannot be approved through a stale DB row.
            candidate = parse_md(path)
            self._index_candidate(candidate)
        return candidate

    def list_candidates(self, status: str | None = None, project: str | None = None) -> list[dict]:
        if status and status not in {"pending", "approved", "rejected"}:
            raise ValueError("invalid candidate status")
        sql = "SELECT * FROM candidates"
        args: list = []
        clauses = []
        if status:
            clauses.append("status=?")
            args.append(status)
        if project:
            if not PROJECT_RE.fullmatch(project):
                raise ValueError("unsafe project")
            clauses.append("project=?")
            args.append(project)
        if clauses:
            sql += " WHERE " + " AND ".join(clauses)
        rows = self.db.execute(sql + " ORDER BY created_at", args).fetchall()
        cols = [c[0] for c in self.db.execute("SELECT * FROM candidates LIMIT 0").description]
        return [dict(zip(cols, row)) for row in rows]

    def has_approved_candidate(self, fact_id: str) -> bool:
        return self.db.execute(
            "SELECT 1 FROM candidates WHERE fact_id=? AND status='approved' LIMIT 1", (fact_id,),
        ).fetchone() is not None

    def _check_review(self, candidate: dict | None, expected_hash: str) -> dict:
        if not candidate:
            raise KeyError("unknown candidate")
        if not self._candidate_path(candidate).exists():
            raise ReviewConflict("candidate Markdown is missing")
        actual_hash = self._candidate_hash(candidate["text"])
        if actual_hash != expected_hash or candidate["content_hash"] != expected_hash:
            raise ReviewConflict("candidate content hash is stale")
        identity = self._candidate_identity(candidate["project"], candidate["subject"],
                                            candidate["source_event_id"], actual_hash)
        if identity != candidate["id"]:
            raise ReviewConflict("candidate project, subject or source changed")
        return candidate

    def _staging_path(self, fact: dict) -> Path:
        if not PROJECT_RE.fullmatch(fact["project"]):
            raise ValueError("unsafe project in staged fact")
        return self.staging / fact["project"] / f"{fact['id']}.md"

    def _replacement_target(self, entry: dict, fact_id: str) -> dict:
        old = self.get_fact(fact_id)
        if old is None or old["project"] != entry["project"] or old["subject"] != entry["subject"] or not old["confirmed"]:
            raise ReviewConflict("替换目标不在当前范围，或尚未确认")
        return old

    def _commit_staged_fact(self, fact: dict) -> dict:
        target = fact.get("supersedes")
        if target:
            old = self._replacement_target(fact, target)
            if old["status"] == "current":
                if not self._close_fact(target, "superseded", fact["recorded_at"], expected_project=fact["project"],
                                        superseded_by=fact["id"]):
                    raise ReviewConflict("无法关闭待替换的旧记忆")
            elif old["status"] != "superseded" or parse_md(self._path(old)).get("superseded_by") != fact["id"]:
                raise ReviewConflict("旧记忆已变化，请重新核对")
        src = self._staging_path(fact)
        dst = self._path(fact)
        dst.parent.mkdir(parents=True, exist_ok=True)
        os.replace(src, dst)
        committed = parse_md(dst)
        self._index(committed)
        self._record_event(committed)
        return committed

    def _recover_staging(self) -> dict:
        moved = kept = removed = blocked = 0
        for path in sorted(self.staging.rglob("*.md")):
            try:
                fact = parse_md(path)
            except (OSError, ValueError, json.JSONDecodeError) as exc:
                warnings.warn(f"memlayer: skipping unreadable staged fact {path}: {exc}")
                kept += 1
                continue
            candidate = self._candidate_by_fact_id(fact["id"])
            status = candidate["status"] if candidate else None
            if status == "approved":
                sources = set(fact.get("source_ids") or [])
                if candidate and (candidate["project"], candidate["source_event_id"]) in self._retracted_sources \
                        or any((fact["project"], s) in self._retracted_sources for s in sources):
                    # A source was retracted after approval but before commit:
                    # never publish it; a human must reject or re-source it.
                    warnings.warn(f"memlayer: staged fact {fact['id']} blocked by retraction ledger")
                    blocked += 1
                    continue
                try:
                    self._commit_staged_fact(fact)
                    moved += 1
                except ReviewConflict as exc:
                    warnings.warn(f"memlayer: staged replacement blocked: {exc}")
                    blocked += 1
            elif status == "rejected":
                path.unlink()
                removed += 1
            else:
                # Pending or orphaned: stay invisible until a human decides.
                kept += 1
        return {"moved": moved, "kept": kept, "removed": removed, "blocked": blocked}

    def _candidate_by_fact_id(self, fact_id: str) -> dict | None:
        row = self.db.execute("SELECT * FROM candidates WHERE fact_id=?", (fact_id,)).fetchone()
        if not row:
            return None
        cols = [c[0] for c in self.db.execute("SELECT * FROM candidates LIMIT 0").description]
        return dict(zip(cols, row))

    def approve_candidate(self, candidate_id: str, expected_hash: str, note: str = "",
                          supersedes_fact_id: str | None = None, *, add_exception: bool = False,
                          expected_target_hash: str | None = None) -> dict:
        if expected_target_hash is not None and (
            not supersedes_fact_id or not isinstance(expected_target_hash, str)
            or not re.fullmatch(r"[a-f0-9]{64}", expected_target_hash)
        ):
            raise ValueError("invalid review hash for the selected current memory")
        clean_note = review_note(note)
        candidate = self._check_review(self.get_candidate(candidate_id), expected_hash)
        if candidate["status"] == "approved":
            fid = candidate["fact_id"]
            entry = {"project": candidate["project"], "id": fid}
            staged = self._staging_path(entry)
            destination = self._path(entry)
            if staged.exists():
                fact = parse_md(staged)
                if (fact.get("supersedes") != supersedes_fact_id
                        or ("author-exceptions" in fact["tags"]) != add_exception):
                    raise ReviewConflict("候选已按另一种方式确认，请刷新")
                if any((candidate["project"], source) in self._retracted_sources for source in fact["source_ids"]):
                    raise ReviewConflict("候选来源已撤回")
                self._commit_staged_fact(fact)
            elif destination.exists():
                fact = parse_md(destination)
                if (fact.get("supersedes") != supersedes_fact_id
                        or ("author-exceptions" in fact["tags"]) != add_exception):
                    raise ReviewConflict("候选已按另一种方式确认，请刷新")
                self._index(fact)
                self._record_event(fact)
            else:
                raise ReviewConflict("已确认记录缺失，请核对记忆库")
            return {"candidate": candidate, "fact_id": fid, "duplicate": True}
        if candidate["status"] != "pending":
            raise ReviewConflict("only pending candidates can be approved")
        if (candidate["project"], candidate["source_event_id"]) in self._retracted_sources:
            raise ReviewConflict("candidate source was retracted; approve is blocked")
        if supersedes_fact_id is not None:
            old = self._replacement_target(candidate, supersedes_fact_id)
            if old["status"] != "current":
                raise ReviewConflict("待替换的旧记忆已停用，请重新核对")
            if expected_target_hash is not None:
                try:
                    markdown = parse_md(self._path(old))
                    matching_review = all(fact_review_hash(snapshot) == expected_target_hash
                                          for snapshot in (old, markdown))
                except (OSError, ValueError, KeyError) as exc:
                    raise ReviewConflict("无法核对旧记忆，请重新读取") from exc
                if not matching_review:
                    raise ReviewConflict("旧记忆已修改，请重新核对")
                old = markdown
        if add_exception and not supersedes_fact_id:
            raise ValueError("请选择要补充例外的现行记忆")
        wording = candidate["text"]
        tags = ["human-approved"]
        sources = [candidate["source_event_id"]]
        if add_exception:
            if not self.has_approved_candidate(supersedes_fact_id):
                raise ReviewConflict("例外需要关联作者已确认的记忆")
            sources.extend(old["source_ids"])
            if any((candidate["project"], source) in self._retracted_sources for source in sources):
                raise ReviewConflict("现行记忆的来源已撤回")
            wording = old["text"] + "\n\n适用例外（只在下述条件成立时优先）：\n" + wording
            if len(wording) > 1800:
                raise ReviewConflict("合并后的约定太长，请先整理现行规则")
            tags.append("author-exceptions")
        fact = self._fact_from_event({
            "event_id": "candidate:" + candidate_id,
            "supersedes": supersedes_fact_id,
            "project": candidate["project"], "subject": candidate["subject"],
            "text": wording, "perspective": candidate["perspective"],
            "confirmed": True, "source_msg": candidate["source_event_id"],
            "tags": tags, **({"add_exception": True} if add_exception else {}),
        })
        fact["source_ids"] = list(dict.fromkeys(sources))
        # Staged commit: the fact is invisible to every query and injection until
        # the candidate row says approved AND the file has moved into memory/.
        staging = self._staging_path(fact)
        self._atomic_write(staging, render_md(fact))
        candidate["status"] = "approved"
        candidate["fact_id"] = fact["id"]
        candidate["reviewed_at"] = now_iso()
        candidate["review_note"] = clean_note
        self._write_candidate(candidate)
        self._index_candidate(candidate)
        self._commit_staged_fact(fact)
        return {"candidate": candidate, "fact_id": fact["id"], "duplicate": False}

    def reject_candidate(self, candidate_id: str, expected_hash: str, note: str = "") -> dict:
        clean_note = review_note(note)
        candidate = self._check_review(self.get_candidate(candidate_id), expected_hash)
        if candidate["status"] == "rejected":
            return {"candidate": candidate, "duplicate": True}
        if candidate["status"] != "pending":
            raise ReviewConflict("only pending candidates can be rejected")
        # Destroy the staged copy first: a crash after this point can never make
        # the unapproved fact visible.
        staged = self._staging_path({"project": candidate["project"],
                                     "id": self._event_fact_id(candidate["project"], "candidate:" + candidate_id)})
        if staged.exists():
            staged.unlink()
        # Legacy/external facts already in memory are tombstoned, not deleted.
        orphan_id = self._event_fact_id(candidate["project"], "candidate:" + candidate_id)
        orphan_path = self.memory / candidate["project"] / f"{orphan_id}.md"
        if orphan_path.exists():
            orphan = parse_md(orphan_path)
            self._index(orphan)
            self._record_event(orphan)
            self.retract(orphan_id, "candidate rejected")
        candidate["status"] = "rejected"
        candidate["reviewed_at"] = now_iso()
        candidate["review_note"] = clean_note
        self._write_candidate(candidate)
        self._index_candidate(candidate)
        return {"candidate": candidate, "duplicate": False}

    def _assert_readable(self) -> None:
        if self.read_failure:
            raise RuntimeError(f"store read blocked: {self.read_failure}")

    def query(self, project: str, subject: str | None = None, mode: str = "current",
              include_inferred: bool = True, confirmed_only: bool = False) -> list[dict]:
        self._assert_readable()
        if not PROJECT_RE.fullmatch(project):
            raise ValueError("unsafe project")
        if mode not in {"current", "all"}:
            raise ValueError("mode must be current or all")
        at = now_iso()
        sql = "SELECT * FROM facts WHERE project=?"
        args: list = [project]
        if subject:
            sql += " AND subject=?"
            args.append(subject)
        if mode == "current":
            sql += " AND status='current' AND valid_from<=? AND (valid_to IS NULL OR valid_to>?)"
            args.extend((at, at))
        else:
            sql += " AND status<>'retracted'"
        if not include_inferred:
            sql += " AND perspective<>'inferred'"
        if confirmed_only:
            sql += " AND confirmed=1"
        rows = self.db.execute(sql + " ORDER BY recorded_at", args).fetchall()
        cols = [c[0] for c in self.db.execute("SELECT * FROM facts LIMIT 0").description]
        out = []
        for row in rows:
            item = dict(zip(cols, row))
            item["source_ids"] = json.loads(item["source_ids"])
            item["tags"] = json.loads(item["tags"])
            item["confirmed"] = bool(item["confirmed"])
            out.append(item)
        return out

    def status(self) -> dict:
        q = lambda sql: self.db.execute(sql).fetchone()[0]
        return {
            "facts_total": q("SELECT COUNT(*) FROM facts"),
            "facts_current": q("SELECT COUNT(*) FROM facts WHERE status='current'"),
            "facts_superseded": q("SELECT COUNT(*) FROM facts WHERE status='superseded'"),
            "facts_retracted": q("SELECT COUNT(*) FROM facts WHERE status='retracted'"),
            "events": q("SELECT COUNT(*) FROM events"),
            "queue_pending": q("SELECT COUNT(*) FROM queue WHERE status='pending'"),
            "candidates_pending": q("SELECT COUNT(*) FROM candidates WHERE status='pending'"),
            "candidates_approved": q("SELECT COUNT(*) FROM candidates WHERE status='approved'"),
            "candidates_rejected": q("SELECT COUNT(*) FROM candidates WHERE status='rejected'"),
            "staging": len(list(self.staging.rglob("*.md"))),
        }

    def rebuild(self) -> dict:
        recovered = self._recover_pending()
        rebuilt = self._reconcile_all()
        replay = self._replay_retractions()
        staging = self._recover_staging()
        return {"rebuilt": rebuilt, "recovered_pending": recovered["recovered"],
                "retraction_replay": replay["replayed"], "staging": staging}

    def close(self) -> None:
        self.db.close()

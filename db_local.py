"""Local SQLite database manager for OpenShorts AI Assistant.

Manages persistent storage for chat conversations, messages, and assistant tasks,
linking each request to real OpenShorts job_ids. Configured with WAL mode and indexes.
"""
from __future__ import annotations

import json
import os
import sqlite3
import time
import uuid
from typing import Any, Dict, List, Optional

PROJECT_ROOT = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(PROJECT_ROOT, "data")
DB_PATH = os.path.join(DATA_DIR, "openshorts.db")


def _get_connection() -> sqlite3.Connection:
    """Return a thread-safe connection with WAL mode and foreign keys enabled."""
    os.makedirs(DATA_DIR, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=30.0)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute("PRAGMA foreign_keys=ON;")
    return conn


def init_db() -> None:
    """Initialize database tables and indexes if they do not exist."""
    with _get_connection() as conn:
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS conversations (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                context_json TEXT DEFAULT '{}',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS messages (
                id TEXT PRIMARY KEY,
                conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
                sender TEXT NOT NULL CHECK (sender IN ('user', 'assistant', 'system')),
                content TEXT NOT NULL,
                tool_calls TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS assistant_tasks (
                id TEXT PRIMARY KEY,
                conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
                message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
                tool_name TEXT NOT NULL,
                parameters TEXT NOT NULL,
                status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed')),
                job_id TEXT,
                result TEXT,
                error_message TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, created_at);
            CREATE INDEX IF NOT EXISTS idx_tasks_conv ON assistant_tasks(conversation_id, created_at);
            CREATE INDEX IF NOT EXISTS idx_tasks_job ON assistant_tasks(job_id);
        """)

        # Migration: ensure context_json and agy_session_id columns exist in conversations
        cur = conn.execute("PRAGMA table_info(conversations)")
        columns = [row[1] for row in cur.fetchall()]
        if "context_json" not in columns:
            conn.execute("ALTER TABLE conversations ADD COLUMN context_json TEXT DEFAULT '{}'")
        if "agy_session_id" not in columns:
            conn.execute("ALTER TABLE conversations ADD COLUMN agy_session_id TEXT")

        conn.commit()


DEFAULT_CONVERSATION_CONTEXT = {
    "last_source_url": None,
    "last_job_id": None,
    "last_requested_quantity": 2,
    "last_creative_style": None,
    "previous_jobs": [],
    "previous_clips": [],
    "default_preferences": {},
}


def get_conversation_agy_session_id(conv_id: str) -> Optional[str]:
    """Retrieve native AGY ACP session ID associated with this conversation."""
    with _get_connection() as conn:
        row = conn.execute("SELECT agy_session_id FROM conversations WHERE id = ?", (conv_id,)).fetchone()
        if row and row["agy_session_id"]:
            return row["agy_session_id"]
        return None


def set_conversation_agy_session_id(conv_id: str, agy_session_id: str) -> bool:
    """Store native AGY ACP session ID for this conversation."""
    with _get_connection() as conn:
        cur = conn.execute(
            "UPDATE conversations SET agy_session_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
            (agy_session_id, conv_id),
        )
        conn.commit()
        return cur.rowcount > 0


def create_conversation(title: Optional[str] = None, initial_context: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Create and return a new conversation thread."""
    conv_id = str(uuid.uuid4())
    conv_title = (title or "Nueva conversación").strip()
    ctx = dict(DEFAULT_CONVERSATION_CONTEXT)
    if initial_context:
        ctx.update(initial_context)
    ctx_str = json.dumps(ctx, ensure_ascii=False)

    with _get_connection() as conn:
        conn.execute(
            "INSERT INTO conversations (id, title, context_json) VALUES (?, ?, ?)",
            (conv_id, conv_title, ctx_str),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM conversations WHERE id = ?", (conv_id,)).fetchone()
        d = dict(row)
        d["context"] = ctx
        return d


def get_conversation_context(conv_id: str) -> Dict[str, Any]:
    """Retrieve structured context for a conversation."""
    with _get_connection() as conn:
        row = conn.execute("SELECT context_json FROM conversations WHERE id = ?", (conv_id,)).fetchone()
        if not row or not row["context_json"]:
            return dict(DEFAULT_CONVERSATION_CONTEXT)
        try:
            loaded = json.loads(row["context_json"])
            ctx = dict(DEFAULT_CONVERSATION_CONTEXT)
            ctx.update(loaded)
            return ctx
        except Exception:
            return dict(DEFAULT_CONVERSATION_CONTEXT)


def update_conversation_context(conv_id: str, context: Dict[str, Any]) -> bool:
    """Save updated structured context for a conversation."""
    ctx_str = json.dumps(context, ensure_ascii=False)
    with _get_connection() as conn:
        cur = conn.execute(
            "UPDATE conversations SET context_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
            (ctx_str, conv_id),
        )
        conn.commit()
        return cur.rowcount > 0


def patch_conversation_context(conv_id: str, updates: Dict[str, Any]) -> Dict[str, Any]:
    """Atomically patch specific fields in the conversation context."""
    ctx = get_conversation_context(conv_id)
    ctx.update(updates)
    update_conversation_context(conv_id, ctx)
    return ctx


def list_conversations(limit: int = 50) -> List[Dict[str, Any]]:
    """List recent conversations ordered by updated_at descending."""
    with _get_connection() as conn:
        rows = conn.execute(
            "SELECT * FROM conversations ORDER BY updated_at DESC LIMIT ?",
            (limit,),
        ).fetchall()
        result = []
        for r in rows:
            d = dict(r)
            try:
                d["context"] = json.loads(d.get("context_json") or "{}")
            except Exception:
                d["context"] = dict(DEFAULT_CONVERSATION_CONTEXT)
            result.append(d)
        return result


def get_conversation(conv_id: str) -> Optional[Dict[str, Any]]:
    """Retrieve conversation metadata by ID."""
    with _get_connection() as conn:
        row = conn.execute("SELECT * FROM conversations WHERE id = ?", (conv_id,)).fetchone()
        if not row:
            return None
        d = dict(row)
        try:
            d["context"] = json.loads(d.get("context_json") or "{}")
        except Exception:
            d["context"] = dict(DEFAULT_CONVERSATION_CONTEXT)
        return d


def get_conversation_with_messages(conv_id: str) -> Optional[Dict[str, Any]]:
    """Retrieve conversation metadata together with its message list."""
    conv = get_conversation(conv_id)
    if not conv:
        return None
    conv["messages"] = get_messages(conv_id)
    return conv


def update_conversation_title(conv_id: str, title: str) -> bool:
    """Update a conversation title."""
    with _get_connection() as conn:
        cur = conn.execute(
            "UPDATE conversations SET title = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
            (title.strip(), conv_id),
        )
        conn.commit()
        return cur.rowcount > 0


def delete_conversation(conv_id: str) -> bool:
    """Delete a conversation and all its messages/tasks (cascading)."""
    with _get_connection() as conn:
        cur = conn.execute("DELETE FROM conversations WHERE id = ?", (conv_id,))
        conn.commit()
        return cur.rowcount > 0


def add_message(
    conv_id: str,
    sender: str,
    content: str,
    tool_calls: Optional[Any] = None,
) -> Dict[str, Any]:
    """Append a new message to a conversation and bump updated_at timestamp."""
    msg_id = str(uuid.uuid4())
    tool_calls_str = json.dumps(tool_calls) if tool_calls is not None else None
    with _get_connection() as conn:
        conn.execute(
            """INSERT INTO messages (id, conversation_id, sender, content, tool_calls)
               VALUES (?, ?, ?, ?, ?)""",
            (msg_id, conv_id, sender, content, tool_calls_str),
        )
        conn.execute(
            "UPDATE conversations SET updated_at = CURRENT_TIMESTAMP WHERE id = ?",
            (conv_id,),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM messages WHERE id = ?", (msg_id,)).fetchone()
        msg = dict(row)
        if msg.get("tool_calls"):
            try:
                msg["tool_calls"] = json.loads(msg["tool_calls"])
            except Exception:
                pass
        return msg


def get_messages(conv_id: str, limit: int = 100) -> List[Dict[str, Any]]:
    """Retrieve all messages for a conversation thread in chronological order."""
    with _get_connection() as conn:
        rows = conn.execute(
            "SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC LIMIT ?",
            (conv_id, limit),
        ).fetchall()
        result = []
        for r in rows:
            d = dict(r)
            if d.get("tool_calls"):
                try:
                    d["tool_calls"] = json.loads(d["tool_calls"])
                except Exception:
                    pass
            result.append(d)
        return result


def create_task(
    conv_id: str,
    tool_name: str,
    parameters: Dict[str, Any],
    message_id: Optional[str] = None,
    job_id: Optional[str] = None,
) -> Dict[str, Any]:
    """Record an assistant tool task linked to a conversation and optional OpenShorts job_id."""
    task_id = str(uuid.uuid4())
    params_str = json.dumps(parameters)
    initial_status = "running" if job_id else "pending"
    with _get_connection() as conn:
        conn.execute(
            """INSERT INTO assistant_tasks (id, conversation_id, message_id, tool_name, parameters, status, job_id)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (task_id, conv_id, message_id, tool_name, params_str, initial_status, job_id),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM assistant_tasks WHERE id = ?", (task_id,)).fetchone()
        task = dict(row)
        task["parameters"] = parameters
        return task


def update_task(
    task_id: str,
    status: Optional[str] = None,
    job_id: Optional[str] = None,
    result: Optional[Dict[str, Any]] = None,
    error_message: Optional[str] = None,
) -> bool:
    """Update task state, real OpenShorts job_id, and output."""
    fields = []
    values = []
    if status is not None:
        fields.append("status = ?")
        values.append(status)
    if job_id is not None:
        fields.append("job_id = ?")
        values.append(job_id)
    if result is not None:
        fields.append("result = ?")
        values.append(json.dumps(result))
    if error_message is not None:
        fields.append("error_message = ?")
        values.append(error_message)

    if not fields:
        return False

    fields.append("updated_at = CURRENT_TIMESTAMP")
    query = f"UPDATE assistant_tasks SET {', '.join(fields)} WHERE id = ?"
    values.append(task_id)

    with _get_connection() as conn:
        cur = conn.execute(query, tuple(values))
        conn.commit()
        return cur.rowcount > 0


def get_tasks_for_conversation(conv_id: str) -> List[Dict[str, Any]]:
    """Retrieve all assistant tasks for a given conversation."""
    with _get_connection() as conn:
        rows = conn.execute(
            "SELECT * FROM assistant_tasks WHERE conversation_id = ? ORDER BY created_at ASC",
            (conv_id,),
        ).fetchall()
        tasks = []
        for r in rows:
            d = dict(r)
            try:
                d["parameters"] = json.loads(d["parameters"])
            except Exception:
                pass
            if d.get("result"):
                try:
                    d["result"] = json.loads(d["result"])
                except Exception:
                    pass
            tasks.append(d)
        return tasks


def get_task_by_id(task_id: str) -> Optional[Dict[str, Any]]:
    """Get single task by ID."""
    with _get_connection() as conn:
        row = conn.execute("SELECT * FROM assistant_tasks WHERE id = ?", (task_id,)).fetchone()
        if not row:
            return None
        d = dict(row)
        try:
            d["parameters"] = json.loads(d["parameters"])
        except Exception:
            pass
        if d.get("result"):
            try:
                d["result"] = json.loads(d["result"])
            except Exception:
                pass
        return d


def get_task_by_job_id(job_id: str) -> Optional[Dict[str, Any]]:
    """Find the assistant task corresponding to an OpenShorts job_id."""
    with _get_connection() as conn:
        row = conn.execute("SELECT * FROM assistant_tasks WHERE job_id = ?", (job_id,)).fetchone()
        if not row:
            return None
        d = dict(row)
        try:
            d["parameters"] = json.loads(d["parameters"])
        except Exception:
            pass
        if d.get("result"):
            try:
                d["result"] = json.loads(d["result"])
            except Exception:
                pass
        return d


# Alias for assistant endpoints
get_assistant_task = get_task_by_id


# Auto-initialize database on module import
init_db()

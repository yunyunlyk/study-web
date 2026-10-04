"""SQLite 访问层：建库、建表、连接管理。"""
from __future__ import annotations

import sqlite3
import threading
from contextlib import contextmanager

from . import config

_local = threading.local()
_init_lock = threading.Lock()
_initialized = False

SCHEMA = """
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    is_admin INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS materials (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,
    rel_path TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    subject TEXT NOT NULL,
    group_path TEXT NOT NULL DEFAULT '',
    ext TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL DEFAULT 'other',
    size INTEGER NOT NULL DEFAULT 0,
    mtime REAL NOT NULL DEFAULT 0,
    text_state TEXT NOT NULL DEFAULT 'pending',
    vision_state TEXT NOT NULL DEFAULT 'pending',
    text_note TEXT NOT NULL DEFAULT '',
    vision_note TEXT NOT NULL DEFAULT '',
    pages INTEGER NOT NULL DEFAULT 0,
    priority INTEGER NOT NULL DEFAULT 0,
    added_by INTEGER,
    owner_id INTEGER,
    visibility TEXT NOT NULL DEFAULT 'private',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_materials_subject ON materials(subject);
CREATE INDEX IF NOT EXISTS idx_materials_kind ON materials(kind);
CREATE INDEX IF NOT EXISTS idx_materials_text_state ON materials(text_state, kind);
CREATE INDEX IF NOT EXISTS idx_materials_vision_state ON materials(vision_state, kind);
CREATE INDEX IF NOT EXISTS idx_materials_visibility ON materials(visibility, owner_id);
CREATE INDEX IF NOT EXISTS idx_materials_priority ON materials(priority, id);

CREATE TABLE IF NOT EXISTS texts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    material_id INTEGER NOT NULL,
    page INTEGER NOT NULL DEFAULT 0,
    origin TEXT NOT NULL DEFAULT 'extract',
    content TEXT NOT NULL,
    UNIQUE(material_id, page, origin)
);
CREATE INDEX IF NOT EXISTS idx_texts_material ON texts(material_id);

CREATE VIRTUAL TABLE IF NOT EXISTS texts_fts USING fts5(
    content,
    material_id UNINDEXED,
    page UNINDEXED,
    tokenize='trigram'
);

CREATE TABLE IF NOT EXISTS summaries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    material_id INTEGER NOT NULL,
    kind TEXT NOT NULL,
    content TEXT NOT NULL,
    model TEXT,
    created_at TEXT NOT NULL,
    UNIQUE(material_id, kind)
);

CREATE TABLE IF NOT EXISTS notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    material_id INTEGER NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL,
    UNIQUE(user_id, material_id)
);

CREATE TABLE IF NOT EXISTS favorites (
    user_id INTEGER NOT NULL,
    material_id INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (user_id, material_id)
);

CREATE TABLE IF NOT EXISTS quiz_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    material_id INTEGER NOT NULL,
    score INTEGER NOT NULL DEFAULT 0,
    total INTEGER NOT NULL DEFAULT 0,
    detail TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_quiz_user ON quiz_attempts(user_id, material_id);

CREATE TABLE IF NOT EXISTS progress (
    user_id INTEGER NOT NULL,
    material_id INTEGER NOT NULL,
    position REAL NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (user_id, material_id)
);

CREATE TABLE IF NOT EXISTS exports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    file_name TEXT NOT NULL,
    size INTEGER NOT NULL DEFAULT 0,
    warning TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    username TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL DEFAULT 'suggestion',
    content TEXT NOT NULL,
    contact TEXT NOT NULL DEFAULT '',
    page TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'new',
    reply TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    handled_at TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_feedback_status ON feedback(status, id DESC);
CREATE INDEX IF NOT EXISTS idx_feedback_user ON feedback(user_id, id DESC);

CREATE TABLE IF NOT EXISTS qa (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    username TEXT NOT NULL DEFAULT '',
    question TEXT NOT NULL,
    answer TEXT NOT NULL DEFAULT '',
    answer_source TEXT NOT NULL DEFAULT '',
    answered_by TEXT NOT NULL DEFAULT '',
    asked_at TEXT NOT NULL,
    answered_at TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_qa_asked ON qa(id DESC);

CREATE TABLE IF NOT EXISTS password_resets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    username TEXT NOT NULL DEFAULT '',
    code_hash TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used_at TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reset_user ON password_resets(user_id, id DESC);

CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    username TEXT NOT NULL DEFAULT '',
    action TEXT NOT NULL,
    level TEXT NOT NULL DEFAULT 'info',
    detail TEXT NOT NULL DEFAULT '',
    ip TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_id, id DESC);

CREATE TABLE IF NOT EXISTS app_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""


def connect() -> sqlite3.Connection:
    conn = getattr(_local, "conn", None)
    if conn is None:
        config.ensure_dirs()
        conn = sqlite3.connect(str(config.DB_PATH), timeout=30, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA foreign_keys=ON")
        conn.execute("PRAGMA synchronous=NORMAL")
        _local.conn = conn
    return conn


def init_db() -> None:
    global _initialized
    with _init_lock:
        if _initialized:
            return
        config.ensure_dirs()
        conn = connect()
        conn.executescript(SCHEMA)
        _migrate(conn)
        conn.commit()
        _initialized = True


USER_COLUMNS = (
    ("disabled", "INTEGER NOT NULL DEFAULT 0"),
    ("last_login_at", "TEXT NOT NULL DEFAULT ''"),
    ("last_ip", "TEXT NOT NULL DEFAULT ''"),
    ("login_fails", "INTEGER NOT NULL DEFAULT 0"),
    ("nickname", "TEXT NOT NULL DEFAULT ''"),
    ("avatar", "TEXT NOT NULL DEFAULT ''"),
    ("theme_json", "TEXT NOT NULL DEFAULT ''"),
    ("ai_json", "TEXT NOT NULL DEFAULT ''"),
    ("session_version", "INTEGER NOT NULL DEFAULT 0"),
    ("quota_mb", "INTEGER NOT NULL DEFAULT 0"),
)

# 记录「这份资料为什么读不出来」：文件是空的 / 不是这个格式 / 内部结构损坏。
# 以前只知道状态是 failed，看不到原因，页面上只能反复点重试。
MATERIAL_COLUMNS = (
    ("text_note", "TEXT NOT NULL DEFAULT ''"),
    ("vision_note", "TEXT NOT NULL DEFAULT ''"),
)


def _add_columns(conn, table: str, columns) -> None:
    """SQLite 的 ADD COLUMN 没有 IF NOT EXISTS，只能先查再补。"""
    existing = {row["name"] for row in conn.execute("PRAGMA table_info(" + table + ")")}
    for name, decl in columns:
        if name not in existing:
            conn.execute("ALTER TABLE " + table + " ADD COLUMN " + name + " " + decl)


def _migrate(conn) -> None:
    """老数据库补列：加了新字段以后，旧库打开时会自动补上，不动已有数据。"""
    _add_columns(conn, "users", USER_COLUMNS)
    _add_columns(conn, "materials", MATERIAL_COLUMNS)


@contextmanager
def tx():
    conn = connect()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise


def get_state(key: str, default: str = "") -> str:
    row = connect().execute("SELECT value FROM app_state WHERE key=?", (key,)).fetchone()
    return row["value"] if row else default


def set_state(key: str, value: str) -> None:
    with tx() as conn:
        conn.execute(
            "INSERT INTO app_state(key, value) VALUES(?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (key, value),
        )

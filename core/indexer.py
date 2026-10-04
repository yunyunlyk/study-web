"""后台索引器：阶段1抽文字、阶段2看图识字。可暂停、可续跑、重启自动接上。"""
from __future__ import annotations

import threading
import time
from datetime import datetime, timezone

from . import ai, catalog, config, db, extract

PHASE1_KINDS = ("pdf", "word", "ppt", "excel", "text")
# 哪一级的状态对应哪个「原因」列
NOTE_COLUMN = {"text_state": "text_note", "vision_state": "vision_note"}
VISION_QUERY = (
    "(kind='image' AND vision_state='pending')"
    " OR (kind='pdf' AND text_state='scan' AND vision_state='pending')"
)


def now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def _store_texts(conn, material_id: int, rows, origin: str):
    for page, content in rows:
        content = (content or "").strip()
        if not content:
            continue
        conn.execute(
            "INSERT INTO texts(material_id, page, origin, content) VALUES(?,?,?,?)"
            " ON CONFLICT(material_id, page, origin) DO UPDATE SET content=excluded.content",
            (material_id, page, origin, content),
        )
        conn.execute(
            "DELETE FROM texts_fts WHERE material_id=? AND page=?",
            (material_id, page),
        )
        conn.execute(
            "INSERT INTO texts_fts(content, material_id, page) VALUES(?,?,?)",
            (content, material_id, page),
        )


def _clear_texts(conn, material_id: int):
    conn.execute("DELETE FROM texts WHERE material_id=?", (material_id,))
    conn.execute("DELETE FROM texts_fts WHERE material_id=?", (material_id,))


class Indexer:
    def __init__(self):
        self._thread = None
        self._stop = threading.Event()
        self.paused = False
        self.phase = "idle"
        self.current = None
        self.last_error = ""
        self.last_finished = ""
        self.stats = {"done": 0, "failed": 0}
        self._lock = threading.Lock()

    # ---------- 生命周期 ----------
    def ensure_started(self):
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, name="indexer", daemon=True)
        self._thread.start()

    def stop(self):
        self._stop.set()

    def _run(self):
        while not self._stop.is_set():
            if self.paused:
                self.phase = "paused"
                time.sleep(1.0)
                continue
            try:
                worked = self._step()
            except Exception as exc:
                self.last_error = str(exc)
                worked = False
            if not worked:
                self.phase = "idle"
                time.sleep(2.0)

    # ---------- 主循环 ----------
    def _step(self) -> bool:
        conn = db.connect()
        row = conn.execute(
            "SELECT * FROM materials WHERE text_state='pending' AND kind IN (?,?,?,?,?)"
            " ORDER BY priority DESC, id ASC LIMIT 1",
            PHASE1_KINDS,
        ).fetchone()
        if row is not None:
            self.phase = "text"
            self._run_text(row)
            return True
        row = conn.execute(
            "SELECT * FROM materials WHERE " + VISION_QUERY + " ORDER BY priority DESC, id ASC LIMIT 1"
        ).fetchone()
        if row is not None:
            self.phase = "vision"
            self._run_vision(row)
            return True
        return False

    def _set_current(self, row, phase):
        self.current = {
            "id": row["id"],
            "name": row["name"],
            "subject": row["subject"],
            "phase": phase,
        }

    def _set_result(self, material_id: int, column: str, state: str, message: str):
        """把这一级的最终状态和原因写进 materials（column 是 text_state / vision_state）。"""
        note_column = NOTE_COLUMN.get(column, column + "_note")
        with db.tx() as conn:
            conn.execute(
                "UPDATE materials SET " + column + "=?, " + note_column + "=?, priority=0,"
                " updated_at=? WHERE id=?",
                (state, (message or "")[:400], now_iso(), material_id),
            )

    def _fail(self, material_id: int, column: str, message: str):
        """这一级出错了，属于「还能再试一次」的失败。"""
        self.stats["failed"] += 1
        self.last_error = message[:400]
        self._set_result(material_id, column, "failed", message)

    def _unreadable(self, material_id: int, column: str, message: str):
        """源文件本身读不出来（空的 / 格式不对 / 结构损坏）。

        重试多少次结果都一样，所以不再计入「失败」、也不参与「重试失败项」；
        原因写进 note，管理端在索引进度页能直接看到到底是哪种问题。
        """
        self.last_error = message[:400]
        self._set_result(material_id, column, "unreadable", message)

    # ---------- 阶段 1 ----------
    def _run_text(self, row):
        self._set_current(row, 1)
        material_id = row["id"]
        path = catalog.resolve_material(row)
        try:
            pages, total, note = extract.extract(path, row["ext"])
        except extract.UnreadableFile as exc:
            self._unreadable(material_id, "text_state", str(exc))
            return
        except Exception as exc:
            self._fail(material_id, "text_state", "解析失败：" + str(exc))
            return
        body = "\n".join(t for _, t in pages if t).strip()
        if body:
            state = "done"
        elif row["kind"] == "pdf":
            state = "scan"
        elif note:
            state = "skip"
        else:
            state = "skip"
        try:
            with db.tx() as conn:
                _clear_texts(conn, material_id)
                if body:
                    _store_texts(conn, material_id, pages, "extract")
                conn.execute(
                    "UPDATE materials SET text_state=?, pages=?, priority=0, updated_at=? WHERE id=?",
                    (state, total or len(pages), now_iso(), material_id),
                )
            self.stats["done"] += 1
            self.last_finished = row["name"]
        except Exception as exc:
            self._fail(material_id, "text_state", "入库失败：" + str(exc))

    # ---------- 阶段 2 ----------
    def _text_queue_waiting(self) -> bool:
        """第一级（快）还有排队时，先让出位置，别让上传的资料等在看图后面。"""
        conn = db.connect()
        row = conn.execute(
            "SELECT 1 FROM materials WHERE text_state='pending' AND kind IN (?,?,?,?,?) LIMIT 1",
            PHASE1_KINDS,
        ).fetchone()
        return row is not None

    def _vision_done_pages(self, material_id: int) -> int:
        conn = db.connect()
        row = conn.execute(
            "SELECT COUNT(*) AS c FROM texts WHERE material_id=? AND origin='vision'",
            (material_id,),
        ).fetchone()
        return int(row["c"] or 0)

    def _run_vision(self, row):
        self._set_current(row, 2)
        material_id = row["id"]
        path = catalog.resolve_material(row)
        try:
            if row["kind"] == "image":
                self._vision_image(row, path)
            else:
                self._vision_pdf(row, path)
        except extract.UnreadableFile as exc:
            self._unreadable(material_id, "vision_state", str(exc))
        except Exception as exc:
            self._fail(material_id, "vision_state", "识别失败：" + str(exc))

    def _vision_image(self, row, path):
        try:
            data = extract.image_to_jpeg_bytes(path)
        except Exception as exc:
            raise extract.UnreadableFile("这张图片打不开（" + type(exc).__name__
                                         + "），文件可能已损坏。")
        text = ai.vision_text(data)
        with db.tx() as conn:
            _store_texts(conn, row["id"], [(1, text)], "vision")
            conn.execute(
                "UPDATE materials SET vision_state='done', pages=1, priority=0, updated_at=? WHERE id=?",
                (now_iso(), row["id"]),
            )
        self.stats["done"] += 1
        self.last_finished = row["name"]

    def _vision_pdf(self, row, path):
        material_id = row["id"]
        total = int(row["pages"] or 0) or extract.pdf_page_count(path)
        cap = min(total, config.VISION_MAX_PAGES_PER_DOC)
        already = self._vision_done_pages(material_id)
        if already >= cap:
            with db.tx() as conn:
                conn.execute(
                    "UPDATE materials SET vision_state='limited', updated_at=? WHERE id=?",
                    (now_iso(), material_id),
                )
            return
        for index in range(already, cap):
            if self._stop.is_set() or self.paused:
                return
            if self._text_queue_waiting():
                return
            data = extract.render_pdf_page(path, index)
            text = ai.vision_text(data)
            with db.tx() as conn:
                _store_texts(conn, material_id, [(index + 1, text)], "vision")
            self.stats["done"] += 1
            self.last_finished = row["name"] + " 第 " + str(index + 1) + " 页"
            time.sleep(0.2)
        with db.tx() as conn:
            conn.execute(
                "UPDATE materials SET vision_state=?, priority=0, updated_at=? WHERE id=?",
                ("done" if cap >= total else "limited", now_iso(), material_id),
            )

    # ---------- 状态 ----------
    def status(self) -> dict:
        conn = db.connect()
        p1 = conn.execute(
            "SELECT COUNT(*) AS c FROM materials WHERE text_state='pending' AND kind IN (?,?,?,?,?)",
            PHASE1_KINDS,
        ).fetchone()["c"]
        p2 = conn.execute(
            "SELECT COUNT(*) AS c FROM materials WHERE " + VISION_QUERY
        ).fetchone()["c"]
        failed = conn.execute(
            "SELECT COUNT(*) AS c FROM materials WHERE text_state='failed' OR vision_state='failed'"
        ).fetchone()["c"]
        unreadable = conn.execute(
            "SELECT COUNT(*) AS c FROM materials"
            " WHERE text_state='unreadable' OR vision_state='unreadable'"
        ).fetchone()["c"]
        indexed = conn.execute(
            "SELECT COUNT(DISTINCT material_id) AS c FROM texts"
        ).fetchone()["c"]
        total = conn.execute("SELECT COUNT(*) AS c FROM materials").fetchone()["c"]
        return {
            "running": bool(self._thread and self._thread.is_alive()) and not self.paused,
            "paused": self.paused,
            "phase": self.phase,
            "current": self.current,
            "text_pending": p1,
            "vision_pending": p2,
            "failed": failed,
            "unreadable": unreadable,
            "indexed": indexed,
            "total": total,
            "done": self.stats["done"],
            "last_error": self.last_error,
            "last_finished": self.last_finished,
        }

    def requeue_failed(self) -> int:
        with db.tx() as conn:
            cur = conn.execute(
                "UPDATE materials SET text_state='pending' WHERE text_state='failed'"
            )
            a = cur.rowcount or 0
            cur2 = conn.execute(
                "UPDATE materials SET vision_state='pending' WHERE vision_state='failed'"
            )
            b = cur2.rowcount or 0
        return a + b

    def index_one(self, material_id: int, mode: str = "auto") -> dict:
        conn = db.connect()
        row = conn.execute("SELECT * FROM materials WHERE id=?", (material_id,)).fetchone()
        if row is None:
            return {"ok": False, "error": "资料不存在"}
        if row["kind"] == "web":
            return {"ok": True, "mode": "web", "note": "网页文件直接在网页里运行，不需要建立索引"}
        if mode == "vision" or (mode == "auto" and row["kind"] in ("image", "pdf") and not row["text_state"] in ("pending",)):
            self._run_vision(row)
            return {"ok": True, "mode": "vision"}
        self._run_text(row)
        return {"ok": True, "mode": "text"}


INDEXER = Indexer()


def bootstrap():
    """启动时把上次中断的状态恢复成可续跑。"""
    conn = db.connect()
    conn.execute("UPDATE materials SET text_state='pending' WHERE text_state='running'")
    conn.execute("UPDATE materials SET vision_state='pending' WHERE vision_state='running'")
    conn.commit()

"""服务端定时扫描：默认关闭，管理端可以开。

开了以后，服务自己每隔一段时间重扫一次资料目录（只读），把新增或改动过的文件
排进索引队列；每次结果记进 app_state，管理端能看到"上次自动扫描"。
"""
from __future__ import annotations

import threading
import time
from datetime import datetime, timedelta, timezone

from . import config, db

TZ = timezone(timedelta(hours=8))
LAST_KEY = "autoscan_last"
TICK = 30.0
_started = False
_lock = threading.Lock()


def _now_text() -> str:
    return datetime.now(TZ).strftime("%Y-%m-%d %H:%M:%S")


def last() -> dict:
    """上次（自动或手动）扫描的时间、结果与说明。"""
    raw = db.get_state(LAST_KEY, "")
    if not raw:
        return {"at": "", "result": "", "text": ""}
    parts = raw.split("|", 2)
    while len(parts) < 3:
        parts.append("")
    return {"at": parts[0], "result": parts[1], "text": parts[2]}


def _record(result: str, text: str) -> None:
    try:
        db.set_state(LAST_KEY, _now_text() + "|" + result + "|" + text)
    except Exception:
        pass


def run_once(trigger: str = "自动") -> dict:
    """扫一次资料目录，把新文件排进索引队列。失败也不抛，结果记进 app_state。"""
    from . import catalog
    from .indexer import INDEXER
    try:
        stats = catalog.scan_all()
        library = stats.get("library")
        added = int(library.get("add", 0)) if isinstance(library, dict) else 0
        text = trigger + "扫描完成：新增 " + str(added) + " 个，资料共 " + str(stats.get("total") or 0) + " 条"
        _record("ok", text)
        INDEXER.ensure_started()
        return {"ok": True, "text": text, "stats": stats}
    except Exception as exc:
        text = trigger + "扫描失败：" + str(exc)
        _record("error", text)
        return {"ok": False, "text": text}


def _loop() -> None:
    last_run = time.time()
    while True:
        time.sleep(TICK)
        conf = config.scan_settings()
        if not conf["enabled"]:
            last_run = time.time()
            continue
        if time.time() - last_run < conf["minutes"] * 60:
            continue
        last_run = time.time()
        run_once("自动")


def start() -> bool:
    """启动后台线程（只启一次），返回这次是否真的启动了。"""
    global _started
    with _lock:
        if _started:
            return False
        _started = True
    threading.Thread(target=_loop, name="autoscan", daemon=True).start()
    return True

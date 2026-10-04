"""导出：单文件 HTML（内联）与打包 zip（含原始文件，视频也能看）。"""
from __future__ import annotations

import base64
import html
import json
import re
import shutil
import zipfile
from datetime import datetime, timezone
from pathlib import Path

from . import catalog, config, db, extract

EXPORT_CSS = """
:root{--fg:#1f2328;--muted:#656d76;--line:#d8dee4;--bg:#fff;--soft:#f6f8fa;--accent:#1f6feb}
*{box-sizing:border-box}
body{margin:0;background:var(--soft);color:var(--fg);font:16px/1.75 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
.wrap{max-width:900px;margin:0 auto;padding:32px 20px 80px}
.head{background:var(--bg);border:1px solid var(--line);border-radius:14px;padding:24px 28px;margin-bottom:20px}
.head h1{margin:0 0 8px;font-size:26px}
.head .meta{color:var(--muted);font-size:14px}
.toc{background:var(--bg);border:1px solid var(--line);border-radius:14px;padding:16px 28px;margin-bottom:20px}
.toc a{color:var(--accent);text-decoration:none;display:block;padding:3px 0}
.card{background:var(--bg);border:1px solid var(--line);border-radius:14px;padding:24px 28px;margin-bottom:20px}
.card h2{margin:0 0 6px;font-size:22px;border-bottom:1px solid var(--line);padding-bottom:10px}
.badge{display:inline-block;background:var(--soft);border:1px solid var(--line);border-radius:999px;padding:1px 10px;font-size:12px;color:var(--muted);margin-right:6px}
h3{font-size:17px;margin:20px 0 8px}
pre.text{white-space:pre-wrap;word-wrap:break-word;background:var(--soft);border:1px solid var(--line);border-radius:10px;padding:14px 16px;font:14px/1.7 "Consolas","Microsoft YaHei",monospace;max-height:520px;overflow:auto}
img.page,video,audio{max-width:100%;border:1px solid var(--line);border-radius:10px;display:block;margin:10px 0}
.q{border-left:3px solid var(--accent);padding:4px 0 4px 14px;margin:16px 0}
.q .stem{font-weight:600}
.q .opts label{display:block;padding:3px 0;cursor:pointer}
.q .res{margin-top:6px;font-size:14px;display:none}
.q .res.ok{color:#1a7f37}
.q .res.no{color:#cf222e}
.q .explain{display:none;margin-top:6px;font-size:14px;color:#656d76;background:var(--soft);border-radius:8px;padding:8px 10px}
.warn{background:#fff8c5;border:1px solid #d4a72c;border-radius:10px;padding:12px 16px;margin:12px 0;font-size:14px}
.empty{color:var(--muted)}
a.dl{color:var(--accent)}
footer{color:var(--muted);font-size:13px;text-align:center;padding:20px 0}
"""

EXPORT_JS = """
(function(){
  function norm(s){return (s||"").replace(/\\s+/g,"").replace(/[。，、；：（）()【】\\[\\]]/g,"").toLowerCase();}
  var qs = document.querySelectorAll(".q");
  for (var i=0;i<qs.length;i++){
    (function(q){
      var btn = q.querySelector(".check");
      if(btn){
        btn.addEventListener("click", function(){
          var correct = q.getAttribute("data-answer");
          var picked = null;
          var radios = q.querySelectorAll("input[type=radio]");
          for (var j=0;j<radios.length;j++){ if(radios[j].checked){ picked = radios[j].value; } }
          var res = q.querySelector(".res");
          var ok = picked !== null && norm(picked) === norm(correct);
          res.style.display = "block";
          res.className = "res " + (ok ? "ok" : "no");
          res.textContent = ok ? "回答正确" : ("回答错误，正确答案：" + correct);
        });
      }
      var input = q.querySelector(".blank");
      if(input){
        input.addEventListener("change", function(){
          var correct = q.getAttribute("data-answer");
          var res = q.querySelector(".res");
          var ok = norm(input.value) === norm(correct);
          res.style.display = "block";
          res.className = "res " + (ok ? "ok" : "no");
          res.textContent = ok ? "回答正确" : ("回答错误，正确答案：" + correct);
        });
      }
      var show = q.querySelector(".show");
      if(show){
        show.addEventListener("click", function(){
          var ex = q.querySelector(".explain");
          ex.style.display = ex.style.display === "block" ? "none" : "block";
        });
      }
    })(qs[i]);
  }
})();
"""


def _inline(s: str) -> str:
    s = html.escape(s)
    s = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", s)
    s = re.sub("\x60(.+?)\x60", r"<code>\1</code>", s)
    return s


def mini_markdown(text: str) -> str:
    out = []
    in_list = False
    for raw in (text or "").split("\n"):
        line = raw.rstrip()
        if not line.strip():
            if in_list:
                out.append("</ul>")
                in_list = False
            continue
        m = re.match(r"^(#{1,6})\s+(.*)$", line)
        if m:
            if in_list:
                out.append("</ul>")
                in_list = False
            level = min(6, len(m.group(1)) + 1)
            tag = "h" + str(level)
            out.append("<" + tag + ">" + _inline(m.group(2)) + "</" + tag + ">")
            continue
        m = re.match(r"^\s*[-*+]\s+(.*)$", line)
        if m:
            if not in_list:
                out.append("<ul>")
                in_list = True
            out.append("<li>" + _inline(m.group(1)) + "</li>")
            continue
        m = re.match(r"^\s*\d+[.)]\s+(.*)$", line)
        if m:
            if not in_list:
                out.append("<ul>")
                in_list = True
            out.append("<li>" + _inline(m.group(1)) + "</li>")
            continue
        if in_list:
            out.append("</ul>")
            in_list = False
        out.append("<p>" + _inline(line) + "</p>")
    if in_list:
        out.append("</ul>")
    return "\n".join(out)


def _data_uri(data: bytes, mime: str) -> str:
    return "data:" + mime + ";base64," + base64.b64encode(data).decode("ascii")


def content_for(conn, material_id: int) -> str:
    rows = conn.execute(
        "SELECT page, origin, content FROM texts WHERE material_id=?"
        " ORDER BY (origin='extract') DESC, page ASC",
        (material_id,),
    ).fetchall()
    parts = []
    for row in rows:
        text = (row["content"] or "").strip()
        if text:
            parts.append(text)
    return "\n\n".join(parts)


def _quiz_payload(conn, material_id: int):
    row = conn.execute(
        "SELECT content FROM summaries WHERE material_id=? AND kind='quiz'", (material_id,)
    ).fetchone()
    if not row:
        return None
    try:
        data = json.loads(row["content"])
    except Exception:
        return None
    return data if isinstance(data, list) and data else None


def render_quiz(questions: list, tag: str) -> str:
    if not questions:
        return ""
    chunks = ["<h3>练习题</h3>"]
    for i, q in enumerate(questions):
        stem = html.escape(str(q.get("stem") or ""))
        answer = html.escape(str(q.get("answer") or ""))
        explain = mini_markdown(str(q.get("explain") or ""))
        opts = q.get("options") or []
        if q.get("type") == "choice" and opts:
            picks = []
            for j, opt in enumerate(opts):
                letter = "ABCD"[j] if j < 4 else str(j + 1)
                picks.append(
                    '<label><input type="radio" name="' + tag + "_" + str(i) + '" value="'
                    + html.escape(letter) + '"> ' + html.escape(letter) + ". "
                    + html.escape(str(opt)) + "</label>"
                )
            body = '<div class="opts">' + "".join(picks) + "</div>"
        else:
            body = ('<div><input class="blank" type="text" placeholder="在这里填写答案" '
                    'style="padding:6px 10px;border:1px solid #d8dee4;border-radius:8px;width:60%"></div>')
        chunks.append(
            '<div class="q" data-answer="' + answer + '">'
            '<div class="stem">' + str(i + 1) + ". " + stem + "</div>" + body
            + '<div style="margin-top:8px"><button class="check" style="padding:5px 14px;border:1px solid #d8dee4;border-radius:8px;background:#fff;cursor:pointer">检查答案</button> '
            '<button class="show" style="padding:5px 14px;border:1px solid #d8dee4;border-radius:8px;background:#fff;cursor:pointer">看解析</button></div>'
            '<div class="res"></div><div class="explain">' + explain + "</div></div>"
        )
    return "\n".join(chunks)


def _head(title: str, user, count: int) -> str:
    stamp = datetime.now(timezone.utc).astimezone().strftime("%Y-%m-%d %H:%M")
    return (
        '<div class="head"><h1>' + html.escape(title) + "</h1>"
        '<div class="meta">导出时间：' + stamp + "　·　导出人：" + html.escape(user["username"])
        + "　·　资料数量：" + str(count) + "</div></div>"
    )


def _wrap(title: str, header: str, nav: str, body: str, footer_note: str,
          css: str = "", js: str = "") -> bytes:
    # EXPORT_JS 负责页内练习题的「检查答案 / 看解析」；js 是这一页额外的脚本
    # （目前只有分享版会把模型播放器 _SHARE_JS 传进来）。两个都要带上：
    # 以前这里写的是 `js or EXPORT_JS`，分享版一旦带了模型播放器，判分脚本就被顶掉，
    # 结果就是分享出去的网页里练习题按钮点了没反应。
    scripts = EXPORT_JS + (("\n" + js) if js else "")
    doc = (
        '<!DOCTYPE html>\n<html lang="zh-CN">\n<head>\n<meta charset="utf-8">\n'
        '<meta name="viewport" content="width=device-width,initial-scale=1">\n'
        "<title>" + html.escape(title) + "</title>\n<style>" + (css or EXPORT_CSS) + "</style>\n"
        '</head>\n<body>\n<div class="wrap">\n' + header + nav + body
        + "\n<footer>" + footer_note + "</footer>\n</div>\n<script>"
        + scripts + "</script>\n</body>\n</html>\n"
    )
    return doc.encode("utf-8")


def _material_card_head(row, extra_badges: str = "") -> str:
    return (
        '<div class="card" id="m' + str(row["id"]) + '">'
        + "<h2>" + html.escape(row["name"]) + "</h2>"
        + '<div><span class="badge">' + html.escape(row["subject"]) + "</span>"
        + '<span class="badge">' + html.escape(extract.KIND_LABELS.get(row["kind"], row["kind"]))
        + "</span><span class=\"badge\">" + _human(row["size"]) + "</span>" + extra_badges + "</div>"
    )


def _summary_block(conn, material_id: int) -> str:
    row = conn.execute(
        "SELECT content FROM summaries WHERE material_id=? AND kind='summary'", (material_id,)
    ).fetchone()
    if not row or not (row["content"] or "").strip():
        return ""
    return "<h3>AI 学习笔记</h3>" + mini_markdown(row["content"])


def _human(num) -> str:
    value = float(num or 0)
    for unit in ("B", "KB", "MB", "GB"):
        if value < 1024 or unit == "GB":
            if unit == "B":
                return str(int(value)) + " B"
            return ("%.1f" % value) + " " + unit
        value /= 1024.0
    return str(int(value)) + " B"


# ---------------- 单文件模式 ----------------

def _material_body(conn, material_ids, warnings):
    """把选中的资料拼成一段 HTML，返回（正文, 目录, 真正用到的编号）。"""
    chunks = []
    toc = []
    used = []
    for material_id in material_ids:
        row = conn.execute("SELECT * FROM materials WHERE id=?", (material_id,)).fetchone()
        if row is None:
            continue
        used.append(material_id)
        toc.append('<a href="#m' + str(material_id) + '">' + html.escape(row["name"]) + "</a>")
        pieces = [_material_card_head(row)]
        pieces.append(_summary_block(conn, material_id))
        kind = row["kind"]
        path = catalog.resolve_material(row)
        if kind == "image" and path.exists():
            try:
                if path.stat().st_size <= config.EXPORT_MAX_INLINE_IMAGE:
                    data = extract.image_to_jpeg_bytes(path, max_side=config.RENDER_MAX_SIDE)
                else:
                    data = extract.image_to_jpeg_bytes(path, max_side=1200, quality=70)
                    warnings.append(row["name"] + " 体积较大，已压缩后内联。")
                pieces.append('<img class="page" src="' + _data_uri(data, "image/jpeg") + '" alt="">')
            except Exception as exc:
                warnings.append(row["name"] + " 图片内联失败：" + str(exc))
        elif kind == "pdf" and path.exists():
            size = path.stat().st_size
            try:
                first = extract.render_pdf_page(path, 0, max_side=900, quality=72)
                pieces.append('<img class="page" src="' + _data_uri(first, "image/jpeg") + '" alt="第一页">')
            except Exception:
                pass
            if size <= config.EXPORT_MAX_INLINE_PDF:
                try:
                    pieces.append('<p><a class="dl" href="' + _data_uri(path.read_bytes(), "application/pdf")
                                  + '" download="' + html.escape(row["name"]) + '">下载完整 PDF（'
                                  + _human(size) + "）</a></p>")
                except Exception as exc:
                    warnings.append(row["name"] + " PDF 内联失败：" + str(exc))
            else:
                warnings.append(row["name"] + " 超过 8 MB，没有内联。想让对方看到完整内容，请改用「打包 zip」模式。")
        elif kind in ("video", "audio"):
            warnings.append(row["name"] + " 是视频/音频，单文件模式放不进去。想让对方能看到，请改用「打包 zip」模式。")
        content = content_for(conn, material_id)
        if content.strip():
            pieces.append("<h3>资料原文（自动提取）</h3>")
            pieces.append('<pre class="text">' + html.escape(content.strip()[:60000]) + "</pre>")
        elif kind not in ("image", "video", "audio"):
            pieces.append('<p class="empty">暂时没有可提取的文字内容。</p>')
        pieces.append(render_quiz(_quiz_payload(conn, material_id), "s" + str(material_id)))
        pieces.append("</div>")
        chunks.append("\n".join(pieces))
    return "\n".join(chunks), "".join(toc), used


def build_export(user, material_ids, title: str) -> dict:
    conn = db.connect()
    warnings = []
    body_text, toc_text, used = _material_body(conn, material_ids, warnings)
    body = body_text or '<div class="card"><p class="empty">没有选择任何资料。</p></div>'
    nav = '<div class="toc"><strong>目录</strong>' + toc_text + "</div>" if toc_text else ""
    raw = _wrap(title or "学习资料包", _head(title or "学习资料包", user, len(used)), nav, body,
                "由本地学习网页导出，双击本文件即可离线阅读。")
    if len(raw) > config.EXPORT_WARN_BYTES:
        warnings.append("文件约 " + _human(len(raw)) + "，微信可能发不出去，建议改用打包 zip 再发网盘。")
    return {"html": raw, "warnings": warnings, "size": len(raw), "count": len(used)}


# ---------------- 打包模式 ----------------

def _safe_asset_name(index: int, name: str) -> str:
    stem = Path(name).stem
    suffix = Path(name).suffix
    cleaned = re.sub(r'[\\\\/:*?"<>|]', "_", stem).strip() or "file"
    if len(cleaned) > 60:
        cleaned = cleaned[:60]
    return str(index) + "_" + cleaned + suffix


def build_bundle(user, material_ids, title: str) -> dict:
    conn = db.connect()
    rows = []
    total_bytes = 0
    for material_id in material_ids:
        row = conn.execute("SELECT * FROM materials WHERE id=?", (material_id,)).fetchone()
        if row is None:
            continue
        rows.append(row)
        total_bytes += int(row["size"] or 0)
    if not rows:
        return {"error": "没有可导出的资料"}
    if total_bytes > config.EXPORT_BUNDLE_MAX_BYTES:
        return {"error": "选中的资料共 " + _human(total_bytes) + "，超过打包上限 "
                         + _human(config.EXPORT_BUNDLE_MAX_BYTES) + "。请减少数量，或分几次导出。"}

    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    folder = "study-" + stamp
    zip_path = config.EXPORT_DIR / (folder + ".zip")
    warnings = []
    toc = []
    chunks = []
    stored = 0

    with zipfile.ZipFile(str(zip_path), "w", allowZip64=True) as zf:
        for index, row in enumerate(rows):
            toc.append('<a href="#m' + str(row["id"]) + '">' + html.escape(row["name"]) + "</a>")
            pieces = [_material_card_head(row)]
            pieces.append(_summary_block(conn, row["id"]))
            kind = row["kind"]
            path = catalog.resolve_material(row)
            asset_rel = None
            if path.exists():
                asset_name = _safe_asset_name(index, row["name"])
                asset_rel = "assets/" + asset_name
                try:
                    compression = (zipfile.ZIP_STORED
                                   if row["ext"].lower() in ("mp4", "mpg", "rm", "rmvb", "avi",
                                                             "mkv", "mov", "jpg", "jpeg", "png",
                                                             "zip", "rar", "7z", "gz")
                                   else zipfile.ZIP_DEFLATED)
                    zf.write(str(path), folder + "/" + asset_rel, compress_type=compression)
                    stored += 1
                except Exception as exc:
                    warnings.append(row["name"] + " 复制失败：" + str(exc))
                    asset_rel = None
            else:
                warnings.append(row["name"] + " 在磁盘上找不到，已跳过原文件。")

            if asset_rel:
                src = asset_rel
                if kind == "image":
                    pieces.append('<img class="page" src="' + src + '" alt="">')
                elif kind == "video":
                    pieces.append('<video controls src="' + src + '"></video>')
                elif kind == "audio":
                    pieces.append('<audio controls src="' + src + '"></audio>')
                elif kind == "pdf":
                    try:
                        first = extract.render_pdf_page(path, 0, max_side=900, quality=72)
                        pieces.append('<img class="page" src="' + _data_uri(first, "image/jpeg")
                                      + '" alt="第一页预览">')
                    except Exception:
                        pass
                    pieces.append('<p><a class="dl" href="' + src + '" target="_blank">打开原版 PDF</a></p>')
                else:
                    pieces.append('<p><a class="dl" href="' + src + '" target="_blank">打开原文件（'
                                  + html.escape(row["ext"]) + "，需要本机有对应软件）</a></p>")

            content = content_for(conn, row["id"])
            if content.strip():
                pieces.append("<h3>资料原文（自动提取，不用装软件也能读）</h3>")
                pieces.append('<pre class="text">' + html.escape(content.strip()[:60000]) + "</pre>")
            pieces.append(render_quiz(_quiz_payload(conn, row["id"]), "b" + str(row["id"])))
            pieces.append("</div>")
            chunks.append("\n".join(pieces))

        body = "\n".join(chunks)
        nav = '<div class="toc"><strong>目录</strong>' + "".join(toc) + "</div>"
        header = _head(title or "学习资料包", user, len(rows))
        note = ("把这个文件夹里的内容一起发给别人，双击 index.html 即可阅读；"
                "视频和原文件都在 assets 文件夹里。")
        zf.writestr(folder + "/index.html",
                    _wrap(title or "学习资料包", header, nav, body, note))
        zf.writestr(folder + "/说明.txt",
                    "解压后双击 index.html 打开。\nassets 文件夹里是原始的图片、视频和文档，请一起保留。\n")

    size = zip_path.stat().st_size
    if size > config.EXPORT_WARN_BYTES:
        warnings.append("压缩包约 " + _human(size) + "，微信发不出去，建议用网盘或U盘。")
    return {
        "path": zip_path,
        "file_name": zip_path.name,
        "warnings": warnings,
        "size": size,
        "count": len(rows),
        "stored": stored,
    }


# ---------------- 打印友好：只导出 AI 总结 ----------------

NOTES_CSS = """
:root{--fg:#1f2328;--muted:#656d76;--line:#d8dee4;--accent:#1f6feb}
*{box-sizing:border-box}
body{margin:0;background:#f6f8fa;color:var(--fg);font:16px/1.85 "Songti SC",Georgia,-apple-system,"Microsoft YaHei",serif}
.wrap{max-width:820px;margin:0 auto;padding:24px 22px 90px}
.toolbar{position:sticky;top:0;background:#fff;border-bottom:1px solid var(--line);padding:10px 0;margin-bottom:18px;display:flex;gap:10px;flex-wrap:wrap;font-family:-apple-system,"Microsoft YaHei",sans-serif}
.toolbar button{padding:7px 14px;border:1px solid var(--line);border-radius:9px;background:#fff;cursor:pointer;font:inherit}
.toolbar button.primary{background:var(--accent);border-color:var(--accent);color:#fff}
.banner{background:#fff;border:1px solid var(--line);border-radius:12px;padding:20px 26px;margin-bottom:16px}
.banner h1{margin:0 0 6px;font-size:24px}
.banner .note-meta{color:var(--muted);font-size:13px;font-family:-apple-system,"Microsoft YaHei",sans-serif}
.page{background:#fff;border:1px solid var(--line);border-radius:12px;padding:24px 28px;margin-bottom:16px}
.page h2{margin:0 0 4px;font-size:20px;border-bottom:1px solid var(--line);padding-bottom:8px}
.page h3{font-size:16px;margin:16px 0 6px}
.badge{display:inline-block;background:#f6f8fa;border:1px solid var(--line);border-radius:999px;padding:1px 9px;font-size:12px;color:var(--muted);margin-right:6px;font-family:-apple-system,"Microsoft YaHei",sans-serif}
.q{margin:12px 0;padding-left:14px;border-left:3px solid var(--accent)}
.q .stem{font-weight:600}
.q .ans{color:var(--muted);font-size:14px}
pre.text{white-space:pre-wrap;word-wrap:break-word;background:#f6f8fa;border:1px solid var(--line);border-radius:10px;padding:12px 14px;font:13.5px/1.75 "Consolas","Microsoft YaHei",monospace;max-height:400px;overflow:auto}
.muted{color:var(--muted)}
@media print{
  body{background:#fff;font-size:12pt}
  .toolbar{display:none}
  .wrap{max-width:none;padding:0}
  .banner,.page{border:none;border-radius:0;padding:0;margin:0 0 20px}
  h2{page-break-after:avoid;border-bottom:1px solid #ccc}
  .page{page-break-inside:auto}
}
"""

NOTES_JS = """
document.addEventListener("click", function(ev){
  var t = ev.target;
  if(!t || !t.getAttribute){ return; }
  if(t.getAttribute("data-print")){ window.print(); }
  if(t.getAttribute("data-save")){ document.title = t.getAttribute("data-save"); }
});
"""


def build_notes_doc(user, material_ids, title: str, include_quiz: bool = True,
                    include_text: bool = False) -> dict:
    conn = db.connect()
    warnings = []
    pages = []
    used = 0
    for material_id in material_ids:
        row = conn.execute("SELECT * FROM materials WHERE id=?", (material_id,)).fetchone()
        if row is None:
            continue
        used += 1
        chunk = ["<div class=\"page\">"]
        chunk.append("<h2>" + html.escape(row["name"]) + "</h2>")
        chunk.append('<div><span class="badge">' + html.escape(row["subject"]) + "</span>"
                     + '<span class="badge">'
                     + html.escape(extract.KIND_LABELS.get(row["kind"], row["kind"])) + "</span></div>")
        summary = conn.execute(
            "SELECT content FROM summaries WHERE material_id=? AND kind='summary'", (material_id,)
        ).fetchone()
        if summary and (summary["content"] or "").strip():
            chunk.append(mini_markdown(summary["content"]))
        else:
            chunk.append('<p class="muted">这份资料还没有生成 AI 笔记。</p>')
            warnings.append(row["name"] + " 还没有 AI 笔记，已跳过它的总结部分。")
        if include_text:
            body = content_for(conn, material_id)
            if body.strip():
                chunk.append("<h3>资料原文</h3>")
                chunk.append('<pre class="text">' + html.escape(body.strip()[:40000]) + "</pre>")
        if include_quiz:
            questions = _quiz_payload(conn, material_id)
            if questions:
                chunk.append("<h3>练习题与答案</h3>")
                for index, item in enumerate(questions, 1):
                    stem = html.escape(str(item.get("stem") or ""))
                    answer = html.escape(str(item.get("answer") or ""))
                    explain = html.escape(str(item.get("explain") or "")).replace("\n", " ")
                    chunk.append('<div class="q"><div class="stem">' + str(index) + ". " + stem + "</div>")
                    options = item.get("options") or []
                    if options:
                        for tag, option in zip("ABCD", options):
                            chunk.append('<div style="padding-left:14px">' + tag + ". "
                                         + html.escape(str(option)) + "</div>")
                    line = '<div class="ans">答案：' + answer
                    if explain:
                        line += "　解析：" + explain
                    chunk.append(line + "</div></div>")
        chunk.append("</div>")
        pages.append("\n".join(chunk))

    stamp = datetime.now(timezone.utc).astimezone().strftime("%Y-%m-%d %H:%M")
    banner = ('<div class="banner"><h1>' + html.escape(title or "AI 学习总结") + "</h1>"
              '<div class="note-meta">导出时间：' + stamp + "　·　导出人："
              + html.escape(user["username"]) + "　·　资料数量：" + str(used) + "</div></div>")
    toolbar = ('<div class="toolbar">'
               '<button class="primary" data-print="1">打印 / 另存为 PDF</button>'
               '<span class="muted" style="align-self:center;font-size:13px">'
               "点“打印”，在打印窗口里选“另存为 PDF”就能保存成 PDF 文件。</span></div>")
    body = "\n".join(pages) or '<div class="page"><p class="muted">没有可导出的内容。</p></div>'
    doc = ('<!DOCTYPE html>\n<html lang="zh-CN">\n<head>\n<meta charset="utf-8">\n'
           '<meta name="viewport" content="width=device-width,initial-scale=1">\n'
           "<title>" + html.escape(title or "AI 学习总结") + "</title>\n"
           "<style>" + NOTES_CSS + "</style>\n</head>\n<body>\n<div class=\"wrap\">\n"
           + toolbar + banner + body + "\n</div>\n<script>" + NOTES_JS + "</script>\n</body>\n</html>\n")
    return {"html": doc.encode("utf-8"), "warnings": warnings, "count": used}

# ---------------- 分享版（离线网站，不含个人数据） ----------------

_SHARE_CSS = "#shareModels .tabs{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px}\n#shareModels .tab{padding:6px 12px;border:1px solid var(--line);background:#fff;border-radius:9px;cursor:pointer}\n#shareModels .tab.on{background:var(--accent);border-color:var(--accent);color:#fff}\n#shareModels .models{display:grid;grid-template-columns:200px 1fr;gap:14px;align-items:start}\n#shareModels .mlist{display:flex;flex-direction:column;gap:6px}\n#shareModels .pick{text-align:left;background:#fff;border:1px solid var(--line);border-radius:9px;padding:8px 10px;cursor:pointer;font-size:14px}\n#shareModels .pick.on{background:var(--accent);border-color:var(--accent);color:#fff}\n#shareModels .mrow{display:flex;align-items:center;gap:8px;flex-wrap:wrap}\n#shareModels .sp{flex:1}\n#shareModels .mbtn{padding:5px 10px;border:1px solid var(--line);background:#fff;border-radius:8px;cursor:pointer;font-size:13px}\n#shareModels .msp{padding:4px 6px;border:1px solid var(--line);border-radius:8px;font-size:13px}\n#shareModels .mdesc{color:var(--muted);font-size:13.5px;margin:8px 0}\n#shareModels .stage{height:420px;border-radius:12px;overflow:hidden;background:#0e1521}\n#shareModels .stage canvas{display:block}\n#shareModels .mctrls{display:flex;flex-wrap:wrap;gap:12px 20px;margin-top:12px}\n#shareModels .mp{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--muted)}\n#shareModels .mp input[type=range]{width:140px;accent-color:var(--accent)}\n#shareModels .mv{min-width:40px;color:var(--accent)}\n@media (max-width:760px){#shareModels .models{grid-template-columns:1fr}#shareModels .stage{height:300px}}\n"

_SHARE_JS = "(function () {\n  var all = window.MODELS || [];\n  var root = document.getElementById('shareModels');\n  if (!root || !all.length) { return; }\n  var subs = [];\n  all.forEach(function (m) { if (subs.indexOf(m.subject) < 0) { subs.push(m.subject); } });\n  var sub = subs[0], mid = '', playing = true, speed = 1, time = 0, raf = null, lastTs = 0;\n  var pv = {};\n  var canvas = null, ctx = null, lastW = 0, lastH = 0;\n\n  function bySub(s) { return all.filter(function (m) { return m.subject === s; }); }\n  function current() {\n    var found = null;\n    all.forEach(function (m) { if (m.id === mid) { found = m; } });\n    if (found && found.subject === sub) { return found; }\n    var list = bySub(sub);\n    if (!list.length) { sub = subs[0]; list = bySub(sub); }\n    return list[0];\n  }\n  function resize() {\n    if (!canvas) { return; }\n    var box = canvas.parentNode;\n    var cw = Math.max(240, box.clientWidth), ch = Math.max(180, box.clientHeight);\n    var dpr = window.devicePixelRatio || 1;\n    canvas.width = Math.round(cw * dpr); canvas.height = Math.round(ch * dpr);\n    canvas.style.width = cw + 'px'; canvas.style.height = ch + 'px';\n    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);\n    lastW = cw; lastH = ch;\n  }\n  function frame(ts) {\n    if (!canvas) { raf = requestAnimationFrame(frame); return; }\n    var box = canvas.parentNode;\n    if (box.clientWidth !== lastW || box.clientHeight !== lastH) { resize(); }\n    var dt = lastTs ? Math.min(0.05, (ts - lastTs) / 1000) : 0;\n    lastTs = ts;\n    if (playing) { time += dt * speed; }\n    var cur = current();\n    ctx.save();\n    try { cur.draw(ctx, lastW, lastH, time, pv[cur.id]); }\n    catch (e) {\n      ctx.restore(); ctx.fillStyle = '#0e1521'; ctx.fillRect(0, 0, lastW, lastH);\n      ctx.fillStyle = '#ff6b6b'; ctx.font = '13px sans-serif';\n      ctx.fillText('这个模型画不出来了：' + e.message, 14, 24);\n    }\n    ctx.restore();\n    raf = requestAnimationFrame(frame);\n  }\n  function ctrls(cur) {\n    var params = cur.params || [], p = pv[cur.id] || {};\n    return params.map(function (pp) {\n      if (pp.type === 'select') {\n        var opts = (pp.options || []).map(function (o) {\n          return '<option value=\"' + o[1] + '\"' + (String(p[pp.key]) === String(o[1]) ? ' selected' : '') + '>' + o[0] + '</option>';\n        }).join('');\n        return '<label class=\"mp\">' + pp.label + '<select data-k=\"' + pp.key + '\">' + opts + '</select></label>';\n      }\n      return '<label class=\"mp\">' + pp.label + '<input type=\"range\" min=\"' + pp.min + '\" max=\"' + pp.max + '\" step=\"' + pp.step + '\" value=\"' + p[pp.key] + '\" data-k=\"' + pp.key + '\"><span class=\"mv\" data-v=\"' + pp.key + '\">' + p[pp.key] + '</span></label>';\n    }).join('');\n  }\n  function render() {\n    var cur = current();\n    mid = cur.id;\n    var tabs = subs.map(function (s) { return '<button class=\"tab' + (s === sub ? ' on' : '') + '\" data-s=\"' + s + '\">' + s + '</button>'; }).join('');\n    var picks = bySub(sub).map(function (m) { return '<button class=\"pick' + (m.id === cur.id ? ' on' : '') + '\" data-i=\"' + m.id + '\">' + m.title + '</button>'; }).join('');\n    var speeds = [0.25, 0.5, 1, 2, 4].map(function (v) {\n      return '<option value=\"' + v + '\"' + (v === speed ? ' selected' : '') + '>' + v + '×</option>';\n    }).join('');\n    root.innerHTML = '<div class=\"tabs\">' + tabs + '</div>' +\n      '<div class=\"models\">' +\n        '<div class=\"mlist\">' + picks + '</div>' +\n        '<div class=\"mmain\">' +\n          '<div class=\"mrow\"><b>' + cur.title + '</b><span class=\"sp\"></span>' +\n            '<button class=\"mbtn\" data-a=\"play\">' + (playing ? '暂停' : '播放') + '</button>' +\n            '<button class=\"mbtn\" data-a=\"reset\">重放</button>' +\n            '<select class=\"msp\" data-a=\"speed\">' + speeds + '</select>' +\n          '</div>' +\n          '<p class=\"mdesc\">' + cur.desc + '</p>' +\n          '<div class=\"stage\"><canvas id=\"smCanvas\"></canvas></div>' +\n          '<div class=\"mctrls\">' + ctrls(cur) + '</div>' +\n        '</div>' +\n      '</div>';\n    canvas = document.getElementById('smCanvas');\n    ctx = canvas.getContext('2d');\n    resize();\n    Array.prototype.forEach.call(root.querySelectorAll('[data-s]'), function (b) {\n      b.onclick = function () { sub = b.getAttribute('data-s'); mid = ''; render(); };\n    });\n    Array.prototype.forEach.call(root.querySelectorAll('[data-i]'), function (b) {\n      b.onclick = function () { mid = b.getAttribute('data-i'); time = 0; render(); };\n    });\n    Array.prototype.forEach.call(root.querySelectorAll('[data-k]'), function (inp) {\n      var key = inp.getAttribute('data-k');\n      function changed() {\n        pv[current().id][key] = inp.type === 'range' ? parseFloat(inp.value) : inp.value;\n        var lbl = root.querySelector('[data-v=\"' + key + '\"]');\n        if (lbl) { lbl.textContent = inp.value; }\n      }\n      inp.oninput = changed; inp.onchange = changed;\n    });\n    var pb = root.querySelector('[data-a=\"play\"]');\n    if (pb) { pb.onclick = function () { playing = !playing; pb.textContent = playing ? '暂停' : '播放'; }; }\n    var rb = root.querySelector('[data-a=\"reset\"]');\n    if (rb) { rb.onclick = function () { time = 0; lastTs = 0; }; }\n    var sb = root.querySelector('[data-a=\"speed\"]');\n    if (sb) { sb.onchange = function () { speed = parseFloat(sb.value) || 1; }; }\n  }\n  all.forEach(function (m) {\n    var p = {};\n    (m.params || []).forEach(function (pp) { p[pp.key] = pp.value; });\n    pv[m.id] = p;\n  });\n  render();\n  raf = requestAnimationFrame(frame);\n})();\n"


def _model_section(models_js: str) -> str:
    return (
        '<div class="card" id="shareModelsCard">'
        '<h2>数理化模型动画</h2>'
        '<p class="muted" style="margin:0 0 14px">这些动画是随这个网页一起打包的，不用联网、不用账号，'
        '双击本文件就能拖动滑块、暂停、调速度。改变速度只影响播放快慢，物理规律不变。</p>'
        '<div id="shareModels"></div>'
        '</div>'
        '<script>' + models_js + '</script>'
    )


def _share_head(title: str, count: int) -> str:
    stamp = datetime.now(timezone.utc).astimezone().strftime("%Y-%m-%d %H:%M")
    what = ("包含 " + str(count) + " 份你勾选的资料") if count else "只包含模型动画和学习界面"
    return (
        '<div class="head"><h1>' + html.escape(title) + "</h1>"
        '<div class="meta">离线分享版　·　生成时间：' + stamp + "　·　" + what
        + "　·　不含账号、笔记、收藏等任何个人数据</div></div>"
    )


# 分享版会把「勾选的资料原文 + AI 笔记」打进单文件，是唯一一个会对外发出去的东西。
# 正常情况下里面不可能有密钥或本机文件名；这里做一道硬闸门兜底 —— 哪天有人把密钥写进
# 资料正文、或者代码改动把本机路径带了进来，就直接拒绝出包，而不是悄悄发给别人。
_SHARE_FORBIDDEN = ("study.db", "secret.key", "storage.json", "baseline_source")


def _assert_share_safe(html_text: str) -> None:
    key = str(config.ai_settings().get("api_key") or "").strip()
    if len(key) >= 12 and key in html_text:
        raise ValueError("分享版里出现了你自己的 AI 密钥，出于安全已经拒绝出包。")
    for token in _SHARE_FORBIDDEN:
        if token in html_text:
            raise ValueError("分享版里出现了本机文件名「" + token + "」，出于安全已经拒绝出包。")


def build_share_site(material_ids, title: str, include_models: bool = True) -> dict:
    """生成一个可以发给别人的单文件离线网站：只有界面、模型动画和你勾选的资料。"""
    conn = db.connect()
    warnings = []
    parts = []
    inline_js = ""
    if include_models:
        try:
            models_js = (config.WEB_DIR / "models.js").read_text(encoding="utf-8")
        except OSError:
            models_js = ""
        if models_js:
            parts.append(_model_section(models_js))
            inline_js = _SHARE_JS
        else:
            warnings.append("没有找到模型动画库，分享页里只有资料。")
    body_text, toc_text, used = _material_body(conn, material_ids, warnings)
    if body_text:
        parts.append(
            '<div class="card"><h2>分享的资料</h2><p class="muted" style="margin:0">'
            '下面这些是你勾选、明确同意分享出去的资料。'
            '没有勾选的东西、别人的资料、你的笔记和收藏都不在这个文件里。</p></div>'
        )
        parts.append(body_text)
    if not parts:
        parts.append('<div class="card"><p class="empty">这个分享文件里暂时没有内容。</p></div>')
    nav = ('<div class="toc"><strong>目录</strong>' + toc_text + "</div>") if toc_text else ""
    notes = ""
    if warnings:
        notes = "".join('<div class="warn">' + html.escape(w) + "</div>" for w in warnings)
    raw = _wrap(
        title or "离线学习站",
        _share_head(title or "离线学习站", len(used)),
        nav,
        notes + "\n".join(parts),
        "本文件由本地学习网页导出，双击即可离线打开，不需要联网、不需要账号。",
        css=EXPORT_CSS + _SHARE_CSS,
        js=inline_js,
    )
    _assert_share_safe(raw.decode("utf-8", "replace"))
    if len(raw) > config.EXPORT_WARN_BYTES:
        warnings.append("文件约 " + _human(len(raw)) + "，微信可能发不出去，建议改用打包 zip 再发网盘。")
    return {"html": raw, "warnings": warnings, "size": len(raw), "count": len(used)}

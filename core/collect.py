"""网络收集：搜索、抓正文、存成资料（默认私有）。抓不到全文时退化为搜索摘要。"""
from __future__ import annotations

import re
from datetime import datetime
from urllib.parse import quote, urlparse

import requests

from . import ai, catalog, config

BROWSER_HEADERS = {
    "User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                   "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"),
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Upgrade-Insecure-Requests": "1",
}
PLAIN_HEADERS = {
    "User-Agent": "Mozilla/5.0 (compatible; StudyCollector/1.0)",
    "Accept-Language": "zh-CN,zh;q=0.9",
}

DROP_XPATH = ("//script|//style|//noscript|//nav|//footer|//header|//aside|//form|//iframe"
              "|//svg|//button|//select|//textarea")
KEEP_XPATH = "//h1|//h2|//h3|//h4|//p|//li|//td|//blockquote|//pre"

_session = None


def session() -> requests.Session:
    global _session
    if _session is None:
        _session = requests.Session()
        _session.headers.update(BROWSER_HEADERS)
    return _session


def clean_url(url: str) -> str:
    url = (url or "").strip()
    if not url:
        return ""
    if not re.match(r"^https?://", url, re.I):
        url = "https://" + url
    return url


def safe_filename(name: str, fallback: str = "资料") -> str:
    text = re.sub(r'[\\/:*?"<>|\r\n\t]', "_", (name or "").strip())
    text = text.strip(" .")
    return (text or fallback)[:80]


def _now_label() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M")


def domain_of(url: str) -> str:
    try:
        return urlparse(url).netloc.replace("www.", "")
    except Exception:
        return ""


def extract_html(html_text: str):
    import lxml.html

    doc = lxml.html.fromstring(html_text)
    title = ""
    values = doc.xpath("//meta[@property='og:title']/@content") + doc.xpath("//title/text()")
    for value in values:
        value = (value or "").strip()
        if value:
            title = value
            break
    for bad in doc.xpath(DROP_XPATH):
        try:
            bad.drop_tree()
        except Exception:
            pass
    seen = set()
    lines = []
    for node in doc.xpath(KEEP_XPATH):
        text = " ".join((node.text_content() or "").split())
        if len(text) < 8 or text in seen:
            continue
        seen.add(text)
        lines.append(text)
    return title, "\n".join(lines)


def fetch_page(url: str, timeout: int = 25):
    """返回 (标题, 正文, 最终网址)。抓不到就抛异常。"""
    target = clean_url(url)
    if not target:
        raise ValueError("请填写网址")
    response = None
    last_error = None
    for headers in (BROWSER_HEADERS, PLAIN_HEADERS):
        try:
            response = session().get(target, headers=headers, timeout=timeout,
                                     allow_redirects=True)
            if response.status_code < 400:
                break
            last_error = "HTTP " + str(response.status_code)
            response = None
        except Exception as exc:
            last_error = str(exc)
            response = None
    if response is None:
        raise ValueError("对方网站拒绝访问或打不开（" + str(last_error) + "）")
    content_type = (response.headers.get("Content-Type") or "").lower()
    if "html" not in content_type and "text" not in content_type:
        raise ValueError("这个链接不是网页内容（" + (content_type or "未知类型") + "）")
    response.encoding = response.apparent_encoding or response.encoding or "utf-8"
    title, body = extract_html(response.text)
    return title, body, response.url


def _bing(query: str, limit: int) -> list:
    url = ("https://cn.bing.com/search?q=" + quote(query)
           + "&ensearch=0&count=" + str(max(limit, 10)))
    resp = session().get(url, timeout=20)
    resp.encoding = resp.apparent_encoding or "utf-8"
    import lxml.html

    doc = lxml.html.fromstring(resp.text)
    results = []
    for item in doc.xpath("//li[contains(@class,'b_algo')]"):
        links = item.xpath(".//h2/a/@href")
        if not links:
            continue
        href = links[0]
        if not href.startswith("http"):
            continue
        title = " ".join((" ".join(item.xpath("string(.//h2)")) or "").split())
        snippet = " ".join((" ".join(item.xpath("string(.//p)")) or "").split())
        results.append({"title": title or href, "url": href, "snippet": snippet,
                        "engine": "bing", "domain": domain_of(href)})
        if len(results) >= limit:
            break
    return results


def _baidu(query: str, limit: int) -> list:
    url = "https://www.baidu.com/s?wd=" + quote(query)
    resp = session().get(url, timeout=20)
    resp.encoding = resp.apparent_encoding or "utf-8"
    import lxml.html

    doc = lxml.html.fromstring(resp.text)
    results = []
    for item in doc.xpath("//div[contains(@class,'result') and not(contains(@class,'result-op'))]"):
        links = item.xpath(".//h3//a/@href")
        if not links:
            continue
        href = links[0]
        if not href.startswith("http"):
            continue
        title = " ".join((" ".join(item.xpath("string(.//h3)")) or "").split())
        snippet = " ".join((" ".join(item.xpath("string(.)")) or "").split())[:200]
        results.append({"title": title or href, "url": href, "snippet": snippet,
                        "engine": "baidu", "domain": domain_of(href)})
        if len(results) >= limit:
            break
    return results


def _so360(query: str, limit: int) -> list:
    url = "https://www.so.com/s?q=" + quote(query)
    resp = session().get(url, timeout=20)
    resp.encoding = resp.apparent_encoding or "utf-8"
    import lxml.html

    doc = lxml.html.fromstring(resp.text)
    results = []
    for item in doc.xpath("//li[contains(@class,'res-list')]"):
        links = item.xpath(".//h3//a/@href")
        if not links:
            continue
        href = links[0]
        if not href.startswith("http"):
            continue
        if href.startswith("https://www.so.com/link"):
            try:
                jump = session().get(href, timeout=10, allow_redirects=True)
                href = jump.url or href
            except Exception:
                continue
        if domain_of(href) in ("so.com", "www.so.com", "m.so.com"):
            continue
        title = " ".join((" ".join(item.xpath("string(.//h3)")) or "").split())
        snippet = " ".join((" ".join(item.xpath("string(.)")) or "").split())[:200]
        results.append({"title": title or href, "url": href, "snippet": snippet,
                        "engine": "so360", "domain": domain_of(href)})
        if len(results) >= limit:
            break
    return results


def search_web(query: str, limit: int = 6) -> list:
    query = (query or "").strip()
    if not query:
        return []
    results = []
    seen = set()
    for engine in (_bing, _baidu, _so360):
        if len(results) >= max(3, limit):
            break
        try:
            for item in engine(query, limit):
                if item["url"] in seen:
                    continue
                seen.add(item["url"])
                results.append(item)
        except Exception:
            continue
    return results[:limit]


def _save(user, subject: str, filename: str, content: str):
    target = catalog.unique_upload_path(subject, filename)
    target.write_text(content, encoding="utf-8")
    rel = target.relative_to(config.UPLOAD_DIR).as_posix()
    return catalog.register_one("upload", rel, user["id"])


def _quiz_block(heading: str, text: str) -> str:
    try:
        questions = ai.make_quiz(heading, text)
    except Exception:
        return ""
    lines = ["\n## AI 练习题\n"]
    for index, item in enumerate(questions, 1):
        lines.append(str(index) + ". " + item["stem"])
        for tag, option in zip("ABCD", item.get("options") or []):
            lines.append("   - " + tag + ". " + option)
        lines.append("   - 答案：" + item["answer"])
        if item.get("explain"):
            lines.append("   - 解析：" + item["explain"])
    return "\n".join(lines) + "\n"


def collect_url(user, url, subject, summarize: bool = True, quiz: bool = False):
    title, body, final_url = fetch_page(url)
    if len(body) < 80:
        raise ValueError("这个页面没抓到有效正文（可能是靠脚本加载的），换一个来源或改用「自己粘贴」")
    heading = title or domain_of(final_url) or final_url
    parts = ["# " + heading + "\n",
             "来源：" + final_url + "\n抓取时间：" + _now_label() + "\n"]
    if summarize:
        try:
            parts.append("\n## AI 总结\n\n" + ai.summarize(heading, body) + "\n")
        except Exception as exc:
            parts.append("\n> AI 总结失败：" + str(exc) + "\n")
    if quiz:
        parts.append(_quiz_block(heading, body))
    parts.append("\n## 网页原文\n\n" + body + "\n")
    filename = "【网络】" + safe_filename(heading) + ".md"
    row = _save(user, subject, filename, "\n".join(parts))
    return {"material_id": row["id"] if row else None, "title": heading, "url": final_url,
            "chars": len(body), "filename": filename, "mode": "full"}


def collect_topic(user, topic, subject, limit: int = 5, quiz: bool = False):
    topic = (topic or "").strip()
    if not topic:
        raise ValueError("请填写想收集的主题")
    hits = search_web(topic, limit=max(limit, 4) + 2)
    if not hits:
        raise ValueError("没有搜索到结果，换个说法再试")
    docs = []
    for hit in hits:
        if len(docs) >= limit:
            break
        entry = {"title": hit["title"], "url": hit["url"], "domain": hit["domain"],
                 "text": hit["snippet"], "full": False}
        try:
            title, body, final_url = fetch_page(hit["url"], timeout=18)
            if len(body) >= 200:
                entry.update({"title": title or hit["title"], "text": body[:6000],
                              "url": final_url, "full": True})
        except Exception:
            pass
        docs.append(entry)
    full_count = sum(1 for d in docs if d["full"])
    digest = "\n\n".join(
        "【" + d["title"] + "】" + d["url"] + "\n" + d["text"] for d in docs
    )
    try:
        summary = ai.summarize(topic, digest)
    except Exception as exc:
        summary = "（AI 汇总失败：" + str(exc) + "）"
    parts = ["# " + topic + "\n",
             "收集时间：" + _now_label() + "　·　AI 汇总自 " + str(len(docs)) + " 个网络来源\n",
             "> 提醒：网络内容可能有错，请对照权威资料核对后再用。\n",
             "## AI 汇总的知识点\n", summary, "\n"]
    if quiz:
        parts.append(_quiz_block(topic, digest))
    parts.append("\n---\n\n## 原始来源\n")
    for doc in docs:
        mark = "（全文）" if doc["full"] else "（搜索摘要，对方网站不允许抓取全文）"
        parts.append("### " + doc["title"] + " " + mark + "\n" + doc["url"] + "\n\n"
                     + doc["text"][:3000] + "\n")
    filename = "【网络收集】" + safe_filename(topic) + ".md"
    row = _save(user, subject, filename, "\n".join(parts))
    return {
        "material_id": row["id"] if row else None,
        "title": topic,
        "sources": [{"title": d["title"], "url": d["url"], "full": d["full"]} for d in docs],
        "full_count": full_count,
        "chars": len(digest),
        "filename": filename,
        "mode": "topic",
    }


def collect_note(user, title, content, subject):
    title = (title or "").strip() or "我的手写笔记"
    content = (content or "").strip()
    if len(content) < 10:
        raise ValueError("内容太短了")
    body = "# " + title + "\n\n记录时间：" + _now_label() + "\n\n" + content + "\n"
    filename = "【笔记】" + safe_filename(title) + ".md"
    row = _save(user, subject, filename, body)
    return {"material_id": row["id"] if row else None, "title": title,
            "chars": len(content), "filename": filename, "mode": "note"}

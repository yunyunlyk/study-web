"""对 AI 解析和提取模块做单元级检查（不依赖网络）。"""
from __future__ import annotations

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from core import ai, audit, config, export as export_mod, extract, query

TICK = chr(96)
results = []


def check(name, ok, detail=""):
    results.append((name, ok))
    print("[" + ("PASS" if ok else "FAIL") + "] " + name + (("  -> " + str(detail)) if detail else ""))


good = '[{"type":"choice","stem":"题目一","options":["A选项","B选项","C选项","D选项"],"answer":"A","explain":"解析"}]'
check("plain json parses", len(ai.parse_quiz(good)) == 1)

fenced = TICK * 3 + "json\n" + good + "\n" + TICK * 3
check("fenced json parses", len(ai.parse_quiz(fenced)) == 1)

trailing = '[{"type":"choice","stem":"题目二","options":["a","b"],"answer":"A","explain":"x"},]'
check("trailing comma repaired", len(ai.parse_quiz(trailing)) == 1)

truncated = '[{"type":"choice","stem":"题一","options":["a","b"],"answer":"A","explain":"x"},{"type":"blank","stem":"题二","options":[],"answer":"答'
check("truncated json salvaged", len(ai.parse_quiz(truncated)) >= 1, len(ai.parse_quiz(truncated)))

smart = "[{\u201ctype\u201d:\u201cblank\u201d,\u201cstem\u201d:\u201c题目三\u201d,\u201coptions\u201d:[],\u201canswer\u201d:\u201c答案\u201d,\u201cexplain\u201d:\u201c解析\u201d}]"
check("full-width quotes repaired", len(ai.parse_quiz(smart)) == 1)

short_options = '[{"type":"choice","stem":"题","options":["只有一个"],"answer":"A","explain":""}]'
check("choice with too few options becomes blank", ai.parse_quiz(short_options)[0]["type"] == "blank")

check("kind detection pdf", extract.kind_of("pdf") == "pdf")
check("kind detection image", extract.kind_of("png") == "image")
check("kind detection video", extract.kind_of("mp4") == "video")
check("kind detection legacy word", extract.kind_of("doc") == "word")
check("kind detection unknown", extract.kind_of("xyz") == "other")
check("flash animation goes to video", extract.kind_of("swf") == "video")

# ---- 分享版网站（离线、不含个人数据） ----
check("share site builder is available", callable(getattr(export_mod, "build_share_site", None)))
if callable(getattr(export_mod, "build_share_site", None)):
    site = export_mod.build_share_site([], "单元测试离线站")
    page = site["html"].decode("utf-8")
    check("share site is one self-contained html", page.startswith("<!DOCTYPE html>"))
    check("share site inlines the model library", "window.MODELS" in page and "MODEL_KIT" in page)
    check("share site has no external links", "http://" not in page.split("</style>")[0])
    check("share site carries no login form", "退出登录" not in page and "密码" not in page)
    check("share site states it holds no personal data", "个人数据" in page)
    check("share site reports its own size", site["size"] == len(site["html"]) and site["count"] == 0)

# ---- 导出辅助函数 ----
check("inline markdown turns bold into strong", "<strong>重点</strong>" in export_mod._inline("**重点**"))
check("html in exported text is escaped", "&lt;script&gt;" in export_mod._inline("<script>"))
check("empty material list makes an empty body", export_mod._material_body(None, [], []) == ("", "", []))

# ---- 管理端规则 ----
check("violation rules are declared", len(audit.RULES) >= 3 and "login_fail_burst" in audit.RULE_SOURCE)
check("risky suffixes cover scripts", {"exe", "bat", "ps1", "vbs"}.issubset(audit.RISKY_EXTS))
check("every audit action has a chinese label",
      all(k in audit.ACTION_LABELS for k in ("login", "upload", "forbidden", "admin", "storage")))
check("admin api is not the public one", callable(audit.violations) and callable(audit.user_stats))

# ---- 数据目录校验 ----
ok_relative, why = config.check_data_dir("相对目录")
check("relative data dir is rejected", ok_relative is False and bool(why), why)
check("ai presets are built in", config.AI_DEFAULTS["base_url"].startswith("http")
      and config.AI_DEFAULTS["model_text"] and config.AI_DEFAULTS["model_vision"])
check("legacy doc explains why it is skipped",
      extract.extract(Path("nonexistent.doc"), "doc")[2] != "",
      extract.extract(Path("nonexistent.doc"), "doc")[2])

# 用配置里的资料目录，不要写死路径：换台电脑、把资料挪到别处，这个单测还能跑。
source = Path(config.SOURCE_ROOT)
if source.exists():
    buckets = {"pdf_small": None, "docx": None, "xlsx": None, "pptx": None}
    for dirpath, dirnames, filenames in os.walk(str(source)):
        for name in filenames:
            full = Path(dirpath) / name
            low = name.lower()
            try:
                size = full.stat().st_size
            except OSError:
                continue
            if low.endswith(".pdf") and size < 400000 and buckets["pdf_small"] is None:
                buckets["pdf_small"] = full
            elif low.endswith(".docx") and size < 300000 and buckets["docx"] is None:
                buckets["docx"] = full
            elif low.endswith(".xlsx") and size < 300000 and buckets["xlsx"] is None:
                buckets["xlsx"] = full
            elif low.endswith(".pptx") and size < 500000 and buckets["pptx"] is None:
                buckets["pptx"] = full
        if all(buckets.values()):
            break

    expects = {"pdf_small": ("pdf", 50), "docx": ("docx", 20), "xlsx": ("xlsx", 10), "pptx": ("pptx", 20)}
    for key, (ext, minimum) in expects.items():
        path = buckets[key]
        if not path:
            check("sample found: " + ext, False, "no sample under size limit")
            continue
        pages, total, note = extract.extract(path, ext)
        body = "".join(t for _, t in pages)
        check(ext + " text extraction", len(body) > minimum,
              path.name + " chars=" + str(len(body)) + " pages=" + str(total))
else:
    check("source folder exists", False, str(source))

# 自然语言问句要先拆出关键词，否则整句在中文资料里一个字都匹配不上
check("question keeps its subject", query.query_terms("动量守恒是什么？") == ["动量守恒"],
      query.query_terms("动量守恒是什么？"))
check("question drops what/why/how", query.query_terms("为什么细胞呼吸会释放能量")[0] == "细胞呼吸会释放能量",
      query.query_terms("为什么细胞呼吸会释放能量"))
check("plain keyword untouched", query.query_terms("古典概型") == ["古典概型"])
check("empty question gives no keyword", query.query_terms("") == [] and query.query_terms("吗") == [])
check("two-character gram fallback", "动量" in query.query_grams("动量守恒是什么？"),
      query.query_grams("动量守恒是什么？"))
check("no keyword means no gram", query.query_grams("") == [])

# apply_ai_settings 必须把新的配置返回回去（管理端保存 AI 设置时要用到）
import tempfile
from pathlib import Path as _Path
_real = config.SETTINGS_PATH
_tmp = _Path(tempfile.mkdtemp()) / "storage.json"
try:
    config.SETTINGS_PATH = _tmp
    out = config.apply_ai_settings(base_url="https://api.example.com/v1", api_key="k1",
                                   model_text="m-text", model_vision="m-vision")
    check("apply_ai_settings returns the new config",
          isinstance(out, dict) and out.get("base_url") == "https://api.example.com/v1"
          and out.get("model_text") == "m-text" and out.get("api_key") == "k1", out)
    check("apply_ai_settings wrote to the settings file",
          _tmp.exists() and "api.example.com" in _tmp.read_text(encoding="utf-8"))
    check("shared ai switch defaults to off", config.allow_shared_ai() is False)
    check("shared ai switch can be turned on", config.save_allow_shared_ai(True) is True
          and config.allow_shared_ai() is True)
    # 测完立刻还原成关闭：共用额度默认关，避免测试把站长的 AI 额度开放出去
    config.save_allow_shared_ai(False)
    check("shared ai switch restored to off after the test", config.allow_shared_ai() is False)
    check("bridge is off by default", config.bridge_settings()["enabled"] is False)
    _br = config.save_bridge(enabled=True)
    check("bridge generates a connection code when turned on",
          _br["enabled"] is True and len(_br["token"]) >= 8, _br)
    check("bridge keeps the code on the next read",
          config.bridge_settings()["token"] == _br["token"])
    _br2 = config.save_bridge(regenerate=True)
    check("bridge can hand out a fresh code",
          _br2["token"] != _br["token"] and len(_br2["token"]) >= 8)
    check("bridge can be turned off again", config.save_bridge(enabled=False)["enabled"] is False)
finally:
    config.SETTINGS_PATH = _real

# 服务商对 max_tokens 有上限时，要能读出上限并用上限重发，而不是把 400 丢给用户
check("token cap is read from the provider error",
      ai.token_cap('HTTP 400: {"error":{"code":"1210","message":"max_tokens 的值不符合取值范围[1,2048]"}}') == 2048,
      ai.token_cap('max_tokens 的值不符合取值范围[1,2048]'))
check("token cap works for english errors", ai.token_cap("max_tokens must be in [1, 4096]") == 4096)
check("token cap falls back to a safe default", ai.token_cap("完全没提到上限") == 2048)


# ---- 流式问答（SSE 的底层）----
import json as _json

def _chunk(text=None, think=None):
    delta = {}
    if think is not None:
        delta["reasoning_content"] = think
    if text is not None:
        delta["content"] = text
    return _json.dumps({"choices": [{"delta": delta}]})


def _fake_stream(chunks):
    def gen(payload, timeout=None):
        for item in chunks:
            yield item
    return gen


_real_stream = ai._post_stream
try:
    ai._post_stream = _fake_stream([_chunk(think="先想一下"), _chunk(text="动量"),
                                    _chunk(text="守恒")])
    events = list(ai.ask_stream("动量守恒是什么？",
                                [{"title": "t", "subject": "s", "text": "x"}], deep=False))
    kinds = [k for k, _ in events]
    check("streaming ask emits reasoning, then answer, then the model name",
          kinds == ["reasoning", "answer", "answer", "model"], kinds)
    check("streaming ask keeps the thinking separate from the answer",
          [v for k, v in events if k == "reasoning"] == ["先想一下"]
          and "".join(v for k, v in events if k == "answer") == "动量守恒")
    check("streaming ask says which model answered", events[-1][1] == ai._model_vision(), events[-1])

    ai._post_stream = _fake_stream([_chunk(think="只有思考，没有正文")])
    empty_err = ""
    try:
        list(ai.ask_stream("问", [], deep=False))
    except ai.AIError as exc:
        empty_err = str(exc)
    check("a stream that never produces answer text raises instead of passing silently",
          "没有返回正文" in empty_err, empty_err)

    ai._post_stream = _fake_stream(["这不是 JSON", _chunk(text="好")])
    junk = list(ai.ask_stream("问", [], deep=False))
    check("a malformed stream packet is skipped, not fatal",
          [k for k, _ in junk] == ["answer", "model"], junk)
finally:
    ai._post_stream = _real_stream

_long = {"title": "a", "subject": "s", "text": "字" * 5000}
plain = ai._ask_prompt("问", [_long], False)
deep = ai._ask_prompt("问", [_long], True)
check("the deep ask keeps a longer excerpt than the normal ask",
      len(plain) < len(deep) and ("字" * 2601) in deep and ("字" * 2601) not in plain,
      (len(plain), len(deep)))

failed = [n for n, ok in results if not ok]
print("\npassed " + str(len(results) - len(failed)) + ", failed " + str(len(failed)))
for n in failed:
    print("  FAILED: " + n)
sys.exit(1 if failed else 0)

"""调用本机模型代理：文字理解、看图识字、问答。实测无需密钥。"""
from __future__ import annotations

import base64
import json
import re
import threading
import time

import requests

from . import config

_sem = threading.Semaphore(config.AI_MAX_CONCURRENCY)
TICK = "\x60"


class AIError(RuntimeError):
    pass


def _trim(text: str, limit: int) -> str:
    text = text or ""
    if len(text) <= limit:
        return text
    return text[:limit] + "\n…（内容过长已截断）"


def _pick(data: dict):
    choice = (data.get("choices") or [{}])[0]
    msg = choice.get("message") or {}
    content = (msg.get("content") or "").strip()
    reasoning = (msg.get("reasoning_content") or msg.get("reasoning") or "").strip()
    return content, reasoning, choice.get("finish_reason")


_USER_CONF = threading.local()


def set_user_conf(conf):
    """普通账号把密钥存在自己账号里时，这次请求就用他的那份，不花站长的额度。"""
    _USER_CONF.value = conf if isinstance(conf, dict) and conf.get("api_key") else None


def _user_conf() -> dict:
    return getattr(_USER_CONF, "value", None) or {}


def _chat_url() -> str:
    base = str(_user_conf().get("base_url") or "").strip() or config.AI_BASE_URL
    return base.rstrip("/") + "/chat/completions"


def _api_key() -> str:
    return str(_user_conf().get("api_key") or "").strip() or config.AI_API_KEY


def _model_text() -> str:
    return str(_user_conf().get("model_text") or "").strip() or config.MODEL_TEXT


def _model_vision() -> str:
    return str(_user_conf().get("model_vision") or "").strip() or config.MODEL_VISION


_TOKEN_RANGE_RE = re.compile(r"max_tokens.{0,60}?\[\s*\d+\s*,\s*(\d+)", re.S | re.I)


def token_cap(body: str) -> int:
    """从服务商的报错里读出它允许的 max_tokens 上限（读不出来就退回常见的 2048）。"""
    m = _TOKEN_RANGE_RE.search(body or "")
    if m:
        try:
            return int(m.group(1))
        except ValueError:
            pass
    return 2048


def user_conf() -> dict:
    """这次请求该用哪份密钥（普通账号存自己账号里的那份）。流式响应里要重新设一次，所以要有读取口。"""
    return _user_conf()


def _post_stream(payload: dict, timeout=None):
    """流式调用：逐条吐出服务商 SSE 里 data: 后面的 JSON 文本（OpenAI 兼容格式）。"""
    timeout = timeout or config.AI_TIMEOUT
    headers = {"Accept": "text/event-stream"}
    if _api_key():
        headers["Authorization"] = "Bearer " + _api_key()
    _sem.acquire()
    resp = None
    try:
        resp = requests.post(_chat_url(), json=payload, timeout=timeout,
                             headers=headers, stream=True)
        if resp.status_code >= 400:
            raise AIError("HTTP " + str(resp.status_code) + ": " + resp.text[:300])
        for raw in resp.iter_lines(decode_unicode=False):
            if not raw:
                continue
            line = raw.decode("utf-8", "replace").strip()
            if not line.startswith("data:"):
                continue
            chunk = line[5:].strip()
            if chunk == "[DONE]":
                return
            yield chunk
    except AIError:
        raise
    except Exception as exc:
        raise AIError(str(exc))
    finally:
        if resp is not None:
            resp.close()
        _sem.release()


def _post(payload: dict, timeout=None, retries: int = 2) -> dict:
    timeout = timeout or config.AI_TIMEOUT
    last = None
    for attempt in range(retries + 1):
        try:
            headers = {}
            if _api_key():
                headers["Authorization"] = "Bearer " + _api_key()
            with _sem:
                resp = requests.post(_chat_url(), json=payload, timeout=timeout,
                                     headers=headers or None)
            if resp.status_code >= 400:
                body = resp.text[:300]
                # 有的服务（智谱等）对 max_tokens 卡了上限，超一点就直接 400；
                # 照它自己给的上限再发一次，别让用户看到这种没意义的失败。
                if payload.get("max_tokens") and "max_tokens" in body:
                    cap = token_cap(body)
                    try:
                        too_big = int(payload["max_tokens"]) > cap
                    except (TypeError, ValueError):
                        too_big = False
                    if too_big:
                        fixed = dict(payload)
                        fixed["max_tokens"] = cap
                        with _sem:
                            resp = requests.post(_chat_url(), json=fixed, timeout=timeout,
                                                 headers=headers or None)
                        if resp.status_code < 400:
                            return resp.json()
                        body = resp.text[:300]
                raise AIError("HTTP " + str(resp.status_code) + ": " + body)
            return resp.json()
        except Exception as exc:
            last = exc
            if attempt < retries:
                time.sleep(2 * (attempt + 1))
    raise AIError(str(last))


def chat(messages, model=None, max_tokens: int = 3000, temperature=None,
         timeout=None, retries: int = 2, response_format=None) -> str:
    """推理模型经常把预算花在思考上，导致正文为空，所以这里做多级兜底。"""
    model = model or _model_text()
    plan = [(model, max_tokens), (model, max_tokens * 3)]
    if model != _model_vision():
        plan.append((_model_vision(), max_tokens * 2))
    last_error = None
    for index, (use_model, budget) in enumerate(plan):
        try:
            content = _call(messages, use_model, budget, temperature, timeout,
                            retries if index == 0 else 0, response_format)
        except Exception as exc:
            last_error = exc
            continue
        if content:
            return content
        last_error = AIError("模型没有返回正文（model=" + use_model + "，预算 " + str(budget) + "）")
    raise AIError(str(last_error) if last_error else "模型调用失败")


def chat_full(messages, model=None, max_tokens: int = 3000, temperature=None,
              timeout=None, retries: int = 2, response_format=None):
    """和 chat() 一样，但把模型的思考过程一并返回。"""
    model = model or _model_text()
    plan = [(model, max_tokens), (model, max_tokens * 3)]
    if model != _model_vision():
        plan.append((_model_vision(), max_tokens * 2))
    last_error = None
    for index, (use_model, budget) in enumerate(plan):
        try:
            content, reasoning = _call_full(messages, use_model, budget, temperature, timeout,
                                            retries if index == 0 else 0, response_format)
        except Exception as exc:
            last_error = exc
            continue
        if content:
            return content, reasoning
        last_error = AIError("模型没有返回正文（model=" + use_model + "，预算 " + str(budget) + "）")
    raise AIError(str(last_error) if last_error else "模型调用失败")


def _call(messages, model: str, max_tokens: int, temperature, timeout, retries: int,
          response_format=None) -> str:
    return _call_full(messages, model, max_tokens, temperature, timeout, retries, response_format)[0]


def _call_full(messages, model: str, max_tokens: int, temperature, timeout, retries: int,
               response_format=None):
    """返回 (正文, 思考过程)。推理模型会把思考放在 reasoning_content 里。"""
    payload = {
        "model": model,
        "messages": messages,
        "max_tokens": max_tokens,
        "stream": False,
    }
    if temperature is not None:
        payload["temperature"] = temperature
    if response_format is not None:
        payload["response_format"] = response_format
    data = _post(payload, timeout=timeout, retries=retries)
    content, reasoning, finish = _pick(data)
    if not content and finish == "length":
        payload["max_tokens"] = max_tokens * 2
        data = _post(payload, timeout=timeout, retries=0)
        content, reasoning, finish = _pick(data)
    return content, reasoning


def ping() -> dict:
    try:
        text = chat([{"role": "user", "content": "回复两个字：可用"}],
                    model=_model_vision(), max_tokens=64, retries=1, timeout=30)
        return {"ok": True, "message": text, "url": _chat_url(),
                "model": _model_vision()}
    except Exception as exc:
        return {"ok": False, "message": str(exc)}


VISION_PROMPT = (
    "请把这张图片里的所有文字原样提取出来，保持原有顺序和结构。"
    "数学公式请用 LaTeX 表示。只输出内容本身，不要任何解释或开场白。"
    "如果图片里几乎没有文字，就用一到两句话描述图片内容。"
)


def vision_text(image_bytes: bytes, hint: str = "", model=None, max_tokens: int = 4000) -> str:
    b64 = base64.b64encode(image_bytes).decode("ascii")
    messages = [{
        "role": "user",
        "content": [
            {"type": "text", "text": hint or VISION_PROMPT},
            {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64," + b64}},
        ],
    }]
    return chat(messages, model=model or _model_vision(), max_tokens=max_tokens)


SUMMARY_PROMPT = (
    "你在帮一位学习者整理资料。下面是一份资料里提取出来的内容。"
    "请严格依据资料内容，输出 Markdown 格式的学习笔记，包含四个小节：\n"
    "## 一句话概括\n## 核心知识点\n## 易错点\n## 复习建议\n"
    "要求：不要编造资料里没有的内容；知识点分条列出；语言简洁，便于快速阅读。"
)


def summarize(title: str, text: str, model=None) -> str:
    body = _trim(text, 14000)
    messages = [{"role": "user", "content": SUMMARY_PROMPT + "\n\n资料标题：" + title + "\n\n资料内容：\n" + body}]
    return chat(messages, model=model or _model_text(), max_tokens=6000)


QUIZ_PROMPT = (
    "根据下面的资料出 6 道练习题，用来检验是否真正掌握。\n\n"
    "只输出一个 JSON 对象，格式为：\n"
    '{"questions":[{"type":"choice","stem":"题干","options":["选项A","选项B","选项C","选项D"],'
    '"answer":"A","explain":"解析"}]}\n'
    "说明：\n"
    "- 选择题的 type 用 choice，必须给 4 个选项，answer 为 A/B/C/D 之一；\n"
    "- 填空题的 type 用 blank，options 写空数组 []，answer 是答案文本；\n"
    "- 不要输出任何解释性文字，不要用代码块包裹；全部使用中文。"
)


def _balance_json(fragment: str) -> str:
    """把被截断的 JSON 片段补齐：闭合没写完的字符串和没闭合的括号。"""
    out = []
    in_str = False
    escaped = False
    stack = []
    for ch in fragment:
        out.append(ch)
        if in_str:
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch in "[{":
            stack.append(ch)
        elif ch in "]}":
            if stack:
                stack.pop()
    if in_str:
        out.append('"')
    while out and out[-1] in ", \n\r\t":
        out.pop()
    if out and out[-1] == ":":
        out.append("null")
    for opener in reversed(stack):
        out.append("]" if opener == "[" else "}")
    return "".join(out)


def _loads_tolerant(text: str):
    """模型偶尔会给出带尾逗号、全角引号或末尾被截断的 JSON，这里尽量救回来。"""
    try:
        return json.loads(text)
    except Exception:
        pass
    fixed = text
    for bad, good in (("\u201c", '"'), ("\u201d", '"'), ("\u2018", "'"), ("\u2019", "'")):
        fixed = fixed.replace(bad, good)
    fixed = re.sub(r",\s*([\]}])", r"\1", fixed)
    try:
        return json.loads(fixed)
    except Exception:
        pass
    for closer in ("}", "]", '"'):
        end = fixed.rfind(closer)
        while end > 0:
            try:
                return json.loads(_balance_json(fixed[:end + 1]))
            except Exception:
                end = fixed.rfind(closer, 0, end)
    raise AIError("模型返回的不是有效 JSON")


def _unwrap_questions(data):
    if isinstance(data, list):
        return data
    if isinstance(data, dict):
        for key in ("questions", "items", "quiz", "list", "data", "result"):
            value = data.get(key)
            if isinstance(value, list):
                return value
            if isinstance(value, dict):
                inner = _unwrap_questions(value)
                if inner:
                    return inner
    return []


def parse_quiz(raw: str) -> list:
    s = (raw or "").strip()
    fence = TICK * 3
    if s.startswith(fence):
        rest = s[len(fence):]
        newline = rest.find("\n")
        s = rest[newline + 1:] if 0 <= newline <= 12 else rest
    tail = s.rfind(fence)
    if tail >= 0:
        s = s[:tail]
    start = s.find("[")
    stop = s.rfind("]")
    if start >= 0 and stop > start:
        s = s[start:stop + 1]
    try:
        data = _loads_tolerant(s)
    except Exception as exc:
        raise AIError("练习题解析失败：" + str(exc))
    items = _unwrap_questions(data)
    cleaned = _normalise_quiz(items)
    if not cleaned:
        raise AIError("没有解析出有效的练习题")
    return cleaned


def make_quiz(title: str, text: str, model=None) -> list:
    body = _trim(text, 12000)
    prompt = QUIZ_PROMPT + "\n\n资料标题：" + title + "\n\n资料内容：\n" + body
    messages = [{"role": "user", "content": prompt}]
    last_error = None
    for attempt in range(2):
        try:
            raw = chat(messages, model=model or _model_text(), max_tokens=16000,
                       response_format={"type": "json_object"})
            questions = _normalise_quiz(_unwrap_questions(_loads_tolerant(raw)))
            if questions:
                return questions
            last_error = AIError("模型没有生成有效的题目")
        except Exception as exc:
            last_error = exc
        messages = [{"role": "user", "content": prompt}]
    raise AIError(str(last_error) if last_error else "出题失败")


def _normalise_quiz(items: list) -> list:
    cleaned = []
    for item in items or []:
        if not isinstance(item, dict):
            continue
        stem = str(item.get("stem") or item.get("question") or "").strip()
        if not stem:
            continue
        qtype = "choice" if str(item.get("type")) == "choice" else "blank"
        raw_options = item.get("options") or []
        if not isinstance(raw_options, list):
            raw_options = []
        options = [str(o).strip() for o in raw_options if str(o).strip()]
        answer = str(item.get("answer") or item.get("correct") or "").strip()
        if qtype == "choice" and len(options) < 2:
            qtype = "blank"
            options = []
        if not answer:
            continue
        cleaned.append({
            "type": qtype,
            "stem": stem,
            "options": options,
            "answer": answer,
            "explain": str(item.get("explain") or item.get("explanation") or "").strip(),
        })
    return cleaned


ASK_PROMPT = (
    "你是一名学习助手。请依据下面提供的资料片段回答问题，用中文回答。\n\n"
    "规则：\n"
    "1. 优先使用资料片段里的信息，不要编造资料中没有的事实；\n"
    "2. 如果资料不足，明确说明，并给出通用的学习建议；\n"
    "3. 用 Markdown 分点作答，篇幅适中；\n"
    "4. 引用资料时在句子末尾标注来源编号，例如 [1]。"
)


ASK_PROMPT_DEEP = (
    "你是一名学习助手，要一步步把问题讲透。请依据下面提供的资料片段回答，用中文。\n\n"
    "要求：\n"
    "1. 先把推理做完再下结论：判断已知条件、选出公式、逐步推导，中间结果写出来；\n"
    "2. 正文按“思路 → 步骤 → 结论”组织，关键公式和代入的数都要写清楚；\n"
    "3. 优先使用资料片段里的信息，不要编造资料中没有的事实；\n"
    "4. 资料不足时明确说明哪里不足，并给出通用的解题思路；\n"
    "5. 用 Markdown，引用资料时在句末标注来源编号，例如 [1]。"
)


def _ask_prompt(question: str, contexts: list, deep: bool) -> str:
    """把检索到的片段拼成提示词（普通和深度只是提示词与截断长度不同）。"""
    limit = 3200 if deep else 2600
    blocks = []
    for idx, ctx in enumerate(contexts, 1):
        head = "[" + str(idx) + "] 来源：" + str(ctx.get("title", "")) + "（" + str(ctx.get("subject", "")) + "）"
        blocks.append(head + "\n" + _trim(str(ctx.get("text", "")), limit))
    head_text = ASK_PROMPT_DEEP if deep else ASK_PROMPT
    return head_text + "\n\n资料片段：\n" + "\n\n".join(blocks) + "\n\n问题：" + question


def ask_stream(question: str, contexts: list, deep: bool = False, model=None):
    """流式版问答：yield ("reasoning"|"answer"|"model", 文本)，交给 /api/ask 用 SSE 转给浏览器。

    一个字一个字地吐，前端就能边收边显示；思考过程（reasoning_content）单独标出来。
    """
    if deep:
        use_model = model or _model_text()
        budget, timeout = 8000, config.AI_DEEP_TIMEOUT
    else:
        use_model = model or _model_vision()
        budget, timeout = 5000, config.AI_TIMEOUT
    payload = {"model": use_model,
               "messages": [{"role": "user", "content": _ask_prompt(question, contexts, deep)}],
               "max_tokens": budget, "stream": True}
    got = False
    for chunk in _post_stream(payload, timeout=timeout):
        try:
            data = json.loads(chunk)
        except ValueError:
            continue
        for choice in (data.get("choices") or []):
            delta = choice.get("delta") or {}
            think = delta.get("reasoning_content") or delta.get("reasoning") or ""
            text = delta.get("content") or ""
            if think:
                yield ("reasoning", think)
            if text:
                got = True
                yield ("answer", text)
    if not got:
        raise AIError("模型没有返回正文（流式，model=" + use_model + "）")
    yield ("model", use_model)


def ask_deep(question: str, contexts: list, model=None) -> dict:
    """用会思考的模型作答，并把模型的思考过程一起带回来。"""
    prompt = _ask_prompt(question, contexts, True)
    use_model = model or _model_text()
    answer, reasoning = chat_full([{"role": "user", "content": prompt}], model=use_model,
                                  max_tokens=8000, timeout=config.AI_DEEP_TIMEOUT)
    return {"answer": answer, "reasoning": reasoning, "model": use_model}


def ask(question: str, contexts: list, model=None) -> str:
    prompt = _ask_prompt(question, contexts, False)
    return chat([{"role": "user", "content": prompt}], model=model or _model_vision(), max_tokens=5000)


DOUBT_PROMPT = (
    "你是一位耐心、严谨的老师。学生问了一个问题，请直接解答。要求："
    "1) 先用一句话给出结论；2) 再给必要的理由或推导，分点写清楚；"
    "3) 涉及计算时写出关键步骤和单位；4) 题面信息不够时，先说明还需要补充什么；"
    "5) 用简体中文，不要客套话，不要重复题目。"
)


def answer_question(question: str, model=None) -> str:
    """疑问解答区用：不检索资料，直接回答学生的问题。"""
    return chat([{"role": "user", "content": DOUBT_PROMPT + "\n\n学生的问题：" + question}],
                model=model, max_tokens=1600, timeout=180)


ANIMATION_SYSTEM = (
    "你是代码生成器。只输出代码本身，不要输出任何思考过程、解释、开场白或 Markdown 代码块。"
)

ANIMATION_PROMPT = (
    "请围绕一个学习主题，写一个**紧凑的单文件 HTML**（控制在 120 行以内），用 <canvas> 做动画演示。\n\n"
    "硬性要求：\n"
    "1. 从 <!DOCTYPE html> 开始，到 </html> 结束，中间不要有任何解释文字；\n"
    "2. 所有 CSS 和 JavaScript 都写在文件内部；绝对不能引用 http/https 的外部地址、CDN、外部图片或字体；\n"
    "3. 必须有 requestAnimationFrame 动画循环，让它真的动起来；\n"
    "4. 画面上要有中文标注和一条关键公式，便于讲解；\n"
    "5. 要有“暂停/继续”按钮，以及至少一个可以拖动的参数滑块（input type=range）；\n"
    "6. 深色背景、浅色文字，字号看得清，页面自适应窗口大小。"
)


def _clean_code(raw: str) -> str:
    """把模型返回里的代码块标记和多余的话去掉，只留一份完整 HTML。"""
    text = (raw or "").strip()
    fence = TICK * 3
    if text.startswith(fence):
        rest = text[len(fence):]
        newline = rest.find("\n")
        text = rest[newline + 1:] if 0 <= newline <= 14 else rest
    tail = text.rfind(fence)
    if tail >= 0:
        text = text[:tail]
    low = text.lower()
    start = low.find("<!doctype")
    if start < 0:
        start = low.find("<html")
    if start < 0:
        return ""
    end = low.rfind("</html>")
    return text[start:(end + 7) if end >= 0 else len(text)].strip()


def make_animation(title: str, brief: str = "", model=None) -> str:
    """让模型写一个可以离线运行的单文件动画。

    这里刻意用**快的模型 + 一次够用的预算**：本机代理上的推理模型会把大头预算花在
    思考上，预算给小了正文会被截断，所以直接给足；只试两次，然后干脆地报错，
    绝不让人干等十分钟。
    """
    use_model = model or _model_vision()
    ask_text = ANIMATION_PROMPT + "\n\n模型名称：" + title
    if brief.strip():
        ask_text += "\n补充要求：" + _trim(brief.strip(), 300)
    messages = [{"role": "system", "content": ANIMATION_SYSTEM},
                {"role": "user", "content": ask_text}]
    last_error = None
    for _ in range(2):
        payload = {"model": use_model, "messages": messages,
                   "max_tokens": config.AI_ANIM_TOKENS, "stream": False}
        try:
            data = _post(payload, timeout=config.AI_ANIM_TIMEOUT, retries=0)
        except Exception as exc:
            last_error = exc
            continue
        text = _clean_code(_pick(data)[0])
        if text and "</html>" in text.lower():
            return text
        last_error = AIError("模型这次没写完整个动画（只写了 " + str(len(text))
                             + " 个字符），再点一次「生成动画」就好。")
    raise AIError(str(last_error) if last_error else "模型调用失败")

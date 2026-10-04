"""把一句自然语言问题拆成能拿去检索的关键词（纯函数，方便单测）。"""
from __future__ import annotations

# 提问时常见但检索时没用的词：留着它们，整句问句在资料里一个字都匹配不上。
_QUESTION_WORDS = ("有什么区别", "有什么不同", "有什么", "是什么样", "是什么", "什么是",
                   "为什么", "怎么样", "怎么", "怎样", "如何", "哪些", "哪个", "多少",
                   "请问", "介绍一下", "解释一下", "解释", "说明", "讲讲", "关于", "请",
                   "一下", "吗", "呢", "吧")
_STOP_WORDS = {"一下", "一些", "什么", "这个", "那个", "这些", "那些", "我们", "你们",
               "可以", "应该", "就是", "还是", "但是", "怎么", "怎样", "如何", "哪些",
               "多少", "请问", "介绍", "解释", "说明", "关于"}
_PUNCT = "\uff0c\u3002\uff01\uff1f\u3001\uff1b\uff1a\"'\uff08\uff09()\u3010\u3011\u300a\u300b<>~!@#$%^&*_+=|\\/,.?:;-"


def query_terms(q: str) -> list:
    """把问题拆成最长的两个关键词（去掉疑问词、标点和常见虚词）。"""
    s = str(q or "")
    for w in _QUESTION_WORDS:
        s = s.replace(w, " ")
    s = "".join(" " if c in _PUNCT else c for c in s)
    parts = [p for p in (x.strip() for x in s.split()) if len(p) >= 2 and p not in _STOP_WORDS]
    parts.sort(key=len, reverse=True)
    return parts[:2]


def query_grams(q: str) -> list:
    """最后一步：把最长的关键词切成两字词，命中任意一个就算相关（最多 8 个）。"""
    terms = query_terms(q)
    if not terms:
        return []
    longest = terms[0]
    out = []
    for i in range(len(longest) - 1):
        g = longest[i:i + 2]
        if g not in out:
            out.append(g)
    return out[:8]

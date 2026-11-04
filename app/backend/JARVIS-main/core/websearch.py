#!/usr/bin/env python3
"""
core/websearch.py — JARVIS internet lookups (opt-in, cited) + YouTube resolve

The ONE outbound path. It is never used on its own — the UI only calls it when
you explicitly ask ("/search", "/web", "search the web for …", "look up …") or
after you accept an auto-offer. Everything else stays local.

What it does:
  • search(query)          -> [{title, url, snippet}]  via DuckDuckGo (default),
                              SearXNG, or Brave — pick with JARVIS_SEARCH_BACKEND.
  • fetch_page_text(url)    -> readable text of a page (tags stripped, capped).
  • answer(query)          -> {answer, sources[]} — the local LLM summarises the
                              top results and cites them inline as [1], [2], …
  • youtube_search(query)   -> {videoId, title, url} for the best match (no API key).
  • needs_web(message)      -> bool, a cheap LLM check used only to *offer* a search.

Config (all optional):
  JARVIS_SEARCH_BACKEND  ddg | searxng | brave     (default ddg)
  JARVIS_SEARXNG_URL     e.g. http://127.0.0.1:8888 (for searxng)
  JARVIS_BRAVE_KEY       Brave Search API token     (for brave)
  JARVIS_WEB             "0" disables web entirely   (default on)
  JARVIS_MODEL / OLLAMA_URL  (shared with the rest of JARVIS)
"""
import html as _html
import json
import os
import re
import urllib.parse
import urllib.request

OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://127.0.0.1:11434").rstrip("/")
MODEL      = os.environ.get("JARVIS_MODEL", "llama3")
BACKEND    = os.environ.get("JARVIS_SEARCH_BACKEND", "ddg").lower()
SEARXNG    = os.environ.get("JARVIS_SEARXNG_URL", "http://127.0.0.1:8888").rstrip("/")
BRAVE_KEY  = os.environ.get("JARVIS_BRAVE_KEY", "")
WEB_ON     = os.environ.get("JARVIS_WEB", "1") != "0"

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/122.0 Safari/537.36")
TIMEOUT = 12


# ============================ http + html helpers ============================
def _get(url, headers=None, timeout=TIMEOUT, data=None):
    h = {"User-Agent": UA, "Accept-Language": "en-US,en;q=0.9"}
    if headers:
        h.update(headers)
    req = urllib.request.Request(url, headers=h, data=data)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        charset = r.headers.get_content_charset() or "utf-8"
        return r.read().decode(charset, errors="replace")


def _strip_html(s):
    s = re.sub(r"(?is)<(script|style|noscript)[^>]*>.*?</\1>", " ", s)
    s = re.sub(r"(?s)<[^>]+>", " ", s)
    s = _html.unescape(s)
    s = re.sub(r"[^\S\n]+", " ", s)          # collapse horizontal whitespace incl. \xa0 (&nbsp;)
    s = re.sub(r"\n\s*\n\s*\n+", "\n\n", s)
    return s.strip()


def _clean_inline(s):
    return re.sub(r"\s+", " ", _html.unescape(re.sub(r"(?s)<[^>]+>", "", s))).strip()


def _ddg_unwrap(href):
    """DuckDuckGo wraps results in /l/?uddg=<encoded-real-url>. Decode it."""
    if href.startswith("//"):
        href = "https:" + href
    m = re.search(r"[?&]uddg=([^&]+)", href)
    if m:
        return urllib.parse.unquote(m.group(1))
    return href


# ============================ search backends ============================
def _anchor_href(attrs):
    m = re.search(r'href="([^"]+)"', attrs)
    return m.group(1) if m else ""


def _search_ddg(query, k):
    q = urllib.parse.quote(query)
    try:
        page = _get("https://html.duckduckgo.com/html/?q=" + q)
    except Exception:
        page = _get("https://lite.duckduckgo.com/lite/?q=" + q)  # simpler markup
    out = []
    # result anchors — href may appear before OR after the class attribute
    for m in re.finditer(r'(?is)<a\b([^>]*\bclass="[^"]*result__a[^"]*"[^>]*)>(.*?)</a>', page):
        real = _ddg_unwrap(_anchor_href(m.group(1)))
        if not real.startswith("http"):
            continue
        out.append({"title": _clean_inline(m.group(2)) or real, "url": real, "snippet": ""})
        if len(out) >= k:
            break
    snips = [_clean_inline(s) for s in re.findall(
        r'(?is)<a\b[^>]*\bclass="[^"]*result__snippet[^"]*"[^>]*>(.*?)</a>', page)]
    for i in range(min(len(out), len(snips))):
        out[i]["snippet"] = snips[i]
    if out:
        return out
    # lite endpoint fallback: <a class="result-link" href="…">
    for m in re.finditer(r'(?is)<a\b([^>]*\bclass="[^"]*result-link[^"]*"[^>]*)>(.*?)</a>', page):
        real = _ddg_unwrap(_anchor_href(m.group(1)))
        if real.startswith("http"):
            out.append({"title": _clean_inline(m.group(2)) or real, "url": real, "snippet": ""})
        if len(out) >= k:
            break
    return out


def _search_searxng(query, k):
    url = SEARXNG + "/search?" + urllib.parse.urlencode({"q": query, "format": "json"})
    data = json.loads(_get(url))
    out = []
    for r in (data.get("results") or [])[:k]:
        if r.get("url"):
            out.append({"title": r.get("title") or r["url"], "url": r["url"],
                        "snippet": r.get("content") or ""})
    return out


def _search_brave(query, k):
    url = "https://api.search.brave.com/res/v1/web/search?" + urllib.parse.urlencode(
        {"q": query, "count": k})
    data = json.loads(_get(url, headers={"X-Subscription-Token": BRAVE_KEY,
                                         "Accept": "application/json"}))
    out = []
    for r in ((data.get("web") or {}).get("results") or [])[:k]:
        if r.get("url"):
            out.append({"title": r.get("title") or r["url"], "url": r["url"],
                        "snippet": r.get("description") or ""})
    return out


def search(query, k=5):
    query = (query or "").strip()
    if not query or not WEB_ON:
        return []
    try:
        if BACKEND == "searxng":
            return _search_searxng(query, k)
        if BACKEND == "brave" and BRAVE_KEY:
            return _search_brave(query, k)
        return _search_ddg(query, k)
    except Exception:
        # last-ditch: try DDG even if the configured backend failed
        try:
            return _search_ddg(query, k)
        except Exception:
            return []


# ============================ page fetch ============================
def fetch_page_text(url, max_chars=3500):
    try:
        raw = _get(url, timeout=TIMEOUT)
    except Exception:
        return ""
    text = _strip_html(raw)
    return text[:max_chars]


# ============================ YouTube ============================
_YT_ID = re.compile(r'"videoId":"([0-9A-Za-z_-]{11})"')


def _yt_title(video_id):
    try:
        o = json.loads(_get("https://www.youtube.com/oembed?" + urllib.parse.urlencode(
            {"url": "https://www.youtube.com/watch?v=" + video_id, "format": "json"})))
        return o.get("title", "")
    except Exception:
        return ""


def youtube_search(query):
    query = (query or "").strip()
    if not query or not WEB_ON:
        return {"ok": False, "error": "empty query"}
    vid = None
    try:
        page = _get("https://www.youtube.com/results?" + urllib.parse.urlencode(
            {"search_query": query, "hl": "en"}))
        m = _YT_ID.search(page)
        if m:
            vid = m.group(1)
    except Exception:
        vid = None
    if not vid:
        # fallback: ask DDG for a youtube watch link
        for r in _search_ddg("site:youtube.com/watch " + query, 5):
            mm = re.search(r"[?&]v=([0-9A-Za-z_-]{11})", r["url"])
            if mm:
                vid = mm.group(1)
                break
    if not vid:
        return {"ok": False, "error": "no video found"}
    title = _yt_title(vid) or query
    return {"ok": True, "videoId": vid, "title": title,
            "url": "https://www.youtube.com/watch?v=" + vid}


# ============================ local LLM ============================
def _llm(prompt, temperature=0.2):
    payload = json.dumps({"model": MODEL, "prompt": prompt, "stream": False,
                          "options": {"temperature": temperature}}).encode("utf-8")
    req = urllib.request.Request(OLLAMA_URL + "/api/generate", data=payload,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=90) as r:
        return json.load(r).get("response", "")


_SYNTH = (
    "You are JARVIS answering from live web results for the user (address them as 'sir' "
    "occasionally). Use ONLY the numbered sources below. Cite inline with [1], [2] etc. "
    "Be concise and factual; do NOT invent anything not supported by the sources. If the "
    "sources don't actually answer it, say so plainly.\n\n"
    "Question: {q}\n\nSources:\n{src}\n\nAnswer (with inline [n] citations):"
)

_NEEDS = (
    "Decide if answering the user's message needs up-to-date or external internet "
    "information (current events, news, prices, weather, sports, schedules, releases, "
    "live status, or specific facts a local model likely won't know reliably). "
    "Answer with ONLY one word: YES or NO.\n\nMessage: {q}\nAnswer:"
)


def answer(query, k=5, pages=3):
    query = (query or "").strip()
    if not WEB_ON:
        return {"ok": False, "error": "Web lookups are disabled (JARVIS_WEB=0)."}
    if not query:
        return {"ok": False, "error": "empty query"}
    results = search(query, k)
    if not results:
        return {"ok": False, "error": "No results — the search source may be unreachable, sir."}

    blocks = []
    for i, r in enumerate(results[:pages], 1):
        body = fetch_page_text(r["url"]) or r["snippet"]
        blocks.append(f"[{i}] {r['title']} — {r['url']}\n{body}")
    for i, r in enumerate(results[pages:k], pages + 1):
        blocks.append(f"[{i}] {r['title']} — {r['url']}\n{r['snippet']}")
    src = "\n\n".join(blocks)
    sources = [{"n": i + 1, "title": r["title"], "url": r["url"]}
               for i, r in enumerate(results[:k])]

    try:
        ans = _llm(_SYNTH.format(q=query, src=src[:9000])).strip()
    except Exception:
        ans = ""
    if not ans:
        ans = ("I found these but couldn't summarise them (is the brain running?), sir:\n"
               + "\n".join(f"[{i+1}] {r['title']} — {r['snippet']}"
                           for i, r in enumerate(results[:k])))
    return {"ok": True, "query": query, "answer": ans, "sources": sources}


def needs_web(message):
    message = (message or "").strip()
    if not WEB_ON or len(message) < 12:
        return {"suggest": False, "query": message}
    try:
        out = _llm(_NEEDS.format(q=message), temperature=0).strip().upper()
    except Exception:
        return {"suggest": False, "query": message}
    return {"suggest": out.startswith("Y"), "query": message}


def backend_name():
    if BACKEND == "brave" and BRAVE_KEY:
        return "brave"
    if BACKEND == "searxng":
        return "searxng"
    return "duckduckgo"


if __name__ == "__main__":  # manual: python websearch.py "your query"
    import sys
    q = " ".join(sys.argv[1:]) or "python release notes"
    print("backend:", backend_name())
    for r in search(q):
        print("-", r["title"], "\n  ", r["url"], "\n  ", r["snippet"][:120])

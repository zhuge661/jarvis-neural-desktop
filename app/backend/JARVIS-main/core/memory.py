#!/usr/bin/env python3
"""
core/memory.py — JARVIS long-term memory (local, private)

Stores short facts with vector embeddings from your local `nomic-embed-text`
model (via Ollama) and recalls the most relevant ones for each new message.
Everything lives in data/memory.json on your machine. If embeddings aren't
available, memory degrades gracefully (recall returns nothing, add is a no-op).
"""
import json
import math
import os
import time
import urllib.request

ROOT      = os.path.dirname(os.path.abspath(__file__))
DATA_DIR  = os.environ["JARVIS_DATA_DIR"]
MEM_PATH  = os.path.join(DATA_DIR, "memory.json")

OLLAMA_URL  = os.environ.get("OLLAMA_URL", "http://127.0.0.1:11434").rstrip("/")
EMBED_MODEL = os.environ.get("JARVIS_EMBED_MODEL", "nomic-embed-text")


def _embed(text):
    payload = json.dumps({"model": EMBED_MODEL, "prompt": text}).encode("utf-8")
    req = urllib.request.Request(
        OLLAMA_URL + "/api/embeddings", data=payload,
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)["embedding"]


def _load():
    try:
        with open(MEM_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return []


def _save(items):
    os.makedirs(DATA_DIR, exist_ok=True)
    tmp = MEM_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(items, f)
    os.replace(tmp, MEM_PATH)


def _cosine(a, b):
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    return dot / (na * nb + 1e-9)


def add(text):
    """Embed and store a fact. Returns True on success."""
    text = (text or "").strip()
    if not text:
        return False
    try:
        emb = _embed(text)
    except Exception:
        return False
    items = _load()
    # skip near-duplicates
    for it in items:
        if it["text"].lower() == text.lower():
            return True
    items.append({"text": text, "embedding": emb, "ts": time.time()})
    _save(items)
    return True


def recall(query, k=4):
    """Return up to k stored facts most relevant to `query`."""
    items = _load()
    if not items:
        return []
    try:
        q = _embed(query)
    except Exception:
        return []
    ranked = sorted(items, key=lambda it: _cosine(q, it["embedding"]), reverse=True)
    return [it["text"] for it in ranked[:k]]


def count():
    return len(_load())


def list_all():
    return [{"text": it["text"], "ts": it.get("ts")} for it in _load()]

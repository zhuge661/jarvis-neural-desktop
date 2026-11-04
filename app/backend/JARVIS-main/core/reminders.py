#!/usr/bin/env python3
"""
core/reminders.py — JARVIS reminders & scheduler (local, private)

Stores reminders in data/reminders.json and computes when each is next due.
Everything runs on your machine; nothing is uploaded.

Supported schedules:
    • once     — "in 20 min", "tomorrow 3pm", "on July 20 at 9am"
    • cron     — "every day at 8", "every weekday at 8", "every Mon/Wed 9am"
    • interval — "every 2 weeks", "every 90 minutes", biweekly
    • nthdow   — "2nd Tuesday of the month at 9am"  (n = -1 → last)

Natural language is parsed by a fast deterministic layer first; if that fails
and JARVIS_AUTOMEM-style LLM access is available, a local Ollama model is asked
to return a strict-JSON schedule (long tail: odd phrasings, "every 2nd Tuesday").
If the model isn't reachable, parsing degrades to the deterministic layer only.

Schedule shapes stored on disk:
    {"type":"once","at": <epoch>}
    {"type":"cron","expr":"MIN HOUR DOM MON DOW"}     # standard 5-field, DOW 0=Sun..6=Sat
    {"type":"interval","seconds": N, "anchor": <epoch>}
    {"type":"nthdow","n": N, "wd": 0-6(Mon=0), "hour": H, "minute": M}
"""
import calendar
import json
import math
import os
import re
import threading
import time
import urllib.request
from datetime import datetime, timedelta

ROOT     = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.environ.get("JARVIS_DATA_DIR") or os.path.abspath(os.path.join(ROOT, "..", "data"))
REM_PATH = os.path.join(DATA_DIR, "reminders.json")

OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://127.0.0.1:11434").rstrip("/")
MODEL      = os.environ.get("JARVIS_MODEL", "llama3")
USE_LLM    = os.environ.get("JARVIS_REMIND_LLM", "1") != "0"

_LOCK  = threading.Lock()
_ITEMS = None  # in-memory cache (list of dicts), loaded lazily under _LOCK


# ============================ storage ============================
def _load_locked():
    global _ITEMS
    if _ITEMS is not None:
        return _ITEMS
    try:
        with open(REM_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
        _ITEMS = data if isinstance(data, list) else []
    except Exception:
        _ITEMS = []
    return _ITEMS


def _save_locked():
    os.makedirs(DATA_DIR, exist_ok=True)
    tmp = REM_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(_ITEMS, f, indent=2)
    os.replace(tmp, REM_PATH)


# ============================ time helpers ============================
WD = {  # name -> python weekday (Mon=0 .. Sun=6)
    "monday": 0, "mon": 0, "tuesday": 1, "tues": 1, "tue": 1,
    "wednesday": 2, "weds": 2, "wed": 2, "thursday": 3, "thurs": 3, "thur": 3, "thu": 3,
    "friday": 4, "fri": 4, "saturday": 5, "sat": 5, "sunday": 6, "sun": 6,
}
WD_RE = (r"monday|tuesday|wednesday|thursday|friday|saturday|sunday|"
         r"mon|tues|tue|weds|wed|thurs|thur|thu|fri|sat|sun")

MONTHS = {m: i + 1 for i, m in enumerate(
    ["january", "february", "march", "april", "may", "june", "july",
     "august", "september", "october", "november", "december"])}
MON_ABBR = {"jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6, "jul": 7,
            "aug": 8, "sep": 9, "sept": 9, "oct": 10, "nov": 11, "dec": 12}
MONTH_RE = (r"january|february|march|april|may|june|july|august|september|october|"
            r"november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec")

DAYPART = {"morning": (8, 0), "noon": (12, 0), "midday": (12, 0), "afternoon": (15, 0),
           "evening": (19, 0), "night": (21, 0), "tonight": (21, 0)}

UNIT_SEC = {"second": 1, "sec": 1, "s": 1, "minute": 60, "min": 60, "m": 60,
            "hour": 3600, "hr": 3600, "h": 3600, "day": 86400, "d": 86400,
            "week": 604800, "w": 604800}


def _now_dt():
    return datetime.now()


def _clock(h, m):
    hr = h % 12 or 12
    ap = "AM" if h < 12 else "PM"
    return f"{hr}:{m:02d} {ap}"


def _fmt_dt(ep):
    if not ep:
        return "—"
    dt = datetime.fromtimestamp(ep)
    return f"{dt.strftime('%a')} {dt.strftime('%b')} {dt.day}, {_clock(dt.hour, dt.minute)}"


def _iso(ep):
    return datetime.fromtimestamp(ep).strftime("%Y-%m-%d %H:%M") if ep else None


def _month_num(name):
    name = name.lower()
    return MONTHS.get(name) or MON_ABBR.get(name)


def parse_time(s):
    """'3pm' '3:30 pm' '15:00' '9' 'noon' 'midnight' -> (hour, minute) or None."""
    s = s.strip().lower()
    if s in ("noon", "midday"):
        return (12, 0)
    if s == "midnight":
        return (0, 0)
    m = re.match(r"^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$", s)
    if not m:
        return None
    h = int(m.group(1))
    mi = int(m.group(2) or 0)
    ap = m.group(3)
    if ap == "pm" and h != 12:
        h += 12
    if ap == "am" and h == 12:
        h = 0
    if h > 23 or mi > 59:
        return None
    return (h, mi)


def _next_time(h, m, now):
    """Next datetime at h:m today, or tomorrow if that's already past."""
    cand = now.replace(hour=h, minute=m, second=0, microsecond=0)
    if cand <= now:
        cand += timedelta(days=1)
    return cand


def _next_weekday(wd, now, h, m, force_next=False):
    """Next datetime whose weekday==wd at h:m. force_next skips today."""
    days = (wd - now.weekday()) % 7
    cand = now.replace(hour=h, minute=m, second=0, microsecond=0) + timedelta(days=days)
    if cand <= now or (force_next and days == 0):
        cand += timedelta(days=7)
    return cand


# ============================ cron / interval / nthdow math ============================
def _cron_field(f, lo, hi):
    out = set()
    for part in str(f).split(","):
        step = 1
        rng = part
        if "/" in part:
            rng, st = part.split("/", 1)
            step = int(st)
        if rng == "*":
            a, b = lo, hi
        elif "-" in rng.lstrip("-"):
            a_s, b_s = rng.split("-", 1)
            a, b = int(a_s), int(b_s)
        else:
            a = b = int(rng)
        a = max(a, lo)
        b = min(b, hi)
        for v in range(a, b + 1, max(step, 1)):
            out.add(v)
    return out


def _cron_sets(expr):
    mi, ho, dom, mon, dow = expr.split()
    return {
        "min": _cron_field(mi, 0, 59),
        "hour": _cron_field(ho, 0, 23),
        "dom": _cron_field(dom, 1, 31),
        "mon": _cron_field(mon, 1, 12),
        "dow": {d % 7 for d in _cron_field(dow, 0, 7)},  # normalise 7 -> 0 (Sunday)
        "dom_star": dom.strip() == "*",
        "dow_star": dow.strip() == "*",
        "hour_star": ho.strip() == "*",
    }


def _cron_match(S, dt):
    if dt.minute not in S["min"]:
        return False
    if dt.hour not in S["hour"]:
        return False
    if dt.month not in S["mon"]:
        return False
    dom_ok = dt.day in S["dom"]
    cron_dow = (dt.weekday() + 1) % 7  # Mon0->1 .. Sun6->0
    dow_ok = cron_dow in S["dow"]
    if not S["dom_star"] and not S["dow_star"]:
        return dom_ok or dow_ok
    if not S["dom_star"]:
        return dom_ok
    if not S["dow_star"]:
        return dow_ok
    return True


def _next_cron(expr, after_ep):
    S = _cron_sets(expr)
    dt = datetime.fromtimestamp(after_ep).replace(second=0, microsecond=0)
    for _ in range(366 * 24 * 60 * 5):  # up to ~5 years (covers Feb 29 crons)
        if dt.timestamp() > after_ep and _cron_match(S, dt):
            return dt.timestamp()
        dt += timedelta(minutes=1)
    return None


def _next_interval(sched, after_ep):
    sec = sched["seconds"]
    anc = sched["anchor"]
    if sec <= 0:
        return None
    if anc > after_ep:
        return anc
    k = math.floor((after_ep - anc) / sec) + 1
    nd = anc + k * sec
    while nd <= after_ep:
        nd += sec
    return nd


def _nth_dow_day(year, month, n, wd):
    total = calendar.monthrange(year, month)[1]
    matches = [d for d in range(1, total + 1) if datetime(year, month, d).weekday() == wd]
    if not matches:
        return None
    if n == -1:
        return matches[-1]
    return matches[n - 1] if 1 <= n <= len(matches) else None


def _next_nthdow(sched, after_ep):
    after = datetime.fromtimestamp(after_ep)
    y, m = after.year, after.month
    h, mi = sched.get("hour", 9), sched.get("minute", 0)
    for _ in range(60):
        day = _nth_dow_day(y, m, sched["n"], sched["wd"])
        if day:
            cand = datetime(y, m, day, h, mi)
            if cand.timestamp() > after_ep:
                return cand.timestamp()
        m += 1
        if m > 12:
            m = 1
            y += 1
    return None


def next_due_after(sched, after_ep):
    t = sched.get("type")
    if t == "once":
        at = sched.get("at")
        return at if at and at > after_ep else None
    if t == "cron":
        return _next_cron(sched["expr"], after_ep)
    if t == "interval":
        return _next_interval(sched, after_ep)
    if t == "nthdow":
        return _next_nthdow(sched, after_ep)
    return None


# ============================ human description ============================
CRON_DOW_NAME = {0: "Sun", 1: "Mon", 2: "Tue", 3: "Wed", 4: "Thu", 5: "Fri", 6: "Sat"}
WD_FULL = {0: "Monday", 1: "Tuesday", 2: "Wednesday", 3: "Thursday",
           4: "Friday", 5: "Saturday", 6: "Sunday"}
ORD = {1: "1st", 2: "2nd", 3: "3rd", 4: "4th", 5: "5th", -1: "last"}


def describe(sched, next_due=None):
    t = sched.get("type")
    nxt = f" (next: {_fmt_dt(next_due)})" if next_due else ""
    if t == "once":
        return _fmt_dt(sched.get("at"))
    if t == "cron":
        try:
            mi, ho, dom, mon, dow = sched["expr"].split()
            S = _cron_sets(sched["expr"])
        except Exception:
            return "custom schedule" + nxt
        if ho == "*" and mi != "*":
            return "every hour" + nxt
        timepart = ""
        if len(S["min"]) == 1 and len(S["hour"]) == 1:
            timepart = " at " + _clock(next(iter(S["hour"])), next(iter(S["min"])))
        if dow == "*" and dom == "*":
            base = "every day"
        elif dow != "*":
            ds = sorted({d % 7 for d in _cron_field(dow, 0, 7)})
            if ds == [1, 2, 3, 4, 5]:
                base = "every weekday"
            elif ds == [0, 6]:
                base = "every weekend"
            else:
                base = "every " + "/".join(CRON_DOW_NAME[d] for d in ds)
        elif dom != "*":
            base = f"monthly (day {dom})"
        else:
            base = "scheduled"
        return base + timepart + nxt
    if t == "interval":
        sec = sched["seconds"]
        base = f"every {sec}s"
        for unit, label in ((604800, "week"), (86400, "day"), (3600, "hour"),
                            (60, "minute"), (1, "second")):
            if sec % unit == 0:
                n = sec // unit
                base = f"every {n} {label}" + ("s" if n != 1 else "")
                break
        return base + nxt
    if t == "nthdow":
        ordn = ORD.get(sched["n"], f"{sched['n']}th")
        return (f"{ordn} {WD_FULL[sched['wd']]} monthly at "
                f"{_clock(sched.get('hour', 9), sched.get('minute', 0))}" + nxt)
    return "custom" + nxt


# ============================ natural-language parser ============================
_PREFIX = re.compile(
    r"^\s*(?:/remind\s+|please\s+|hey\s+|can you\s+|could you\s+|will you\s+)?"
    r"(?:remind me to|remind me that|remind me|reminder to|reminder:|reminder|"
    r"set a reminder to|set a reminder|set reminder to|nudge me to|nudge me|remind)\b[:,]?\s*",
    re.I)

_TIME_AT = re.compile(r"\bat\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?|noon|midnight)\b", re.I)
_TIME_BARE = re.compile(r"\b(\d{1,2}:\d{2}\s*(?:am|pm)?|\d{1,2}\s*(?:am|pm)|noon|midnight)\b", re.I)


def _strip_prefix(raw):
    return _PREFIX.sub("", raw or "", count=1).strip()


def _extract_tod(s):
    """Returns (hh_mm, span, explicit) where explicit means am/pm/24h was stated."""
    m = _TIME_AT.search(s) or _TIME_BARE.search(s)
    if not m:
        return None, None, False
    t = parse_time(m.group(1))
    if not t:
        return None, None, False
    raw = m.group(1).lower()
    explicit = ("am" in raw) or ("pm" in raw) or raw in ("noon", "midnight") or t[0] >= 13 or t[0] == 0
    return t, m.span(), explicit


def _tidy(text):
    text = re.sub(r"\s+", " ", text).strip(" ,.:-")
    text = re.sub(r"^(?:(?:to|that|about|for|the|on|at)\s+)+", "", text, flags=re.I).strip()
    text = re.sub(r"\s+(?:at|on|in|by|every|this|next)$", "", text, flags=re.I).strip()
    return text


def _remove_spans(s, spans):
    for a, b in sorted([sp for sp in spans if sp], key=lambda x: -x[0]):
        s = s[:a] + " " + s[b:]
    return s


def _in_seconds(tail):
    """Sum a run of '<n><unit>' tokens from the start of tail. Returns (seconds, end_index)."""
    total = 0
    pos = 0
    found = False
    tok = re.compile(
        r"\s*(?:and\s+)?(\d+)\s*(weeks?|w|days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b",
        re.I)
    while True:
        mm = tok.match(tail, pos)
        if not mm:
            break
        unit = mm.group(2).lower().rstrip("s")
        unit = {"hr": "hour", "hrs": "hour", "sec": "sec", "min": "min",
                "wk": "week"}.get(unit, unit)
        # normalise plural strips: "minutes"->"minute", keep single-letter keys
        key = {"week": "week", "w": "w", "day": "day", "d": "d", "hour": "hour",
               "h": "h", "minute": "min", "min": "min", "m": "m",
               "second": "sec", "sec": "sec", "s": "s"}.get(unit, unit)
        total += int(mm.group(1)) * UNIT_SEC.get(key, 0)
        pos = mm.end()
        found = True
    return (total, pos) if found else (0, 0)


def _apply_daypart(h, m, part, explicit):
    """Bias a bare hour toward a named part of day ('evening at 7' -> 19:00)."""
    if explicit:
        return h, m
    if part in ("evening", "night", "tonight") and h < 12:
        h += 12
    elif part == "afternoon" and 1 <= h <= 11:
        h += 12
    elif part == "morning" and h == 12:
        h = 0
    return h, m


def _parse_deterministic(raw, now):
    s = _strip_prefix(raw)
    if not s:
        return {"ok": False, "error": "Remind you of what, sir?"}
    low = s.lower()
    tod, tod_span, tod_expl = _extract_tod(s)

    def T(default):
        return tod if tod else default

    sched = None
    spans = []

    # 1) nth weekday of month  ("2nd Tuesday", "last Friday of the month", "every 3rd Monday")
    m = re.search(r"\b(?:every\s+|on\s+the\s+|the\s+)?"
                  r"(first|second|third|fourth|fifth|last|\d+(?:st|nd|rd|th))\s+"
                  r"(" + WD_RE + r")\b(?:\s+of\s+(?:the|each|every)?\s*month)?", low)
    if m:
        nmap = {"first": 1, "second": 2, "third": 3, "fourth": 4, "fifth": 5, "last": -1}
        g = m.group(1)
        n = nmap.get(g) if g in nmap else int(re.match(r"\d+", g).group())
        h, mi = T((9, 0))
        sched = {"type": "nthdow", "n": n, "wd": WD[m.group(2)], "hour": h, "minute": mi}
        spans += [m.span(), tod_span]

    # 1b) biweekly / n-weekly on a weekday ("every other Tuesday", "every 2 weeks on Fri")
    if not sched:
        m = re.search(r"\bevery\s+(other|\d+)\s+weeks?\s+on\s+(" + WD_RE + r")\b", low) \
            or re.search(r"\bevery\s+other\s+(" + WD_RE + r")\b", low)
        if m:
            if m.lastindex == 2:
                n = 2 if m.group(1) == "other" else int(m.group(1))
                name = m.group(2)
            else:
                n, name = 2, m.group(1)
            h, mi = T((9, 0))
            anchor = _next_weekday(WD[name], now, h, mi).timestamp()
            sched = {"type": "interval", "seconds": n * 604800, "anchor": anchor}
            spans += [m.span(), tod_span]

    # 2) interval with explicit count ("every 2 weeks", "every other day", "every 90 minutes")
    if not sched:
        m = re.search(r"\bevery\s+(other\s+|\d+\s+)(seconds?|secs?|minutes?|mins?|"
                      r"hours?|hrs?|days?|weeks?)\b", low)
        if m:
            n = 2 if m.group(1).strip() == "other" else int(m.group(1).strip())
            unit = m.group(2).rstrip("s")
            unit = {"sec": "second", "min": "minute", "hr": "hour"}.get(unit, unit)
            sec = n * UNIT_SEC.get(unit, UNIT_SEC.get(unit[0], 0))
            anchor = now.timestamp()
            if unit in ("day", "week") and tod:
                anchor = _next_time(tod[0], tod[1], now).timestamp()
            sched = {"type": "interval", "seconds": sec, "anchor": anchor}
            spans += [m.span(), tod_span if unit in ("day", "week") else None]

    # 3) hourly
    if not sched and re.search(r"\b(every hour|hourly|each hour)\b", low):
        m = re.search(r"\b(every hour|hourly|each hour)\b", low)
        sched = {"type": "cron", "expr": "0 * * * *"}
        spans += [m.span()]

    # 4) daily  ("every day", "daily", "every morning/evening/night")
    if not sched:
        m = re.search(r"\b(every\s*day|everyday|daily|each\s*day)\b", low)
        mp = re.search(r"\bevery\s+(morning|afternoon|evening|night)\b", low)
        if m or mp:
            if mp and not tod:
                h, mi = DAYPART[mp.group(1)]
            else:
                h, mi = T((9, 0))
                if mp:
                    h, mi = _apply_daypart(h, mi, mp.group(1), tod_expl)
            sched = {"type": "cron", "expr": f"{mi} {h} * * *"}
            spans += [m.span() if m else mp.span(), tod_span]

    # 5) weekday / weekend / specific weekdays / weekly
    if not sched:
        if re.search(r"\bevery\s+weekday(s)?\b", low):
            m = re.search(r"\bevery\s+weekday(s)?\b", low)
            h, mi = T((9, 0))
            sched = {"type": "cron", "expr": f"{mi} {h} * * 1-5"}
            spans += [m.span(), tod_span]
        elif re.search(r"\bevery\s+weekend(s)?\b", low):
            m = re.search(r"\bevery\s+weekend(s)?\b", low)
            h, mi = T((9, 0))
            sched = {"type": "cron", "expr": f"{mi} {h} * * 0,6"}
            spans += [m.span(), tod_span]
        else:
            m = re.search(r"\bevery\s+((?:" + WD_RE + r")(?:s)?"
                          r"(?:\s*(?:,|and|&|/)\s*(?:" + WD_RE + r")(?:s)?)*)\b", low)
            if m:
                names = re.findall(r"(" + WD_RE + r")", m.group(1))
                cron_days = sorted({(WD[n] + 1) % 7 for n in names})
                h, mi = T((9, 0))
                sched = {"type": "cron",
                         "expr": f"{mi} {h} * * {','.join(str(d) for d in cron_days)}"}
                spans += [m.span(), tod_span]
            else:
                m = re.search(r"\b(every\s*week|weekly)\b(?:\s+on\s+(" + WD_RE + r"))?", low)
                if m:
                    wd = WD[m.group(2)] if m.group(2) else now.weekday()
                    h, mi = T((9, 0))
                    sched = {"type": "cron", "expr": f"{mi} {h} * * {(wd + 1) % 7}"}
                    spans += [m.span(), tod_span]

    # 5b) monthly ("every month on the 1st", "monthly")
    if not sched:
        m = re.search(r"\bevery\s+month\b(?:\s+on\s+the\s+(\d{1,2})(?:st|nd|rd|th)?)?", low) \
            or re.search(r"\bmonthly\b(?:\s+on\s+the\s+(\d{1,2})(?:st|nd|rd|th)?)?", low)
        if m:
            dom = int(m.group(1)) if m.group(1) else now.day
            if dom < 1 or dom > 31:
                dom = now.day
            h, mi = T((9, 0))
            sched = {"type": "cron", "expr": f"{mi} {h} {dom} * *"}
            spans += [m.span(), tod_span]

    # 6) relative  ("in 20 min", "in 1 hour 30 minutes", "in 3 days at 9am")
    if not sched:
        m = re.search(r"\bin\s+(?=\d)", low)
        if m:
            secs, end = _in_seconds(low[m.end():])
            if secs > 0:
                if secs >= 86400 and tod:  # "in 3 days at 9am" -> date + time
                    base = now + timedelta(seconds=secs)
                    at = base.replace(hour=tod[0], minute=tod[1], second=0, microsecond=0)
                    sched = {"type": "once", "at": at.timestamp()}
                    spans += [(m.start(), m.end() + end), tod_span]
                else:
                    sched = {"type": "once", "at": now.timestamp() + secs}
                    spans += [(m.start(), m.end() + end)]

    # 7) tomorrow
    if not sched:
        m = re.search(r"\btomorrow(?:\s+(morning|afternoon|evening|night))?\b", low)
        if m:
            if m.group(1) and not tod:
                h, mi = DAYPART[m.group(1)]
            else:
                h, mi = T((9, 0))
                if m.group(1):
                    h, mi = _apply_daypart(h, mi, m.group(1), tod_expl)
            at = (now + timedelta(days=1)).replace(hour=h, minute=mi, second=0, microsecond=0)
            sched = {"type": "once", "at": at.timestamp()}
            spans += [m.span(), tod_span]

    # 8) tonight / today
    if not sched:
        if re.search(r"\btonight\b", low):
            m = re.search(r"\btonight\b", low)
            h, mi = T((21, 0))
            if tod:
                h, mi = _apply_daypart(h, mi, "tonight", tod_expl)
            at = now.replace(hour=h, minute=mi, second=0, microsecond=0)
            if at <= now:
                at += timedelta(days=1)
            sched = {"type": "once", "at": at.timestamp()}
            spans += [m.span(), tod_span]
        elif re.search(r"\btoday\b", low):
            m = re.search(r"\btoday\b", low)
            if tod:
                at = now.replace(hour=tod[0], minute=tod[1], second=0, microsecond=0)
                if at <= now:
                    at += timedelta(days=1)
            else:
                at = now + timedelta(hours=1)
            sched = {"type": "once", "at": at.timestamp()}
            spans += [m.span(), tod_span]

    # 9) next / this / on <weekday>, or a bare weekday only if a time was given
    if not sched:
        m = re.search(r"\b(next|this|on)\s+(" + WD_RE + r")\b", low)
        if not m and tod:
            m = re.search(r"\b(" + WD_RE + r")\b", low)
        if m:
            if m.lastindex == 2:
                kind, name = m.group(1), m.group(2)
            else:
                kind, name = "", m.group(1)
            h, mi = T((9, 0))
            at = _next_weekday(WD[name], now, h, mi, force_next=(kind == "next"))
            sched = {"type": "once", "at": at.timestamp()}
            spans += [m.span(), tod_span]

    # 10a) "on the Nth" (day of this or a later month)
    if not sched:
        m = re.search(r"\bon\s+the\s+(\d{1,2})(?:st|nd|rd|th)\b", low)
        if m:
            day = int(m.group(1))
            h, mi = T((9, 0))
            at = _future_dom(now, day, h, mi)
            if at:
                sched = {"type": "once", "at": at.timestamp()}
                spans += [m.span(), tod_span]

    # 10) explicit dates  ("July 20 at 9am", "7/20", "2026-07-20")
    if not sched:
        m = re.search(r"\b(" + MONTH_RE + r")\s+(\d{1,2})(?:st|nd|rd|th)?\b", low)
        if m:
            mon = _month_num(m.group(1))
            day = int(m.group(2))
            h, mi = T((9, 0))
            at = _future_date(now, now.year, mon, day, h, mi)
            if at:
                sched = {"type": "once", "at": at.timestamp()}
                spans += [m.span(), tod_span]
        if not sched:
            m = re.search(r"\b(\d{4})-(\d{2})-(\d{2})\b", low)
            if m:
                y, mo, d = int(m.group(1)), int(m.group(2)), int(m.group(3))
                h, mi = T((9, 0))
                try:
                    sched = {"type": "once",
                             "at": datetime(y, mo, d, h, mi).timestamp()}
                    spans += [m.span(), tod_span]
                except ValueError:
                    pass
        if not sched:
            m = re.search(r"\bon\s+(\d{1,2})/(\d{1,2})(?:/(\d{2,4}))?\b", low)
            if m:
                mo, d = int(m.group(1)), int(m.group(2))
                yr = m.group(3)
                h, mi = T((9, 0))
                if yr:
                    yr = int(yr) + (2000 if int(yr) < 100 else 0)
                    try:
                        sched = {"type": "once", "at": datetime(yr, mo, d, h, mi).timestamp()}
                    except ValueError:
                        pass
                else:
                    at = _future_date(now, now.year, mo, d, h, mi)
                    if at:
                        sched = {"type": "once", "at": at.timestamp()}
                if sched:
                    spans += [m.span(), tod_span]

    # 11) a bare time of day ("at 3pm", "9am")
    if not sched and tod:
        at = _next_time(tod[0], tod[1], now)
        sched = {"type": "once", "at": at.timestamp()}
        spans += [tod_span]

    if not sched:
        return {"ok": False, "error": "no time found"}

    # once must be in the future
    if sched["type"] == "once" and sched["at"] <= now.timestamp() + 1:
        return {"ok": False, "error": "That time has already passed, sir."}

    text = _tidy(_remove_spans(s, spans))
    nd = sched["at"] if sched["type"] == "once" else next_due_after(sched, now.timestamp())
    if not nd:
        return {"ok": False, "error": "That schedule has no upcoming time, sir."}
    return {"ok": True, "text": text or "reminder", "schedule": sched, "next_due": nd}


def _future_date(now, year, month, day, h, mi):
    try:
        at = datetime(year, month, day, h, mi)
    except ValueError:
        return None
    if at <= now:
        try:
            at = datetime(year + 1, month, day, h, mi)
        except ValueError:
            return None
    return at


def _future_dom(now, day, h, mi):
    """Next date whose day-of-month == day, at h:m (this month or a later one)."""
    y, mo = now.year, now.month
    for _ in range(13):
        try:
            at = datetime(y, mo, day, h, mi)
        except ValueError:
            at = None
        if at and at > now:
            return at
        mo += 1
        if mo > 12:
            mo = 1
            y += 1
    return None


# ---- optional local-LLM fallback -------------------------------------------
_LLM_PROMPT = (
    "You convert a reminder request into a JSON schedule. "
    "Current local date-time is {now} ({wd}). "
    "Return ONLY compact JSON, no prose, exactly:\n"
    '{{"text":"<concise reminder, no time words>","schedule":<S>}}\n'
    "where <S> is one of:\n"
    '{{"type":"once","at":"YYYY-MM-DD HH:MM"}}\n'
    '{{"type":"cron","expr":"MIN HOUR DOM MON DOW"}}   (5-field cron, DOW 0=Sun..6=Sat)\n'
    '{{"type":"interval","seconds":N,"anchor":"YYYY-MM-DD HH:MM"}}\n'
    '{{"type":"nthdow","n":N,"weekday":"tuesday","hour":H,"minute":M}}   (n=-1 = last)\n'
    "Use 24-hour times. Prefer once for a single moment; cron for daily/weekly; "
    "interval for 'every N minutes/hours/weeks' and biweekly; nthdow for 'the 2nd Tuesday'. "
    "If it is in the past, roll to the next sensible future occurrence.\n"
    "Request: {req}\nJSON:"
)


def _llm(prompt):
    payload = json.dumps({"model": MODEL, "prompt": prompt, "stream": False,
                          "options": {"temperature": 0}}).encode("utf-8")
    req = urllib.request.Request(OLLAMA_URL + "/api/generate", data=payload,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r).get("response", "")


def _parse_llm(raw, now):
    if not USE_LLM:
        return {"ok": False, "error": "no time found"}
    try:
        out = _llm(_LLM_PROMPT.format(now=now.strftime("%Y-%m-%d %H:%M"),
                                      wd=now.strftime("%A"), req=raw))
    except Exception:
        return {"ok": False, "error": "no time found"}
    m = re.search(r"\{.*\}", out, re.S)
    if not m:
        return {"ok": False, "error": "no time found"}
    try:
        obj = json.loads(m.group(0))
        sched = obj["schedule"]
        t = sched["type"]
        if t == "once":
            sched = {"type": "once",
                     "at": datetime.strptime(sched["at"], "%Y-%m-%d %H:%M").timestamp()}
        elif t == "cron":
            _cron_sets(sched["expr"])  # validate
            sched = {"type": "cron", "expr": sched["expr"]}
        elif t == "interval":
            sched = {"type": "interval", "seconds": int(sched["seconds"]),
                     "anchor": datetime.strptime(sched["anchor"], "%Y-%m-%d %H:%M").timestamp()}
        elif t == "nthdow":
            wd = WD[str(sched["weekday"]).lower()]
            sched = {"type": "nthdow", "n": int(sched["n"]), "wd": wd,
                     "hour": int(sched.get("hour", 9)), "minute": int(sched.get("minute", 0))}
        else:
            return {"ok": False, "error": "no time found"}
    except Exception:
        return {"ok": False, "error": "no time found"}

    nd = sched["at"] if sched["type"] == "once" else next_due_after(sched, now.timestamp())
    if not nd or (sched["type"] == "once" and nd <= now.timestamp() + 1):
        return {"ok": False, "error": "That time has already passed, sir."}
    text = _tidy(str(obj.get("text", "")).strip()) or _tidy(_strip_prefix(raw)) or "reminder"
    return {"ok": True, "text": text, "schedule": sched, "next_due": nd}


def parse(raw, now=None):
    now = now or _now_dt()
    res = _parse_deterministic(raw, now)
    if res.get("ok"):
        return res
    if res.get("error") in ("no time found", None):
        llm = _parse_llm(raw, now)
        if llm.get("ok"):
            return llm
        return {"ok": False,
                "error": "I couldn't work out when, sir. Try 'in 20 min', "
                         "'tomorrow 3pm', or 'every weekday at 8'."}
    return res


# ============================ public record shaping ============================
def _public(r):
    return {
        "id": r["id"],
        "text": r["text"],
        "when": describe(r["schedule"], r.get("next_due")),
        "next_due": r.get("next_due"),
        "next_due_iso": _iso(r.get("next_due")),
        "repeat": r["schedule"]["type"] != "once",
        "type": r["schedule"]["type"],
        "fired": bool(r.get("fired")),
        "done": bool(r.get("done")),
        "snoozed": bool(r.get("snooze_until")),
    }


def _new_id():
    return "r_%d_%d" % (int(time.time() * 1000), int.from_bytes(os.urandom(2), "big"))


# ============================ public API ============================
def create(raw):
    p = parse(raw)
    if not p.get("ok"):
        return {"ok": False, "error": p.get("error", "I couldn't parse that, sir.")}
    r = {
        "id": _new_id(),
        "text": p["text"],
        "schedule": p["schedule"],
        "next_due": p["next_due"],
        "created": time.time(),
        "fired": False, "fired_at": None,
        "acknowledged": False, "snooze_until": None,
        "done": False,
    }
    with _LOCK:
        _load_locked().append(r)
        _save_locked()
    return {"ok": True, "reminder": _public(r)}


def check_and_fire(now=None):
    """Flip due reminders to fired; return the list that just fired."""
    now = now or time.time()
    fired = []
    with _LOCK:
        items = _load_locked()
        changed = False
        for r in items:
            if r.get("done"):
                continue
            due = r.get("snooze_until") or r.get("next_due")
            if due and not r.get("fired") and due <= now:
                r["fired"] = True
                r["fired_at"] = now
                r["acknowledged"] = False
                changed = True
                fired.append(_public(r))
        if changed:
            _save_locked()
    return fired


def pending_notifications():
    """Reminders that have fired and not yet been acknowledged."""
    with _LOCK:
        return [_public(r) for r in _load_locked()
                if r.get("fired") and not r.get("acknowledged") and not r.get("done")]


def dismiss(rid):
    with _LOCK:
        items = _load_locked()
        for r in items:
            if r["id"] == rid:
                r["acknowledged"] = True
                r["snooze_until"] = None
                if r["schedule"]["type"] == "once":
                    r["done"] = True
                else:
                    nd = next_due_after(r["schedule"], time.time())
                    if nd:
                        r["next_due"] = nd
                        r["fired"] = False
                        r["fired_at"] = None
                    else:
                        r["done"] = True
                _save_locked()
                return {"ok": True, "reminder": _public(r)}
    return {"ok": False, "error": "not found"}


def snooze(rid, minutes=10):
    try:
        minutes = max(1, int(minutes))
    except Exception:
        minutes = 10
    with _LOCK:
        items = _load_locked()
        for r in items:
            if r["id"] == rid:
                r["snooze_until"] = time.time() + minutes * 60
                r["fired"] = False
                r["fired_at"] = None
                r["acknowledged"] = False
                _save_locked()
                return {"ok": True, "reminder": _public(r), "minutes": minutes}
    return {"ok": False, "error": "not found"}


def delete(rid):
    with _LOCK:
        items = _load_locked()
        for i, r in enumerate(items):
            if r["id"] == rid:
                items.pop(i)
                _save_locked()
                return {"ok": True}
    return {"ok": False, "error": "not found"}


def list_all():
    with _LOCK:
        items = _load_locked()
        pending = [_public(r) for r in items if not r.get("done")]
        done = [_public(r) for r in items if r.get("done")]
    pending.sort(key=lambda x: (x["next_due"] is None, x["next_due"] or 0))
    done.sort(key=lambda x: x["next_due"] or 0, reverse=True)
    return {"pending": pending, "done": done, "count": len(pending)}


def count():
    with _LOCK:
        return sum(1 for r in _load_locked() if not r.get("done"))


if __name__ == "__main__":  # quick manual check: python reminders.py "remind me ..."
    import sys
    now = _now_dt()
    for arg in sys.argv[1:]:
        r = parse(arg, now)
        if r.get("ok"):
            print(f"OK   | {arg!r}\n     -> text={r['text']!r}  {describe(r['schedule'], r['next_due'])}")
        else:
            print(f"FAIL | {arg!r}  ({r.get('error')})")
# end of core/reminders.py

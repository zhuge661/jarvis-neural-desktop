"""Read-only Obsidian graph. Vault contents never enter the chat/model backend."""
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import threading
import time
from urllib.parse import unquote

CONFIG = Path(os.environ['JARVIS_DATA_DIR']) / 'knowledge-vault.json'
_guard = threading.RLock()
_cache = None
_cached_at = 0
MAX_NOTE_BYTES = 2 * 1024 * 1024


def vault_root():
    try:
        config = json.loads(CONFIG.read_text(encoding='utf-8'))
        root = Path(config['path']).resolve(strict=True)
        if not root.is_dir() or not (root / '.obsidian').is_dir():
            raise ValueError('所选目录不是有效的 Obsidian 知识库。')
        return root
    except (OSError, KeyError, json.JSONDecodeError) as exc:
        raise ValueError('尚未配置可用的 Obsidian 知识库。') from exc


def _note_files(root):
    for directory, folders, files in os.walk(root, followlinks=False):
        folders[:] = sorted(f for f in folders if not f.startswith('.')
                            and not (Path(directory) / f).is_symlink()
                            and not (Path(directory) / f).is_junction())
        for name in sorted(files):
            p = Path(directory) / name
            if name.startswith('.') or p.suffix.lower() != '.md' or p.is_symlink():
                continue
            if p.resolve().is_relative_to(root):
                yield p


def _key(path):
    return unquote(path).replace('\\', '/').casefold().removesuffix('.md').strip('/')


def _aliases(text):
    # Common Obsidian YAML aliases, inline and indented list forms.
    front = re.match(r'^---\s*\n(.*?)\n---(?:\n|$)', text, re.S)
    if not front:
        return []
    lines = front.group(1).splitlines()
    aliases = []
    for i, line in enumerate(lines):
        match = re.match(r'^aliases?:\s*(.*)$', line)
        if not match:
            continue
        value = match[1].strip()
        if value:
            aliases.extend(v.strip(' \"\'') for v in value.strip('[]').split(','))
        else:
            for following in lines[i + 1:]:
                item = re.match(r'^\s*-\s+(.+)$', following)
                if not item:
                    break
                aliases.append(item[1].strip(' \"\''))
    return [a for a in aliases if a]


def has_content(text):
    body = re.sub(r'^---\s*\n.*?\n---(?:\n|$)', '', text, count=1, flags=re.S)
    body = re.sub(r'<!--.*?-->', '', body, flags=re.S)
    return any(line.strip() and not re.fullmatch(r'\s*(?:#{1,6}\s+.*|[-*_]{3,})\s*', line)
               for line in body.splitlines())


def graph(refresh=False):
    global _cache, _cached_at
    if not CONFIG.exists():
        return {'vault':'本机资料','nodes':[],'links':[],'skipped':0}
    with _guard:
        if _cache and not refresh and time.monotonic() - _cached_at < 30:
            return _cache['public']
        root = vault_root()
        nodes, texts, by_path, names = [], {}, {}, {}
        skipped = 0
        for path in _note_files(root):
            if path.stat().st_size > MAX_NOTE_BYTES:
                skipped += 1
                continue
            relative = path.relative_to(root).as_posix()
            try:
                text = path.read_text(encoding='utf-8-sig')
            except (OSError, UnicodeError):
                skipped += 1
                continue
            node_id = hashlib.sha256(relative.encode('utf-8')).hexdigest()[:24]
            node = {'id': node_id, 'title': path.stem, 'path': relative,
                    'folder': path.parent.relative_to(root).as_posix(),
                    'bytes': path.stat().st_size, 'hasContent': has_content(text)}
            nodes.append(node)
            texts[node_id] = text
            by_path[_key(relative)] = node_id
            for name in [path.stem, *_aliases(text)]:
                names.setdefault(_key(name), set()).add(node_id)

        def resolve(source, target):
            target = target.split('|', 1)[0].split('#', 1)[0].strip()
            if not target or re.match(r'^[a-z][a-z0-9+.-]*:', target, re.I):
                return None
            # Source-relative Markdown links take precedence over vault paths.
            candidate = PurePosixPath(source['path']).parent / unquote(target).replace('\\', '/')
            normalized = os.path.normpath(str(candidate)).replace('\\', '/')
            found = by_path.get(_key(normalized)) or by_path.get(_key(target))
            if found:
                return found
            candidates = names.get(_key(target), set())
            return next(iter(candidates)) if len(candidates) == 1 else None

        links = set()
        for node in nodes:
            text = re.sub(r'(?ms)^(```|~~~).*?^\1[^\n]*$', '', texts[node['id']])
            text = re.sub(r'`[^`\n]+`', '', text)
            targets = re.findall(r'\[\[([^\]]+)\]\]', text)
            targets += re.findall(r'(?<!!)\[[^\]]*\]\(<?([^\s)>]+)>?(?:\s+[^)]*)?\)', text)
            for target in targets:
                destination = resolve(node, target)
                if destination and destination != node['id']:
                    links.add(tuple(sorted((node['id'], destination))))
        public = {'vault': root.name, 'nodes': nodes,
                  'links': [{'source': a, 'target': b} for a, b in sorted(links)],
                  'skipped': skipped, 'readOnly': True}
        _cache = {'root': root, 'nodes': {n['id']: n for n in nodes}, 'public': public}
        _cached_at = time.monotonic()
        return public


def note(node_id):
    if not isinstance(node_id, str) or not re.fullmatch(r'[a-f0-9]{24}', node_id):
        raise ValueError('笔记标识无效。')
    with _guard:
        graph()
        node = _cache['nodes'].get(node_id)
        if not node:
            raise ValueError('笔记不存在，请刷新知识库。')
        path = (_cache['root'] / node['path']).resolve(strict=True)
        if not path.is_relative_to(_cache['root']) or path.suffix.lower() != '.md':
            raise ValueError('只允许读取所选库内的 Markdown 笔记。')
        if path.stat().st_size > MAX_NOTE_BYTES:
            raise ValueError('笔记过大，请在 Obsidian 中查看。')
        content = path.read_text(encoding='utf-8-sig')
        return {**node, 'hasContent': has_content(content), 'content': content}

"""Check the exact tracked source tree; do not read a developer's private state."""
from pathlib import Path
import re
import subprocess

ROOT=Path(__file__).resolve().parents[1]
forbidden={'private-settings.json','model-connections.json','realtime-voice.json','knowledge-vault.json','profile.json','memory.json','reminders.json'}
patterns=[re.compile(rb'\bgh[opusr]_[A-Za-z0-9]{30,}'),re.compile(rb'\bgithub_pat_[A-Za-z0-9_]{30,}'),re.compile(rb'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----')]
files=subprocess.check_output(['git','ls-files','-z'],cwd=ROOT).decode('utf-8').split('\0')
issues=[]
for name in filter(None,files):
    path=ROOT/name
    if path.name in forbidden or any(part in {'桌面数据','OpenClaw后端','.venv','node_modules','.cache'} for part in path.relative_to(ROOT).parts):issues.append(name);continue
    data=path.read_bytes()
    if any(pattern.search(data) for pattern in patterns):issues.append(name)
    if re.search(rb'[A-Za-z]:[\\/]+Users[\\/]+[A-Za-z0-9_.-]+',data):issues.append(name)
assert not issues,'Public tree contains disallowed content: '+', '.join(issues)
print('Tracked public source: no private state paths or obvious secret patterns.')

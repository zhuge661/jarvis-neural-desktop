"""Verify isolated CI packages against tracked public source before a release."""
import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import plistlib
import re
import shutil
import stat
import subprocess

ROOT=Path(__file__).resolve().parents[1]
def verify(incoming,out,arches=('arm64','x64')):
    import zipfile
    out.mkdir(parents=True,exist_ok=True)
    tracked=subprocess.check_output(['git','ls-files','-z','app'],cwd=ROOT).decode().split('\0')
    source={name[4:]:hashlib.sha256(subprocess.check_output(['git','show','HEAD:'+name],cwd=ROOT)).digest() for name in filter(None,tracked)}
    results=[]
    for arch in arches:
        archive=next((incoming/arch).rglob(f'Jarvis-macOS-{arch}-v1.0.0.zip'))
        smoke_path=next((incoming/arch).rglob(f'mac-smoke-{arch}.json'))
        smoke=json.loads(smoke_path.read_text())
        assert smoke['platform']=='darwin' and smoke['packaged'] and smoke['arch']==('x64' if arch=='x64' else 'arm64'),smoke
        assert not any(smoke[key] for key in ('knowledgeNodes','imports','modelConfigured','voiceConfigured')),smoke
        digest=hashlib.file_digest(archive.open('rb'),'sha256').hexdigest()
        assert archive.with_suffix('.zip.sha256').read_text().split()[0]==digest
        seen=set();links=0
        with zipfile.ZipFile(archive) as z:
            for info in z.infolist():
                name=info.filename;parts=PurePosixPath(name).parts
                assert not PurePosixPath(name).is_absolute() and '..' not in parts,name
                assert not any(part in ('桌面数据','OpenClaw后端','.git','.env','JarvisClean') for part in parts),name
                assert PurePosixPath(name).name not in ('private-settings.json','model-connections.json','realtime-voice.json','profile.json','memory.json','reminders.json','knowledge-vault.json'),name
                if info.is_dir():continue
                if stat.S_ISLNK(info.external_attr>>16):links+=1
                prefix='贾维斯.app/Contents/Resources/app/'
                relative=name[len(prefix):] if name.startswith(prefix) else None
                checksum=hashlib.sha256()
                with z.open(info) as stream:
                    while chunk:=stream.read(1024*1024):checksum.update(chunk)
                if relative in source:
                    assert checksum.digest()==source[relative],('Source mismatch',relative)
                    seen.add(relative)
                elif relative is not None:
                    assert relative.startswith(('python/','backend/语音模型/')) or relative=='dependency-versions.json',('Unexpected payload',relative)
            assert seen==set(source),('Missing source',set(source)-seen)
            assert links>10
            plist=plistlib.loads(z.read('贾维斯.app/Contents/Info.plist'))
            assert plist['CFBundleExecutable']=='Jarvis' and plist['CFBundleIdentifier']=='com.jarvis.desktop.clean'
            assert (z.getinfo('首次安装.command').external_attr>>16)&0o111
            assert b'Contents/Resources/app" -type f' in z.read('首次安装.command')
        for file in (archive,archive.with_suffix('.zip.sha256'),smoke_path):shutil.copy2(file,out/file.name)
        results.append({'file':archive.name,'bytes':archive.stat().st_size,'sha256':digest,
            'nativeMacLaunch':'pass','arch':arch,'modelConfigured':False,'voiceConfigured':False,
            'importedFiles':0,'sourceMatchesPublicTree':True,'zipCrc':'pass','unixSymlinks':links})
    report={'commit':subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT).decode().strip(),
        'packages':results,'appleNotarized':False,'manualCameraAndCloudVoiceTested':False,
        'buildEnvironment':'isolated GitHub-hosted macOS runners without sender private files'}
    (out/'release-audit.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps(report,ensure_ascii=False,indent=2))
if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('incoming',type=Path);p.add_argument('output',type=Path)
    p.add_argument('--arches',nargs='+',choices=('arm64','x64'),default=['arm64','x64'])
    a=p.parse_args();verify(a.incoming,a.output,a.arches)

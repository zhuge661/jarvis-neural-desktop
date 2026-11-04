"""Build a relocatable clean Mac app. Native signing/smoke tests run only on Mac."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path, PurePosixPath
import platform
import plistlib
import shutil
import stat
import struct
import subprocess
import sys
import tarfile
import zipfile

ROOT=Path(__file__).resolve().parents[1]
CACHE=ROOT/'.cache'
DIST=ROOT/'dist'
MACHO={b'\xcf\xfa\xed\xfe',b'\xfe\xed\xfa\xcf',b'\xca\xfe\xba\xbe',b'\xbe\xba\xfe\xca'}

def checked(root,name):
    target=root/PurePosixPath(name)
    assert target.resolve().is_relative_to(root.resolve()),'Archive path escape'
    return target

def runtimes(arch):
    from download_runtimes import fetch,URLS
    target='aarch64' if arch=='arm64' else 'x86_64'
    urls=[u for u in URLS if f'darwin-{arch}.zip' in u or f'{target}-apple-darwin-' in u or u.endswith(('SHASUMS256.txt','SHA256SUMS'))]
    for url in urls:fetch(url)
    for name,sums in [(f'electron-v45.2.1-darwin-{arch}.zip','SHASUMS256.txt'),
        (f'cpython-3.13.18+20261026-{target}-apple-darwin-install_only_stripped.tar.gz','SHA256SUMS')]:
        checks={line.split()[-1].lstrip('*'):line.split()[0] for line in (CACHE/sums).read_text().splitlines() if line.strip()}
        assert hashlib.file_digest((CACHE/name).open('rb'),'sha256').hexdigest()==checks[name],name
    wheels=CACHE/f'wheels-{arch}';wheels.mkdir(exist_ok=True)
    mac_platform='macosx_11_0_arm64' if arch=='arm64' else 'macosx_11_0_x86_64'
    subprocess.run([sys.executable,'-m','pip','download','--dest',str(wheels),'--find-links',str(ROOT/'vendor/wheels'),
        '--platform',mac_platform,'--python-version','3.13','--implementation','cp','--abi','cp313',
        '--only-binary=:all:','--require-hashes','-r',str(ROOT/f'requirements-macos-{arch}.lock')],check=True)
    return target,wheels

def extract_electron(archive,stage):
    links=[]
    with zipfile.ZipFile(archive) as z:
        for info in z.infolist():
            if not info.filename.startswith('Electron.app/'):continue
            if info.filename.endswith('/Resources/default_app.asar'):continue
            target=checked(stage,info.filename)
            if info.is_dir():target.mkdir(parents=True,exist_ok=True);continue
            target.parent.mkdir(parents=True,exist_ok=True)
            if stat.S_ISLNK(info.external_attr>>16):links.append((target,z.read(info).decode()));continue
            with z.open(info) as src,target.open('wb') as out:shutil.copyfileobj(src,out)
            os.chmod(target,(info.external_attr>>16)&0o777 or 0o644)
        for target,value in links:
            resolved=(target.parent/value).resolve()
            assert resolved.is_relative_to(stage.resolve()),'External symlink'
            os.symlink(value,target,target_is_directory=resolved.is_dir())

def wheels_install(wheels,python):
    site=python/'lib/python3.13/site-packages';site.mkdir(parents=True,exist_ok=True)
    entries=[]
    for wheel in sorted(wheels.glob('*.whl')):
        with zipfile.ZipFile(wheel) as z:
            for info in z.infolist():
                if info.is_dir():continue
                parts=PurePosixPath(info.filename).parts
                if len(parts)>2 and parts[0].endswith('.data'):
                    if parts[1] not in ('purelib','platlib'):continue
                    name='/'.join(parts[2:])
                else:name=info.filename
                target=checked(site,name);target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(z.read(info))
        entries.append({'wheel':wheel.name,'sha256':hashlib.file_digest(wheel.open('rb'),'sha256').hexdigest()})
    return entries

def archive_app(app,destination):
    with zipfile.ZipFile(destination,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=6,allowZip64=True) as z:
        def add(path):
            name=path.relative_to(app.parent).as_posix();info=zipfile.ZipInfo(name);info.create_system=3;info.compress_type=zipfile.ZIP_DEFLATED
            if path.is_symlink():info.external_attr=(stat.S_IFLNK|0o777)<<16;z.writestr(info,os.readlink(path).replace('\\','/').encode());return
            if path.is_dir():
                info.filename+='/';info.external_attr=((stat.S_IFDIR|0o755)<<16)|0x10;z.writestr(info,b'')
                for child in sorted(path.iterdir(),key=lambda p:p.name):add(child)
                return
            with path.open('rb') as stream:magic=stream.read(4)
            executable=magic in MACHO or '/MacOS/' in name or '/python/bin/' in name
            info.external_attr=(stat.S_IFREG|(0o755 if executable else 0o644))<<16
            with path.open('rb') as stream,z.open(info,'w',force_zip64=True) as out:shutil.copyfileobj(stream,out)
        add(app)
        for source,name in [(ROOT/'scripts/first-install.command','首次安装.command'),(ROOT/'docs/MAC_INSTALL.md','Mac安装与使用说明.txt')]:
            info=zipfile.ZipInfo(name);info.create_system=3;info.external_attr=(stat.S_IFREG|(0o755 if name.endswith('.command') else 0o644))<<16
            z.writestr(info,source.read_bytes())

def build(args):
    DIST.mkdir(exist_ok=True);stage=ROOT/'build'/args.arch;stage.mkdir(parents=True,exist_ok=True)
    target,wheels=runtimes(args.arch)
    from download_model import download
    download()
    app=stage/'贾维斯.app'
    if not app.exists():extract_electron(CACHE/f'electron-v45.2.1-darwin-{args.arch}.zip',stage);(stage/'Electron.app').rename(app)
    resources=app/'Contents/Resources';payload=resources/'app'
    shutil.copytree(ROOT/'app',payload,dirs_exist_ok=True,ignore=shutil.ignore_patterns('__pycache__','*.pyc'))
    if not (payload/'python/bin/python3').exists():
        with tarfile.open(CACHE/f'cpython-3.13.18+20261026-{target}-apple-darwin-install_only_stripped.tar.gz') as tar:tar.extractall(payload,filter='data')
    deps=wheels_install(wheels,payload/'python')
    (payload/'dependency-versions.json').write_text(json.dumps(deps,indent=2),encoding='utf-8')
    for plist in app.rglob('Info.plist'):
        if plist.is_symlink():continue
        data=plistlib.loads(plist.read_bytes())
        if isinstance(data.get('CFBundleIdentifier'),str):data['CFBundleIdentifier']=data['CFBundleIdentifier'].replace('com.github.Electron','com.jarvis.desktop.clean')
        if plist==app/'Contents/Info.plist':data.update(CFBundleName='贾维斯',CFBundleDisplayName='贾维斯',CFBundleIdentifier='com.jarvis.desktop.clean',
            CFBundleShortVersionString='1.0.0',CFBundleVersion='1.0.0',CFBundleIconFile='jarvis.icns',
            NSCameraUsageDescription='用于本机手势识别；摄像头画面不上传。',NSMicrophoneUsageDescription='用于语音对话；开启实时语音时发送至你配置的语音服务。')
        plist.write_bytes(plistlib.dumps(data))
    png=(ROOT/'app/icon.png').read_bytes();width,height=struct.unpack('>II',png[16:24]);assert width==height
    body={128:b'ic07',256:b'ic08',512:b'ic09',1024:b'ic10'}[width]+struct.pack('>I',len(png)+8)+png
    (resources/'jarvis.icns').write_bytes(b'icns'+struct.pack('>I',len(body)+8)+body)
    with zipfile.ZipFile(CACHE/f'electron-v45.2.1-darwin-{args.arch}.zip') as z:
        for name in ('LICENSE','LICENSES.chromium.html'):
            if name in z.namelist():(resources/('Electron-'+name)).write_bytes(z.read(name))
    if args.sign:
        assert sys.platform=='darwin','Native signing requires macOS'
        subprocess.run(['/bin/bash',str(ROOT/'scripts/sign_mac.sh'),str(app)],check=True)
    if args.smoke:
        assert sys.platform=='darwin' and ('arm64' if platform.machine()=='arm64' else 'x64')==args.arch,'Smoke test requires matching Mac CPU'
        report=DIST/f'mac-smoke-{args.arch}.json'
        env=dict(os.environ,JARVIS_SMOKE_REPORT=str(report))
        executable=app/'Contents/MacOS/Electron'
        subprocess.run([str(executable),'--smoke-test'],env=env,check=True,timeout=120)
        data=json.loads(report.read_text());assert data.get('platform')=='darwin' and data.get('packaged') and not data.get('error'),data
    destination=DIST/f'Jarvis-macOS-{args.arch}-v1.0.0.zip'
    archive_app(app,destination)
    digest=hashlib.file_digest(destination.open('rb'),'sha256').hexdigest()
    destination.with_suffix('.zip.sha256').write_text(digest+'  '+destination.name+'\n',encoding='utf-8')
    print('Built',destination.name,digest)

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--arch',choices=('arm64','x64'),default='arm64' if platform.machine()=='arm64' else 'x64')
    parser.add_argument('--sign',action='store_true');parser.add_argument('--smoke',action='store_true');build(parser.parse_args())

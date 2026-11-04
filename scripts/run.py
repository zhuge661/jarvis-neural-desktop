"""Run the clean web application from source; state always stays outside the repo."""
import argparse
import os
from pathlib import Path
import sys
import threading
import webbrowser

ROOT=Path(__file__).resolve().parents[1]
def main():
    parser=argparse.ArgumentParser();parser.add_argument('--no-browser',action='store_true');parser.add_argument('--port',type=int,default=47671)
    args=parser.parse_args()
    if sys.platform=='darwin':default=Path.home()/'Library/Application Support/JarvisClean-dev'
    elif os.name=='nt':default=Path(os.environ.get('LOCALAPPDATA',str(Path.home())))/'JarvisClean-dev'
    else:default=Path(os.environ.get('XDG_DATA_HOME',str(Path.home()/'.local/share')))/'JarvisClean-dev'
    user_root=Path(os.environ.get('JARVIS_USER_ROOT',str(default))).resolve()
    if user_root.is_relative_to(ROOT):raise SystemExit('用户数据目录必须位于源码仓库之外。')
    user_root.mkdir(parents=True,exist_ok=True,mode=0o700)
    os.environ.update(JARVIS_USER_ROOT=str(user_root),JARVIS_DATA_DIR=str(user_root/'data'),JARVIS_PORT=str(args.port),JARVIS_AUTOMEM='0')
    sys.dont_write_bytecode=True
    sys.path.insert(0,str(ROOT/'app/backend/JARVIS-main/core'))
    import server
    if not args.no_browser:
        timer=threading.Timer(1.5,lambda:webbrowser.open(f'http://127.0.0.1:{args.port}/'))
        timer.daemon=True;timer.start()
    server.main()
if __name__=='__main__':main()

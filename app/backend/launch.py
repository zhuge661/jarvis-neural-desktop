import os
from pathlib import Path
import sys
import threading
os.environ.setdefault('JARVIS_AUTOMEM','0')
sys.path.insert(0,str(Path(__file__).resolve().parent/'JARVIS-main/core'))
import server
stopping=threading.Event()
def owner():
    for line in sys.stdin:
        if line.strip()=='stop':break
    stopping.set()
threading.Thread(target=owner,daemon=True).start()
server.main(stop_event=stopping)

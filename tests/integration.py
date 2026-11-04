"""Test the clean portable backend/UI with local fixtures and no real API calls."""
from functools import partial
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from io import BytesIO
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import threading
import urllib.request
import sys

from playwright.sync_api import sync_playwright

WORK=Path(__file__).resolve().parents[1]
CORE=WORK/'app/backend/JARVIS-main/core'
(WORK/'test-results').mkdir(exist_ok=True)
requests=[]

class MockProvider(BaseHTTPRequestHandler):
    def log_message(self,*args):pass
    def do_POST(self):
        payload=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        requests.append({'path':self.path,'payload':payload,'headers':dict(self.headers)})
        self.send_response(200);self.send_header('Content-Type','text/event-stream');self.end_headers()
        route=self.path
        if route.endswith('/chat/completions'):body='data: '+json.dumps({'choices':[{'delta':{'content':'本机接口正常'}}]})+'\n\ndata: [DONE]\n\n'
        elif route.endswith('/responses'):body='data: '+json.dumps({'type':'response.output_text.delta','delta':'本机接口正常'})+'\n\n'
        elif route.endswith('/messages'):body='data: '+json.dumps({'type':'content_block_delta','delta':{'type':'text_delta','text':'本机接口正常'}})+'\n\n'
        elif 'streamGenerateContent' in route:body='data: '+json.dumps({'candidates':[{'content':{'parts':[{'text':'本机接口正常'}]}}]})+'\n\n'
        else:body=json.dumps({'message':{'content':'本机接口正常'},'done':True})+'\n'
        self.wfile.write(body.encode())

def read(url):
    with urllib.request.urlopen(url,timeout=10) as response:return json.load(response)

def post(url,value):
    request=urllib.request.Request(url,data=json.dumps(value).encode(),headers={'Content-Type':'application/json','Origin':url.split('/api/')[0]})
    with urllib.request.urlopen(request,timeout=10) as response:return response.read().decode()

with tempfile.TemporaryDirectory() as temporary:
    testRoot=Path(temporary)
    os.environ.update(JARVIS_USER_ROOT=str(testRoot/'private'),JARVIS_DATA_DIR=str(testRoot/'private/data'),JARVIS_AUTOMEM='0')
    # Test-only Windows dependencies. Never copied into the Mac distribution.
    sys.path.insert(0,str(CORE))
    import server
    import openclaw_backend as adapter
    import realtime_voice
    httpd=ThreadingHTTPServer(('127.0.0.1',0),partial(server.JarvisHandler,directory=server.UI_DIR))
    server.PORT=httpd.server_port
    threading.Thread(target=httpd.serve_forever,daemon=True).start()
    base=f'http://127.0.0.1:{httpd.server_port}'
    mock=ThreadingHTTPServer(('127.0.0.1',0),MockProvider)
    threading.Thread(target=mock.serve_forever,daemon=True).start()
    try:
        health=read(base+'/api/health')
        assert health['provider']=='mac-direct' and not health['configured']
        assert health['memories']==health['reminders']==0
        assert read(base+'/api/knowledge/graph')['nodes']==[]
        assert not read(base+'/api/voice/realtime/config')['configured']
        assert not adapter.SETTINGS.exists()
        for protocol in adapter.PROTOCOLS:
            adapter.save_settings({'profile_id':'default','name':'Local test fixture','api':protocol,
                'base_url':f'http://127.0.0.1:{mock.server_port}/v1','model':'fixture-model',
                'api_key':'FAKE-ONLY-FOR-LOCAL-TESTS','no_auth':False,'context_window':128000,'max_tokens':64})
            answer=post(base+'/api/chat',{'message':'本机测试','conversation':'test','history':[{'role':'user','content':'上文问题'},{'role':'assistant','content':'上文回答'}]})
            assert answer=='本机接口正常',(protocol,answer)
            assert '上文问题' in json.dumps(requests[-1]['payload'],ensure_ascii=False)
            assert 'FAKE-ONLY' not in json.dumps(adapter.public_status())
        assert len(requests)==5
        assert adapter.safe_error('error FAKE-ONLY-FOR-LOCAL-TESTS')=='error [已隐藏]'
        adapter.SETTINGS.unlink()  # Only the temporary fixture, never recipient data.
        with sync_playwright() as p:
            profile=str(testRoot/'browser')
            context=p.chromium.launch_persistent_context(profile,headless=True,viewport={'width':1440,'height':900})
            page=context.new_page();errors=[]
            page.on('pageerror',lambda error:errors.append(str(error)))
            page.route('https://**',lambda route:route.abort())
            page.goto(base+'/?desktop=1',wait_until='networkidle')
            page.wait_for_function('''() => {try{return getComputedStyle(document.getElementById("hud")).opacity==="1" && window.NeuralImports && window.Knowledge && window.Hologram && Knowledge.snapshot().count===0 && Hologram.visualSnapshot().calls>=6;}catch{return false;}}''')
            assert page.evaluate('NeuralImports.snapshot().count')==0
            assert page.evaluate('getComputedStyle(document.documentElement).getPropertyValue("--cyan").trim()')=='#ffc861'
            assert '待配置模型' in page.locator('#brain-state').inner_text()
            assert page.locator('#reply-panel').is_visible()
            page.screenshot(path=str(WORK/'test-results/first-run.png'))
            # Same photo/document node behavior with isolated, newly selected files.
            text=testRoot/'new-document.txt';text.write_text('这是一份新用户本机导入的测试资料。',encoding='utf-8')
            photo=testRoot/'new-photo.png'
            from PIL import Image
            Image.new('RGB',(32,32),(60,150,240)).save(photo)
            page.set_input_files('#import-docs-input',str(text))
            page.wait_for_function('NeuralImports.snapshot().count===1 && !NeuralImports.snapshot().busy')
            page.set_input_files('#import-photos-input',str(photo))
            page.wait_for_function('NeuralImports.snapshot().count===2 && Knowledge.snapshot().count===2')
            assert page.evaluate('typeof NetworkPhotos')=='undefined'
            page.locator('.import-open').filter(has_text='new-photo.png').click()
            page.wait_for_function('document.querySelector("#knowledge-attachment img")?.naturalWidth===32')
            assert not errors,errors
            context.close()
            reopened=p.chromium.launch_persistent_context(profile,headless=True)
            page=reopened.new_page();page.route('https://**',lambda route:route.abort())
            page.goto(base+'/?desktop=1',wait_until='networkidle')
            page.wait_for_function('window.NeuralImports && window.Knowledge && NeuralImports.snapshot().count===2 && Knowledge.snapshot().count===2')
            reopened.close()
        report={'freshModelConfigured':False,'freshVoiceConfigured':False,'freshKnowledgeNodes':0,
            'freshImports':0,'freshMemories':0,'freshReminders':0,'localProtocolTests':5,
            'importAndBrowserRestart':'pass','uiErrors':errors,'actualCloudRequests':0,
            'nativeDesktopLaunchTested':False}
        (WORK/'test-results/functional.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
        print(json.dumps(report,ensure_ascii=False))
    finally:httpd.shutdown();mock.shutdown()

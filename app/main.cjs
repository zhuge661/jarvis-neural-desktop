"use strict";
const {app,BrowserWindow,Menu,dialog,session,shell} = require('electron');
const {spawn} = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const http = require('node:http');
app.setName('贾维斯');
const PROFILE=path.join(app.getPath('appData'),'JarvisClean');
fs.mkdirSync(PROFILE,{recursive:true,mode:0o700});
app.setPath('userData',PROFILE);
const ROOT=path.join(__dirname,'backend');
const PYTHON=path.join(__dirname,'python','bin','python3');
let window,backend,log,quitting=false,BASE='';
const local=url=>{try{return new URL(url).origin===BASE;}catch{return false;}};
function freePort(){return new Promise((resolve,reject)=>{
  const server=net.createServer();server.once('error',reject);
  // Keep the localhost origin stable so IndexedDB photos survive app restarts.
  server.listen(47671,'127.0.0.1',()=>{const port=server.address().port;server.close(error=>error?reject(error):resolve(port));});
});}
function get(url){return new Promise((resolve,reject)=>{
  const req=http.get(url,res=>{let body='';res.setEncoding('utf8');res.on('data',chunk=>body+=chunk);res.on('end',()=>resolve({status:res.statusCode,body}));});
  req.setTimeout(1500,()=>req.destroy(new Error('本机服务响应超时')));req.on('error',reject);
});}
async function startBackend(){
  const port=await freePort();BASE=`http://127.0.0.1:${port}`;
  fs.mkdirSync(PROFILE,{recursive:true,mode:0o700});
  const userRoot=path.join(PROFILE,'backend');
  fs.mkdirSync(userRoot,{recursive:true,mode:0o700});
  log=fs.createWriteStream(path.join(PROFILE,'backend.log'),{flags:'a',mode:0o600});
  const certificates=path.join(__dirname,'python','lib','python3.13','site-packages','certifi','cacert.pem');
  backend=spawn(PYTHON,['-I','-B','-u',path.join(ROOT,'launch.py')],{
    cwd:ROOT,stdio:['pipe','pipe','pipe'],
    env:{HOME:os.homedir(),TMPDIR:os.tmpdir(),PATH:'/usr/bin:/bin:/usr/sbin:/sbin',LANG:'en_US.UTF-8',
      JARVIS_PORT:String(port),JARVIS_USER_ROOT:userRoot,JARVIS_DATA_DIR:path.join(userRoot,'data'),
      JARVIS_AUTOMEM:'0',SSL_CERT_FILE:certificates,REQUESTS_CA_BUNDLE:certificates},
  });
  backend.stdout.pipe(log,{end:false});backend.stderr.pipe(log,{end:false});
  backend.stdin.on('error',()=>{});
  let launchError;backend.on('error',error=>launchError=error);
  for(let i=0;i<100;i++){
    if(launchError)throw launchError;
    if(backend.exitCode!==null)throw new Error('本机服务启动失败，日志位于 ~/Library/Application Support/JarvisClean/backend.log');
    try{const response=await get(BASE+'/api/health');if(response.status===200&&JSON.parse(response.body).provider==='mac-direct')return;}catch{}
    await new Promise(resolve=>setTimeout(resolve,200));
  }
  throw new Error('本机服务启动超时，请退出后重开。');
}
async function stopBackend(){
  if(backend&&backend.exitCode===null){
    const owned=backend;try{owned.stdin.end('stop\n');}catch{}
    await Promise.race([new Promise(resolve=>owned.once('exit',resolve)),new Promise(resolve=>setTimeout(resolve,4000))]);
    if(owned.exitCode===null)owned.kill('SIGTERM');
  }
  backend=null;if(log){log.end();log=null;}
}
function permissions(){
  const ses=session.defaultSession;
  ses.setPermissionCheckHandler((contents,permission,origin,details)=>local(origin)&&permission==='media'&&
    (!details.mediaType||['video','audio'].includes(details.mediaType)));
  ses.setPermissionRequestHandler((contents,permission,callback,details)=>callback(
    permission==='media'&&local(details.requestingUrl||contents.getURL())&&
    (details.mediaTypes||[]).every(type=>['video','audio'].includes(type))));
}
async function createWindow(){
  window=new BrowserWindow({title:'贾维斯',width:1440,height:900,minWidth:1050,minHeight:720,
    backgroundColor:'#020b11',show:false,
    webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true,
      spellcheck:false,backgroundThrottling:true,autoplayPolicy:'no-user-gesture-required'}});
  window.on('page-title-updated',event=>event.preventDefault());
  window.on('closed',()=>window=null);
  window.webContents.setWindowOpenHandler(({url})=>{if(/^https:\/\//.test(url))shell.openExternal(url);return {action:'deny'};});
  window.webContents.on('will-navigate',(event,url)=>{if(!local(url)&&!url.startsWith('data:'))event.preventDefault();});
  await window.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent('<html lang="zh-CN"><meta charset="utf-8"><body style="background:#020b11;color:#ffc861;font:20px sans-serif;display:grid;place-items:center;height:90vh"><div>J.A.R.V.I.S<br><small>正在启动本机服务…</small></div></body></html>'));
  window.show();
  if(!backend)await startBackend();
  permissions();
  await window.loadURL(BASE+'/?desktop=1');window.maximize();
  if(process.argv.includes('--smoke-test'))setTimeout(async()=>{
    const destination=process.env.JARVIS_SMOKE_REPORT;
    try{
      const result=await window.webContents.executeJavaScript(`(async()=>{
        for(let i=0;i<120;i++){
          try{if(window.Hologram&&Hologram.visualSnapshot().calls>=6&&window.NeuralImports)break;}catch{}
          await new Promise(resolve=>setTimeout(resolve,100));
        }
        const health=await(await fetch('api/health')).json();
        const voice=await(await fetch('api/voice/realtime/config')).json();
        return {render:Hologram.visualSnapshot(),knowledgeNodes:Knowledge.snapshot().count,
          imports:NeuralImports.snapshot().count,modelConfigured:health.configured,voiceConfigured:voice.configured,
          replies:!!document.getElementById('reply-panel'),theme:getComputedStyle(document.documentElement).getPropertyValue('--cyan').trim()};
      })()`);
      result.platform=process.platform;result.arch=process.arch;result.packaged=app.isPackaged;
      if(!result.render.innerNodes||result.modelConfigured||result.voiceConfigured||result.imports||result.knowledgeNodes||!result.replies)
        throw new Error('桌面启动检查不符合纯净版预期');
      if(destination){fs.mkdirSync(path.dirname(destination),{recursive:true});fs.writeFileSync(destination,JSON.stringify(result,null,2));
        fs.writeFileSync(destination.replace(/\.json$/,'.png'),(await window.webContents.capturePage()).toPNG());}
      app.quit();
    }catch(error){
      if(destination)fs.writeFileSync(destination,JSON.stringify({error:error.message}));
      await stopBackend();app.exit(1);
    }
  },2500);
}
function installMenu(){Menu.setApplicationMenu(Menu.buildFromTemplate([
  {label:'贾维斯',submenu:[{role:'about',label:'关于贾维斯'},{type:'separator'},
    {role:'hide',label:'隐藏贾维斯'},{role:'hideOthers',label:'隐藏其他应用'},{type:'separator'},{role:'quit',label:'退出贾维斯'}]},
  {label:'编辑',submenu:[{role:'undo',label:'撤销'},{role:'redo',label:'重做'},{type:'separator'},
    {role:'cut',label:'剪切'},{role:'copy',label:'复制'},{role:'paste',label:'粘贴'},{role:'selectAll',label:'全选'}]},
  {label:'视图',submenu:[{role:'reload',label:'刷新界面'},{role:'togglefullscreen',label:'全屏'},
    {role:'resetZoom',label:'恢复界面比例'},{role:'zoomIn',label:'放大界面'},{role:'zoomOut',label:'缩小界面'}]},
  {label:'窗口',submenu:[{role:'minimize',label:'最小化'},{role:'zoom',label:'缩放窗口'}]},
]));}
if(!app.requestSingleInstanceLock())app.quit();
else{
  app.on('second-instance',()=>{if(window){if(window.isMinimized())window.restore();window.show();window.focus();}});
  app.whenReady().then(async()=>{installMenu();await createWindow();}).catch(async error=>{dialog.showErrorBox('贾维斯启动失败',error.message);await stopBackend();app.exit(1);});
  app.on('activate',()=>{if(!window)createWindow().catch(error=>dialog.showErrorBox('贾维斯启动失败',error.message));});
  app.on('before-quit',event=>{if(quitting)return;event.preventDefault();quitting=true;stopBackend().finally(()=>app.quit());});
}

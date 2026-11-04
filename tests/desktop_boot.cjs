"use strict";
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const vm=require('node:vm');
const testRoot=fs.mkdtempSync(path.join(os.tmpdir(),'jarvis-mac-boot-'));
let readyHandler,menuCreated=false,profile;
const app={setName(){},getPath(name){assert.equal(name,'appData');return testRoot;},
  setPath(name,value){assert.equal(name,'userData');assert.ok(fs.statSync(value).isDirectory());profile=value;},
  requestSingleInstanceLock(){return true;},on(){},whenReady(){return {then(fn){readyHandler=fn;return {catch(){}};}};}};
const electron={app,Menu:{buildFromTemplate(){menuCreated=true;},setApplicationMenu(){}},session:{},shell:{},dialog:{}};
const sandbox={require(name){return name==='electron'?electron:require(name);},__dirname:__dirname,process,console,setTimeout};
vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../app/main.cjs'),'utf8'),sandbox);
assert.ok(profile&&readyHandler);
assert.equal(menuCreated,false,'native menu must wait for app readiness');
assert.equal(path.basename(profile),'JarvisClean');
console.log('Fresh profile directory exists before app.setPath; native menu defers until ready: PASS');

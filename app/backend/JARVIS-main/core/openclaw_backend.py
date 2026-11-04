"""Independent Mac API adapter. Never reads global OpenClaw or environment keys."""
import json
import os
from pathlib import Path
import secrets
import threading
import urllib.request
from urllib.parse import quote, urlsplit

RUNTIME=Path(os.environ['JARVIS_USER_ROOT'])
SETTINGS=RUNTIME/'model-connections.json'
GATEWAY_URL='本机 API 直连'
MODELS=()
PROTOCOLS={
    'openai-completions':'OpenAI 兼容 · Chat Completions',
    'openai-responses':'OpenAI 兼容 · Responses',
    'anthropic-messages':'Anthropic 兼容 · Messages',
    'google-generative-ai':'Gemini · Generate Content',
    'ollama':'Ollama 原生',
}
_lock=threading.RLock()
_starting=False

def _read_settings():
    if SETTINGS.exists(): return json.loads(SETTINGS.read_text(encoding='utf-8'))
    return {'profiles':[{'id':'default','name':'我的模型','api':'openai-completions',
        'base_url':'','model':'','api_key':'','no_auth':False,'context_window':128000,'max_tokens':8192}],
        'active_profile':'default'}

def _active(settings):
    return next(profile for profile in settings['profiles'] if profile['id']==settings['active_profile'])

def _configured(profile):
    return bool(profile['model'] and profile['base_url'] and (profile['api_key'] or profile['no_auth']))

def _write_private(path,value):
    path.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
    temporary=path.with_suffix('.tmp')
    fd=os.open(temporary,os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600)
    with os.fdopen(fd,'w',encoding='utf-8') as out: json.dump(value,out,ensure_ascii=False,indent=2)
    os.replace(temporary,path)

def start(): pass
def stop(): pass
def restart_async(): pass

def public_status():
    settings=_read_settings();active=_active(settings);ready=_configured(active)
    fields=('id','name','api','base_url','model','no_auth','context_window','max_tokens')
    return {'provider':'mac-direct','model':active['model'],'connection_name':active['name'],
        'active_profile':active['id'],'profiles':[{**{key:p[key] for key in fields},'key_saved':bool(p['api_key'])} for p in settings['profiles']],
        'protocols':PROTOCOLS,'configured':ready,'gateway_ready':ready,'gateway_running':True,
        'ok':ready,'model_installed':ready,'models':[active['model']] if ready else [],'starting':False,
        'error':'' if ready else '请点击“模型 API 设置”，填写你自己的连接信息。'}

# save_settings is appended from the locked Windows source by prepare_source.py.

def chat_request(messages,conversation):
    active=_active(_read_settings())
    if not _configured(active):raise ValueError('请先点击“模型 API 设置”完成连接。')
    protocol=active['api'];base=active['base_url'];key=active['api_key'];model=active['model']
    headers={'Content-Type':'application/json','Accept':'text/event-stream'}
    if key and not active['no_auth']:headers['Authorization']='Bearer '+key
    limit=active['max_tokens']
    if protocol=='openai-completions':
        endpoint=base+'/chat/completions';payload={'model':model,'messages':messages,'stream':True,'max_tokens':limit}
    elif protocol=='openai-responses':
        endpoint=base+'/responses';payload={'model':model,'input':messages,'stream':True,'max_output_tokens':limit}
    elif protocol=='anthropic-messages':
        headers.pop('Authorization',None)
        if key and not active['no_auth']:headers['x-api-key']=key
        headers['anthropic-version']='2023-06-01';endpoint=base+'/messages'
        payload={'model':model,'system':'\n'.join(m['content'] for m in messages if m['role']=='system'),
            'messages':[m for m in messages if m['role']!='system'],'stream':True,'max_tokens':limit}
    elif protocol=='google-generative-ai':
        headers.pop('Authorization',None)
        if key and not active['no_auth']:headers['x-goog-api-key']=key
        endpoint=base+'/models/'+quote(model.removeprefix('models/'),safe='')+':streamGenerateContent?alt=sse'
        payload={'systemInstruction':{'parts':[{'text':'\n'.join(m['content'] for m in messages if m['role']=='system')}]},
            'contents':[{'role':'model' if m['role']=='assistant' else 'user','parts':[{'text':m['content']}]} for m in messages if m['role']!='system'],
            'generationConfig':{'maxOutputTokens':limit}}
    elif protocol=='ollama':
        endpoint=base+'/api/chat';payload={'model':model,'messages':messages,'stream':True,'options':{'num_predict':limit}}
    else: raise ValueError('不支持的 API 协议。')
    return urllib.request.Request(endpoint,data=json.dumps(payload,ensure_ascii=False).encode(),headers=headers)

def iter_content(stream):
    for raw in stream:
        line=raw.decode('utf-8').strip()
        if not line or line.startswith(('event:',':','id:')):continue
        if line.startswith('data:'):line=line[5:].strip()
        if line=='[DONE]':return
        try:item=json.loads(line)
        except json.JSONDecodeError:continue
        if not isinstance(item,dict):continue
        if item.get('error'):
            error=item['error'];message=error.get('message','模型服务返回错误') if isinstance(error,dict) else str(error)
            raise RuntimeError(safe_error(message))
        for choice in item.get('choices',[]):
            text=choice.get('delta',{}).get('content')
            if isinstance(text,str):yield text
        if item.get('type')=='response.output_text.delta':
            if isinstance(item.get('delta'),str):yield item['delta']
        if item.get('type')=='content_block_delta':
            text=item.get('delta',{}).get('text')
            if isinstance(text,str):yield text
        for candidate in item.get('candidates',[]):
            for part in candidate.get('content',{}).get('parts',[]):
                if isinstance(part.get('text'),str) and not part.get('thought'):yield part['text']
        text=item.get('message',{}).get('content')
        if isinstance(text,str):yield text

def safe_error(message):
    text=str(message)
    for profile in _read_settings()['profiles']:
        if profile.get('api_key'):text=text.replace(profile['api_key'],'[已隐藏]')
    return text[:800]


def save_settings(data):
    if not isinstance(data, dict):
        raise ValueError("配置格式不正确。")
    key = data.get("api_key")
    if key is not None and (not isinstance(key, str) or len(key) > 1024 or any(c.isspace() for c in key.strip())):
        raise ValueError("API Key 格式不正确，请重新粘贴。")
    with _lock:
        if _starting:
            raise ValueError("正在切换连接，请稍等片刻再保存。")
        settings = _read_settings()
        profile_id = data.get("profile_id", settings["active_profile"])
        if not isinstance(profile_id, str):
            raise ValueError("连接编号不正确。")
        previous = next((p for p in settings["profiles"] if p["id"] == profile_id), None)
        if profile_id != "new" and previous is None:
            raise ValueError("未找到该连接，请重新打开设置。")
        if previous is None and len(settings["profiles"]) >= 50:
            raise ValueError("最多保存 50 个连接。")
        profile = dict(previous or {"id": "custom-" + secrets.token_hex(6), "api_key": "",
            "name": "自定义连接", "api": "openai-completions", "base_url": "", "model": "",
            "no_auth": False, "context_window": 128000, "max_tokens": 8192})
        for field in ("name", "model", "api", "base_url"):
            value = data.get(field, profile[field])
            if not isinstance(value, str) or not value.strip() or len(value) > (2048 if field == "base_url" else 256):
                raise ValueError("请填写有效的连接名称、模型名、协议和 API 地址。")
            profile[field] = value.strip()
        if profile["api"] not in PROTOCOLS:
            raise ValueError("请选择已支持的接口协议；专有协议需要添加适配器。")
        if any(c.isspace() or ord(c) < 32 for c in profile["model"]):
            raise ValueError("模型 ID 不能包含空白字符。")
        try:
            url = urlsplit(profile["base_url"])
            if url.scheme not in ("http", "https") or not url.hostname or url.username or url.password or url.query or url.fragment:
                raise ValueError
            _ = url.port
        except ValueError:
            raise ValueError("API 地址须为 http/https 基础地址，不包含账号、密码或查询参数。") from None
        if any(c.isspace() for c in profile["base_url"]):
            raise ValueError("API 地址不能包含空白字符。")
        profile["base_url"] = profile["base_url"].rstrip("/")
        no_auth = data.get("no_auth", profile["no_auth"])
        if not isinstance(no_auth, bool):
            raise ValueError("无需 Key 选项格式不正确。")
        profile["no_auth"] = no_auth
        for field, minimum, maximum in (("context_window", 16000, 10000000), ("max_tokens", 1, 1000000)):
            value = data.get(field, profile[field])
            if type(value) is not int or not minimum <= value <= maximum:
                raise ValueError("上下文长度至少 16000，输出长度须为正整数。")
            profile[field] = value
        if profile["max_tokens"] > profile["context_window"]:
            raise ValueError("最大输出长度不能超过上下文长度。")
        endpoint_changed = previous and (previous["base_url"], previous["api"]) != (profile["base_url"], profile["api"])
        if endpoint_changed or no_auth:
            profile["api_key"] = ""
        if key and key.strip():
            if not no_auth:
                profile["api_key"] = key.strip()
        if not _configured(profile):
            raise ValueError("请填写此连接的 API Key；更换地址或协议后须重新填写，避免误用旧 Key。")
        settings["profiles"] = [profile if p["id"] == profile["id"] else p for p in settings["profiles"]]
        if previous is None:
            settings["profiles"].append(profile)
        settings["active_profile"] = profile["id"]
        _write_private(SETTINGS, settings)
    restart_async()
    return {"ok": True, "message": "已保存到本机。发送一条消息即可验证当前 API 连接。"}

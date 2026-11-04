/* User-selected local files only. Persist copies in this app's IndexedDB. */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const PHOTO = /\.(png|jpe?g|webp|gif|bmp|avif)$/i;
  const TEXT = /\.(txt|md|csv|json)$/i;
  const MAX_FILE = 20 * 1024 * 1024, MAX_TOTAL = 256 * 1024 * 1024, MAX_COUNT = 200;
  let records = [], database, busy = false;
  const status = text => { $('import-status').textContent = text; };
  const ready = new Promise((resolve, reject) => {
    const request = indexedDB.open('jarvis-neural-imports-v1', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('files', { keyPath: 'id' });
    request.onsuccess = () => { database = request.result; resolve(); };
    request.onerror = () => reject(new Error('本机资料存储无法打开，请检查磁盘空间。'));
  });
  async function transaction(mode, work) {
    await ready;
    return new Promise((resolve, reject) => {
      const tx = database.transaction('files', mode), request = work(tx.objectStore('files'));
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = tx.onabort = () => reject(new Error('保存失败，请检查本机存储空间。'));
    });
  }
  const list = () => transaction('readonly', store => store.getAll());
  const get = id => transaction('readonly', store => store.get(id));
  const hash = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))).map(v => v.toString(16).padStart(2, '0')).join('');

  async function inflate(bytes, expected) {
    const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
    let size = 0; const chunks = [];
    try {
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.length;
        if (size > 12 * 1024 * 1024) { await reader.cancel(); throw new Error('Word 正文过大，请拆分后导入。'); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    if (size !== expected) throw new Error('Word 文件不完整。');
    return new Blob(chunks).text();
  }
  async function wordText(buffer) {
    const view = new DataView(buffer), bytes = new Uint8Array(buffer);
    let end = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) if (view.getUint32(i, true) === 0x06054b50) { end = i; break; }
    if (end < 0) throw new Error('无法读取 Word，请使用 .docx 格式。');
    const count = view.getUint16(end + 10, true); let at = view.getUint32(end + 16, true);
    if (count > 10000 || at >= end) throw new Error('Word 文件结构异常。');
    for (let i = 0; i < count; i++) {
      if (at + 46 > end || view.getUint32(at, true) !== 0x02014b50) throw new Error('Word 文件目录损坏。');
      const flags = view.getUint16(at + 8, true), method = view.getUint16(at + 10, true);
      const compressed = view.getUint32(at + 20, true), plain = view.getUint32(at + 24, true);
      const nameLength = view.getUint16(at + 28, true), extra = view.getUint16(at + 30, true), comment = view.getUint16(at + 32, true);
      const local = view.getUint32(at + 42, true), next = at + 46 + nameLength + extra + comment;
      if (next > end) throw new Error('Word 文件目录不完整。');
      const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLength));
      if (name === 'word/document.xml') {
        if (flags & 1) throw new Error('请先取消 Word 密码保护。');
        if (plain > 12 * 1024 * 1024 || local + 30 > at || view.getUint32(local, true) !== 0x04034b50) throw new Error('Word 正文过大或文件损坏。');
        const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
        if (start + compressed > at) throw new Error('Word 文件不完整。');
        const payload = bytes.subarray(start, start + compressed);
        const xml = method === 0 ? new TextDecoder().decode(payload) : method === 8 ? await inflate(payload, plain) : null;
        if (xml === null) throw new Error('暂不支持此 Word 压缩方式。');
        if (/<!DOCTYPE/i.test(xml)) throw new Error('Word 文件格式异常。');
        const doc = new DOMParser().parseFromString(xml, 'application/xml');
        if (doc.querySelector('parsererror')) throw new Error('Word 正文损坏。');
        const ns = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
        return Array.from(doc.getElementsByTagNameNS(ns, 'p')).map(p => Array.from(p.getElementsByTagNameNS(ns, 't')).map(t => t.textContent).join('')).join('\n');
      }
      at = next;
    }
    throw new Error('Word 文件没有可读取的正文。');
  }
  async function prepare(file) {
    if (!file.size) throw new Error('文件为空。');
    if (file.size > MAX_FILE) throw new Error('单个文件请控制在 20 MB 以内。');
    const image = PHOTO.test(file.name), pdf = /\.pdf$/i.test(file.name), word = /\.docx$/i.test(file.name);
    if (!image && !pdf && !word && !TEXT.test(file.name)) throw new Error('支持 Word(.docx)、PDF、TXT、Markdown、CSV、JSON 和常见照片。');
    const buffer = await file.arrayBuffer(); let content = '', type = file.type;
    if (image) {
      const mime = { jpg:'image/jpeg',jpeg:'image/jpeg',png:'image/png',webp:'image/webp',gif:'image/gif',bmp:'image/bmp',avif:'image/avif' };
      type = mime[file.name.split('.').pop().toLowerCase()];
      let bitmap;
      try { bitmap = await createImageBitmap(new Blob([buffer], { type })); }
      catch (_) { throw new Error('照片无法读取，请检查文件是否损坏。'); }
      const pixels = bitmap.width * bitmap.height; bitmap.close();
      if (pixels > 100000000) throw new Error('照片尺寸过大，请缩小后导入。');
    } else if (pdf) {
      if (new TextDecoder().decode(buffer.slice(0, 5)) !== '%PDF-') throw new Error('不是有效的 PDF 文件。');
      type = 'application/pdf'; content = 'PDF 文档，可在下方预览原文。';
    } else if (word) content = await wordText(buffer);
    else {
      if (buffer.byteLength > 2 * 1024 * 1024) throw new Error('纯文本文档请控制在 2 MB 以内。');
      try { content = new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
      catch (_) { content = new TextDecoder('gb18030').decode(buffer); }
      if (content.includes('\0')) throw new Error('这不是可读取的文本文件。');
    }
    if (!image && !pdf && !content.trim()) throw new Error('文档没有可读取的正文。');
    const digest = await hash(buffer), id = 'import-' + await hash(new TextEncoder().encode(file.name + '\0' + digest));
    return { id, name: file.name, kind: image ? 'image' : pdf ? 'pdf' : 'text',
      content, blob: new Blob([buffer], { type }), size: file.size, added: Date.now() };
  }
  function render() {
    const host = $('import-list'); host.replaceChildren();
    records.slice().sort((a,b) => b.added - a.added).forEach(record => {
      const row = document.createElement('div'); row.className = 'import-item';
      const open = document.createElement('button'); open.type = 'button'; open.className = 'import-open';
      open.textContent = (record.kind === 'image' ? '▧ ' : '▤ ') + record.name; open.title = record.name;
      open.onclick = () => window.Knowledge?.openById(record.id);
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'import-remove'; remove.textContent = '×';
      remove.setAttribute('aria-label', '移出神经网络：' + record.name); remove.title = '移出神经网络，原文件不变';
      remove.onclick = () => erase(record.id).catch(error => status(error.message));
      row.append(open, remove); host.append(row);
    });
  }
  async function refresh() { records = await list(); render(); return records; }
  const changed = () => window.dispatchEvent(new CustomEvent('jarvis-imports-changed'));
  async function importFiles(files) {
    if (busy) return;
    busy = true; const errors = []; let added = 0, duplicate = 0;
    $('btn-import-docs').disabled = $('btn-import-photos').disabled = true;
    try {
      await refresh(); let total = records.reduce((sum,r) => sum + r.size, 0);
      for (const file of Array.from(files)) {
        status('正在导入：' + file.name);
        try {
          const record = await prepare(file);
          if (records.some(r => r.id === record.id)) { duplicate++; continue; }
          if (records.length >= MAX_COUNT || total + record.size > MAX_TOTAL) throw new Error('本机资料区已满，请先移出部分资料。');
          await transaction('readwrite', store => store.put(record)); records.push(record); total += record.size; added++;
        } catch (error) { errors.push(file.name + '：' + error.message); }
      }
      render(); if (added) changed();
      status(`已保存 ${records.length} 份资料` + (added ? ` · 新增 ${added} 份` : '') + (duplicate ? ` · ${duplicate} 份已存在` : '') + (errors.length ? '\n' + errors.join('\n') : ' · 点击文件名或网络节点查看'));
      if (added) HUD.log('资料已加入神经网络：' + added + ' 份');
    } catch (error) { errors.push(error.message); status(error.message); }
    finally { busy = false; $('btn-import-docs').disabled = $('btn-import-photos').disabled = false; }
    return { added, duplicate, errors };
  }
  async function erase(id) {
    if (busy) return;
    await transaction('readwrite', store => store.delete(id)); await refresh(); changed();
    status(`已保存 ${records.length} 份资料 · 移出的原文件不变`);
  }
  async function graph() {
    await refresh();
    return records.map(record => ({ id:record.id, title:record.name, path:'导入资料/' + record.name,
      folder:record.kind === 'image' ? '导入照片' : '导入文档', source:'import', kind:record.kind,
      bytes:record.size, hasContent:true }));
  }
  async function read(id) {
    const record = await get(id); if (!record) throw new Error('资料已移出，请刷新知识库。');
    return { id:record.id, title:record.name, content:record.content, kind:record.kind, blob:record.blob, hasContent:true };
  }
  function positionRight() {
    const footer = $('hud-bottom').getBoundingClientRect();
    $('hud-right').style.bottom = Math.max(12, innerHeight - footer.top + 16) + 'px';
  }
  function init() {
    for (const [button,input] of [['btn-import-docs','import-docs-input'],['btn-import-photos','import-photos-input']]) $(button).onclick = () => $(input).click();
    for (const id of ['import-docs-input','import-photos-input','import-any-input']) $(id).onchange = async event => { const input = event.target; await importFiles(input.files); input.value = ''; };
    const drop = $('import-drop'); drop.onclick = () => $('import-any-input').click();
    drop.onkeydown = e => { if (['Enter',' '].includes(e.key)) { e.preventDefault(); drop.click(); } };
    for (const event of ['dragenter','dragover']) drop.addEventListener(event, e => { e.preventDefault(); drop.classList.add('dragover'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('dragover'));
    drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('dragover'); importFiles(e.dataTransfer.files); });
    // Never navigate away when a file misses the drop zone.
    window.addEventListener('dragover', e => { if (e.dataTransfer?.types.includes('Files')) e.preventDefault(); });
    window.addEventListener('drop', e => { if (e.dataTransfer?.types.includes('Files')) e.preventDefault(); });
    new ResizeObserver(positionRight).observe($('hud-bottom')); window.addEventListener('resize', positionRight); positionRight();
    refresh().then(() => { if (records.length) status(`已保存 ${records.length} 份资料 · 点击网络节点查看`); }).catch(error => status(error.message));
  }
  window.NeuralImports = { graph, read, importFiles, erase, snapshot: () => ({ count:records.length, busy, names:records.map(r=>r.name) }) };
  init();
})();

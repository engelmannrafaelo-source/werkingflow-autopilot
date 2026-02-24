import { readFileSync as _readEnvFile, existsSync as _envExists } from 'fs';
// Load .env from CUI root (manual dotenv — fixed absolute path, always runs before const init)
const _envPath = '/root/projekte/werkingflow/autopilot/cui/.env';
if (_envExists(_envPath)) {
  const _lines = _readEnvFile(_envPath, 'utf8').split('\n');
  for (const _line of _lines) {
    const _trimmed = _line.trim();
    if (!_trimmed || _trimmed.startsWith('#')) continue;
    const _eq = _trimmed.indexOf('=');
    if (_eq < 1) continue;
    const _key = _trimmed.slice(0, _eq).trim();
    const _val = _trimmed.slice(_eq + 1).trim();
    // Always set from .env (override empty/missing, but not if already explicitly set via env)
    if (!process.env[_key]) process.env[_key] = _val;
  }
}
// Debug: verify secret loaded (only log presence, not value)
console.log('[.env] WERKING_REPORT_ADMIN_SECRET:', process.env.WERKING_REPORT_ADMIN_SECRET ? `set (${process.env.WERKING_REPORT_ADMIN_SECRET.length} chars)` : 'MISSING');

import express from 'express';
import { createServer, request as httpRequest, IncomingMessage, ServerResponse } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { resolve, extname, relative, join } from 'path';
import { readFileSync, readdirSync, statSync, existsSync, mkdirSync, writeFileSync, unlinkSync, rmSync, copyFileSync } from "fs";
import { homedir } from 'os';
import { watch } from 'chokidar';
import mime from 'mime-types';
import httpProxy from 'http-proxy';
import documentManager, { registerWebSocketClient } from './document-manager.js';

const PORT = parseInt(process.env.PORT ?? '4005', 10);
const PROD = process.env.NODE_ENV === 'production';

// --- CUI Reverse Proxies ---
// Each CUI account gets a local proxy port so iframes load same-origin (no cookie issues)
const CUI_PROXIES: Array<{id: string; localPort: number; target: string}> = [
  { id: 'rafael', localPort: 5001, target: 'http://localhost:4001' },
  { id: 'engelmann', localPort: 5002, target: 'http://localhost:4002' },
  { id: 'office', localPort: 5003, target: 'http://localhost:4003' },
  { id: 'local', localPort: 5004, target: 'http://localhost:4004' },
];

// SSE proxy: blocks data relay to browser (no continuous streaming).
// Still connects upstream to detect attention markers (plan/question/done).
// Browser gets an open SSE connection with heartbeat comments only.
function sseProxy(targetBase: string, req: IncomingMessage, res: ServerResponse, cuiId?: string) {
  const streamId = req.url!.split('/api/stream/')[1]?.slice(0, 8) ?? '?';
  console.log(`[SSE] → Monitor-only ${streamId} (${cuiId || 'no-id'})`);
  const url = new URL(req.url!, targetBase);
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (v && typeof v === 'string') headers[k] = v;
  }
  headers.host = url.host;
  delete headers['accept-encoding'];

  // Send SSE headers to browser but NO data — just heartbeat to keep alive
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Credentials': 'true',
  });
  res.write(':ok\n\n'); // Initial comment to confirm connection
  const heartbeat = setInterval(() => { res.write(':\n\n'); }, 30000);

  // Connect to upstream SSE silently — only for attention detection
  const proxyReq = httpRequest(url, { method: req.method, headers }, (proxyRes) => {
    let chunkCount = 0;

    proxyRes.on('data', (chunk: Buffer) => {
      chunkCount++;
      // Detect attention markers (plan/question/done) — no data relay
      if (cuiId) {
        const text = chunk.toString();
        const attention = detectAttentionMarkers(text);
        if (attention) {
          console.log(`[SSE] ${streamId} attention: ${attention.state}/${attention.reason ?? '-'}`);
          if (attention.state === 'idle') {
            broadcast({ type: 'cui-state', cuiId, state: 'done' });
            broadcast({ type: 'cui-response-ready', cuiId });
            setSessionState(cuiId, cuiId, 'idle', 'done');
          } else {
            setSessionState(cuiId, cuiId, attention.state, attention.reason);
          }
        }
      }
    });

    proxyRes.on('end', () => {
      clearInterval(heartbeat);
      console.log(`[SSE] End ${streamId} (${chunkCount} chunks monitored)`);
      if (cuiId && chunkCount > 0) {
        broadcast({ type: 'cui-state', cuiId, state: 'done' });
        broadcast({ type: 'cui-response-ready', cuiId });
        const current = sessionStates.get(cuiId);
        if (!current || current.state !== 'needs_attention') {
          setSessionState(cuiId, cuiId, 'idle', 'done');
        }
      }
      res.end();
    });
  });

  proxyReq.on('error', (err) => {
    clearInterval(heartbeat);
    console.error(`[SSE] ✗ Error ${streamId}:`, err.message);
    if (cuiId) broadcast({ type: 'cui-state', cuiId, state: 'done' });
    res.end();
  });

  req.on('close', () => {
    clearInterval(heartbeat);
    console.log(`[SSE] Client disconnected ${streamId}`);
    proxyReq.destroy();
  });

  proxyReq.end();
}

// --- Auto-Refresh: Monitor CUI streams for response completion ---
function monitorStream(targetBase: string, streamingId: string, cuiId: string, authHeaders: Record<string, string>) {
  const url = new URL(`/api/stream/${streamingId}`, targetBase);
  const headers: Record<string, string> = { 'Accept': 'text/event-stream' };
  if (authHeaders.authorization) headers['Authorization'] = authHeaders.authorization;
  if (authHeaders.cookie) headers['Cookie'] = authHeaders.cookie;

  const monitorReq = httpRequest(url, { method: 'GET', headers }, (monitorRes) => {
    if (monitorRes.statusCode !== 200) {
      // Stream not available — set idle after delay
      setTimeout(() => {
        broadcast({ type: 'cui-state', cuiId, state: 'done' });
        broadcast({ type: 'cui-response-ready', cuiId });
        setSessionState(cuiId, cuiId, 'idle', 'done');
      }, 8000);
      return;
    }
    monitorRes.on('data', (chunk: Buffer) => {
      const attention = detectAttentionMarkers(chunk.toString());
      if (attention) {
        if (attention.state === 'idle') {
          broadcast({ type: 'cui-response-ready', cuiId });
          broadcast({ type: 'cui-state', cuiId, state: 'done' });
          setSessionState(cuiId, cuiId, 'idle', 'done');
          monitorReq.destroy();
        } else {
          console.log(`[Monitor] ${cuiId}: ${attention.reason}`);
          setSessionState(cuiId, cuiId, attention.state, attention.reason);
        }
      }
    });
    monitorRes.on('end', () => {
      broadcast({ type: 'cui-response-ready', cuiId });
      broadcast({ type: 'cui-state', cuiId, state: 'done' });
      setSessionState(cuiId, cuiId, 'idle', 'done');
    });
  });
  monitorReq.on('error', () => {
    // Connection error — set idle after delay
    setTimeout(() => {
      broadcast({ type: 'cui-state', cuiId, state: 'done' });
      broadcast({ type: 'cui-response-ready', cuiId });
      setSessionState(cuiId, cuiId, 'idle', 'done');
    }, 8000);
  });
  monitorReq.end();
  // Safety timeout: if stream hasn't ended in 45s, set idle
  setTimeout(() => {
    const current = sessionStates.get(cuiId);
    if (current?.state === 'working') {
      console.log(`[Monitor] ${cuiId}: 45s timeout, setting idle`);
      broadcast({ type: 'cui-state', cuiId, state: 'done' });
      broadcast({ type: 'cui-response-ready', cuiId });
      setSessionState(cuiId, cuiId, 'idle', 'done');
    }
    monitorReq.destroy();
  }, 45000);
}

// Manual proxy for message POST to capture streamingId for auto-refresh
function messagePostProxy(targetBase: string, cuiId: string, req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url!, targetBase);
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (v && typeof v === 'string') headers[k] = v;
  }
  const authHeaders = { authorization: headers.authorization || '', cookie: headers.cookie || '' };
  headers.host = url.host;

  const bodyChunks: Buffer[] = [];
  req.on('data', (chunk: Buffer) => bodyChunks.push(chunk));
  req.on('end', () => {
    const body = Buffer.concat(bodyChunks);
    const proxyReq = httpRequest(url, { method: 'POST', headers }, (proxyRes) => {
      const resChunks: Buffer[] = [];
      proxyRes.on('data', (chunk: Buffer) => resChunks.push(chunk));
      proxyRes.on('end', () => {
        const responseBody = Buffer.concat(resChunks);
        const resHeaders: Record<string, string | string[] | undefined> = {};
        for (const [k, v] of Object.entries(proxyRes.headers)) {
          if (v) resHeaders[k] = v;
        }
        res.writeHead(proxyRes.statusCode ?? 200, resHeaders);
        res.end(responseBody);

        try {
          const data = JSON.parse(responseBody.toString());
          const streamingId = data.streamingId || data.streaming_id || data.id;
          if (streamingId) {
            console.log(`[${cuiId}] Got streamingId: ${streamingId}, starting monitor`);
            monitorStream(targetBase, streamingId, cuiId, authHeaders);
          } else {
            console.log(`[${cuiId}] No streamingId found, keys:`, Object.keys(data).join(','));
            console.log(`[${cuiId}] Response preview:`, responseBody.toString().slice(0, 300));
            // Fallback: set idle after delay
            setTimeout(() => {
              broadcast({ type: 'cui-state', cuiId, state: 'done' });
              broadcast({ type: 'cui-response-ready', cuiId });
              setSessionState(cuiId, cuiId, 'idle', 'done');
            }, 10000);
          }
        } catch {
          console.log(`[${cuiId}] Non-JSON POST response, fallback broadcast`);
          setTimeout(() => {
            broadcast({ type: 'cui-state', cuiId, state: 'done' });
            broadcast({ type: 'cui-response-ready', cuiId });
            setSessionState(cuiId, cuiId, 'idle', 'done');
          }, 10000);
        }
      });
    });
    proxyReq.on('error', (err) => {
      console.error(`[${cuiId}] Message POST proxy error:`, err.message);
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    proxyReq.write(body);
    proxyReq.end();
  });
}

// Script injected into CUI HTML:
// 1. Reports route changes to parent via postMessage (parent saves in its own localStorage)
// 2. Handles postMessage refresh commands
// 3. Reformats ExitPlanMode/EnterPlanMode JSON blocks into readable markdown
// 4. Enforces workingDirectory from ?cwd= URL parameter
const CUI_INJECT_SCRIPT = `<script>(function(){
  function notifyParent(){
    var p=location.pathname;
    try{window.parent.postMessage({type:'cui-route',pathname:p||'/'},'*');}catch(e){}
  }

  // --- Working Directory Enforcement ---
  var _params=new URLSearchParams(location.search);
  var _cwdParam=_params.get('cwd');
  var _projectParam=_params.get('project');

  // Detect project change: if project param differs from stored project, clear stale session
  var _storedProject=sessionStorage.getItem('cui-project');
  if(_projectParam && _storedProject && _projectParam!==_storedProject){
    console.log('[CUI-inject] Project changed: '+_storedProject+' -> '+_projectParam+', clearing session');
    sessionStorage.clear();
  }
  if(_projectParam) sessionStorage.setItem('cui-project',_projectParam);
  if(_cwdParam) sessionStorage.setItem('cui-forced-cwd',_cwdParam);
  var _forcedCwd=sessionStorage.getItem('cui-forced-cwd');

  // Monkey-patch fetch for cwd enforcement + conversation filtering + working-directories injection
  var _origFetch=window.fetch;
  window.fetch=function(url,opts){
    // POST: inject workingDirectory + projectPath into conversation API calls
    if(_forcedCwd&&opts&&opts.method&&opts.method.toUpperCase()==='POST'&&typeof url==='string'){
      if((url.indexOf('/api/conversations')>-1)&&opts.body){
        try{
          var body=JSON.parse(opts.body);
          if(!body.workingDirectory) body.workingDirectory=_forcedCwd;
          if(!body.projectPath) body.projectPath=_forcedCwd;
          if(!body.cwd) body.cwd=_forcedCwd;
          opts=Object.assign({},opts,{body:JSON.stringify(body)});
        }catch(e){}
      }
    }
    // GET /api/conversations: filter to only show conversations from this workspace
    if(_forcedCwd&&typeof url==='string'&&url.indexOf('/api/conversations')>-1&&(!opts||!opts.method||opts.method.toUpperCase()==='GET')){
      // Only intercept the list endpoint, not /api/conversations/start or /api/conversations/{id}/messages
      var urlPath=url.split('?')[0];
      if(urlPath.endsWith('/api/conversations')||urlPath.endsWith('/api/conversations/')){
        return _origFetch.call(this,url,opts).then(function(res){
          return res.clone().json().then(function(data){
            var convs=data.conversations||[];
            var filtered=convs.filter(function(c){
              var pp=c.projectPath||'';
              return pp===_forcedCwd||pp.indexOf(_forcedCwd)===0;
            });
            return new Response(JSON.stringify({conversations:filtered,total:filtered.length}),{status:200,headers:{'Content-Type':'application/json'}});
          }).catch(function(){return res;});
        });
      }
    }
    // GET: inject forced cwd into working-directories response
    if(_forcedCwd&&typeof url==='string'&&url.indexOf('/api/working-directories')>-1){
      return _origFetch.call(this,url,opts).then(function(res){
        return res.clone().json().then(function(data){
          var dirs=Array.isArray(data)?data:(data.directories||[]);
          var found=false;
          for(var i=0;i<dirs.length;i++){if(dirs[i]===_forcedCwd||dirs[i].path===_forcedCwd)found=true;}
          if(!found){
            if(dirs.length>0&&typeof dirs[0]==='object'){dirs.unshift({path:_forcedCwd,shortname:_forcedCwd.split('/').pop(),lastDate:new Date().toISOString(),conversationCount:0});}
            else{dirs.unshift(_forcedCwd);}
          }
          // Also rewrite response to ONLY show the forced cwd directory (filter others)
          var filteredDirs=dirs.filter(function(d){
            var p=typeof d==='string'?d:d.path;
            return p===_forcedCwd;
          });
          return new Response(JSON.stringify(Array.isArray(data)?filteredDirs:{directories:filteredDirs,totalCount:filteredDirs.length}),{status:200,headers:{'Content-Type':'application/json'}});
        }).catch(function(){return res;});
      });
    }
    return _origFetch.call(this,url,opts);
  };
  if(_forcedCwd){try{window.parent.postMessage({type:'cui-cwd',cwd:_forcedCwd},'*');}catch(e){}}

  // Override pushState/replaceState to detect route changes
  var _ps=history.pushState;
  history.pushState=function(s,t,u){
    _ps.call(this,s,t,u);setTimeout(notifyParent,100);
  };
  var _rs=history.replaceState;
  history.replaceState=function(s,t,u){
    _rs.call(this,s,t,u);setTimeout(notifyParent,100);
  };
  window.addEventListener('popstate',function(){setTimeout(notifyParent,100);});

  // Notify parent on load (reduced frequency to avoid noise)
  setTimeout(notifyParent,500);
  setTimeout(notifyParent,2000);
  setInterval(notifyParent,30000);

  // Handle commands from parent
  var _lastRefresh=0;
  window.addEventListener('message',function(e){
    if(!e.data) return;
    if(e.data.type==='cui-refresh'){
      // Debounce: max 1 refresh per 10s, and NEVER full reload - just click refresh button if exists
      var now=Date.now();
      if(now-_lastRefresh<10000) return;
      _lastRefresh=now;
      // Try to trigger a soft refresh by dispatching a custom event the CUI app listens to
      try{
        // Find and click the sidebar refresh/conversation list area to trigger re-fetch
        var btn=document.querySelector('[data-testid="refresh-button"]')||document.querySelector('button[aria-label*="efresh"]');
        if(btn){btn.click();return;}
        // Fallback: re-fetch conversations via the CUI's own mechanisms
        window.dispatchEvent(new CustomEvent('cui-soft-refresh'));
      }catch(ex){}
      // Do NOT location.reload() - this causes the flickering loop
    }
    if(e.data.type==='cui-set-cwd'&&e.data.cwd){
      sessionStorage.setItem('cui-forced-cwd',e.data.cwd);
      _forcedCwd=e.data.cwd;
    }
    // Clear session command from parent (on "New Conversation" click)
    if(e.data.type==='cui-clear-session'){
      sessionStorage.clear();
      if(_cwdParam) sessionStorage.setItem('cui-forced-cwd',_cwdParam);
      if(_projectParam) sessionStorage.setItem('cui-project',_projectParam);
    }
  });

  // --- Plan Mode Formatter (instant, pre-rendered) ---
  // Detects tool call JSON blocks (ExitPlanMode, etc.) and renders plan text as readable markdown
  // Uses requestAnimationFrame for instant rendering + scroll listener for virtualized lists
  // Auto-detects light/dark theme for proper contrast
  var _pfPending=false;
  function _pfIsDark(){
    try{
      var bg=getComputedStyle(document.body).backgroundColor;
      var m=bg.match(/\d+/g);
      if(m&&m.length>=3){var lum=(parseInt(m[0])*299+parseInt(m[1])*587+parseInt(m[2])*114)/1000;return lum<128;}
    }catch(e){}
    return true;
  }
  var _pfDark=null;
  function _pfColors(){
    if(_pfDark===null)_pfDark=_pfIsDark();
    return _pfDark?{
      h1:'#c0caf5',h2:'#bb9af7',h3:'#7aa2f7',body:'#a9b1d6',strong:'#c0caf5',
      code:'rgba(122,162,247,0.15)',bullet:'#a9b1d6'
    }:{
      h1:'#1a1b2e',h2:'#6930c3',h3:'#2563eb',body:'#1e293b',strong:'#0f172a',
      code:'rgba(37,99,235,0.1)',bullet:'#334155'
    };
  }
  function formatPlanBlocks(){
    _pfPending=false;
    _pfDark=null; // re-detect each pass
    var c=_pfColors();
    var els=document.querySelectorAll('pre:not([data-pf]), code:not([data-pf])');
    for(var i=0;i<els.length;i++){
      var el=els[i];
      var t=(el.textContent||'').trim();
      if(t.length<80){el.dataset.pf='1';continue;}
      if(t.startsWith('{')&&t.indexOf('"plan"')>-1){
        try{
          var j=JSON.parse(t);
          if(j.plan&&j.plan.length>80){
            var html=j.plan
              .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
              .replace(/^### (.+)$/gm,'<div style="font-size:14px;font-weight:700;color:'+c.h3+';margin:12px 0 4px">$1</div>')
              .replace(/^## (.+)$/gm,'<div style="font-size:15px;font-weight:700;color:'+c.h2+';margin:14px 0 6px">$1</div>')
              .replace(/^# (.+)$/gm,'<div style="font-size:17px;font-weight:700;color:'+c.h1+';margin:16px 0 8px">$1</div>')
              .replace(/\\*\\*(.+?)\\*\\*/g,'<strong style="color:'+c.strong+'">$1</strong>')
              .replace(/^- (.+)$/gm,'<div style="padding-left:16px;color:'+c.bullet+'">\\u2022 $1</div>')
              .replace(/^\\d+\\. (.+)$/gm,function(m,p1){return '<div style="padding-left:16px;color:'+c.bullet+'">'+m.match(/^\\d+/)[0]+'. '+p1+'</div>';})
              .replace(/\`([^\`]+)\`/g,'<code style="background:'+c.code+';padding:1px 4px;border-radius:3px;font-size:12px">$1</code>')
              .replace(/\\n/g,'<br>');
            var div=document.createElement('div');
            div.innerHTML=html;
            div.style.cssText='font-family:-apple-system,system-ui,sans-serif;font-size:13px;line-height:1.6;padding:12px 16px;color:'+c.body+';overflow:visible;';
            div.dataset.pf='1';
            el.parentNode.replaceChild(div,el);
            continue;
          }
        }catch(e){}
      }
      el.dataset.pf='1';
    }
  }
  function schedulePF(){
    if(!_pfPending){_pfPending=true;requestAnimationFrame(formatPlanBlocks);}
  }
  // MutationObserver fires on next animation frame (not 300ms delay)
  var planObs=new MutationObserver(schedulePF);
  if(document.body) planObs.observe(document.body,{childList:true,subtree:true});
  else document.addEventListener('DOMContentLoaded',function(){planObs.observe(document.body,{childList:true,subtree:true});});
  // Scroll listener catches virtualized list renders instantly
  document.addEventListener('scroll',schedulePF,true);
  // Fallback interval (reduced from 3s to 500ms)
  setInterval(schedulePF,500);

  // --- Rate Limit Detection ---
  var _rlLast=false;
  function checkRateLimit(){
    var t=(document.body&&document.body.innerText)||'';
    var limited=t.indexOf("You've hit your limit")>-1||t.indexOf("you've hit your limit")>-1||t.indexOf("rate limit")>-1;
    if(limited!==_rlLast){
      _rlLast=limited;
      try{window.parent.postMessage({type:'cui-rate-limit',limited:limited},'*');}catch(e){}
    }
  }
  setInterval(checkRateLimit,3000);
  setTimeout(checkRateLimit,2000);
})();</script>`;

// Inject script into CUI HTML for route persistence + auto-refresh
function serveInjectedHtml(targetBase: string, req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url!, targetBase);
  const headers: Record<string, string> = { 'Accept-Encoding': 'identity' };
  if (req.headers.cookie && typeof req.headers.cookie === 'string') headers['Cookie'] = req.headers.cookie;
  if (req.headers.authorization && typeof req.headers.authorization === 'string') headers['Authorization'] = req.headers.authorization;
  headers['Host'] = url.host;

  const fetchReq = httpRequest(url, { method: 'GET', headers }, (fetchRes) => {
    const contentType = fetchRes.headers['content-type'] || '';
    if (!contentType.includes('text/html')) {
      res.writeHead(fetchRes.statusCode ?? 200, fetchRes.headers);
      fetchRes.pipe(res);
      return;
    }
    const chunks: Buffer[] = [];
    fetchRes.on('data', (chunk: Buffer) => chunks.push(chunk));
    fetchRes.on('end', () => {
      let html = Buffer.concat(chunks).toString();
      html = html.replace('</head>', CUI_INJECT_SCRIPT + '</head>');
      const resHeaders: Record<string, string | string[] | undefined> = {};
      for (const [k, v] of Object.entries(fetchRes.headers)) {
        if (v && k !== 'content-length' && k !== 'content-encoding') resHeaders[k] = v;
      }
      res.writeHead(fetchRes.statusCode ?? 200, resHeaders);
      res.end(html);
    });
  });
  fetchReq.on('error', () => {
    if (!res.headersSent) res.writeHead(502);
    res.end();
  });
  fetchReq.end();
}

// Log only POST requests (GETs are too noisy with 3-4 proxies)
function logRequest(cuiId: string, req: IncomingMessage) {
  if (req.method === 'POST') {
    console.log(`[${cuiId}] POST ${req.url?.slice(0, 80)}`);
  }
}

// Rate-limit proxy error logging (1x/min per proxy) but always broadcast error state
const proxyErrorLog: Record<string, number> = {};

for (const cui of CUI_PROXIES) {
  const proxy = httpProxy.createProxyServer({ target: cui.target, ws: true });
  proxy.on('error', (err, req, res) => {
    const now = Date.now();
    // Broadcast error to frontend so it's visible
    broadcast({ type: 'cui-state', cuiId: cui.id, state: 'error', message: (err as Error).message });
    // Rate-limit log output (max 1x per minute per proxy)
    if (!proxyErrorLog[cui.id] || now - proxyErrorLog[cui.id] > 60000) {
      console.error(`[Proxy ${cui.id}] Error: ${(err as Error).message}`);
      proxyErrorLog[cui.id] = now;
    }
    // Send error response so the client doesn't hang forever
    const response = res as ServerResponse;
    if (response && !response.headersSent && typeof response.writeHead === 'function') {
      response.writeHead(502, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: `CUI server ${cui.id} nicht erreichbar` }));
    }
  });

  const proxyServer = createServer((req, res) => {
    logRequest(cui.id, req);

    // Block SW files so no new SW gets registered
    if (req.url === '/sw.js' || req.url === '/registerSW.js' || req.url?.startsWith('/workbox-')) {
      res.writeHead(200, { 'Content-Type': 'application/javascript', 'Cache-Control': 'no-cache' });
      res.end('// blocked');
      return;
    }

    // Inject auto-refresh script into CUI HTML pages (non-API, non-asset GET)
    if (req.method === 'GET' && req.url && !req.url.startsWith('/api/') && !req.url.startsWith('/assets/') && !req.url.includes('.')) {
      serveInjectedHtml(cui.target, req, res);
      return;
    }

    // SSE streams bypass http-proxy to prevent buffering + track CUI state
    if (req.url?.startsWith('/api/stream/')) {
      sseProxy(cui.target, req, res, cui.id);
      return;
    }

    // Intercept message POST for auto-refresh stream monitoring
    if (req.method === 'POST' && /\/api\/conversations\/(start|[^/]+\/messages)/.test(req.url || '')) {
      const urlMatch = req.url?.match(/\/api\/conversations\/([^/]+)/);
      if (urlMatch?.[1]) setLastPrompt(urlMatch[1]);
      broadcast({ type: 'cui-state', cuiId: cui.id, state: 'processing' });
      messagePostProxy(cui.target, cui.id, req, res);
      return;
    }

    proxy.web(req, res);
  });

  proxyServer.on('upgrade', (req, socket, head) => {
    proxy.ws(req, socket, head, undefined, (err) => {
      console.error(`[Proxy ${cui.id}] WS upgrade error:`, (err as Error).message);
      socket.destroy();
    });
  });

  proxyServer.on('error', (err: any) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[Proxy] ${cui.id}: Port ${cui.localPort} already in use — skipping`);
    } else {
      console.error(`[Proxy] ${cui.id}: Listen error:`, err.message);
    }
  });
  proxyServer.listen(cui.localPort, () => {
    console.log(`[Proxy] ${cui.id}: localhost:${cui.localPort} → ${cui.target}`);
  });
}
const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// --- Workspace Runtime State (for Control API) ---
const startTime = Date.now();
const workspaceState = {
  activeProjectId: '',
  cuiStates: {} as Record<string, string>,
  panels: [] as Array<{ id: string; component: string; config: Record<string, unknown>; name: string }>,
};

// --- Panel Visibility Registry ---
// Tracks which conversations are currently visible in CUI panels
interface PanelVisibility {
  panelId: string;
  projectId: string;
  accountId: string;
  sessionId: string;
  route: string;
  updatedAt: number;
}

const visibilityRegistry = new Map<string, PanelVisibility>();

function updatePanelVisibility(data: { panelId: string; projectId: string; accountId: string; sessionId: string; route: string }): void {
  const key = `${data.projectId}:${data.panelId}`;
  const prev = visibilityRegistry.get(key);
  visibilityRegistry.set(key, { ...data, updatedAt: Date.now() });
  if (!prev || prev.sessionId !== data.sessionId) {
    broadcast({ type: 'visibility-update', visibleSessionIds: [...getVisibleSessionIds()] });
  }
}

function removePanelVisibility(projectId: string, panelId: string): void {
  visibilityRegistry.delete(`${projectId}:${panelId}`);
  broadcast({ type: 'visibility-update', visibleSessionIds: [...getVisibleSessionIds()] });
}

function getVisibleSessionIds(): Set<string> {
  const ids = new Set<string>();
  for (const entry of visibilityRegistry.values()) {
    if (entry.sessionId) ids.add(entry.sessionId);
  }
  return ids;
}

// Cleanup stale entries every 60s (panels closed, browser refreshed)
setInterval(() => {
  const cutoff = Date.now() - 5 * 60 * 1000;
  for (const [key, entry] of visibilityRegistry) {
    if (entry.updatedAt < cutoff) visibilityRegistry.delete(key);
  }
}, 60000);

// --- Per-Session Attention State Tracker ---
// Tracks whether each conversation needs user attention (plan, question, permission, done)
type AttentionReason = 'plan' | 'question' | 'permission' | 'error' | 'done';
type ConvAttentionState = 'working' | 'needs_attention' | 'idle';
interface SessionState {
  state: ConvAttentionState;
  reason?: AttentionReason;
  since: number;
  accountId: string;
  sessionId?: string;
}
const sessionStates = new Map<string, SessionState>();

function setSessionState(key: string, accountId: string, state: ConvAttentionState, reason?: AttentionReason, sessionId?: string) {
  const prev = sessionStates.get(key);
  if (prev?.state === state && prev?.reason === reason) return; // no change
  sessionStates.set(key, { state, reason, since: Date.now(), accountId, sessionId });
  broadcast({ type: 'conv-attention', key, accountId, sessionId, state, reason });
}

function getSessionStates(): Record<string, SessionState> {
  const out: Record<string, SessionState> = {};
  for (const [k, v] of sessionStates) out[k] = v;
  return out;
}

// Detect attention-requiring markers in SSE text
// IMPORTANT: Only match LIVE stream events, not historical conversation replay data.
// Historical chunks contain "type":"result", "stop_reason" etc. for every past message.
function detectAttentionMarkers(text: string): { state: ConvAttentionState; reason?: AttentionReason } | null {
  // Rate limit / billing errors - notify user immediately
  if (text.includes("rate_limit") || text.includes("billing") || text.includes("hit your limit")) {
    return { state: "needs_attention", reason: "error" };
  }
  // Plan mode: ExitPlanMode or EnterPlanMode tool calls
  if (text.includes('"name":"ExitPlanMode"') || text.includes('"name":"EnterPlanMode"')) {
    return { state: 'needs_attention', reason: 'plan' };
  }
  // User question: AskUserQuestion tool call
  if (text.includes('"name":"AskUserQuestion"')) {
    return { state: 'needs_attention', reason: 'question' };
  }
  // Stream-end markers (only these are reliable for live stream completion)
  if (text.includes('"type":"closed"') || text.includes('"type":"message_stop"')) {
    return { state: 'idle', reason: 'done' };
  }
  return null;
}

// --- File Watcher ---
const watchers = new Map<string, ReturnType<typeof watch>>();
const clients = new Set<WebSocket>();

wss.on('connection', (ws) => {
  clients.add(ws);
  ws.on('close', () => clients.delete(ws));

  // Register for Document Manager broadcasts
  registerWebSocketClient(ws);

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'watch') {
        startWatching(msg.path);
      }
      // Frontend state reports (for Control API state queries)
      if (msg.type === 'state-report') {
        if (msg.activeProjectId) workspaceState.activeProjectId = msg.activeProjectId;
        if (msg.panels) workspaceState.panels = msg.panels;
      }
      // Panel visibility reports from CuiPanel
      if (msg.type === 'panel-visibility' && msg.panelId && msg.projectId) {
        updatePanelVisibility({
          panelId: msg.panelId,
          projectId: msg.projectId,
          accountId: msg.accountId || '',
          sessionId: msg.sessionId || '',
          route: msg.route || '',
        });
      }
      // Panel removed from layout
      if (msg.type === 'panel-removed' && msg.projectId && msg.panelId) {
        removePanelVisibility(msg.projectId, msg.panelId);
      }
      // Navigate request from LayoutManager → broadcast to all CuiPanels
      if (msg.type === 'navigate-request' && msg.panelId && msg.sessionId) {
        broadcast({ type: 'control:cui-navigate-conversation', panelId: msg.panelId, sessionId: msg.sessionId, projectId: msg.projectId || '' });
      }
    } catch {
      // ignore malformed messages
    }
  });
});

function broadcast(data: Record<string, unknown>) {
  // Track CUI states in workspace state store
  if (data.type === 'cui-state' && data.cuiId && data.state) {
    workspaceState.cuiStates[data.cuiId as string] = data.state as string;
  }
  const json = JSON.stringify(data);
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(json);
    }
  }
}

function cleanupOldWatchers() {
  // Limit to 10 active watchers max to prevent resource exhaustion
  if (watchers.size <= 10) return;
  const entries = [...watchers.entries()];
  const toRemove = entries.slice(0, entries.length - 10);
  for (const [path, watcher] of toRemove) {
    watcher.close();
    watchers.delete(path);
    console.log(`[Watcher] Cleaned up old watcher: ${path}`);
  }
}

function startWatching(dirPath: string) {
  // Skip remote paths - can't watch via chokidar
  if (isRemotePath(dirPath)) return;

  const resolved = resolve(dirPath);
  if (watchers.has(resolved)) return;

  // Block overly broad paths (home dir, root, etc.) - they cause EPERM crashes on macOS
  const home = homedir();
  if (resolved === home || resolved === '/' || resolved === '/Users') {
    console.warn(`[Watcher] Blocked overly broad watch path: ${resolved}`);
    return;
  }

  cleanupOldWatchers();

  const watcher = watch(resolved, {
    ignored: /(^|[\/\\])\.|node_modules|Library/,
    persistent: true,
    ignoreInitial: true,
    depth: 3,
  });

  // Prevent unhandled EPERM crashes on macOS protected directories
  watcher.on('error', (err) => {
    const e = err as NodeJS.ErrnoException;
    console.warn(`[Watcher] Error on ${resolved}: ${e.code || e.message || err}`);
  });

  watcher.on('change', (filePath) => {
    broadcast({ type: 'file-change', path: filePath, event: 'change' });
  });
  watcher.on('add', (filePath) => {
    broadcast({ type: 'file-change', path: filePath, event: 'add' });
  });
  watcher.on('unlink', (filePath) => {
    broadcast({ type: 'file-change', path: filePath, event: 'unlink' });
  });

  watchers.set(resolved, watcher);
  console.log(`Watching: ${resolved}`);
}

// --- REST API ---
app.use(express.json({ limit: '50mb' }));

// Resolve ~ to home directory
function resolvePath(p: string): string {
  if (p.startsWith('~/') || p === '~') return join(homedir(), p.slice(1));
  return resolve(p);
}

// Detect remote paths (paths on the dev server)
const REMOTE_HOST = '100.121.161.109';
function isRemotePath(p: string): boolean {
  return p.startsWith('/root/');
}

// SSH helper: execute command on remote and return stdout
async function sshExec(cmd: string): Promise<string> {
  const { stdout } = await execAsync(`ssh -o ConnectTimeout=5 root@${REMOTE_HOST} ${JSON.stringify(cmd)}`);
  return stdout;
}

// List directory contents (local or remote via SSH)
app.get('/api/files', async (req, res) => {
  const dirPath = req.query.path as string;
  if (!dirPath) {
    res.status(400).json({ error: 'path required' });
    return;
  }

  // Remote path: browse via SSH
  if (isRemotePath(dirPath)) {
    try {
      // Use find with maxdepth 1 for listing + file type detection
      const raw = await sshExec(
        `mkdir -p ${dirPath} && find ${dirPath} -maxdepth 1 -not -name '.*' -not -path '${dirPath}' -printf '%y\\t%f\\n' 2>/dev/null | sort -t$'\\t' -k1,1r -k2,2`
      );
      const entries = raw.trim().split('\n').filter(Boolean).map(line => {
        const [type, name] = line.split('\t');
        const isDir = type === 'd';
        const fullPath = dirPath.endsWith('/') ? `${dirPath}${name}` : `${dirPath}/${name}`;
        return {
          name,
          path: fullPath,
          isDir,
          ext: isDir ? null : extname(name).toLowerCase() || null,
        };
      }).sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      res.json({ path: dirPath, entries, remote: true });
    } catch (err: any) {
      res.status(500).json({ error: `SSH: ${err.message}` });
    }
    return;
  }

  // Local path
  const resolved = resolvePath(dirPath);
  if (!existsSync(resolved)) {
    res.status(404).json({ error: 'not found' });
    return;
  }

  try {
    const stat = statSync(resolved);
    if (!stat.isDirectory()) {
      res.status(400).json({ error: 'not a directory' });
      return;
    }

    const entries = readdirSync(resolved, { withFileTypes: true })
      .filter((e) => !e.name.startsWith('.'))
      .map((e) => ({
        name: e.name,
        path: join(resolved, e.name),
        isDir: e.isDirectory(),
        ext: e.isDirectory() ? null : extname(e.name).toLowerCase(),
      }))
      .sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

    res.json({ path: resolved, entries });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Read file content (local or remote, supports DOCX→HTML and XLSX→HTML conversion)
app.get('/api/file', async (req, res) => {
  const filePath = req.query.path as string;
  if (!filePath) {
    res.status(400).json({ error: 'path required' });
    return;
  }

  // Remote file: read via SSH
  if (isRemotePath(filePath)) {
    try {
      const ext = extname(filePath).toLowerCase();
      const mimeType = mime.lookup(ext) || 'application/octet-stream';
      const textExts = ['.md', '.ts', '.tsx', '.js', '.jsx', '.py', '.sh', '.yml', '.yaml', '.toml', '.cfg', '.ini', '.env', '.csv', '.log', '.json', '.html', '.htm', '.txt', '.css'];

      if (mimeType.startsWith('text/') || mimeType === 'application/json' || textExts.includes(ext)) {
        const content = await sshExec(`cat ${filePath}`);
        res.json({ path: filePath, content, mimeType, ext, remote: true });
      } else if (mimeType.startsWith('image/') || mimeType === 'application/pdf') {
        // Binary files: SCP to temp, serve, cleanup
        const tmpFile = join('/tmp', `cui-remote-${Date.now()}${ext}`);
        await execAsync(`scp root@${REMOTE_HOST}:${filePath} ${tmpFile}`);
        res.sendFile(tmpFile, () => { try { unlinkSync(tmpFile); } catch {} });
      } else {
        // Try as text
        const content = await sshExec(`cat ${filePath}`);
        res.json({ path: filePath, content, mimeType, ext, remote: true });
      }
    } catch (err: any) {
      res.status(500).json({ error: `SSH: ${err.message}` });
    }
    return;
  }

  // Local file
  const resolved = resolvePath(filePath);
  if (!existsSync(resolved)) {
    res.status(404).json({ error: 'not found' });
    return;
  }

  const ext = extname(resolved).toLowerCase();
  const mimeType = mime.lookup(ext) || 'application/octet-stream';

  // DOCX → convert to HTML with mammoth
  if (ext === '.docx') {
    try {
      const mammoth = await import('mammoth');
      const result = await mammoth.default.convertToHtml({ path: resolved });
      const styled = `<style>body{font-family:-apple-system,system-ui,sans-serif;font-size:14px;line-height:1.6;color:#333;padding:20px;max-width:900px;margin:0 auto}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ddd;padding:8px}h1,h2,h3{color:#1a1b26}</style>${result.value}`;
      res.json({ path: resolved, content: styled, mimeType: 'text/html', ext: '.html' });
    } catch (err: any) {
      res.status(500).json({ error: `DOCX conversion failed: ${err.message}` });
    }
    return;
  }

  // XLSX/XLS → convert to HTML tables
  if (ext === '.xlsx' || ext === '.xls') {
    try {
      const XLSX = await import('xlsx');
      const wb = XLSX.readFile(resolved);
      const sheets = wb.SheetNames.map(name => {
        const html = XLSX.utils.sheet_to_html(wb.Sheets[name]);
        return `<h2 style="color:#7aa2f7;margin:16px 0 8px">${name}</h2>${html}`;
      }).join('');
      const styled = `<style>body{font-family:-apple-system,system-ui,sans-serif;font-size:13px;color:#333;padding:16px}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ddd;padding:6px 10px;text-align:left}th{background:#f5f5f5;font-weight:600}tr:nth-child(even){background:#fafafa}</style>${sheets}`;
      res.json({ path: resolved, content: styled, mimeType: 'text/html', ext: '.html' });
    } catch (err: any) {
      res.status(500).json({ error: `XLSX conversion failed: ${err.message}` });
    }
    return;
  }

  // For text/code files, return as text
  if (
    mimeType.startsWith('text/') ||
    mimeType === 'application/json' ||
    ['.md', '.ts', '.tsx', '.js', '.jsx', '.py', '.sh', '.yml', '.yaml', '.toml', '.cfg', '.ini', '.env', '.csv', '.log'].includes(ext)
  ) {
    try {
      const content = readFileSync(resolved, 'utf8');
      res.json({ path: resolved, content, mimeType, ext });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
    return;
  }

  // For images/PDFs, serve the binary
  if (mimeType.startsWith('image/') || mimeType === 'application/pdf') {
    res.sendFile(resolved);
    return;
  }

  // Fallback: try to read as text
  try {
    const content = readFileSync(resolved, 'utf8');
    res.json({ path: resolved, content, mimeType, ext });
  } catch {
    res.status(415).json({ error: `Unsupported file type: ${mimeType}` });
  }
});

// --- Persistent Storage Dirs ---
const DATA_DIR = resolve(import.meta.dirname ?? __dirname, '..', 'data');
const PROJECTS_DIR = join(DATA_DIR, 'projects');
const NOTES_DIR = join(DATA_DIR, 'notes');
const LAYOUTS_DIR = join(DATA_DIR, 'layouts');
const UPLOADS_DIR = join(DATA_DIR, 'uploads');
const ACTIVE_DIR = join(DATA_DIR, 'active');

// Ensure dirs exist
for (const dir of [PROJECTS_DIR, NOTES_DIR, LAYOUTS_DIR, UPLOADS_DIR, ACTIVE_DIR]) {
  mkdirSync(dir, { recursive: true });
}

// --- Local conversation titles (CUI API doesn't support custom_name) ---
const TITLES_FILE = join(DATA_DIR, 'titles.json');
function loadTitles(): Record<string, string> {
  if (!existsSync(TITLES_FILE)) return {};
  try { return JSON.parse(readFileSync(TITLES_FILE, 'utf8')); } catch { return {}; }
}
function saveTitle(sessionId: string, title: string) {
  const titles = loadTitles();
  titles[sessionId] = title;
  writeFileSync(TITLES_FILE, JSON.stringify(titles, null, 2));
}
function getTitle(sessionId: string): string {
  return loadTitles()[sessionId] || '';
}

// Auto-generate a clean title from summary text (no LLM needed)
function autoTitleFromSummary(summary: string): string {
  if (!summary) return '';
  // Take first line, clean up
  let title = summary.split('\n')[0].replace(/\s+/g, ' ').trim();
  // Skip unhelpful summaries
  if (title.startsWith('API Error') || title.startsWith('{') || title.startsWith('Error:')) return '';
  // Remove common prefixes that aren't useful titles
  title = title.replace(/^(Hey Chat|Hey Claude|Hi Claude|Hallo)[,\s-]*/i, '').trim();
  // Skip if too short or too generic
  if (title.length < 3) return '';
  // Truncate
  if (title.length > 60) title = title.slice(0, 57) + '...';
  return title;
}

// Background: auto-title untitled conversations (runs async, no blocking)
function autoTitleUntitled(results: Array<{ sessionId: string; summary: string; customName: string }>) {
  const untitled = results.filter(r => !r.customName && r.summary);
  if (untitled.length === 0) return;
  const titles = loadTitles();
  let saved = 0;
  for (const r of untitled) {
    if (titles[r.sessionId]) continue; // Already titled
    const title = autoTitleFromSummary(r.summary);
    if (title) {
      titles[r.sessionId] = title;
      saved++;
    }
  }
  if (saved > 0) {
    writeFileSync(TITLES_FILE, JSON.stringify(titles, null, 2));
    console.log(`[AutoTitle] Generated ${saved} titles from summaries`);
  }
}

// --- Conversation Account Assignment ---
// Tracks which account a conversation belongs to (avoids duplicate display)
const ASSIGNMENTS_FILE = join(DATA_DIR, 'conv-accounts.json');
function loadAssignments(): Record<string, string> {
  if (!existsSync(ASSIGNMENTS_FILE)) return {};
  try { return JSON.parse(readFileSync(ASSIGNMENTS_FILE, 'utf8')); } catch { return {}; }
}
function saveAssignment(sessionId: string, accountId: string) {
  const assignments = loadAssignments();
  if (assignments[sessionId] === accountId) return; // No change
  assignments[sessionId] = accountId;
  writeFileSync(ASSIGNMENTS_FILE, JSON.stringify(assignments, null, 2));
}
function getAssignment(sessionId: string): string {
  return loadAssignments()[sessionId] || '';
}

// --- Manual Finished Status ---
// Lets users mark conversations as "finished" even if CUI still says "ongoing"
const FINISHED_FILE = join(DATA_DIR, 'conv-finished.json');
function loadFinished(): Record<string, boolean> {
  if (!existsSync(FINISHED_FILE)) return {};
  try { return JSON.parse(readFileSync(FINISHED_FILE, 'utf8')); } catch { return {}; }
}
function setFinished(sessionId: string, finished: boolean) {
  const data = loadFinished();
  if (finished) data[sessionId] = true;
  else delete data[sessionId];
  writeFileSync(FINISHED_FILE, JSON.stringify(data, null, 2));
}
function isFinished(sessionId: string): boolean {
  return loadFinished()[sessionId] === true;
}

// Track when user last sent a prompt per conversation
const LAST_PROMPT_FILE = join(DATA_DIR, 'conv-last-prompt.json');
let _lastPromptCache: Record<string, string> | null = null;
function loadLastPrompt(): Record<string, string> {
  if (_lastPromptCache) return _lastPromptCache;
  if (!existsSync(LAST_PROMPT_FILE)) { _lastPromptCache = {}; return _lastPromptCache; }
  try { _lastPromptCache = JSON.parse(readFileSync(LAST_PROMPT_FILE, 'utf8')); return _lastPromptCache!; } catch { _lastPromptCache = {}; return _lastPromptCache; }
}
function setLastPrompt(sessionId: string) {
  const data = loadLastPrompt();
  data[sessionId] = new Date().toISOString();
  _lastPromptCache = data;
  writeFileSync(LAST_PROMPT_FILE, JSON.stringify(data, null, 2));
}

// Deduplicate conversations by sessionId (remote accounts share sessions)
function deduplicateConversations(results: any[]): any[] {
  const assignments = loadAssignments();
  const bySessionId = new Map<string, any[]>();

  for (const r of results) {
    const existing = bySessionId.get(r.sessionId) || [];
    existing.push(r);
    bySessionId.set(r.sessionId, existing);
  }

  const deduped: any[] = [];
  for (const [sessionId, entries] of bySessionId) {
    if (entries.length === 1) {
      deduped.push(entries[0]);
      continue;
    }

    // Multiple accounts have this conversation — pick the best one
    const assigned = assignments[sessionId];

    // Priority: 1) streaming, 2) ongoing, 3) assigned account, 4) preferred order (rafael > engelmann > office)
    const streaming = entries.find(e => e.streamingId);
    const ongoing = entries.find(e => e.status === 'ongoing');
    let best: any;

    if (streaming) {
      best = streaming;
      saveAssignment(sessionId, streaming.accountId);
    } else if (ongoing) {
      best = ongoing;
      saveAssignment(sessionId, ongoing.accountId);
    } else if (assigned) {
      best = entries.find(e => e.accountId === assigned) || entries[0];
    } else {
      // No assignment yet — prefer rafael > engelmann > office
      const preferOrder = ['rafael', 'engelmann', 'office', 'local'];
      best = entries[0];
      for (const pref of preferOrder) {
        const match = entries.find(e => e.accountId === pref);
        if (match) { best = match; break; }
      }
    }

    deduped.push(best);
  }

  return deduped;
}

// --- ACTIVE Folder API ---
// Returns the ACTIVE folder path for a project (auto-creates it)
app.get('/api/active-dir/:projectId', (req, res) => {
  const dir = join(ACTIVE_DIR, req.params.projectId);
  mkdirSync(dir, { recursive: true });
  res.json({ path: dir });
});

// --- Mission Control API ---
// Helper: fetch JSON from a CUI proxy
async function cuiFetch(proxyPort: number, path: string, options?: { method?: string; body?: string }): Promise<any> {
  const url = `http://localhost:${proxyPort}${path}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, {
      method: options?.method || 'GET',
      headers: options?.body ? { 'Content-Type': 'application/json' } : {},
      body: options?.body,
      signal: controller.signal,
    });
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

// Helper: resolve projectPath → project name
function resolveProjectName(projectPath: string): string {
  const projects = readdirSync(PROJECTS_DIR).filter(f => f.endsWith('.json'));
  for (const f of projects) {
    try {
      const p = JSON.parse(readFileSync(join(PROJECTS_DIR, f), 'utf8'));
      if (p.workDir && projectPath.includes(p.id)) return p.name;
    } catch { /* skip */ }
  }
  // Fallback: extract last segment
  return projectPath.split('/').filter(Boolean).pop() || projectPath;
}

// Helper: get proxy port for account
function getProxyPort(accountId: string): number | null {
  const proxy = CUI_PROXIES.find(p => p.id === accountId);
  return proxy?.localPort ?? null;
}

// 1. List all conversations across all accounts
app.get('/api/mission/conversations', async (req, res) => {
  const filterProject = req.query.project as string | undefined;
  const results: any[] = [];

  await Promise.all(CUI_PROXIES.map(async (proxy) => {
    const data = await cuiFetch(proxy.localPort, '/api/conversations?limit=50&sortBy=updated&order=desc');
    if (!data?.conversations) return;
    for (const c of data.conversations) {
      if (filterProject && !c.projectPath?.includes(filterProject)) continue;
      results.push({
        sessionId: c.sessionId,
        accountId: proxy.id,
        accountLabel: proxy.id.charAt(0).toUpperCase() + proxy.id.slice(1),
        accountColor: { rafael: '#7aa2f7', engelmann: '#bb9af7', office: '#9ece6a', local: '#e0af68' }[proxy.id] || '#666',
        proxyPort: proxy.localPort,
        projectPath: c.projectPath || '',
        projectName: resolveProjectName(c.projectPath || ''),
        summary: c.summary || '',
        customName: getTitle(c.sessionId) || c.sessionInfo?.custom_name || '',
        status: c.status || 'completed',
        streamingId: c.streamingId || null,
        model: c.model || '',
        messageCount: c.messageCount || 0,
        updatedAt: c.updatedAt || c.sessionInfo?.updated_at || '',
        createdAt: c.createdAt || c.sessionInfo?.created_at || '',
      });
    }
  }));

  // Enrich with lastPromptAt from local tracking
  const promptTimes = loadLastPrompt();
  for (const r of results) {
    r.lastPromptAt = promptTimes[r.sessionId] || '';
  }

  // Sort by updatedAt desc, ongoing first
  results.sort((a, b) => {
    if (a.status !== b.status) return a.status === 'ongoing' ? -1 : 1;
    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  });

  // Auto-title untitled conversations in background (no blocking)
  autoTitleUntitled(results);
  // Re-read titles after auto-titling to include newly generated ones
  const freshTitles = loadTitles();
  for (const r of results) {
    if (!r.customName && freshTitles[r.sessionId]) {
      r.customName = freshTitles[r.sessionId];
    }
  }

  // Deduplicate: remote accounts share sessions, show each conversation only once
  const deduped = deduplicateConversations(results);

  // Enrich with attention states
  const states = getSessionStates();
  for (const conv of deduped) {
    const stateInfo = states[conv.accountId];
    if (stateInfo) {
      (conv as any).attentionState = stateInfo.state;
      (conv as any).attentionReason = stateInfo.reason;
    }
  }

  // Enrich with manualFinished status
  const finished = loadFinished();
  for (const conv of deduped) {
    if (finished[conv.sessionId]) {
      (conv as any).manualFinished = true;
    }
  }

  // Enrich with visibility status
  const visibleIds = getVisibleSessionIds();
  for (const conv of deduped) {
    (conv as any).isVisible = visibleIds.has(conv.sessionId);
  }

  res.json({ conversations: deduped, total: deduped.length });
});

// 2. Get conversation detail (last N messages)
app.get('/api/mission/conversation/:accountId/:sessionId', async (req, res) => {
  const port = getProxyPort(req.params.accountId);
  if (!port) { res.status(400).json({ error: 'unknown account' }); return; }

  const tail = parseInt(req.query.tail as string) || 10;
  const [convData, permData] = await Promise.all([
    cuiFetch(port, `/api/conversations/${req.params.sessionId}`),
    cuiFetch(port, `/api/permissions?streamingId=&status=pending`),
  ]);

  if (!convData) { res.status(502).json({ error: 'CUI unreachable' }); return; }

  // Transform CUI message format: {type, message: {role, content}, timestamp} → {role, content, timestamp}
  const rawMessages = (convData.messages || []).sort((a: any, b: any) => (a.timestamp || '').localeCompare(b.timestamp || ''));
  const messages = rawMessages.slice(-tail).map((m: any) => ({
    role: m.message?.role || m.type || 'user',
    content: m.message?.content || m.content || '',
    timestamp: m.timestamp || '',
  }));

  res.json({
    messages,
    summary: convData.summary || '',
    customName: getTitle(req.params.sessionId) || convData.sessionInfo?.custom_name || '',
    status: convData.metadata?.status || 'completed',
    projectPath: convData.projectPath || '',
    permissions: permData?.permissions || [],
    totalMessages: rawMessages.length,
  });
});

// 3. Send message to existing conversation
app.post('/api/mission/send', async (req, res) => {
  const { accountId, sessionId, message, workDir, model } = req.body;
  if (!accountId || !sessionId || !message) {
    res.status(400).json({ error: 'accountId, sessionId, message required' });
    return;
  }
  const port = getProxyPort(accountId);
  if (!port) { res.status(400).json({ error: 'unknown account' }); return; }

  const result = await cuiFetch(port, '/api/conversations/start', {
    method: 'POST',
    body: JSON.stringify({
      workingDirectory: workDir || '/root',
      initialPrompt: message,
      resumedSessionId: sessionId, ...(model ? { model } : {}),
    }),
  });

  if (!result) { res.status(502).json({ error: 'CUI unreachable' }); return; }
  if (result.error) { res.status(400).json({ error: result.error, code: result.code }); return; }
  saveAssignment(result.sessionId || sessionId, accountId);
  setLastPrompt(result.sessionId || sessionId);

  // Track state
  broadcast({ type: 'cui-state', cuiId: accountId, state: 'processing' });
  setSessionState(accountId, accountId, 'working', undefined, result.sessionId || sessionId);

  // Monitor the new stream
  if (result.streamingId) {
    monitorStream(`http://localhost:${port}`, result.streamingId, accountId, {});
  }

  // Track account assignment for this conversation
  saveAssignment(result.sessionId || sessionId, accountId);

  const busy = !result.streamingId;
  res.json({ ok: true, busy, streamingId: result.streamingId, sessionId: result.sessionId || sessionId });
});

// 4. Approve/deny permission
app.post('/api/mission/permissions/:accountId/:permissionId', async (req, res) => {
  const port = getProxyPort(req.params.accountId);
  if (!port) { res.status(400).json({ error: 'unknown account' }); return; }

  const result = await cuiFetch(port, `/api/permissions/${req.params.permissionId}/decision`, {
    method: 'POST',
    body: JSON.stringify({ action: req.body.action || 'approve' }),
  });

  res.json(result || { error: 'failed' });
});

// 4b. Get all session attention states (for batch UI updates)
app.get('/api/mission/states', (_req, res) => {
  res.json(getSessionStates());
});

// 5. Set conversation name (Betreff) — saved locally (CUI API ignores custom_name)
app.post('/api/mission/conversation/:accountId/:sessionId/name', async (req, res) => {
  const name = req.body.custom_name || '';
  saveTitle(req.params.sessionId, name);
  res.json({ ok: true, sessionId: req.params.sessionId, custom_name: name });
});

// 5b. Assign conversation to account (called when chat is opened in a CUI panel)
app.post('/api/mission/conversation/:sessionId/assign', (req, res) => {
  const { accountId } = req.body;
  if (!accountId) { res.status(400).json({ error: 'accountId required' }); return; }
  saveAssignment(req.params.sessionId, accountId);
  res.json({ ok: true, sessionId: req.params.sessionId, accountId });
});

// 5c. Get panel visibility (which conversations are open in which panels)
app.get('/api/mission/visibility', (_req, res) => {
  const panels: PanelVisibility[] = [];
  for (const entry of visibilityRegistry.values()) panels.push(entry);
  res.json({ panels, visibleSessionIds: [...getVisibleSessionIds()] });
});

// 5d. Mark conversation as finished (user override)
app.post('/api/mission/conversation/:sessionId/finish', (req, res) => {
  const finished = req.body.finished !== false;
  const sid = req.params.sessionId;
  setFinished(sid, finished);
  if (finished) {
    const panelsToClose: Array<{ panelId: string; projectId: string }> = [];
    for (const entry of visibilityRegistry.values()) {
      if (entry.sessionId === sid) {
        panelsToClose.push({ panelId: entry.panelId, projectId: entry.projectId });
      }
    }
    broadcast({ type: 'control:conversation-finished', sessionId: sid, panelsToClose });
  }
  res.json({ ok: true, sessionId: sid, finished });
});

// 5e. Delete conversation permanently (removes .jsonl from disk)
app.delete('/api/mission/conversation/:sessionId', (req, res) => {
  const sid = req.params.sessionId;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sid)) {
    res.status(400).json({ error: 'Invalid sessionId format' });
    return;
  }
  const cuiProjectsDir = join(homedir(), '.claude', 'projects');
  if (!existsSync(cuiProjectsDir)) {
    res.status(404).json({ error: 'CUI projects directory not found' });
    return;
  }
  const deleted: string[] = [];
  const errors: string[] = [];
  try {
    const projectDirs = readdirSync(cuiProjectsDir);
    for (const dir of projectDirs) {
      const dirPath = join(cuiProjectsDir, dir);
      if (!statSync(dirPath).isDirectory()) continue;
      const jsonlPath = join(dirPath, `${sid}.jsonl`);
      if (existsSync(jsonlPath)) {
        try { unlinkSync(jsonlPath); deleted.push(jsonlPath); } catch (e: any) { errors.push(e.message); }
      }
      const sessionDir = join(dirPath, sid);
      if (existsSync(sessionDir) && statSync(sessionDir).isDirectory()) {
        try { rmSync(sessionDir, { recursive: true }); deleted.push(sessionDir); } catch (e: any) { errors.push(e.message); }
      }
    }
  } catch (e: any) {
    res.status(500).json({ error: `Failed to scan projects: ${e.message}` });
    return;
  }
  if (deleted.length === 0 && errors.length === 0) {
    res.status(404).json({ error: 'Conversation not found on disk' });
    return;
  }
  setFinished(sid, false);
  const titles = loadTitles();
  if (titles[sid]) { delete titles[sid]; writeFileSync(TITLES_FILE, JSON.stringify(titles, null, 2)); }
  const prompts = loadLastPrompt();
  if (prompts[sid]) { delete prompts[sid]; writeFileSync(LAST_PROMPT_FILE, JSON.stringify(prompts, null, 2)); }
  console.log(`[Delete] Conversation ${sid}: ${deleted.length} files deleted`);
  res.json({ ok: true, deleted, errors });
});

// 5f. Activate conversations in panels
app.post('/api/mission/activate', (req, res) => {
  const { conversations } = req.body;
  if (!Array.isArray(conversations) || conversations.length === 0) {
    res.status(400).json({ error: 'conversations array required' });
    return;
  }
  // Group by projectName and resolve project IDs
  const projectFiles = readdirSync(PROJECTS_DIR).filter(f => f.endsWith('.json'));
  const projectsData = projectFiles.map(f => {
    try { return JSON.parse(readFileSync(join(PROJECTS_DIR, f), 'utf8')); } catch { return null; }
  }).filter(Boolean);
  const plan: Array<{ projectId: string; conversations: Array<{ sessionId: string; accountId: string }> }> = [];
  const byProject = new Map<string, Array<{ sessionId: string; accountId: string }>>();
  for (const c of conversations) {
    const list = byProject.get(c.projectName) || [];
    list.push(c);
    byProject.set(c.projectName, list);
  }
  for (const [projName, convs] of byProject) {
    const proj = projectsData.find((p: any) => p.name === projName);
    plan.push({ projectId: proj?.id || projName, conversations: convs });
  }
  broadcast({ type: 'control:activate-conversations', plan });
  res.json({ ok: true, plan });
});

// 6. Start new conversation with subject
app.post('/api/mission/start', async (req, res) => {
  const { accountId, workDir, subject, message, model } = req.body;
  if (!accountId || !message) {
    res.status(400).json({ error: 'accountId, message required' });
    return;
  }
  const port = getProxyPort(accountId);
  if (!port) { res.status(400).json({ error: 'unknown account' }); return; }

  // Start conversation
  const result = await cuiFetch(port, '/api/conversations/start', {
    method: 'POST',
    body: JSON.stringify({
      workingDirectory: workDir || '/root',
      initialPrompt: message,
      ...(model ? { model } : {}),
    }),
  });

  if (!result?.sessionId) { res.status(502).json({ error: 'CUI unreachable' }); return; }

  // Save subject as local title (CUI API doesn't support custom_name)
  if (subject) {
    saveTitle(result.sessionId, subject);
  }
  // Track account assignment + prompt time
  saveAssignment(result.sessionId, accountId);
  setLastPrompt(result.sessionId);

  broadcast({ type: 'cui-state', cuiId: accountId, state: 'processing' });
  if (result.streamingId) {
    monitorStream(`http://localhost:${port}`, result.streamingId, accountId, {});
  }

  res.json({ ok: true, sessionId: result.sessionId, streamingId: result.streamingId });
});

// 7. Stop conversation
app.post('/api/mission/conversation/:accountId/:sessionId/stop', async (req, res) => {
  const port = getProxyPort(req.params.accountId);
  if (!port) { res.status(400).json({ error: 'unknown account' }); return; }

  const result = await cuiFetch(port, `/api/conversations/${req.params.sessionId}/stop`, {
    method: 'POST',
  });

  res.json(result || { error: 'failed' });
});

// 8. Auto-title: set conversation name from first user message
app.post('/api/mission/auto-titles', async (_req, res) => {
  let updated = 0;
  const errors: string[] = [];

  // Get all conversations
  const allConvs: Array<{ sessionId: string; accountId: string; port: number; summary: string; customName: string }> = [];
  await Promise.all(CUI_PROXIES.map(async (proxy) => {
    const data = await cuiFetch(proxy.localPort, '/api/conversations?limit=50&sortBy=updated&order=desc');
    if (!data?.conversations) return;
    for (const c of data.conversations) {
      if (c.sessionInfo?.custom_name || getTitle(c.sessionId)) continue; // Already has a title
      allConvs.push({
        sessionId: c.sessionId,
        accountId: proxy.id,
        port: proxy.localPort,
        summary: c.summary || '',
        customName: c.sessionInfo?.custom_name || '',
      });
    }
  }));

  // For each conversation without a title, fetch first user message
  for (const conv of allConvs) {
    try {
      const detail = await cuiFetch(conv.port, `/api/conversations/${conv.sessionId}`);
      if (!detail?.messages) continue;

      // Find first user message
      const firstUserMsg = detail.messages.find((m: any) =>
        (m.type === 'user' || m.message?.role === 'user')
      );
      if (!firstUserMsg) continue;

      const content = firstUserMsg.message?.content || firstUserMsg.content || '';
      const text = typeof content === 'string' ? content : (Array.isArray(content) ? content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join(' ') : '');
      if (!text) continue;

      // Truncate to 50 chars, clean up
      let title = text.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
      if (title.length > 50) title = title.slice(0, 47) + '...';

      // Save title locally (CUI API ignores custom_name)
      saveTitle(conv.sessionId, title);
      updated++;
    } catch (err: any) {
      errors.push(`${conv.sessionId}: ${err.message}`);
    }
  }

  res.json({ ok: true, updated, total: allConvs.length, errors });
});

// 9. Commander context: gather cross-project state
app.get('/api/mission/context', async (_req, res) => {
  try {
    // Get all conversations with last 3 messages each
    const conversations: any[] = [];
    await Promise.all(CUI_PROXIES.map(async (proxy) => {
      const data = await cuiFetch(proxy.localPort, '/api/conversations?limit=20&sortBy=updated&order=desc');
      if (!data?.conversations) return;
      for (const c of data.conversations) {
        const detail = await cuiFetch(proxy.localPort, `/api/conversations/${c.sessionId}`);
        const rawMsgs = detail?.messages || [];
        const lastMsgs = rawMsgs.slice(-3).map((m: any) => ({
          role: m.message?.role || m.type || 'user',
          content: typeof m.message?.content === 'string' ? m.message.content.slice(0, 300) :
            Array.isArray(m.message?.content) ? m.message.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join(' ').slice(0, 300) : '',
        }));

        conversations.push({
          sessionId: c.sessionId,
          accountId: proxy.id,
          projectName: resolveProjectName(c.projectPath || ''),
          status: c.status || 'completed',
          customName: getTitle(c.sessionId) || c.sessionInfo?.custom_name || '',
          summary: (c.summary || '').slice(0, 200),
          messageCount: c.messageCount || 0,
          updatedAt: c.updatedAt || '',
          lastMessages: lastMsgs,
        });
      }
    }));

    // Get git status for each workspace
    const projects = readdirSync(PROJECTS_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => { try { return JSON.parse(readFileSync(join(PROJECTS_DIR, f), 'utf8')); } catch { return null; } })
      .filter(Boolean);

    const gitStatus: Record<string, { status: string; log: string }> = {};
    for (const p of projects) {
      if (!p.workDir || !isRemotePath(p.workDir)) continue;
      try {
        const [status, log] = await Promise.all([
          sshExec(`cd ${p.workDir} && git status --short 2>/dev/null || echo '(kein Git repo)'`),
          sshExec(`cd ${p.workDir} && git log --oneline -5 2>/dev/null || echo '(keine commits)'`),
        ]);
        gitStatus[p.id] = { status: status.trim(), log: log.trim() };
      } catch {
        gitStatus[p.id] = { status: '(SSH error)', log: '' };
      }
    }

    res.json({ conversations, gitStatus, projects });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 10. Commander context cache (60s TTL)
let _ctxCache: { data: any; ts: number } | null = null;
const CTX_CACHE_TTL = 60_000;

async function getCommanderContext(): Promise<any> {
  if (_ctxCache && Date.now() - _ctxCache.ts < CTX_CACHE_TTL) return _ctxCache.data;
  const resp = await fetch(`http://localhost:${PORT}/api/mission/context`);
  const data = await resp.json();
  _ctxCache = { data, ts: Date.now() };
  return data;
}

// Commander chat: LLM via Bridge (Haiku for speed)
app.post('/api/mission/commander', async (req, res) => {
  const { messages, context } = req.body;
  if (!messages || !Array.isArray(messages)) {
    res.status(400).json({ error: 'messages array required' });
    return;
  }

  const BRIDGE_URL = process.env.AI_BRIDGE_URL || 'http://49.12.72.66:8000';
  const BRIDGE_KEY = process.env.AI_BRIDGE_API_KEY;
  if (!BRIDGE_KEY) {
    res.status(500).json({ error: 'AI_BRIDGE_API_KEY not set' });
    return;
  }

  // Build system prompt with context
  let systemPrompt = `Du bist der Commander der CUI Mission Control. Du verwaltest mehrere Claude-Code-Instanzen über verschiedene Projekte.
Deine Aufgaben:
- Zusammenfassungen über alle Projekte geben
- Git-Änderungen analysieren
- Management Summaries erstellen
- Tasks an spezifische Workspaces dispatchen

Antworte auf Deutsch, präzise und kompakt.`;

  if (context) {
    try {
      const ctxData = await getCommanderContext();

      systemPrompt += `\n\n## Aktuelle Projekte\n`;
      for (const p of ctxData.projects || []) {
        systemPrompt += `- ${p.name} (${p.id}): ${p.workDir}\n`;
      }

      systemPrompt += `\n## Git Status\n`;
      for (const [pid, git] of Object.entries(ctxData.gitStatus || {})) {
        const g = git as { status: string; log: string };
        systemPrompt += `### ${pid}\nStatus: ${g.status}\nLog: ${g.log}\n\n`;
      }

      systemPrompt += `\n## Aktive Konversationen\n`;
      const active = (ctxData.conversations || []).filter((c: any) => c.status === 'ongoing');
      for (const c of active) {
        systemPrompt += `- [${c.accountId}] ${c.projectName}: ${c.customName || c.summary}\n`;
        for (const m of c.lastMessages || []) {
          systemPrompt += `  ${m.role}: ${m.content.slice(0, 100)}\n`;
        }
      }

      systemPrompt += `\n## Kürzliche Konversationen (letzte 20)\n`;
      for (const c of (ctxData.conversations || []).slice(0, 20)) {
        systemPrompt += `- [${c.status}] ${c.accountId}/${c.projectName}: ${c.customName || c.summary.slice(0, 80)}\n`;
      }
    } catch (err: any) {
      systemPrompt += `\n\n(Context konnte nicht geladen werden: ${err.message})`;
    }
  }

  try {
    const bridgeResp = await fetch(`${BRIDGE_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${BRIDGE_KEY}`,
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        messages: [
          { role: 'system', content: systemPrompt },
          ...messages,
        ],
        max_tokens: 4096,
      }),
    });

    if (!bridgeResp.ok) {
      const errBody = await bridgeResp.text();
      res.status(bridgeResp.status).json({ error: `Bridge error: ${errBody}` });
      return;
    }

    const data = await bridgeResp.json();
    res.json(data);
  } catch (err: any) {
    res.status(500).json({ error: `Bridge unreachable: ${err.message}` });
  }
});

// 11. Commander dispatch: start conversations in workspaces
app.post('/api/mission/commander/dispatch', async (req, res) => {
  const { actions } = req.body;
  if (!actions || !Array.isArray(actions)) {
    res.status(400).json({ error: 'actions array required' });
    return;
  }

  const results: any[] = [];
  for (const action of actions) {
    try {
      const startResp = await fetch(`http://localhost:${PORT}/api/mission/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accountId: action.accountId || 'rafael',
          workDir: action.workDir,
          subject: action.subject || '',
          message: action.message,
        }),
      });
      const result = await startResp.json();
      results.push({ ...action, ok: true, sessionId: result.sessionId });
    } catch (err: any) {
      results.push({ ...action, ok: false, error: err.message });
    }
  }

  res.json({ ok: true, results });
});

// --- Projects API ---
app.get('/api/projects', (_req, res) => {
  const projects = readdirSync(PROJECTS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try { return JSON.parse(readFileSync(join(PROJECTS_DIR, f), 'utf8')); }
      catch { return null; }
    })
    .filter(Boolean);
  res.json(projects);
});

app.post('/api/projects', async (req, res) => {
  const project = req.body;
  if (!project?.id) {
    res.status(400).json({ error: 'project id required' });
    return;
  }

  // Only auto-create remote workspace for NEW projects (no existing file)
  const projectFile = join(PROJECTS_DIR, `${project.id}.json`);
  const isNew = !existsSync(projectFile);

  if (isNew && !project.workDir) {
    // New project without explicit workDir: create remote workspace
    const remoteWorkDir = `/root/orchestrator/workspaces/${project.id}`;
    try {
      await execAsync(`ssh root@100.121.161.109 "mkdir -p ${remoteWorkDir}"`);
      project.workDir = remoteWorkDir;
      console.log(`[Project] Created remote workspace: ${remoteWorkDir}`);
    } catch (err: any) {
      console.error(`[Project] Failed to create remote workspace: ${err.message}`);
    }
  }

  writeFileSync(projectFile, JSON.stringify(project, null, 2));
  res.json({ ok: true });
});

app.delete('/api/projects/:id', (req, res) => {
  const filePath = join(PROJECTS_DIR, `${req.params.id}.json`);
  if (existsSync(filePath)) unlinkSync(filePath);
  // Also remove associated notes and layout
  const notePath = join(NOTES_DIR, `${req.params.id}.md`);
  if (existsSync(notePath)) unlinkSync(notePath);
  const layoutPath = join(LAYOUTS_DIR, `${req.params.id}.json`);
  if (existsSync(layoutPath)) unlinkSync(layoutPath);
  res.json({ ok: true });
});

// --- Notes API ---
// Common notes on a separate path to avoid clash with project ID 'common'
app.get('/api/common-notes', (_req, res) => {
  const notePath = join(NOTES_DIR, 'common.md');
  if (!existsSync(notePath)) { res.json({ content: '' }); return; }
  res.json({ content: readFileSync(notePath, 'utf8') });
});

app.post('/api/common-notes', (req, res) => {
  writeFileSync(join(NOTES_DIR, 'common.md'), req.body.content ?? '');
  res.json({ ok: true });
});

app.get('/api/notes/:projectId', (req, res) => {
  const notePath = join(NOTES_DIR, `${req.params.projectId}.md`);
  if (!existsSync(notePath)) { res.json({ content: '' }); return; }
  res.json({ content: readFileSync(notePath, 'utf8') });
});

app.post('/api/notes/:projectId', (req, res) => {
  writeFileSync(join(NOTES_DIR, `${req.params.projectId}.md`), req.body.content ?? '');
  res.json({ ok: true });
});

// Shared Notes: auto-generated credentials (read-only)
app.get('/api/shared-notes', (_req, res) => {
  const sharedPath = join(NOTES_DIR, 'shared.md');
  if (!existsSync(sharedPath)) {
    // Try generating on-the-fly
    const credPath = join(DATA_DIR, 'credentials.json');
    if (existsSync(credPath)) {
      try {
        const creds = JSON.parse(readFileSync(credPath, 'utf8'));
        const now = new Date().toISOString().split('T')[0];
        let md = `# Shared Notes - Zugangsdaten\n\n*Auto-generated: ${now}*\n\n---\n\n`;
        for (const [_appId, appData] of Object.entries(creds) as [string, any][]) {
          md += `## ${appData.name}`;
          if (appData.productionUrl) md += ` — [${appData.productionUrl}](${appData.productionUrl})`;
          md += `\n\n`;
          if (!appData.users?.length) { md += `*No users*\n\n`; continue; }
          md += `| Email | Password | Role | Notes |\n|-------|----------|------|-------|\n`;
          for (const u of appData.users) {
            md += `| ${u.email} | \`${u.password || '—'}\` | ${u.role || '—'} | ${u.notes || u.userId || '—'} |\n`;
          }
          if (appData.extras?.length) {
            md += `\n`;
            for (const e of appData.extras) md += `> ${e}\n`;
          }
          md += `\n---\n\n`;
        }
        md += `\n*Refresh: aggregate-credentials + generate-shared-notes*\n`;
        res.json({ content: md });
        return;
      } catch {}
    }
    res.json({ content: '' });
    return;
  }
  res.json({ content: readFileSync(sharedPath, 'utf8') });
});

// Shared Notes: trigger regeneration
app.post('/api/shared-notes/refresh', async (_req, res) => {
  const { exec } = await import('child_process');
  const cwd = process.cwd();
  exec('npx tsx scripts/aggregate-credentials.ts && npx tsx scripts/generate-shared-notes.ts', { cwd, timeout: 30000 }, (err, stdout, stderr) => {
    if (err) {
      console.error('[SharedNotes] Refresh failed:', stderr || err.message);
      res.status(500).json({ error: stderr || err.message });
      return;
    }
    console.log('[SharedNotes] Refreshed:', stdout);
    res.json({ ok: true, output: stdout });
  });
});

// --- Layout API ---
app.get('/api/layouts/:projectId', (req, res) => {
  const layoutPath = join(LAYOUTS_DIR, `${req.params.projectId}.json`);
  if (!existsSync(layoutPath)) { res.json(null); return; }
  try {
    res.json(JSON.parse(readFileSync(layoutPath, 'utf8')));
  } catch {
    res.json(null);
  }
});

app.post('/api/layouts/:projectId', (req, res) => {
  writeFileSync(join(LAYOUTS_DIR, `${req.params.projectId}.json`), JSON.stringify(req.body, null, 2));
  res.json({ ok: true });
});

// Layout template (the "blueprint" from Layout Builder, used for restore)
app.get('/api/layouts/:projectId/template', (req, res) => {
  const tplPath = join(LAYOUTS_DIR, `${req.params.projectId}_template.json`);
  if (!existsSync(tplPath)) { res.json(null); return; }
  try {
    res.json(JSON.parse(readFileSync(tplPath, 'utf8')));
  } catch {
    res.json(null);
  }
});

app.post('/api/layouts/:projectId/template', (req, res) => {
  writeFileSync(join(LAYOUTS_DIR, `${req.params.projectId}_template.json`), JSON.stringify(req.body, null, 2));
  res.json({ ok: true });
});

// --- Image Upload API ---
import { exec } from 'child_process';
import { promisify } from 'util';
const execAsync = promisify(exec);

// Remote server config (matches CUI_PROXIES)
const REMOTE_SERVERS: Record<string, string> = {
  rafael: '100.121.161.109',
  engelmann: '100.121.161.109',
  office: '100.121.161.109',
};
const REMOTE_IMG_DIR = '/tmp/cui-images';

app.post('/api/upload', (req, res) => {
  const { data, filename } = req.body;
  if (!data) {
    res.status(400).json({ error: 'data required (base64)' });
    return;
  }

  const ext = filename?.match(/\.[^.]+$/)?.[0] || '.png';
  const name = `${Date.now()}${ext}`;
  const filePath = join(UPLOADS_DIR, name);

  // Strip data URL prefix if present
  const base64Data = data.replace(/^data:image\/[^;]+;base64,/, '');
  writeFileSync(filePath, Buffer.from(base64Data, 'base64'));

  console.log(`[Upload] Saved ${name} (${Math.round(Buffer.from(base64Data, 'base64').length / 1024)}KB)`);
  res.json({ path: filePath, filename: name, url: `/api/uploads/${name}` });
});

// Upload images for CUI: saves locally + optionally sends to remote server
app.post('/api/images', async (req, res) => {
  const { images, accountId } = req.body as {
    images: { name: string; data: string }[];
    accountId: string;
  };

  if (!images?.length) {
    res.status(400).json({ error: 'images array required' });
    return;
  }

  const isRemote = accountId !== 'local' && REMOTE_SERVERS[accountId];
  const results: { localPath: string; remotePath?: string; name: string }[] = [];

  // Save all images locally first
  for (const img of images) {
    const ext = img.name?.match(/\.[^.]+$/)?.[0] || '.png';
    const safeName = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}${ext}`;
    const localPath = join(UPLOADS_DIR, safeName);
    const base64Data = img.data.replace(/^data:[^;]+;base64,/, '');
    writeFileSync(localPath, Buffer.from(base64Data, 'base64'));
    results.push({ localPath, name: safeName });
  }

  // Copy to /tmp/cui-images (local filesystem, no SCP needed)
  try {
    mkdirSync(REMOTE_IMG_DIR, { recursive: true });
    for (const r of results) {
      const dest = join(REMOTE_IMG_DIR, r.name);
      copyFileSync(r.localPath, dest);
      r.remotePath = dest;
    }
    console.log(`[Images] Saved ${results.length} images to ${REMOTE_IMG_DIR}`);
  } catch (err: any) {
    console.error(`[Images] Save failed: ${err.message}`);
    res.status(500).json({ error: `Save failed: ${err.message}` });
    return;
  }

  // Build the Read command for Claude
  const paths = results.map(r => isRemote ? r.remotePath! : r.localPath);
  const readCommand = paths.length === 1
    ? `Schau dir dieses Bild an: ${paths[0]}`
    : `Schau dir diese ${paths.length} Bilder an:\n${paths.map(p => `- ${p}`).join('\n')}`;

  res.json({
    ok: true,
    count: results.length,
    target: isRemote ? `remote (${REMOTE_SERVERS[accountId]})` : 'local',
    paths,
    readCommand,
    results,
  });
});

// Serve uploaded images
app.get('/api/uploads/:filename', (req, res) => {
  const filePath = join(UPLOADS_DIR, req.params.filename);
  if (!existsSync(filePath)) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  res.sendFile(filePath);
});

// Clean up old uploads (keep last 100)
app.delete('/api/uploads/cleanup', (_req, res) => {
  const files = readdirSync(UPLOADS_DIR)
    .map(f => ({ name: f, time: statSync(join(UPLOADS_DIR, f)).mtimeMs }))
    .sort((a, b) => b.time - a.time);
  let removed = 0;
  for (const f of files.slice(100)) {
    unlinkSync(join(UPLOADS_DIR, f.name));
    removed++;
  }
  res.json({ ok: true, removed });
});

// --- Team API (Virtual Office) ---
import { readdir, readFile } from 'fs/promises';
import { basename } from 'path';

// GET /api/team/personas
// Returns: PersonaCard[]
app.get('/api/team/personas', async (_req, res) => {
  // Use local path on macOS, remote path on server
  const personasPath = process.platform === 'darwin'
    ? '/Users/rafael/Documents/GitHub/orchestrator/team/personas'
    : '/root/projekte/orchestrator/team/personas';
  try {
    const files = await readdir(personasPath);
    const personaFiles = files.filter(f => f.endsWith('.md'));

    const personas = await Promise.all(
      personaFiles.map(async (file) => {
        const content = await readFile(join(personasPath, file), 'utf-8');
        return parsePersona(file, content);
      })
    );

    res.json(personas);
  } catch (err: any) {
    console.error('[Team API] Error loading personas:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/agents/persona/:id
// Returns: Single persona with full metadata
app.get('/api/agents/persona/:id', async (req, res) => {
  const personasPath = process.platform === 'darwin'
    ? '/Users/rafael/Documents/GitHub/orchestrator/team/personas'
    : '/root/projekte/orchestrator/team/personas';

  try {
    const personaFile = `${req.params.id}.md`;
    const personaPath = join(personasPath, personaFile);
    const content = await readFile(personaPath, 'utf-8');
    const persona = parsePersona(personaFile, content);

    // Add additional fields that parsePersona might not include
    const specialtyMatch = content.match(/\*\*Specialty\*\*:\s*(.+)/i);
    const mottoMatch = content.match(/>\s+"(.+?)"/);

    res.json({
      ...persona,
      specialty: specialtyMatch?.[1]?.trim(),
      motto: mottoMatch?.[1]?.trim()
    });
  } catch (err: any) {
    console.error(`[API] Persona not found: ${req.params.id}`, err);
    res.status(404).json({ error: 'Persona not found' });
  }
});

// GET /api/team/worklist/:personaId
// Returns: string (markdown content)
app.get('/api/team/worklist/:personaId', async (req, res) => {
  const { personaId } = req.params;
  const worklistPath = `/root/projekte/orchestrator/team/worklists/${personaId}.md`;

  try {
    const content = await readFile(worklistPath, 'utf-8');
    res.type('text/markdown').send(content);
  } catch (err: any) {
    console.error(`[Team API] Worklist not found for ${personaId}:`, err);
    res.status(404).send('Worklist not found');
  }
});

// GET /api/workspaces/:workspace/credentials
// Returns safe credential info (WITHOUT passwords!)
app.get('/api/workspaces/:workspace/credentials', async (req, res) => {
  try {
    const { workspace } = req.params;
    const registryPath = `/root/orchestrator/workspaces/${workspace}/CREDENTIALS.json`;

    if (!existsSync(registryPath)) {
      return res.status(404).json({
        error: 'Credential registry not found',
        workspace
      });
    }

    const registry = JSON.parse(readFileSync(registryPath, 'utf-8'));

    // NEVER send passwords to frontend!
    const safeRegistry = {
      app: registry.app,
      version: registry.version,
      updated: registry.updated,
      personas: Object.entries(registry.personas || {}).map(([key, persona]: [string, any]) => ({
        key,
        email: persona.email,
        role: persona.role,
        name: `${persona.firstname} ${persona.lastname}`,
        company: persona.company,
        description: persona.description,
        usage: persona.usage || ''
      })),
      expert_reviewers: Object.entries(registry.expert_reviewers || {}).map(([key, reviewer]: [string, any]) => ({
        key,
        name: `${reviewer.firstname} ${reviewer.lastname}`,
        email: reviewer.email,
        description: reviewer.description,
        persona_type: reviewer.persona_type,
        uses_herbert_login: reviewer.uses_herbert_login || false
      })),
      platform_defaults: Object.keys(registry.platform_defaults || {})
    };

    res.json(safeRegistry);
  } catch (error) {
    console.error('[Credentials API] Error loading credential registry:', error);
    res.status(500).json({ error: 'Failed to load credential registry' });
  }
});

// POST /api/workspaces/:workspace/credentials/validate
// Validates that a persona exists in registry
app.post('/api/workspaces/:workspace/credentials/validate', async (req, res) => {
  try {
    const { workspace } = req.params;
    const { persona } = req.body;

    if (!persona) {
      return res.status(400).json({ valid: false, error: 'Persona parameter required' });
    }

    const registryPath = `/root/orchestrator/workspaces/${workspace}/CREDENTIALS.json`;

    if (!existsSync(registryPath)) {
      return res.status(404).json({ valid: false, error: 'Registry not found' });
    }

    const registry = JSON.parse(readFileSync(registryPath, 'utf-8'));

    const personaExists = (
      (registry.personas && registry.personas[persona]) ||
      (registry.expert_reviewers && registry.expert_reviewers[persona]) ||
      (registry.platform_defaults && registry.platform_defaults[persona])
    );

    if (!personaExists) {
      return res.json({ valid: false, error: 'Persona not found' });
    }

    const personaData =
      registry.personas?.[persona] ||
      registry.expert_reviewers?.[persona] ||
      registry.platform_defaults?.[persona];

    res.json({
      valid: true,
      email: personaData.email,
      name: `${personaData.firstname || ''} ${personaData.lastname || ''}`.trim() || persona
    });

  } catch (error) {
    console.error('[Credentials API] Error validating persona:', error);
    res.status(500).json({ valid: false, error: 'Validation failed' });
  }
});

function parsePersona(filename: string, content: string): any {
  // Extract ID from filename: 'max-weber.md' → 'max'
  const id = basename(filename, '.md').split('-')[0];

  // Parse markdown for Name, Rolle, MBTI
  const nameMatch = content.match(/# (.+?) - (.+)/);
  const mbtiMatch = content.match(/\*\*MBTI\*\*:\s*(\w+)/i) || content.match(/MBTI:\s*(\w+)/i);

  // Parse Virtual Office Metadaten
  const teamMatch = content.match(/- \*\*Team\*\*:\s*(.+)/);
  const deptMatch = content.match(/- \*\*Department\*\*:\s*(.+)/);
  const tableMatch = content.match(/- \*\*Table\*\*:\s*(.+)/);
  const governanceMatch = content.match(/- \*\*Governance\*\*:\s*(.+)/);
  const reportsToMatch = content.match(/- \*\*ReportsTo\*\*:\s*(.+)/);

  return {
    id,
    name: nameMatch?.[1] || id,
    role: nameMatch?.[2] || 'Team Member',
    mbti: mbtiMatch?.[1] || 'XXXX',
    status: 'idle', // Default - später aus worklist parsen
    worklistPath: `/root/projekte/orchestrator/team/worklists/${id}.md`,
    lastUpdated: new Date().toISOString(),
    // Virtual Office Metadaten
    team: teamMatch?.[1]?.trim() || 'unassigned',
    department: deptMatch?.[1]?.trim() || 'General',
    table: tableMatch?.[1]?.trim() || 'general',
    governance: governanceMatch?.[1]?.trim() as 'auto-commit' | 'review-required' | undefined,
    reportsTo: reportsToMatch?.[1]?.trim() || null,
  };
}

// --- Task Management ---
interface Task {
  id: string;
  title: string;
  description: string;
  assignee: string;        // Persona ID
  status: 'backlog' | 'in_progress' | 'review' | 'done';
  priority: 'low' | 'medium' | 'high';
  documentRef?: string;    // Optional: Business-Doc Path
  createdAt: string;
  updatedAt: string;
}

let tasks: Task[] = [];  // In-Memory für MVP - später DB

// GET /api/team/tasks
app.get('/api/team/tasks', (req, res) => {
  const { assignee, status } = req.query;
  let filtered = tasks;

  if (assignee) filtered = filtered.filter(t => t.assignee === assignee);
  if (status) filtered = filtered.filter(t => t.status === status);

  res.json(filtered);
});

// POST /api/team/tasks
app.post('/api/team/tasks', (req, res) => {
  const task: Task = {
    id: Date.now().toString(),
    ...req.body,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  tasks.push(task);
  res.json(task);
});

// PATCH /api/team/tasks/:id
app.patch('/api/team/tasks/:id', (req, res) => {
  const task = tasks.find(t => t.id === req.params.id);
  if (!task) return res.status(404).send('Task not found');

  Object.assign(task, req.body);
  task.updatedAt = new Date().toISOString();
  res.json(task);
});

// DELETE /api/team/tasks/:id
app.delete('/api/team/tasks/:id', (req, res) => {
  const index = tasks.findIndex(t => t.id === req.params.id);
  if (index === -1) return res.status(404).send('Task not found');

  tasks.splice(index, 1);
  res.json({ ok: true });
});

// --- Persona Chat via AI-Bridge ---
// POST /api/team/chat/:personaId
app.post('/api/team/chat/:personaId', async (req, res) => {
  const { personaId } = req.params;
  const { message } = req.body;

  if (!message) {
    return res.status(400).json({ error: 'message required' });
  }

  try {
    // Load Persona System Prompt
    // Use local path on macOS, remote path on server
    const personasPath = process.platform === 'darwin'
      ? '/Users/rafael/Documents/GitHub/orchestrator/team/personas'
      : '/root/projekte/orchestrator/team/personas';
    const files = await readdir(personasPath);
    const personaFile = files.find(f => f.startsWith(personaId + '-') && f.endsWith('.md'));

    if (!personaFile) {
      return res.status(404).json({ error: 'Persona not found' });
    }

    const content = await readFile(join(personasPath, personaFile), 'utf-8');
    const systemPrompt = `Du bist ${personaId.toUpperCase()}.

${content}

Antworte im Stil dieser Persona. Beziehe dich auf deine Worklist und aktuelle Aufgaben.`;

    // Session ID: rafael-max (User-Persona)
    const sessionId = `rafael-${personaId}`;

    // Call Bridge with Session
    const BRIDGE_URL = process.env.AI_BRIDGE_URL || 'http://49.12.72.66:8000';
    const BRIDGE_KEY = process.env.AI_BRIDGE_API_KEY;

    if (!BRIDGE_KEY) {
      return res.status(500).json({ error: 'AI_BRIDGE_API_KEY not set' });
    }

    const bridgeResp = await fetch(`${BRIDGE_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${BRIDGE_KEY}`,
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5-20250929',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: message },
        ],
        max_tokens: 2048,
        temperature: 0.7,
        extra_body: { session_id: sessionId },
      }),
    });

    if (!bridgeResp.ok) {
      const errText = await bridgeResp.text();
      console.error('[Team Chat] Bridge error:', errText);
      return res.status(bridgeResp.status).json({ error: `Bridge error: ${errText}` });
    }

    const data = await bridgeResp.json();
    const assistantMessage = data.choices?.[0]?.message?.content || '';

    res.json({
      message: assistantMessage,
      sessionId,
    });
  } catch (err: any) {
    console.error('[Team Chat] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/team/chat/:personaId/history
app.get('/api/team/chat/:personaId/history', async (req, res) => {
  const { personaId } = req.params;
  const sessionId = `rafael-${personaId}`;

  try {
    const BRIDGE_URL = process.env.AI_BRIDGE_URL || 'http://49.12.72.66:8000';
    const BRIDGE_KEY = process.env.AI_BRIDGE_API_KEY;

    if (!BRIDGE_KEY) {
      return res.json({ messages: [] });
    }

    const response = await fetch(
      `${BRIDGE_URL}/v1/sessions/${sessionId}`,
      { headers: { Authorization: `Bearer ${BRIDGE_KEY}` }}
    );

    if (!response.ok) {
      return res.json({ messages: [] });
    }

    const session = await response.json();
    res.json({ messages: session.messages || [] });
  } catch (err: any) {
    console.error('[Team Chat History] Error:', err);
    res.json({ messages: [] });
  }
});

// --- Document Manager (Phase 3) - Registered at top-level imports ---
app.use('/api/team', documentManager);

// --- File Operations API ---

// Move/copy file to workspace (stage operation)
app.post('/api/files/move', async (req, res) => {
  const { sourcePath, targetDir, operation } = req.body as {
    sourcePath: string;
    targetDir: string;
    operation?: 'move' | 'copy';
  };

  if (!sourcePath || !targetDir) {
    res.status(400).json({ error: 'sourcePath and targetDir required' });
    return;
  }

  const op = operation || 'move';
  const sourceIsRemote = isRemotePath(sourcePath);
  const targetIsRemote = isRemotePath(targetDir);

  try {
    const sourceFilename = sourcePath.split('/').pop() || 'file';
    const targetPath = targetDir.endsWith('/')
      ? `${targetDir}${sourceFilename}`
      : `${targetDir}/${sourceFilename}`;

    // Both remote: SSH mv/cp
    if (sourceIsRemote && targetIsRemote) {
      const cmd = op === 'move' ? 'mv' : 'cp';
      await sshExec(`mkdir -p ${targetDir} && ${cmd} ${sourcePath} ${targetPath}`);
      broadcast({ type: 'file-change', path: targetPath, event: 'add' });
      if (op === 'move') {
        broadcast({ type: 'file-change', path: sourcePath, event: 'unlink' });
      }
      res.json({ ok: true, targetPath, operation: op, remote: true });
      return;
    }

    // Both local: fs.copyFileSync/renameSync
    if (!sourceIsRemote && !targetIsRemote) {
      const resolvedSource = resolvePath(sourcePath);
      const resolvedTarget = resolvePath(targetPath);
      const resolvedTargetDir = resolvePath(targetDir);

      if (!existsSync(resolvedSource)) {
        res.status(404).json({ error: 'source file not found' });
        return;
      }

      mkdirSync(resolvedTargetDir, { recursive: true });

      if (op === 'move') {
        const { renameSync } = await import('fs');
        renameSync(resolvedSource, resolvedTarget);
      } else {
        const { copyFileSync } = await import('fs');
        copyFileSync(resolvedSource, resolvedTarget);
      }

      broadcast({ type: 'file-change', path: resolvedTarget, event: 'add' });
      if (op === 'move') {
        broadcast({ type: 'file-change', path: resolvedSource, event: 'unlink' });
      }
      res.json({ ok: true, targetPath: resolvedTarget, operation: op, remote: false });
      return;
    }

    // Mixed (local→remote or remote→local): use scp
    if (sourceIsRemote && !targetIsRemote) {
      // Remote → Local: scp from server
      const resolvedTarget = resolvePath(targetPath);
      const resolvedTargetDir = resolvePath(targetDir);
      mkdirSync(resolvedTargetDir, { recursive: true });
      await execAsync(`scp root@${REMOTE_HOST}:${sourcePath} ${resolvedTarget}`);
      if (op === 'move') {
        await sshExec(`rm ${sourcePath}`);
        broadcast({ type: 'file-change', path: sourcePath, event: 'unlink' });
      }
      broadcast({ type: 'file-change', path: resolvedTarget, event: 'add' });
      res.json({ ok: true, targetPath: resolvedTarget, operation: op, mixed: 'remote→local' });
      return;
    }

    if (!sourceIsRemote && targetIsRemote) {
      // Local → Remote: scp to server
      const resolvedSource = resolvePath(sourcePath);
      if (!existsSync(resolvedSource)) {
        res.status(404).json({ error: 'source file not found' });
        return;
      }
      await sshExec(`mkdir -p ${targetDir}`);
      await execAsync(`scp ${resolvedSource} root@${REMOTE_HOST}:${targetPath}`);
      if (op === 'move') {
        unlinkSync(resolvedSource);
        broadcast({ type: 'file-change', path: resolvedSource, event: 'unlink' });
      }
      broadcast({ type: 'file-change', path: targetPath, event: 'add' });
      res.json({ ok: true, targetPath, operation: op, mixed: 'local→remote' });
      return;
    }

    res.status(500).json({ error: 'unreachable path logic' });
  } catch (err: any) {
    res.status(500).json({ error: `File operation failed: ${err.message}` });
  }
});

// --- CUI Sync (build + pm2 restart, optional git pull) ---
const WORKSPACE_ROOT = resolve(import.meta.dirname ?? __dirname, '..');
let _syncInProgress = false;

app.post('/api/cui-sync', async (_req, res) => {
  if (_syncInProgress) {
    res.status(409).json({ error: 'Sync already in progress' });
    return;
  }
  _syncInProgress = true;
  broadcast({ type: 'cui-sync', status: 'started' });

  const PATH_PREFIX = '/opt/homebrew/bin:/usr/local/bin:' + (process.env.PATH || '');
  const devEnv = { ...process.env, PATH: PATH_PREFIX, NODE_ENV: 'development' };
  const execOpts = { cwd: WORKSPACE_ROOT, env: devEnv, timeout: 120_000 };

  let gitResult = 'skipped';
  try {
    // 1. Git pull (best-effort: skip if dirty tree or no remote)
    try {
      const { stdout } = await execAsync('git pull 2>&1', execOpts);
      gitResult = stdout.trim();
    } catch {
      gitResult = 'skipped (uncommitted changes)';
    }
    broadcast({ type: 'cui-sync', status: 'pulled', detail: gitResult });

    // 2. npm install (NODE_ENV=development so devDependencies like vite get installed)
    await execAsync('npm install --prefer-offline 2>&1', execOpts);
    broadcast({ type: 'cui-sync', status: 'installing' });

    // 3. Build frontend
    const { stdout: buildOut } = await execAsync('npm run build 2>&1', { ...execOpts, env: { ...devEnv, NODE_ENV: 'production' } });
    const builtMatch = buildOut.match(/built in ([\d.]+s)/);
    broadcast({ type: 'cui-sync', status: 'built', detail: builtMatch?.[1] || 'ok' });

    _syncInProgress = false;
    _pendingChanges = []; // Clear pending changes after successful build
    res.json({ ok: true, git: gitResult, build: builtMatch?.[1] || 'ok' });

    // 4. Schedule pm2 restart (after response is sent)
    setTimeout(async () => {
      try {
        await execAsync('pm2 restart cui-workspace', { env: { ...process.env, PATH: PATH_PREFIX } });
      } catch (err: any) {
        console.error('[Sync] pm2 restart failed:', err.message);
      }
    }, 500);

  } catch (err: any) {
    _syncInProgress = false;
    broadcast({ type: 'cui-sync', status: 'error', detail: err.message });
    res.status(500).json({ error: err.message });
  }
});

// --- Change Detection: Watch src/ and server/, notify frontend (no auto-build) ---
let _pendingChanges: string[] = [];
let _changeDebounce: ReturnType<typeof setTimeout> | null = null;

const changeWatcher = watch([
  join(WORKSPACE_ROOT, 'src'),
  // join(WORKSPACE_ROOT, 'server'), // disabled: production mode
], {
  ignored: /(node_modules|dist|\.git|__pycache__)/,
  persistent: true,
  ignoreInitial: true,
  depth: 10,
});

changeWatcher.on('error', (err) => {
  console.warn('[ChangeWatch] Watcher error:', (err as NodeJS.ErrnoException).message);
});

changeWatcher.on('all', (event, filePath) => {
  if (!/\.(ts|tsx|css|html|json)$/.test(filePath)) return;
  if (filePath.includes('/dist/') || filePath.includes('/node_modules/')) return;
  const rel = relative(WORKSPACE_ROOT, filePath);
  console.log(`[ChangeWatch] ${event}: ${rel}`);
  if (!_pendingChanges.includes(rel)) _pendingChanges.push(rel);

  // Debounce: notify frontend after 2s quiet period
  if (_changeDebounce) clearTimeout(_changeDebounce);
  _changeDebounce = setTimeout(() => {
    broadcast({ type: 'cui-update-available', files: _pendingChanges.slice(0, 20), count: _pendingChanges.length });
    console.log(`[ChangeWatch] Update available: ${_pendingChanges.length} files changed`);
  }, 2000);
});

console.log('[ChangeWatch] Watching src/ and server/ for changes (notify-only, no auto-build)');

// API: get pending changes
app.get('/api/cui-sync/pending', (_req, res) => {
  res.json({ pending: _pendingChanges.length > 0, files: _pendingChanges.slice(0, 20), count: _pendingChanges.length, syncing: _syncInProgress });
});

// --- Control API ---
// All endpoints under /api/control/ for automated workspace steering

app.get('/api/control/health', (_req, res) => {
  res.json({
    ok: true,
    uptime: Math.floor((Date.now() - startTime) / 1000),
    wsClients: clients.size,
    cuiProxies: CUI_PROXIES.map(c => ({ id: c.id, port: c.localPort, target: c.target })),
    frontendConnected: clients.size > 0,
  });
});

app.get('/api/control/state', (_req, res) => {
  const projects = readdirSync(PROJECTS_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => { try { return JSON.parse(readFileSync(join(PROJECTS_DIR, f), 'utf8')); } catch { return null; } })
    .filter(Boolean);
  res.json({
    activeProjectId: workspaceState.activeProjectId,
    projects,
    cuiStates: workspaceState.cuiStates,
    panels: workspaceState.panels,
  });
});

app.post('/api/control/project/switch', (req, res) => {
  const { projectId } = req.body;
  if (!projectId) { res.status(400).json({ error: 'projectId required' }); return; }
  const projectFile = join(PROJECTS_DIR, `${projectId}.json`);
  if (!existsSync(projectFile)) { res.status(404).json({ error: `project ${projectId} not found` }); return; }
  workspaceState.activeProjectId = projectId;
  broadcast({ type: 'control:project-switch', projectId });
  res.json({ ok: true, projectId });
});

app.post('/api/control/cui/reload', (req, res) => {
  const { cuiId } = req.body;
  if (!cuiId) { res.status(400).json({ error: 'cuiId required' }); return; }
  broadcast({ type: 'control:cui-reload', cuiId });
  res.json({ ok: true, cuiId });
});

app.post('/api/control/cui/new', (req, res) => {
  const { cuiId } = req.body;
  if (!cuiId) { res.status(400).json({ error: 'cuiId required' }); return; }
  broadcast({ type: 'control:cui-new-conversation', cuiId });
  res.json({ ok: true, cuiId });
});

app.post('/api/control/cui/cwd', (req, res) => {
  const { cuiId, cwd } = req.body;
  if (!cuiId || !cwd) { res.status(400).json({ error: 'cuiId and cwd required' }); return; }
  broadcast({ type: 'control:cui-set-cwd', cuiId, cwd });
  res.json({ ok: true, cuiId, cwd });
});

// ============================================================
// ADMIN APIS - Werking Report Proxy
// ============================================================

const WR_PROD_URL = process.env.WERKING_REPORT_URL ?? 'https://werking-report.vercel.app';
const WR_STAGING_URL = process.env.WERKING_REPORT_STAGING_URL ?? 'https://werking-report-git-develop-rafael-engelmanns-projects.vercel.app';
const WR_ADMIN_SECRET = process.env.WERKING_REPORT_ADMIN_SECRET ?? process.env.ADMIN_SECRET ?? '';

// Runtime-switchable env mode (persists across restarts via file)
type WrEnvMode = 'production' | 'staging';
const WR_ENV_MODE_FILE = '/tmp/cui-wr-env-mode.json';
function loadWrEnvMode(): WrEnvMode {
  try {
    if (existsSync(WR_ENV_MODE_FILE)) {
      const data = JSON.parse(readFileSync(WR_ENV_MODE_FILE, 'utf8'));
      if (data.mode === 'staging') return 'staging';
    }
  } catch {}
  return 'production'; // default
}
function saveWrEnvMode(mode: WrEnvMode) {
  try { writeFileSync(WR_ENV_MODE_FILE, JSON.stringify({ mode })); } catch {}
}
let wrEnvMode: WrEnvMode = loadWrEnvMode();
function wrBase(): string { return wrEnvMode === 'staging' ? WR_STAGING_URL : WR_PROD_URL; }
console.log(`[WR Env] Loaded mode: ${wrEnvMode} → ${wrBase()}`);

function wrAdminHeaders(): Record<string, string> {
  if (!WR_ADMIN_SECRET) throw new Error('WERKING_REPORT_ADMIN_SECRET not set');
  return { 'x-admin-secret': WR_ADMIN_SECRET, 'Content-Type': 'application/json' };
}

// GET /api/admin/wr/env — current env mode
app.get('/api/admin/wr/env', (_req, res) => {
  res.json({ mode: wrEnvMode, urls: { production: WR_PROD_URL, staging: WR_STAGING_URL } });
});

// POST /api/admin/wr/env — switch env mode
app.post('/api/admin/wr/env', (req, res) => {
  const { mode } = req.body as { mode?: string };
  if (mode !== 'production' && mode !== 'staging') {
    res.status(400).json({ error: 'mode must be "production" or "staging"' });
    return;
  }
  wrEnvMode = mode;
  saveWrEnvMode(mode); // persist across restarts
  console.log(`[Admin Proxy] WR env switched to: ${wrEnvMode} → ${wrBase()}`);
  broadcast({ type: 'wr-env-changed', mode: wrEnvMode });
  res.json({ ok: true, mode: wrEnvMode, url: wrBase() });
});

app.get('/api/admin/wr/users', async (_req, res) => {
  try {
    const response = await fetch(`${wrBase()}/api/admin/users`, { headers: wrAdminHeaders() });
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (err: any) {
    console.error('[Admin Proxy] GET /api/admin/wr/users error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/wr/users/:id/approve', async (req, res) => {
  try {
    const response = await fetch(`${wrBase()}/api/admin/users/${req.params.id}/approve`, {
      method: 'POST', headers: wrAdminHeaders(),
    });
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (err: any) {
    console.error('[Admin Proxy] POST /api/admin/wr/users/:id/approve error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/wr/users/:id/verify', async (req, res) => {
  try {
    const response = await fetch(`${wrBase()}/api/admin/users/${req.params.id}/verify`, {
      method: 'POST', headers: wrAdminHeaders(),
    });
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (err: any) {
    console.error('[Admin Proxy] POST /api/admin/wr/users/:id/verify error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/wr/billing/overview', async (_req, res) => {
  try {
    const response = await fetch(`${wrBase()}/api/admin/billing/overview`, { headers: wrAdminHeaders() });
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (err: any) {
    console.error('[Admin Proxy] GET /api/admin/wr/billing/overview error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/wr/usage/stats', async (req, res) => {
  try {
    const period = req.query.period || 'month';
    const response = await fetch(`${wrBase()}/api/admin/usage/stats?period=${period}`, { headers: wrAdminHeaders() });
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (err: any) {
    console.error('[Admin Proxy] GET /api/admin/wr/usage/stats error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/wr/usage/activity', async (_req, res) => {
  try {
    const response = await fetch(`${wrBase()}/api/admin/usage/activity`, { headers: wrAdminHeaders() });
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (err: any) {
    console.error('[Admin Proxy] GET /api/admin/wr/usage/activity error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/wr/feedback', async (_req, res) => {
  try {
    const response = await fetch(`${wrBase()}/api/admin/feedback`, { headers: wrAdminHeaders() });
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (err: any) {
    console.error('[Admin Proxy] GET /api/admin/wr/feedback error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/wr/system-health', async (_req, res) => {
  try {
    const response = await fetch(`${wrBase()}/api/admin/system-health`, { headers: wrAdminHeaders() });
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (err: any) {
    console.error('[Admin Proxy] GET /api/admin/wr/system-health error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/wr/usage/trend', async (_req, res) => {
  try {
    const response = await fetch(`${wrBase()}/api/admin/usage/trend`, { headers: wrAdminHeaders() });
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (err: any) {
    console.error('[Admin Proxy] GET /api/admin/wr/usage/trend error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/ops/deployments — Vercel deployment status for all tracked apps
const VERCEL_APPS = [
  { name: 'werking-report', projectSlug: 'werking-report' },
  { name: 'werking-energy', projectSlug: 'werking-energy' },
  { name: 'platform', projectSlug: 'platform-werkingflow' },
  { name: 'engelmann', projectSlug: 'engelmann' },
  { name: 'tecc-safety', projectSlug: 'tecc-safety' },
];

app.get('/api/ops/deployments', async (_req, res) => {
  const VERCEL_TOKEN = process.env.VERCEL_TOKEN ?? '';
  if (!VERCEL_TOKEN) {
    res.status(500).json({ error: 'VERCEL_TOKEN not set' });
    return;
  }
  try {
    const results = await Promise.all(VERCEL_APPS.map(async (app) => {
      try {
        const url = `https://api.vercel.com/v6/deployments?projectId=${app.projectSlug}&limit=1&target=production`;
        const response = await fetch(url, {
          headers: { Authorization: `Bearer ${VERCEL_TOKEN}` },
        });
        if (!response.ok) {
          return { name: app.name, state: 'ERROR', error: `HTTP ${response.status}` };
        }
        const data: any = await response.json();
        const dep = data.deployments?.[0];
        if (!dep) return { name: app.name, state: 'UNKNOWN' };
        return {
          name: app.name,
          state: dep.state ?? 'UNKNOWN',
          url: dep.url ? `https://${dep.url}` : undefined,
          commitSha: dep.meta?.githubCommitSha?.slice(0, 7),
          commitMessage: dep.meta?.githubCommitMessage,
          ageMin: dep.createdAt ? Math.round((Date.now() - dep.createdAt) / 60000) : undefined,
        };
      } catch (err: any) {
        return { name: app.name, state: 'ERROR', error: err.message };
      }
    }));
    res.json({ deployments: results, checkedAt: new Date().toISOString() });
  } catch (err: any) {
    console.error('[Ops] GET /api/ops/deployments error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// Snapshot API - Capture current state of a panel as JSON
// ============================================================

interface PanelSnapshot {
  panel: string;
  capturedAt: string;
  data: unknown;
}

const panelSnapshots = new Map<string, PanelSnapshot>();

// POST /api/snapshot/:panel  — store snapshot from frontend
app.post('/api/snapshot/:panel', (req, res) => {
  const { panel } = req.params;
  const snapshot: PanelSnapshot = {
    panel,
    capturedAt: new Date().toISOString(),
    data: req.body,
  };
  panelSnapshots.set(panel, snapshot);
  broadcast({ type: 'snapshot-stored', panel, capturedAt: snapshot.capturedAt });
  res.json({ ok: true, panel, capturedAt: snapshot.capturedAt });
});

// GET /api/snapshot/:panel  — retrieve latest snapshot
app.get('/api/snapshot/:panel', (req, res) => {
  const { panel } = req.params;
  const snapshot = panelSnapshots.get(panel);
  if (!snapshot) {
    res.status(404).json({ error: `No snapshot for panel: ${panel}` });
    return;
  }
  res.json(snapshot);
});

// GET /api/snapshot  — list all stored panel snapshots
app.get('/api/snapshot', (_req, res) => {
  const list = Array.from(panelSnapshots.values()).map(s => ({
    panel: s.panel,
    capturedAt: s.capturedAt,
  }));
  res.json({ snapshots: list });
});

// POST /api/control/snapshot/request  — tell frontend to capture + POST a snapshot
app.post('/api/control/snapshot/request', (req, res) => {
  const { panel } = req.body;
  if (!panel) { res.status(400).json({ error: 'panel required' }); return; }
  broadcast({ type: 'control:snapshot-request', panel });
  res.json({ ok: true, panel, message: 'Snapshot request sent to frontend' });
});

// ============================================================
// Screenshot API — html2canvas-based panel screenshots
// ============================================================

const SCREENSHOT_DIR = '/tmp/cui-screenshots';
if (!existsSync(SCREENSHOT_DIR)) mkdirSync(SCREENSHOT_DIR, { recursive: true });

interface PanelScreenshot {
  panel: string;
  capturedAt: string;
  width: number;
  height: number;
  filePath: string;
}
const panelScreenshots = new Map<string, PanelScreenshot>();

// POST /api/screenshot/:panel — frontend posts PNG as base64
app.post('/api/screenshot/:panel', (req, res) => {
  const { panel } = req.params;
  const { dataUrl, width, height } = req.body as { dataUrl?: string; width?: number; height?: number };
  if (!dataUrl?.startsWith('data:image/png;base64,')) {
    res.status(400).json({ error: 'dataUrl (PNG base64) required' });
    return;
  }
  const base64 = dataUrl.replace('data:image/png;base64,', '');
  const filePath = `${SCREENSHOT_DIR}/${panel}-${Date.now()}.png`;
  // Keep only latest per panel — delete old one
  const prev = panelScreenshots.get(panel);
  if (prev?.filePath && existsSync(prev.filePath)) {
    try { unlinkSync(prev.filePath); } catch {}
  }
  writeFileSync(filePath, Buffer.from(base64, 'base64'));
  const meta: PanelScreenshot = { panel, capturedAt: new Date().toISOString(), width: width ?? 0, height: height ?? 0, filePath };
  panelScreenshots.set(panel, meta);
  broadcast({ type: 'screenshot-stored', panel, capturedAt: meta.capturedAt });
  console.log(`[Screenshot] Stored: ${panel} (${width}x${height}) → ${filePath}`);
  res.json({ ok: true, panel, capturedAt: meta.capturedAt, url: `/api/screenshot/${panel}.png` });
});

// GET /api/screenshot/:panel.png — serve PNG image directly
app.get('/api/screenshot/:panel.png', (req, res) => {
  const panel = req.params.panel;
  const meta = panelScreenshots.get(panel);
  if (!meta || !existsSync(meta.filePath)) {
    res.status(404).send('No screenshot for panel: ' + panel);
    return;
  }
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Content-Disposition', `inline; filename="${panel}-${meta.capturedAt.slice(0,10)}.png"`);
  res.send(readFileSync(meta.filePath));
});

// GET /api/screenshot/:panel — metadata only
app.get('/api/screenshot/:panel', (req, res) => {
  const { panel } = req.params;
  const meta = panelScreenshots.get(panel);
  if (!meta) { res.status(404).json({ error: 'No screenshot for panel: ' + panel }); return; }
  res.json({ panel: meta.panel, capturedAt: meta.capturedAt, width: meta.width, height: meta.height, url: `/api/screenshot/${panel}.png` });
});

// GET /api/screenshot — list all screenshots
app.get('/api/screenshot', (_req, res) => {
  const list = Array.from(panelScreenshots.values()).map(m => ({
    panel: m.panel, capturedAt: m.capturedAt, width: m.width, height: m.height,
    url: `/api/screenshot/${m.panel}.png`,
  }));
  res.json({ screenshots: list });
});

// POST /api/control/screenshot/request — trigger frontend to capture a panel screenshot
// panel: component name (e.g. "admin-wr") OR nodeId
// timeout: optional ms to wait before responding (default 3000)
app.post('/api/control/screenshot/request', async (req, res) => {
  const { panel, wait } = req.body as { panel?: string; wait?: number };
  if (!panel) { res.status(400).json({ error: 'panel required' }); return; }
  const waitMs = Math.min(wait ?? 3000, 15000);
  broadcast({ type: 'control:screenshot-request', panel });
  // Wait for screenshot to arrive (poll panelScreenshots)
  const before = panelScreenshots.get(panel)?.capturedAt;
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 200));
    const current = panelScreenshots.get(panel);
    if (current && current.capturedAt !== before) {
      res.json({ ok: true, panel, capturedAt: current.capturedAt, url: `/api/screenshot/${panel}.png` });
      return;
    }
  }
  res.status(408).json({ error: `Screenshot timeout after ${waitMs}ms — panel may not be visible` });
});

// GET /api/dev/screenshot-live — Server-side screenshot using Playwright (dev/debugging only)
app.get('/api/dev/screenshot-live', async (req, res) => {
  // Support both panel type (data-panel) and node ID (data-node-id)
  const panelType = req.query.panel as string;
  const nodeId = req.query.nodeId as string;
  const wait = Math.min(parseInt(req.query.wait as string) || 3000, 15000);

  if (!panelType && !nodeId) {
    res.status(400).json({ error: 'Either panel or nodeId required' });
    return;
  }

  try {
    const playwright = await import('playwright-core');
    const browser = await playwright.chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });

    const targetDesc = nodeId ? `node=${nodeId}` : `panel=${panelType}`;
    console.log(`[Screenshot] Opening http://localhost:4005 for ${targetDesc}...`);
    await page.goto('http://localhost:4005', { waitUntil: 'domcontentloaded', timeout: 20000 });

    // Wait for flexlayout
    await page.waitForSelector('.flexlayout__layout', { timeout: 5000 });

    // Build selector based on nodeId or panelType
    const selector = nodeId ? `[data-node-id="${nodeId}"]` : `[data-panel="${panelType}"]`;

    // Check if panel exists
    const panelExists = await page.locator(selector).count();
    if (panelExists === 0) {
      console.log(`[Screenshot] Panel ${targetDesc} not visible`);

      // If searching by panel type, try to add it via dropdown
      if (panelType && !nodeId) {
        console.log(`[Screenshot] Trying to add panel type ${panelType}...`);
        await page.evaluate((pt) => {
          const select = document.querySelector('select[title="Tab hinzufuegen"]') as HTMLSelectElement;
          if (select) {
            select.value = pt;
            select.dispatchEvent(new Event('change', { bubbles: true }));
          }
        }, panelType);
        await page.waitForTimeout(2000);
      } else {
        // If searching by node ID, try to activate the tab
        console.log(`[Screenshot] Trying to activate node ${nodeId}...`);
        await page.evaluate((nid) => {
          // Find tab with matching data-node-id and click it
          const allTabs = Array.from(document.querySelectorAll('.flexlayout__tab'));
          for (const tab of allTabs) {
            const content = tab.closest('.flexlayout__tabset')?.querySelector(`[data-node-id="${nid}"]`);
            if (content) {
              (tab as HTMLElement).click();
              break;
            }
          }
        }, nodeId);
        await page.waitForTimeout(1000);
      }
    }

    // Wait for panel to be visible
    await page.waitForSelector(selector, { timeout: 5000 });

    // Wait for content to load
    await page.waitForTimeout(wait);

    // Take screenshot
    const screenshot = await page.screenshot({ type: 'png', fullPage: false });
    await browser.close();

    // Save to file
    const fileName = nodeId ? `node-${nodeId}` : `panel-${panelType}`;
    const filePath = `${SCREENSHOT_DIR}/${fileName}-live-${Date.now()}.png`;
    writeFileSync(filePath, screenshot);

    console.log(`[Screenshot] ✓ Saved live screenshot: ${filePath}`);

    // Return as PNG image
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Content-Disposition', `inline; filename="${fileName}-live.png"`);
    res.send(screenshot);

  } catch (error: any) {
    console.error('[Screenshot] Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// List all panel node IDs from the current layout
app.get('/api/dev/panel-ids', async (req, res) => {
  try {
    const playwright = await import('playwright-core');
    const browser = await playwright.chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });

    await page.goto('http://localhost:4005', { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForSelector('.flexlayout__layout', { timeout: 5000 });

    // Extract all panel IDs and their types
    const panels = await page.evaluate(() => {
      const results: Array<{ nodeId: string; panelType: string | null; tabName: string | null }> = [];
      const allPanels = Array.from(document.querySelectorAll('[data-node-id]'));

      for (const panel of allPanels) {
        const nodeId = panel.getAttribute('data-node-id');
        const panelType = panel.getAttribute('data-panel');

        // Try to find the tab name
        let tabName: string | null = null;
        const tabs = Array.from(document.querySelectorAll('.flexlayout__tab'));
        for (const tab of tabs) {
          const tabContent = (tab as HTMLElement).closest('.flexlayout__tabset')?.querySelector(`[data-node-id="${nodeId}"]`);
          if (tabContent) {
            tabName = (tab as HTMLElement).querySelector('.flexlayout__tab_button_content')?.textContent?.trim() || null;
            break;
          }
        }

        if (nodeId) {
          results.push({ nodeId, panelType, tabName });
        }
      }
      return results;
    });

    await browser.close();

    res.json({ panels, count: panels.length });
  } catch (error: any) {
    console.error('[Panel IDs] Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/control/panel/add', (req, res) => {
  const { component, config, name } = req.body;
  if (!component) { res.status(400).json({ error: 'component required' }); return; }
  broadcast({ type: 'control:panel-add', component, config: config ?? {}, name: name ?? component });
  res.json({ ok: true, component, name: name ?? component });
});

app.post('/api/control/panel/remove', (req, res) => {
  const { nodeId } = req.body;
  if (!nodeId) { res.status(400).json({ error: 'nodeId required' }); return; }
  broadcast({ type: 'control:panel-remove', nodeId });
  res.json({ ok: true, nodeId });
});

app.post('/api/control/layout/reset', (_req, res) => {
  broadcast({ type: 'control:layout-reset' });
  res.json({ ok: true });
});

// --- Rebuild & Restart Endpoint ---
app.post('/api/rebuild', (_req, res) => {
  console.log('[Rebuild] Starting frontend rebuild...');
  broadcast({ type: 'cui-rebuilding' });
  res.json({ status: 'rebuilding', message: 'Build gestartet, Server startet gleich neu...' });
  setTimeout(() => {
    exec('cd /root/projekte/werkingflow/autopilot/cui && npx vite build 2>&1', (err, stdout) => {
      if (err) { console.error('[Rebuild] Build failed:', err.message); return; }
      console.log('[Rebuild] Build done:', stdout.trim().split('\n').pop());
      console.log('[Rebuild] Restarting server...');
      const wrSecret = process.env.WERKING_REPORT_ADMIN_SECRET ?? '';
      const wrUrl = process.env.WERKING_REPORT_URL ?? '';
      const wrStagingUrl = process.env.WERKING_REPORT_STAGING_URL ?? '';
      const vercelToken = process.env.VERCEL_TOKEN ?? '';
      const restartCmd = `cd /root/projekte/werkingflow/autopilot/cui && WERKING_REPORT_ADMIN_SECRET="${wrSecret}" WERKING_REPORT_URL="${wrUrl}" WERKING_REPORT_STAGING_URL="${wrStagingUrl}" VERCEL_TOKEN="${vercelToken}" NODE_ENV=production PORT=4005 nohup npx tsx server/index.ts > ~/cui-server.log 2>&1 &`;
      exec(restartCmd, () => {
        setTimeout(() => process.exit(0), 500);
      });
    });
  }, 200);
});

// --- Knowledge Registry (Document Knowledge System) ---
import knowledgeRegistryRouter from './knowledge-registry.js';
app.use('/api/team/knowledge', knowledgeRegistryRouter);

// --- Agent Monitoring & Control ---
import { spawn } from 'child_process';
import { promises as fsAgentPromises } from 'fs';

const AGENTS_DIR = '/root/projekte/werkingflow/team-agents';
const AGENT_REGISTRY: Record<string, { persona_id: string; persona_name: string; schedule: string }> = {
  kai: { persona_id: 'kai-hoffmann', persona_name: 'Kai Hoffmann', schedule: 'Mo 09:00' },
};
const runningAgents = new Set<string>();

async function agentReadJsonlLastN(filePath: string, n: number): Promise<any[]> {
  try {
    const content = await fsAgentPromises.readFile(filePath, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);
    return lines.slice(-n).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

app.get('/api/agents/status', async (_req, res) => {
  const agents = await Promise.all(Object.entries(AGENT_REGISTRY).map(async ([id, info]) => {
    const memory = await agentReadJsonlLastN(`${AGENTS_DIR}/memory/${info.persona_id}.jsonl`, 1);
    const last = memory[0] ?? null;
    let inboxCount = 0;
    try { const inbox = await fsAgentPromises.readFile(`${AGENTS_DIR}/inbox/${info.persona_id}.md`, 'utf-8'); inboxCount = inbox.split('---').filter(s => s.trim()).length; } catch { /**/ }
    let approvalsCount = 0;
    try { const raw = await fsAgentPromises.readFile(`${AGENTS_DIR}/approvals/pending.jsonl`, 'utf-8'); approvalsCount = raw.trim().split('\n').filter(Boolean).filter(l => { try { return JSON.parse(l).persona?.toLowerCase().includes(id.toLowerCase()); } catch { return false; } }).length; } catch { /**/ }
    let status: 'idle' | 'working' | 'error' = 'idle';
    if (runningAgents.has(id)) status = 'working';
    else if (last?.response_preview?.startsWith('ERROR:')) status = 'error';
    const now = new Date();
    const daysUntilMonday = now.getDay() === 1 ? 7 : (8 - now.getDay()) % 7 || 7;
    const nextRun = new Date(now); nextRun.setDate(now.getDate() + daysUntilMonday); nextRun.setHours(9, 0, 0, 0);
    return { id, persona_id: info.persona_id, persona_name: info.persona_name, schedule: info.schedule, status, last_run: last?.timestamp ?? null, last_actions: last?.actions ?? 0, last_action_types: last?.action_types ?? [], last_trigger: last?.trigger ?? null, next_run: nextRun.toISOString(), has_pending_approvals: approvalsCount > 0, approvals_count: approvalsCount, inbox_count: inboxCount };
  }));
  res.json({ agents });
});

app.get('/api/agents/memory/:personaId', async (req, res) => {
  const safe = req.params.personaId.replace(/[^a-z0-9-]/g, '');
  const n = Math.min(parseInt(String(req.query.n ?? '10'), 10), 50);
  const entries = await agentReadJsonlLastN(`${AGENTS_DIR}/memory/${safe}.jsonl`, n);
  res.json({ persona_id: safe, entries: entries.reverse() });
});

app.get('/api/agents/inbox/:personaId', async (req, res) => {
  const safe = req.params.personaId.replace(/[^a-z0-9-]/g, '');
  try {
    const content = await fsAgentPromises.readFile(`${AGENTS_DIR}/inbox/${safe}.md`, 'utf-8');
    const messages = content.split('\n---\n').filter(s => s.trim()).map(block => {
      const vonMatch = block.match(/\*\*Von:\*\*\s*(.+)/);
      const datumMatch = block.match(/\*\*Datum:\*\*\s*(.+)/);
      const body = block.replace(/\*\*Von:\*\*[^\n]+\n?/, '').replace(/\*\*Datum:\*\*[^\n]+\n?/, '').trim();
      return { from: vonMatch?.[1]?.trim() ?? 'Unknown', date: datumMatch?.[1]?.trim() ?? '', body };
    });
    res.json({ persona_id: safe, messages });
  } catch { res.json({ persona_id: safe, messages: [] }); }
});

app.get('/api/agents/approvals', async (_req, res) => {
  try {
    const raw = await fsAgentPromises.readFile(`${AGENTS_DIR}/approvals/pending.jsonl`, 'utf-8');
    const approvals = raw.trim().split('\n').filter(Boolean).map((l, i) => { try { return { index: i, ...JSON.parse(l) }; } catch { return null; } }).filter(Boolean);
    res.json({ approvals });
  } catch { res.json({ approvals: [] }); }
});

app.post('/api/agents/approve', async (req, res) => {
  const { index, execute } = req.body as { index: number; execute: boolean };
  try {
    const raw = await fsAgentPromises.readFile(`${AGENTS_DIR}/approvals/pending.jsonl`, 'utf-8');
    const lines = raw.trim().split('\n').filter(Boolean);
    if (index < 0 || index >= lines.length) return res.status(400).json({ error: 'Invalid index' });
    const entry = JSON.parse(lines[index]);
    lines.splice(index, 1);
    await fsAgentPromises.writeFile(`${AGENTS_DIR}/approvals/pending.jsonl`, lines.join('\n') + (lines.length ? '\n' : ''));
    if (execute && entry.type === 'bash') execAsync(entry.payload, { cwd: AGENTS_DIR, timeout: 30000 }).then(({stdout, stderr}) => console.log('[Approval] OK:', stdout || stderr)).catch(e => console.error('[Approval]', e.message));
    res.json({ ok: true, executed: execute && entry.type === 'bash' });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

app.post('/api/agents/trigger/:id', (req, res) => {
  const { id } = req.params;
  if (!AGENT_REGISTRY[id]) return res.status(404).json({ error: `Unknown agent: ${id}` });
  if (runningAgents.has(id)) return res.status(409).json({ error: 'Agent already running' });
  runningAgents.add(id);
  console.log(`[AgentTrigger] Starting: ${id}`);
  const proc = spawn('python3', ['scheduler.py', '--once', id], { cwd: AGENTS_DIR, detached: false, stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stdout?.on('data', (d: Buffer) => console.log(`[Agent:${id}]`, d.toString().trim()));
  proc.stderr?.on('data', (d: Buffer) => console.error(`[Agent:${id}]`, d.toString().trim()));
  proc.on('close', (code) => { runningAgents.delete(id); console.log(`[Agent:${id}] done (exit ${code})`); });
  res.json({ ok: true, agent_id: id, started_at: new Date().toISOString() });
});

app.get('/api/agents/briefs', async (_req, res) => {
  try {
    const files = await fsAgentPromises.readdir(`${AGENTS_DIR}/shared/weekly-briefs`);
    res.json({ briefs: files.filter(f => f.endsWith('.md')).sort().reverse().map(f => ({ name: f })) });
  } catch { res.json({ briefs: [] }); }
});

app.get('/api/agents/brief/:name', async (req, res) => {
  const safe = req.params.name.replace(/[^a-zA-Z0-9._-]/g, '');
  if (!safe.endsWith('.md')) return res.status(400).json({ error: 'Only .md files' });
  try {
    res.type('text/plain').send(await fsAgentPromises.readFile(`${AGENTS_DIR}/shared/weekly-briefs/${safe}`, 'utf-8'));
  } catch { res.status(404).json({ error: 'Not found' }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// Claude Code Agent Runner — 16 Personas, full filesystem access
// ─────────────────────────────────────────────────────────────────────────────
const PROMPTS_DIR = `${AGENTS_DIR}/prompts`;
const CLAUDE_LOGS_DIR = '/root/projekte/local-storage/backends/team-agents/logs';
const runningClaudes = new Map<string, ReturnType<typeof spawn>>();

// Activity Stream Broadcasting
const activityClients: ServerResponse[] = [];

function broadcastActivity(event: {
  timestamp: string;
  personaId: string;
  personaName: string;
  action: string; // "started", "completed", "error", "wrote", "messaged", "approved", "rejected"
  description: string;
  progress?: number;
}) {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  activityClients.forEach(client => {
    try {
      client.write(data);
    } catch (err) {
      // Client disconnected, will be cleaned up
    }
  });
  console.log(`[Activity] Broadcast: ${event.personaName} - ${event.action}`);
}

// POST /api/test/broadcast-activity — Test endpoint to manually broadcast activity
app.post('/api/test/broadcast-activity', (req, res) => {
  const event = req.body;
  if (!event.timestamp) event.timestamp = new Date().toISOString();
  broadcastActivity(event);
  res.json({ success: true, broadcast: event });
});


const CLAUDE_AGENT_REGISTRY: Record<string, { name: string; schedule: string; task_type: string }> = {
  'rafbot':          { name: 'Rafbot',           schedule: 'tägl. 06:00',    task_type: 'SYNC' },
  'kai-hoffmann':    { name: 'Kai Hoffmann',    schedule: 'Mo 09:00',       task_type: 'SCAN' },
  'birgit-bauer':    { name: 'Birgit Bauer',    schedule: 'Mo 10:00',       task_type: 'SYNC' },
  'max-weber':       { name: 'Max Weber',        schedule: 'Di 09:00',       task_type: 'DECIDE' },
  'vera-vertrieb':   { name: 'Vera Vertrieb',    schedule: 'Mo 11:00',       task_type: 'SCAN' },
  'herbert-sicher':  { name: 'Herbert Sicher',   schedule: 'tägl. 02:00',    task_type: 'SCAN' },
  'otto-operations': { name: 'Otto Operations',  schedule: 'Mi 09:00',       task_type: 'SYNC' },
  'mira-marketing':  { name: 'Mira Marketing',   schedule: 'Di 10:00',       task_type: 'PRODUCE' },
  'felix-krause':    { name: 'Felix Krause',     schedule: 'Fr 14:00',       task_type: 'REVIEW' },
  'anna-frontend':   { name: 'Anna Frontend',    schedule: 'on-demand',      task_type: 'PRODUCE' },
  'tim-berger':      { name: 'Tim Berger',       schedule: 'on-demand',      task_type: 'PRODUCE' },
  'chris-customer':  { name: 'Chris Customer',   schedule: 'tägl. 08:00',    task_type: 'SCAN' },
  'finn-finanzen':   { name: 'Finn Finanzen',    schedule: '1. des Monats',  task_type: 'REVIEW' },
  'lisa-mueller':    { name: 'Lisa Müller',      schedule: 'Mo 08:00',       task_type: 'REVIEW' },
  'peter-doku':      { name: 'Peter Doku',       schedule: 'Fr 10:00',       task_type: 'PRODUCE' },
  'sarah-koch':      { name: 'Sarah Koch',       schedule: 'on-demand',      task_type: 'REVIEW' },
  'klaus-schmidt':   { name: 'Klaus Schmidt',    schedule: 'Mi 09:00',       task_type: 'REVIEW' },
};

app.get('/api/agents/claude/status', async (_req, res) => {
  const readSafe = async (p: string, fb = '') => { try { return await fsAgentPromises.readFile(p, 'utf-8'); } catch { return fb; } };
  const agents = await Promise.all(Object.entries(CLAUDE_AGENT_REGISTRY).map(async ([id, info]) => {
    let last_run: string | null = null; let last_outcome = '';
    try {
      const lines = (await fsAgentPromises.readFile(`${AGENTS_DIR}/memory/${id}.jsonl`, 'utf-8')).trim().split('\n').filter(Boolean);
      const last = JSON.parse(lines[lines.length - 1]);
      last_run = last.timestamp ?? null; last_outcome = (last.outcome ?? '').slice(0, 100);
    } catch { /**/ }
    let inbox_count = 0;
    try { inbox_count = ((await fsAgentPromises.readFile(`${AGENTS_DIR}/inbox/${id}.md`, 'utf-8')).match(/^---$/gm) ?? []).length; } catch { /**/ }
    return { id, name: info.name, schedule: info.schedule, task_type: info.task_type, status: runningClaudes.has(id) ? 'working' : 'idle' as const, last_run, last_outcome, inbox_count };
  }));
  res.json({ agents });
});

app.post('/api/agents/claude/run', async (req, res) => {
  const { persona_id, task, mode, plan_id } = req.body as { persona_id: string; task?: string; mode?: 'plan' | 'execute'; plan_id?: string };
  const runMode = mode ?? 'plan'; // Default: plan first
  if (!CLAUDE_AGENT_REGISTRY[persona_id]) return res.status(404).json({ error: `Unknown persona: ${persona_id}` });
  if (runningClaudes.has(persona_id)) return res.status(409).json({ error: 'Already running' });
  const info = CLAUDE_AGENT_REGISTRY[persona_id];
  const taskId = `${persona_id}-${Date.now()}`;
  const logFile = `${CLAUDE_LOGS_DIR}/${taskId}.log`;
  await fsAgentPromises.mkdir(CLAUDE_LOGS_DIR, { recursive: true });
  const readSafe = async (p: string, fb = '') => { try { return await fsAgentPromises.readFile(p, 'utf-8'); } catch { return fb; } };
  const basePrompt    = await readSafe(`${PROMPTS_DIR}/_base_system.md`);
  const personaPrompt = await readSafe(`${PROMPTS_DIR}/${persona_id}.md`, `Du bist ${info.name} bei Werkingflow.`);
  const memory        = await readSafe(`${AGENTS_DIR}/memory/${persona_id}.summary.md`, 'Erster Durchlauf — kein vorheriges Memory.');
  const inbox         = await readSafe(`${AGENTS_DIR}/inbox/${persona_id}.md`, 'Keine Nachrichten.');
  const now           = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const taskDesc      = task ?? `Führe deinen regulären ${info.task_type}-Zyklus durch.`;

  let fullPrompt = '';
  if (runMode === 'plan') {
    // PLAN MODE: Agent soll nur planen, nicht ausführen
    const planFile = `${AGENTS_DIR}/plans/${persona_id}-${Date.now()}.md`;
    fullPrompt = [
      basePrompt, '---', personaPrompt, '---',
      '## Dein Memory (bisherige Runs)', memory,
      '## Deine Inbox', inbox, '---',
      `## Aktuelle Aufgabe — PLAN MODE\n**Datum:** ${now}  **Task-Typ:** ${info.task_type}\n**Aufgabe:** ${taskDesc}`,
      '',
      '**WICHTIG: Du bist im PLAN-Modus. Führe NICHTS aus!**',
      '',
      'Deine Aufgabe:',
      '1. Analysiere die Aufgabe gründlich',
      '2. Lies relevante Dateien (Read tool) um den aktuellen Stand zu verstehen',
      '3. Erstelle einen detaillierten Umsetzungs-Plan',
      '4. Schreibe den Plan nach: ' + planFile,
      '',
      'Der Plan muss enthalten:',
      '- Was genau gemacht werden soll',
      '- Welche Dateien gelesen/geschrieben werden',
      '- Welche Bash-Commands ausgeführt werden',
      '- Welche Personas benachrichtigt werden',
      '',
      'Am Ende: PLAN_COMPLETE: [Ein-Satz-Zusammenfassung]',
    ].join('\n\n');
  } else {
    // EXECUTE MODE: Agent führt approved Plan aus
    const planContent = plan_id ? await readSafe(`${AGENTS_DIR}/plans/${plan_id}.md`, 'Kein Plan gefunden.') : '';
    fullPrompt = [
      basePrompt, '---', personaPrompt, '---',
      '## Dein Memory (bisherige Runs)', memory,
      '## Deine Inbox', inbox, '---',
      `## Aktuelle Aufgabe — EXECUTE MODE\n**Datum:** ${now}  **Task-Typ:** ${info.task_type}\n**Aufgabe:** ${taskDesc}`,
      '',
      '## Dein genehmigter Plan',
      planContent,
      '',
      '**Führe jetzt den Plan aus. Du hast volle Berechtigung.**',
      '',
      'Arbeite systematisch durch den Plan. Schreibe am Ende deinen Memory-Record und das AGENT_COMPLETE Signal.',
    ].join('\n\n');
  }
  // Remove CLAUDECODE env var so nested claude sessions are allowed
  const spawnEnv = { ...process.env };
  delete (spawnEnv as Record<string, string | undefined>).CLAUDECODE;
  const proc = spawn('claude', ['--dangerously-skip-permissions', '--print', '-p', fullPrompt], { cwd: '/root/projekte/werkingflow', stdio: ['ignore', 'pipe', 'pipe'], env: spawnEnv });
  const writeLog = (s: string) => fsAgentPromises.appendFile(logFile, s).catch(() => {});
  writeLog(`[${now}] ${info.name} gestartet — ${taskDesc}\n${'─'.repeat(60)}\n\n`);

  // Broadcast agent started
  broadcastActivity({
    timestamp: new Date().toISOString(),
    personaId: persona_id,
    personaName: info.name,
    action: 'started',
    description: taskDesc,
    progress: 0
  });

  proc.stdout?.on('data', (d: Buffer) => writeLog(d.toString()));
  proc.stderr?.on('data', (d: Buffer) => writeLog(`[ERR] ${d.toString()}`));
  proc.on('close', (code) => {
    runningClaudes.delete(persona_id);
    writeLog(`\n${'─'.repeat(60)}\n[DONE] Exit: ${code}\n`);
    console.log(`[ClaudeAgent:${persona_id}] done (${code})`);

    // Broadcast agent completed or error
    broadcastActivity({
      timestamp: new Date().toISOString(),
      personaId: persona_id,
      personaName: info.name,
      action: code === 0 ? 'completed' : 'error',
      description: code === 0 ? `${runMode} completed successfully` : `Exited with code ${code}`,
      progress: code === 0 ? 100 : undefined
    });
  });
  runningClaudes.set(persona_id, proc);
  console.log(`[ClaudeAgent] Starting ${persona_id} (${runMode}) → ${logFile}`);
  const planFile = runMode === 'plan' ? `${persona_id}-${Date.now()}.md` : (plan_id ?? null);
  res.json({ ok: true, task_id: taskId, persona_id, log_file: logFile, mode: runMode, plan_file: planFile });
});

app.get('/api/agents/claude/log/:taskId', async (req, res) => {
  const safe = req.params.taskId.replace(/[^a-zA-Z0-9._-]/g, '');
  const logFile = `${CLAUDE_LOGS_DIR}/${safe}.log`;
  res.setHeader('Content-Type', 'text/event-stream'); res.setHeader('Cache-Control', 'no-cache'); res.setHeader('Connection', 'keep-alive');
  try { res.write(`data: ${JSON.stringify({ text: await fsAgentPromises.readFile(logFile, 'utf-8'), init: true })}\n\n`); } catch { /**/ }
  const tail = spawn('tail', ['-f', '-n', '0', logFile]);
  tail.stdout?.on('data', (d: Buffer) => res.write(`data: ${JSON.stringify({ text: d.toString() })}\n\n`));
  req.on('close', () => tail.kill());
});

app.get('/api/agents/claude/memory/:personaId', async (req, res) => {
  const id = req.params.personaId.replace(/[^a-z0-9-]/g, '');
  const summary = await (async () => { try { return await fsAgentPromises.readFile(`${AGENTS_DIR}/memory/${id}.summary.md`, 'utf-8'); } catch { return 'Kein Memory.'; } })();
  const raw = await (async () => { try { return await fsAgentPromises.readFile(`${AGENTS_DIR}/memory/${id}.jsonl`, 'utf-8'); } catch { return ''; } })();
  const runs = raw.trim().split('\n').filter(Boolean).slice(-10).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).reverse();
  res.json({ summary, runs });
});

// GET /api/agents/claude/plan/:planFile — read a plan file
app.get('/api/agents/claude/plan/:planFile', async (req, res) => {
  const safe = req.params.planFile.replace(/[^a-zA-Z0-9._-]/g, '');
  if (!safe.endsWith('.md')) return res.status(400).json({ error: 'Only .md files' });
  try {
    const content = await fsAgentPromises.readFile(`${AGENTS_DIR}/plans/${safe}`, 'utf-8');
    res.type('text/plain').send(content);
  } catch { res.status(404).json({ error: 'Plan not found' }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// Business Approval System — .pending files must be approved by Rafael
// ─────────────────────────────────────────────────────────────────────────────
const BUSINESS_DIR = '/root/projekte/werkingflow/business';
const BUSINESS_QUEUE = `${BUSINESS_DIR}/.pending-queue.jsonl`;

// GET /api/agents/business/pending — list all pending business changes
app.get('/api/agents/business/pending', async (_req, res) => {
  try {
    const raw = await fsAgentPromises.readFile(BUSINESS_QUEUE, 'utf-8');
    const pending = raw.trim().split('\n').filter(Boolean).map((l, i) => {
      try {
        const entry = JSON.parse(l);
        return { index: i, ...entry };
      } catch { return null; }
    }).filter(Boolean);
    res.json({ pending });
  } catch { res.json({ pending: [] }); }
});

// POST /api/agents/business/approve — approve a pending change
app.post('/api/agents/business/approve', async (req, res) => {
  const { index, commit_message } = req.body as { index: number; commit_message?: string };
  try {
    const raw = await fsAgentPromises.readFile(BUSINESS_QUEUE, 'utf-8');
    const lines = raw.trim().split('\n').filter(Boolean);
    if (index >= lines.length) return res.status(404).json({ error: 'Entry not found' });
    const entry = JSON.parse(lines[index]);
    const pendingPath = entry.file;
    const finalPath = pendingPath.replace(/\.pending$/, '');

    // Move .pending → final
    await fsAgentPromises.rename(pendingPath, finalPath);

    // Remove from queue
    lines.splice(index, 1);
    await fsAgentPromises.writeFile(BUSINESS_QUEUE, lines.join('\n') + (lines.length > 0 ? '\n' : ''));

    // Broadcast approval event
    broadcastActivity({
      timestamp: new Date().toISOString(),
      personaId: entry.persona || 'unknown',
      personaName: entry.persona || 'Unknown',
      action: 'approved',
      description: `Document approved: ${finalPath.replace(`${BUSINESS_DIR}/`, '')}`,
      progress: 100
    });

    // Auto-commit (approved option from questions)
    const message = commit_message ?? `Approved by Rafael: ${finalPath.replace(`${BUSINESS_DIR}/`, '')}`;
    const { execAsync } = await import('child_process');
    const { promisify } = await import('util');
    const exec = promisify(execAsync);
    try {
      await exec(`cd ${BUSINESS_DIR} && git add "${finalPath}" && git commit -m "${message}"`, { timeout: 10000 });
    } catch (gitErr) {
      console.warn('[BusinessApprove] Git commit failed:', gitErr);
      // Non-fatal — file is still moved
    }

    res.json({ ok: true, file: finalPath });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// POST /api/agents/business/reject — reject a pending change
app.post('/api/agents/business/reject', async (req, res) => {
  const { index } = req.body as { index: number };
  try {
    const raw = await fsAgentPromises.readFile(BUSINESS_QUEUE, 'utf-8');
    const lines = raw.trim().split('\n').filter(Boolean);
    if (index >= lines.length) return res.status(404).json({ error: 'Entry not found' });
    const entry = JSON.parse(lines[index]);

    // Delete .pending file
    await fsAgentPromises.unlink(entry.file).catch(() => {});

    // Remove from queue
    lines.splice(index, 1);
    await fsAgentPromises.writeFile(BUSINESS_QUEUE, lines.join('\n') + (lines.length > 0 ? '\n' : ''));

    // Broadcast rejection event
    broadcastActivity({
      timestamp: new Date().toISOString(),
      personaId: entry.persona || 'unknown',
      personaName: entry.persona || 'Unknown',
      action: 'rejected',
      description: `Document rejected: ${entry.file.replace(`${BUSINESS_DIR}/`, '')}`,
      progress: 0
    });

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// GET /api/agents/persona/:id — get individual persona data
app.get('/api/agents/persona/:id', async (req, res) => {
  try {
    const personaPath = `${AGENTS_DIR}/personas/${req.params.id}.md`;
    const content = await fsAgentPromises.readFile(personaPath, 'utf-8');

    const persona: Record<string, any> = { id: req.params.id };

    // Parse header
    const headerMatch = content.match(/^#\s+(.+?)\s+-\s+(.+?)$/m);
    if (headerMatch) {
      persona.name = headerMatch[1].trim();
      persona.role = headerMatch[2].trim();
    }

    // Parse MBTI
    const mbtiMatch = content.match(/\*\*MBTI\*\*:\s+(.+?)$/m);
    if (mbtiMatch) persona.mbti = mbtiMatch[1].trim();

    // Parse Specialty
    const specialtyMatch = content.match(/\*\*Specialty\*\*:\s+(.+?)$/m);
    if (specialtyMatch) persona.specialty = specialtyMatch[1].trim();

    // Parse Team
    const teamMatch = content.match(/\*\*Team\*\*:\s+(.+?)$/m);
    if (teamMatch) persona.team = teamMatch[1].trim();

    // Parse Motto
    const mottoMatch = content.match(/>\s+"(.+?)"/);
    if (mottoMatch) persona.motto = mottoMatch[1].trim();

    res.json(persona);
  } catch (err) {
    res.status(404).json({ error: 'Persona not found' });
  }
});

// GET /api/agents/business/diff/:file — get diff for a .pending file
app.get(/^\/api\/agents\/business\/diff\/(.+)$/, async (req, res) => {
  const filePath = req.params[0];
  const pendingPath = `${BUSINESS_DIR}/${filePath}`;
  const finalPath = pendingPath.replace(/\.pending$/, '');
  try {
    const pendingContent = await fsAgentPromises.readFile(pendingPath, 'utf-8');
    let finalContent = '';
    try {
      finalContent = await fsAgentPromises.readFile(finalPath, 'utf-8');
    } catch { /* file doesn't exist yet */ }
    res.json({ pending: pendingContent, final: finalContent });
  } catch (err) {
    res.status(404).json({ error: 'File not found' });
  }
});

// ============================================================================
// API COMMAND SYSTEM - Complete programmatic control
// ============================================================================

// POST /api/commands/run-agent — Run any agent with optional test mode
app.post('/api/commands/run-agent', async (req, res) => {
  const { persona_id, task, test_mode } = req.body as { persona_id: string; task?: string; test_mode?: boolean };

  try {
    // If test_mode, prepend test instruction to task
    let finalTask = task || '';
    if (test_mode) {
      finalTask = `[TEST MODE] Generate dummy test data for the Virtual Office:\n- Create sample approvals\n- Write test inbox messages\n- Generate sample reports\n\nOriginal task: ${task || 'General testing'}`;
    }

    const response = await fetch(`http://localhost:${PORT}/api/agents/claude/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ persona_id, mode: 'plan', task: finalTask })
    });

    const data = await response.json();
    res.json({ success: true, ...data });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/commands/approve-all — Approve all pending items
app.post('/api/commands/approve-all', async (_req, res) => {
  try {
    const raw = await fsAgentPromises.readFile(BUSINESS_QUEUE, 'utf-8');
    const lines = raw.trim().split('\n').filter(Boolean);
    const approved: string[] = [];

    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(lines[i]);
        const pendingPath = entry.file;
        const finalPath = pendingPath.replace(/\.pending$/, '');
        await fsAgentPromises.rename(pendingPath, finalPath);
        approved.push(finalPath);
      } catch (err) {
        console.error(`[ApproveAll] Failed to approve index ${i}:`, err);
      }
    }

    // Clear queue
    await fsAgentPromises.writeFile(BUSINESS_QUEUE, '');

    res.json({ success: true, approved_count: approved.length, files: approved });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/commands/trigger-rafbot-test — Special endpoint to trigger Rafbot in test mode
app.post('/api/commands/trigger-rafbot-test', async (_req, res) => {
  try {
    const response = await fetch(`http://localhost:${PORT}/api/commands/run-agent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        persona_id: 'rafbot',
        test_mode: true,
        task: 'Fill the Virtual Office with test data to demonstrate all features'
      })
    });

    const data = await response.json();
    res.json(data);
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/commands/status — Get complete system status
app.get('/api/commands/status', async (_req, res) => {
  try {
    // Get agent status
    const agentsResponse = await fetch(`http://localhost:${PORT}/api/agents/claude/status`);
    const agentsData = await agentsResponse.json();

    // Get pending approvals
    const pendingResponse = await fetch(`http://localhost:${PORT}/api/agents/business/pending`);
    const pendingData = await pendingResponse.json();

    // Count inbox messages
    let totalInboxCount = 0;
    const inboxDir = `${AGENTS_DIR}/inbox`;
    try {
      const inboxFiles = await fsAgentPromises.readdir(inboxDir);
      for (const file of inboxFiles.filter(f => f.endsWith('.md'))) {
        const content = await fsAgentPromises.readFile(`${inboxDir}/${file}`, 'utf-8');
        const count = (content.match(/^---$/gm) || []).length;
        totalInboxCount += count;
      }
    } catch { /* inbox dir might not exist */ }

    res.json({
      agents: {
        total: agentsData.agents?.length || 0,
        working: agentsData.agents?.filter((a: any) => a.status === 'working').length || 0,
        idle: agentsData.agents?.filter((a: any) => a.status === 'idle').length || 0,
      },
      approvals: {
        pending: pendingData.pending?.length || 0
      },
      inbox: {
        total_messages: totalInboxCount
      },
      timestamp: new Date().toISOString()
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/agents/activity-stream — SSE stream of agent activities
app.get('/api/agents/activity-stream', (_req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Add client to broadcast list
  activityClients.push(res);
  console.log(`[Activity] Client connected (total: ${activityClients.length})`);

  // Send initial ping
  res.write(`data: ${JSON.stringify({ timestamp: new Date().toISOString(), action: 'connected' })}\n\n`);

  // Keepalive ping every 30 seconds
  const interval = setInterval(() => {
    try {
      res.write(`data: ${JSON.stringify({ timestamp: new Date().toISOString(), action: 'ping' })}\n\n`);
    } catch (err) {
      clearInterval(interval);
    }
  }, 30000);

  // Cleanup on client disconnect
  _req.on('close', () => {
    clearInterval(interval);
    const index = activityClients.indexOf(res);
    if (index > -1) {
      activityClients.splice(index, 1);
      console.log(`[Activity] Client disconnected (total: ${activityClients.length})`);
    }
  });
});

// GET /api/agents/recommendations — smart action recommendations
app.get('/api/agents/recommendations', async (_req, res) => {
  try {
    const urgent: Array<any> = [];
    const recommended: Array<any> = [];

    // Check business approvals for old items
    try {
      const raw = await fsAgentPromises.readFile(BUSINESS_QUEUE, 'utf-8');
      const lines = raw.trim().split('\n').filter(Boolean);
      const pending = lines.map(l => JSON.parse(l));

      pending.forEach(entry => {
        const ageMs = Date.now() - new Date(entry.timestamp).getTime();
        const ageDays = Math.floor(ageMs / 86400000);

        if (ageDays > 3) {
          urgent.push({
            title: `Business approval overdue: ${entry.file.split('/').pop().replace('.pending', '')}`,
            description: `Pending for ${ageDays} days - blocking ${entry.persona}`,
            ageDays,
            personaId: entry.persona
          });
        }
      });
    } catch {}

    // TODO: Add more recommendation logic (overdue agents, idle agents, etc.)

    res.json({ urgent, recommended, tips: { idle_agents: 0, blocking_count: urgent.length } });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// GET /api/claude-code/stats-v2 — Claude Code JSONL usage stats (Account-based)
app.get('/api/claude-code/stats-v2', async (_req, res) => {
  try {
    const claudeDir = join(homedir(), '.claude', 'projects');
    if (!existsSync(claudeDir)) {
      res.json({ error: 'No Claude Code data found', accounts: [], alerts: [] });
      return;
    }

    // Load scraped usage data (from scrape-claude-usage.ts)
    let scrapedData: Record<string, any> = {};
    const scrapedPath = join(import.meta.dirname ?? __dirname, 'claude-usage-scraped.json');
    try {
      if (existsSync(scrapedPath)) {
        const scrapedContent = readFileSync(scrapedPath, 'utf-8');
        const scrapedArray = JSON.parse(scrapedContent);
        // Convert array to account-keyed object
        scrapedArray.forEach((item: any) => {
          scrapedData[item.account] = item;
        });
      }
    } catch (err) {
      console.error('[CC-Usage] Failed to load scraped data:', err);
    }

    // Account-to-Workspace mapping (Claude Code limits are per account, not per workspace!)
    const ACCOUNT_MAP: Record<string, string[]> = {
      'rafael': [
        '-root-orchestrator-workspaces-administration',
        '-root-orchestrator-workspaces-team',
        '-root-orchestrator-workspaces-diverse',
        '-root-projekte-orchestrator',
      ],
      'office': [
        '-root-orchestrator-workspaces-werking-report',
        '-root-orchestrator-workspaces-werking-energy',
        '-root-orchestrator-workspaces-werkingsafety',
      ],
      'engelmann': [
        '-root-orchestrator-workspaces-engelmann-ai-hub',
      ],
      'local': [
        '-root-projekte-werkingflow',
        '-tmp',
      ],
    };

    // Reverse mapping: workspace -> account
    const workspaceToAccount: Record<string, string> = {};
    Object.entries(ACCOUNT_MAP).forEach(([account, workspaces]) => {
      workspaces.forEach(ws => workspaceToAccount[ws] = account);
    });

    interface WorkspaceData {
      name: string;
      sessions: number;
      tokens: number;
      inputTokens: number;
      outputTokens: number;
      cacheCreation: number;
      cacheRead: number;
      lastActivity: number | null;
      models: Record<string, number>;
      storageBytes: number;
      timestamps: number[]; // For 5h-window detection
    }

    const workspaceData: Record<string, WorkspaceData> = {};

    // Parse all workspaces
    const entries = readdirSync(claudeDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const workspacePath = join(claudeDir, entry.name);
      const jsonlFiles = readdirSync(workspacePath)
        .filter(f => f.endsWith('.jsonl') && !f.includes('/subagents/'));

      let inputTokens = 0;
      let outputTokens = 0;
      let cacheCreation = 0;
      let cacheRead = 0;
      let lastActivity: number | null = null;
      const models: Record<string, number> = {};
      let storageBytes = 0;
      const timestamps: number[] = [];

      // Parse each JSONL file
      for (const jsonlFile of jsonlFiles) {
        const jsonlPath = join(workspacePath, jsonlFile);
        storageBytes += statSync(jsonlPath).size;

        try {
          const content = readFileSync(jsonlPath, 'utf-8');
          const lines = content.trim().split('\n').filter(Boolean);

          for (const line of lines) {
            try {
              const entry = JSON.parse(line);

              // Track timestamps for 5h-window detection
              if (entry.timestamp) {
                const ts = new Date(entry.timestamp).getTime();
                timestamps.push(ts);
                if (!lastActivity || ts > lastActivity) {
                  lastActivity = ts;
                }
              }

              // Aggregate token usage
              const usage = entry.usage || entry.message?.usage;
              if (usage) {
                inputTokens += usage.input_tokens ?? 0;
                outputTokens += usage.output_tokens ?? 0;
                cacheCreation += usage.cache_creation_input_tokens ?? 0;
                cacheRead += usage.cache_read_input_tokens ?? 0;
              }

              // Track model usage
              if (entry.message?.model) {
                models[entry.message.model] = (models[entry.message.model] ?? 0) + 1;
              }
            } catch {}
          }
        } catch {}
      }

      workspaceData[entry.name] = {
        name: entry.name,
        sessions: jsonlFiles.length,
        tokens: inputTokens + outputTokens,
        inputTokens,
        outputTokens,
        cacheCreation,
        cacheRead,
        lastActivity,
        models,
        storageBytes,
        timestamps: timestamps.sort((a, b) => a - b), // Sort chronologically
      };
    }

    // Aggregate by account
    const accounts: Array<{
      accountName: string;
      workspaces: string[];
      totalTokens: number;
      totalSessions: number;
      totalInputTokens: number;
      totalOutputTokens: number;
      totalCacheCreation: number;
      totalCacheRead: number;
      lastActivity: string | null;
      models: Record<string, number>;
      storageBytes: number;
      burnRatePerHour: number;
      weeklyProjection: number;
      weeklyLimitPercent: number;
      status: 'safe' | 'warning' | 'critical';
      nextWindowReset: string | null;
      currentWindowTokens: number;
    }> = [];

    const now = Date.now();
    const weekStart = now - (7 * 24 * 60 * 60 * 1000);
    const WEEKLY_LIMIT = 10_000_000; // ~10M tokens/week for Pro (conservative estimate)
    const WINDOW_5H = 5 * 60 * 60 * 1000;

    Object.entries(ACCOUNT_MAP).forEach(([accountName, workspaceNames]) => {
      let totalTokens = 0;
      let totalSessions = 0;
      let totalInput = 0;
      let totalOutput = 0;
      let totalCacheCreation = 0;
      let totalCacheRead = 0;
      let lastActivity: number | null = null;
      const models: Record<string, number> = {};
      let storageBytes = 0;
      const allTimestamps: number[] = [];

      workspaceNames.forEach(wsName => {
        const ws = workspaceData[wsName];
        if (!ws) return;

        totalTokens += ws.tokens;
        totalSessions += ws.sessions;
        totalInput += ws.inputTokens;
        totalOutput += ws.outputTokens;
        totalCacheCreation += ws.cacheCreation;
        totalCacheRead += ws.cacheRead;
        storageBytes += ws.storageBytes;
        allTimestamps.push(...ws.timestamps);

        if (ws.lastActivity && (!lastActivity || ws.lastActivity > lastActivity)) {
          lastActivity = ws.lastActivity;
        }

        Object.entries(ws.models).forEach(([model, count]) => {
          models[model] = (models[model] ?? 0) + count;
        });
      });

      // Calculate burn rate (tokens/hour) - last 24h only
      const last24h = now - (24 * 60 * 60 * 1000);
      const recentTokens = allTimestamps.filter(ts => ts >= last24h).length * 50; // Rough estimate: 50 tokens/message
      const burnRatePerHour = recentTokens / 24;

      // Weekly projection
      const tokensThisWeek = allTimestamps.filter(ts => ts >= weekStart).length * 50;
      const daysElapsed = Math.max(1, (now - weekStart) / (24 * 60 * 60 * 1000));
      const dailyAverage = tokensThisWeek / daysElapsed;
      const weeklyProjection = dailyAverage * 7;
      const weeklyLimitPercent = (weeklyProjection / WEEKLY_LIMIT) * 100;

      // 5h-window detection: find latest message cluster
      let nextWindowReset: number | null = null;
      let currentWindowTokens = 0;
      if (allTimestamps.length > 0) {
        const sorted = [...allTimestamps].sort((a, b) => b - a); // Newest first
        const latestTimestamp = sorted[0];

        // Find all messages in current 5h window
        const windowStart = latestTimestamp - WINDOW_5H;
        const windowMessages = sorted.filter(ts => ts >= windowStart);
        currentWindowTokens = windowMessages.length * 50; // Rough estimate

        // Next reset = 5h after first message in window
        const oldestInWindow = Math.min(...windowMessages);
        nextWindowReset = oldestInWindow + WINDOW_5H;
      }

      // Apply scraped data if available (real limits from claude.ai)
      const scraped = scrapedData[accountName];
      let finalWeeklyPercent = weeklyLimitPercent;
      let finalWeeklyLimit = WEEKLY_LIMIT;
      let finalWindowReset = nextWindowReset;
      let dataSource: 'jsonl-estimated' | 'scraped' | 'hybrid' = 'jsonl-estimated';

      if (scraped && scraped.weeklyAllModels && scraped.weeklyAllModels.percent !== null) {
        // Use real scraped weekly percent from claude.ai/settings/usage
        finalWeeklyPercent = scraped.weeklyAllModels.percent;
        dataSource = 'scraped';

        // Calculate actual limit from scraped percent
        if (totalTokens > 0 && finalWeeklyPercent > 0) {
          finalWeeklyLimit = Math.round((totalTokens / (finalWeeklyPercent / 100)));
        }

        // Use scraped session reset if available
        if (scraped.currentSession && scraped.currentSession.resetIn) {
          try {
            // Parse relative time like "in 4 Std. 15 Min." or absolute date
            const resetStr = scraped.currentSession.resetIn;
            if (resetStr.includes('Std.') || resetStr.includes('Min.')) {
              // Relative time parsing would go here
              // For now, keep JSONL-based estimate
            } else {
              finalWindowReset = new Date(resetStr).getTime();
            }
          } catch {}
        }
      }

      // Status determination (use final percent)
      let status: 'safe' | 'warning' | 'critical' = 'safe';
      if (finalWeeklyPercent > 80) status = 'critical';
      else if (finalWeeklyPercent > 60) status = 'warning';

      accounts.push({
        accountName,
        workspaces: workspaceNames.filter(ws => workspaceData[ws]),
        totalTokens,
        totalSessions,
        totalInputTokens: totalInput,
        totalOutputTokens: totalOutput,
        totalCacheCreation,
        totalCacheRead,
        lastActivity: lastActivity ? new Date(lastActivity).toISOString() : null,
        models,
        storageBytes,
        burnRatePerHour: Math.round(burnRatePerHour),
        weeklyProjection: Math.round(weeklyProjection),
        weeklyLimitPercent: Math.round(finalWeeklyPercent * 10) / 10,
        weeklyLimitActual: finalWeeklyLimit,
        status,
        nextWindowReset: finalWindowReset ? new Date(finalWindowReset).toISOString() : null,
        currentWindowTokens: Math.round(currentWindowTokens),
        dataSource,
        scrapedTimestamp: scraped?.timestamp || null,
      });
    });

    // Sort by status (critical first) then by last activity
    accounts.sort((a, b) => {
      const statusOrder = { critical: 0, warning: 1, safe: 2 };
      if (statusOrder[a.status] !== statusOrder[b.status]) {
        return statusOrder[a.status] - statusOrder[b.status];
      }
      if (!a.lastActivity && !b.lastActivity) return 0;
      if (!a.lastActivity) return 1;
      if (!b.lastActivity) return -1;
      return new Date(b.lastActivity).getTime() - new Date(a.lastActivity).getTime();
    });

    // Generate alerts
    const alerts: Array<{ severity: 'critical' | 'warning' | 'info'; title: string; description: string; accountName: string }> = [];

    accounts.forEach(acc => {
      if (acc.status === 'critical') {
        const daysUntilLimit = ((WEEKLY_LIMIT - acc.weeklyProjection) / acc.burnRatePerHour / 24);
        alerts.push({
          severity: 'critical',
          title: `Account "${acc.accountName}" critical`,
          description: `${acc.weeklyLimitPercent}% of weekly limit projected. Limit reached in ~${Math.max(0, daysUntilLimit).toFixed(1)} days at current burn rate (${acc.burnRatePerHour.toLocaleString()} tok/h).`,
          accountName: acc.accountName,
        });
      } else if (acc.status === 'warning') {
        alerts.push({
          severity: 'warning',
          title: `Account "${acc.accountName}" warning`,
          description: `${acc.weeklyLimitPercent}% of weekly limit projected. Monitor usage closely.`,
          accountName: acc.accountName,
        });
      }

      // Window reset alerts
      if (acc.nextWindowReset && acc.currentWindowTokens > 800_000) {
        const resetIn = new Date(acc.nextWindowReset).getTime() - now;
        const hoursUntilReset = Math.max(0, resetIn / (60 * 60 * 1000));
        alerts.push({
          severity: 'info',
          title: `5h-Window active on "${acc.accountName}"`,
          description: `${(acc.currentWindowTokens / 1000).toFixed(0)}K tokens in current window. Reset in ${hoursUntilReset.toFixed(1)}h.`,
          accountName: acc.accountName,
        });
      }
    });

    res.json({
      accounts,
      alerts,
      weeklyLimit: WEEKLY_LIMIT,
      timestamp: new Date().toISOString(),
    });
  } catch (err: any) {
    res.status(500).json({ error: `Failed to parse Claude Code data: ${err.message}` });
  }
});

// --- Serve Frontend in Production ---
if (PROD) {
  const distPath = resolve(import.meta.dirname ?? __dirname, '..', 'dist');

  // Watchdog proxy: /watchdog/* -> localhost:9090
  app.use('/watchdog', (req, res) => {
    const targetUrl = 'http://localhost:9090' + req.url;
    const proxyReq = httpRequest(targetUrl, { method: req.method, headers: req.headers }, (proxyRes) => {
      res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
      proxyRes.pipe(res);
    });
    proxyReq.on('error', () => res.status(502).send('Watchdog not available'));
    req.pipe(proxyReq);
  });

  if (existsSync(distPath)) {
    // Prevent HTML caching — ensures new JS bundles are always loaded after rebuild
    app.use((req, res, next) => {
      if (req.path === '/' || req.path.endsWith('.html')) {
        res.set('Cache-Control', 'no-store, must-revalidate');
      }
      next();
    });
    app.use(express.static(distPath));
    // SPA fallback
    app.use((_req, res) => {
      res.set('Cache-Control', 'no-store');
      res.sendFile(join(distPath, 'index.html'));
    });
  }
}

// --- Knowledge Watcher (File Monitoring) ---
import { KnowledgeWatcher } from './knowledge-watcher.js';
const knowledgeWatcher = new KnowledgeWatcher({
  base_path: '/root/projekte/werkingflow/business',
  ignore_patterns: ['**/archive/**', '**/_archiv/**', '**/.DS_Store', '**/*.pdf', '**/*.html'],
  debounce_ms: 2000,
  auto_scan_threshold: 5,
});
knowledgeWatcher.start();

process.on('SIGTERM', () => {
  knowledgeWatcher.stop();
  process.exit(0);
});

// --- Start ---
server.listen(PORT, () => {
  console.log(`CUI Workspace ${PROD ? '(production)' : '(dev)'} on http://localhost:${PORT}`);
});

import { readFileSync as _readEnvFile, existsSync as _envExists } from 'fs';
import { resolve as _resolvePath } from 'path';
// Load .env from CUI root (relative to this file)
const _envPath = _resolvePath(import.meta.dirname ?? '.', '..', '.env');
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
import { readFileSync, readdirSync, statSync, existsSync, mkdirSync, writeFileSync, unlinkSync, rmSync, appendFileSync, copyFileSync } from 'fs';
import { homedir } from 'os';
import { spawn } from 'child_process';
import { watch } from 'chokidar';
import { createConnection } from 'net';
import mime from 'mime-types';
import httpProxy from 'http-proxy';
import documentManager, { registerWebSocketClient } from './document-manager.js';
import * as metricsDb from './metrics-db.js';

const PORT = parseInt(process.env.PORT ?? '4005', 10);
const PROD = process.env.NODE_ENV === 'production';

// --- CUI Reverse Proxies ---
// Each CUI account gets a local proxy port so iframes load same-origin (no cookie issues)
const CUI_PROXIES = [
  { id: 'rafael',    localPort: 5001, target: 'http://localhost:4001' },
  { id: 'engelmann', localPort: 5002, target: 'http://localhost:4002' },
  { id: 'office',    localPort: 5003, target: 'http://localhost:4003' },
  { id: 'local',     localPort: 5004, target: 'http://localhost:4004' },
];

// SSE proxy: monitors upstream for attention markers (plan/question/done).
// CRITICAL: Only sends SSE headers to browser if upstream has an active stream (200 OK).
// For dead streams (non-200), forwards the error response so the CUI app knows there's no stream.
// This prevents the SSE reconnect loop that causes the "Stopschild" (disabled input) bug.
function sseProxy(targetBase: string, req: IncomingMessage, res: ServerResponse, cuiId?: string) {
  const streamId = req.url!.split('/api/stream/')[1]?.slice(0, 8) ?? '?';
  const url = new URL(req.url!, targetBase);
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (v && typeof v === 'string') headers[k] = v;
  }
  headers.host = url.host;
  delete headers['accept-encoding'];

  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let browserHeadersSent = false;

  // Connect to upstream FIRST — only send SSE headers to browser if upstream is alive
  const proxyReq = httpRequest(url, { method: req.method, headers }, (proxyRes) => {
    // Dead stream: upstream returns non-200 → forward error to browser (no SSE pretending)
    if (proxyRes.statusCode !== 200) {
      console.log(`[SSE] ${streamId} upstream ${proxyRes.statusCode} — forwarding error (${cuiId || 'no-id'})`);
      res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
      proxyRes.pipe(res);
      return;
    }

    // Active stream: send SSE headers to browser, start monitoring
    console.log(`[SSE] → Monitor-only ${streamId} (${cuiId || 'no-id'})`);
    browserHeadersSent = true;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Credentials': 'true',
    });
    res.write(':ok\n\n');
    heartbeat = setInterval(() => { res.write(':\n\n'); }, 30000);

    let chunkCount = 0;

    proxyRes.on('data', (chunk: Buffer) => {
      chunkCount++;
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
      if (heartbeat) clearInterval(heartbeat);
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
    if (heartbeat) clearInterval(heartbeat);
    console.error(`[SSE] ✗ Error ${streamId}:`, err.message);
    if (!browserHeadersSent) {
      // Never sent SSE headers — return proper error so CUI app doesn't retry
      if (!res.headersSent) res.writeHead(502);
      res.end();
    } else {
      // SSE was active — close browser connection
      if (cuiId) broadcast({ type: 'cui-state', cuiId, state: 'done' });
      res.end();
    }
  });

  req.on('close', () => {
    if (heartbeat) clearInterval(heartbeat);
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

// Check if a just-started session immediately hit a rate limit
// CUI binary writes a synthetic error entry to JSONL and exits within 3s
function checkSessionForRateLimit(sessionId: string, cuiId: string, delayMs = 5000) {
  setTimeout(() => {
    try {
      const projectsDir = join("/home/claude-user/.claude/projects");
      if (!existsSync(projectsDir)) return;
      const dirs = readdirSync(projectsDir);
      for (const dir of dirs) {
        const jsonlPath = join(projectsDir, dir, sessionId + ".jsonl");
        if (!existsSync(jsonlPath)) continue;
        const content = readFileSync(jsonlPath, "utf-8");
        const lines = content.trim().split("\n").filter(Boolean);
        // Check last few lines for rate limit indicators
        for (let i = lines.length - 1; i >= Math.max(0, lines.length - 3); i--) {
          try {
            const entry = JSON.parse(lines[i]);
            const isSynthetic = entry.message?.model === "<synthetic>" || entry.isApiErrorMessage === true;
            if (isSynthetic) {
              const errorText = entry.message?.content?.[0]?.text || entry.error || "Rate limit reached";
              console.log("[RateLimit] " + cuiId + " session " + sessionId.slice(0, 8) + ": " + errorText.slice(0, 100));
              broadcast({ type: "cui-state", cuiId, state: "error", message: "Rate Limit: Account hat das Nutzungslimit erreicht. Bitte anderen Account verwenden." });
              broadcast({ type: "cui-rate-limit-hit", cuiId, sessionId, error: errorText });
              setSessionState(cuiId, cuiId, "idle", "rate_limit");
              return;
            }
          } catch { /* skip */ }
        }
      }
    } catch (err) {
      console.error("[RateLimit] Check failed:", (err as Error).message);
    }
  }, delayMs);
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
  // MutationObserver for instant detection, no polling fallback (performance-safe)
  var _pfPending=false;
  var _pfDark=null;
  function _pfIsDark(){
    try{
      var bg=getComputedStyle(document.body).backgroundColor;
      var m=bg.match(/\d+/g);
      if(m&&m.length>=3){var lum=(parseInt(m[0])*299+parseInt(m[1])*587+parseInt(m[2])*114)/1000;return lum<128;}
    }catch(e){}
    return true;
  }
  // Detect theme once (not on every call — saves getComputedStyle)
  setTimeout(function(){_pfDark=_pfIsDark();},1000);
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
  var _pfTimer=null;
  function schedulePF(){
    if(_pfTimer) return;
    _pfTimer=setTimeout(function(){_pfTimer=null;_pfPending=false;formatPlanBlocks();},2000);
  }
  // MutationObserver: debounced to 2s to avoid layout thrashing during typing
  var planObs=new MutationObserver(schedulePF);
  if(document.body) planObs.observe(document.body,{childList:true,subtree:true});
  else document.addEventListener('DOMContentLoaded',function(){planObs.observe(document.body,{childList:true,subtree:true});});

  // --- Rate Limit Detection ---
  // PERF FIX: Use targeted querySelector instead of document.body.innerText (which forces full layout recalc)
  var _rlLast=false;
  function checkRateLimit(){
    // Look for rate limit indicators via targeted selectors (cheap) instead of innerText (very expensive)
    var limited=false;
    try{
      // CUI app shows rate limit in a banner/dialog — check for specific elements
      var banners=document.querySelectorAll('[role="alert"], [class*="error"], [class*="limit"], [class*="banner"]');
      for(var i=0;i<banners.length;i++){
        var txt=banners[i].textContent||'';
        if(txt.indexOf("hit your limit")>-1||txt.indexOf("rate limit")>-1){limited=true;break;}
      }
      // Fallback: check h1/h2 headers only (much cheaper than full innerText)
      if(!limited){
        var headers=document.querySelectorAll('h1,h2,h3');
        for(var i=0;i<headers.length;i++){
          var txt=headers[i].textContent||'';
          if(txt.indexOf("hit your limit")>-1||txt.indexOf("rate limit")>-1){limited=true;break;}
        }
      }
    }catch(e){}
    if(limited!==_rlLast){
      _rlLast=limited;
      try{window.parent.postMessage({type:'cui-rate-limit',limited:limited},'*');}catch(e){}
    }
  }
  setInterval(checkRateLimit,10000); // Reduced from 3s to 10s (rate limits don't need fast detection)
  setTimeout(checkRateLimit,5000);

  // --- Stale Conversation Recovery ---
  var _staleNotified=false;
  function checkStaleConversation(){
    if(_staleNotified) return;
    if(!location.pathname.startsWith('/c/')) return;
    // Use targeted check instead of innerText
    try{
      var banners=document.querySelectorAll('[role="alert"], [class*="error"], [class*="not-found"]');
      for(var i=0;i<banners.length;i++){
        if((banners[i].textContent||'').indexOf('not found')>-1){
          _staleNotified=true;
          try{window.parent.postMessage({type:'cui-stale-conversation',pathname:location.pathname},'*');}catch(e){}
          return;
        }
      }
      // Fallback: check page title area
      var h=document.querySelector('h1,h2,[class*="title"]');
      if(h&&(h.textContent||'').indexOf('not found')>-1){
        _staleNotified=true;
        try{window.parent.postMessage({type:'cui-stale-conversation',pathname:location.pathname},'*');}catch(e){}
      }
    }catch(e){}
  }
  setTimeout(checkStaleConversation,3000);
  setTimeout(checkStaleConversation,8000);
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

    // SSE streams: pass through normal proxy (CUI app needs real stream data for input/output).
    // Attention detection relies on monitorStream() started via messagePostProxy below.
    // No interception needed — http-proxy handles SSE correctly.

    // Intercept message POST for auto-refresh stream monitoring
    if (req.method === 'POST' && /\/api\/conversations\/(start|[^/]+\/messages)/.test(req.url || '')) {
      const urlMatch = req.url?.match(/\/api\/conversations\/([0-9a-f]{8}-[0-9a-f-]+)/);
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
      // Relay control messages from frontend components to LayoutManager (and other listeners)
      if (msg.type === 'control:ensure-panel' || msg.type === 'control:select-tab') {
        broadcast(msg);
      }
      // CPU profile result from renderer
      if (msg.type === 'cpu-profile-result' && pendingProfileResolve) {
        pendingProfileResolve(msg.data);
      }
    } catch {
      // ignore malformed messages
    }
  });
});

// --- Broadcast dedup + throttling ---
// Tracks last broadcast per type+key to suppress duplicates
const _lastBroadcast: Record<string, { state: string; at: number }> = {};
// Global broadcast rate counter (for diagnostics)
let _broadcastCount = 0;
let _broadcastDropped = 0;
let _broadcastT0 = Date.now();
// Per-type throttle: maps "type:key" → pending setTimeout
const _broadcastThrottled: Record<string, ReturnType<typeof setTimeout>> = {};

// Log broadcast rate every 60s
setInterval(() => {
  if (_broadcastCount > 0 || _broadcastDropped > 0) {
    const s = ((Date.now() - _broadcastT0) / 1000).toFixed(0);
    console.log(`[Broadcast] ${s}s: ${_broadcastCount} sent, ${_broadcastDropped} dropped (${(_broadcastCount / (+s || 1)).toFixed(1)}/s)`);
  }
  _broadcastCount = 0;
  _broadcastDropped = 0;
  _broadcastT0 = Date.now();
}, 60000);

function broadcast(data: Record<string, unknown>) {
  const type = data.type as string;

  // Track CUI states in workspace state store
  if (type === 'cui-state' && data.cuiId && data.state) {
    const id = data.cuiId as string;
    const state = data.state as string;
    workspaceState.cuiStates[id] = state;
    // Dedup: skip if same state was broadcast for this cuiId within last 2s
    const prev = _lastBroadcast[id];
    if (prev && prev.state === state && Date.now() - prev.at < 2000) { _broadcastDropped++; return; }
    _lastBroadcast[id] = { state, at: Date.now() };
  }

  // Dedup cui-response-ready: skip if last state is already 'done'
  if (type === 'cui-response-ready' && data.cuiId) {
    const id = data.cuiId as string;
    const prev = _lastBroadcast[id];
    if (prev && prev.state === 'done' && Date.now() - prev.at < 500) { _broadcastDropped++; return; }
  }

  // Throttle high-frequency types: coalesce rapid-fire messages of same type+key
  // Only latest value is sent after the throttle window
  const throttledTypes: Record<string, number> = {
    'visibility-update': 2000,
    'conv-attention': 1000,
    'cui-update-available': 5000,
  };
  const throttleMs = throttledTypes[type];
  if (throttleMs) {
    const throttleKey = `${type}:${data.cuiId || data.key || '_'}`;
    if (_broadcastThrottled[throttleKey]) {
      clearTimeout(_broadcastThrottled[throttleKey]);
      _broadcastDropped++;
    }
    _broadcastThrottled[throttleKey] = setTimeout(() => {
      delete _broadcastThrottled[throttleKey];
      _broadcastCount++;
      const json = JSON.stringify(data);
      for (const client of clients) {
        if (client.readyState === WebSocket.OPEN) client.send(json);
      }
    }, throttleMs);
    return;
  }

  // Direct send for non-throttled types
  _broadcastCount++;
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

  const resolved = resolve(dirPath);
  if (watchers.has(resolved)) return;

  // Block overly broad paths (home dir, root, etc.) to prevent watcher crashes
  const home = homedir();
  if (resolved === home || resolved === '/') {
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

  // Prevent unhandled EPERM crashes on protected directories
  watcher.on('error', (err) => {
    const e = err as NodeJS.ErrnoException;
    console.warn(`[Watcher] Error on ${resolved}: ${e.code || e.message || err}`);
  });

  // file-change broadcasts removed — no frontend consumer listens for this type.
  // ChangeWatch (below) handles src/server change notifications via cui-update-available.

  watchers.set(resolved, watcher);
  console.log(`Watching: ${resolved}`);
}

// --- REST API ---
app.use(express.json({ limit: '50mb' }));


// ============================================================================
// Health & Version Endpoints (for Watchdog integration)
// ============================================================================
app.get("/api/health", (_req, res) => {
  res.json({
    status: "ok",
    app: "cui-workspace",
    port: PORT,
    uptime: process.uptime(),
    memory: process.memoryUsage().rss,
    timestamp: new Date().toISOString(),
  });
});

app.get("/api/version", (_req, res) => {
  res.json({
    app: "cui-workspace",
    version: "1.0.0",
    node: process.version,
    timestamp: new Date().toISOString(),
  });
});

// Get build timestamp from dist/index.html mtime
app.get("/api/build-info", (_req, res) => {
  const distIndexPath = resolve(import.meta.dirname ?? '.', '..', 'dist', 'index.html');
  let buildTime: string | null = null;

  try {
    if (existsSync(distIndexPath)) {
      const stats = statSync(distIndexPath);
      buildTime = stats.mtime.toISOString();
    }
  } catch (err) {
    console.error('[build-info] Error reading dist/index.html:', err);
  }

  res.json({
    buildTime,
    distExists: existsSync(distIndexPath),
  });
});

// Resolve ~ to home directory
function resolvePath(p: string): string {
  if (p.startsWith('~/') || p === '~') return join(homedir(), p.slice(1));
  return resolve(p);
}

// Server runs on the dev server (100.121.161.109) — all /root/ paths are local filesystem.
// No SSH needed. Mac is a thin client (browser only).

// List directory contents
app.get('/api/files', async (req, res) => {
  const dirPath = req.query.path as string;
  if (!dirPath) {
    res.status(400).json({ error: 'path required' });
    return;
  }

  // All paths are local (server runs on dev server)
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

// Read file content (supports DOCX→HTML and XLSX→HTML conversion)
app.get('/api/file', async (req, res) => {
  const filePath = req.query.path as string;
  if (!filePath) {
    res.status(400).json({ error: 'path required' });
    return;
  }

  // All files are local (server runs on dev server)
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

// --- User Input Log ---
// Persistent log of all user inputs (subject + message) from Queue/Commander
const INPUT_LOG_FILE = join(DATA_DIR, 'input-log.jsonl');
function logUserInput(entry: { type: string; accountId: string; workDir?: string; subject?: string; message: string; sessionId?: string; result: 'ok' | 'error'; error?: string }) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
  try { appendFileSync(INPUT_LOG_FILE, line + '\n'); } catch { /* ignore write errors */ }
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
async function cuiFetch(proxyPort: number, path: string, options?: { method?: string; body?: string; timeoutMs?: number }): Promise<{ data: any; ok: boolean; status: number; error?: string }> {
  const url = `http://localhost:${proxyPort}${path}`;
  const controller = new AbortController();
  const ms = options?.timeoutMs ?? 8000;
  const timeout = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetch(url, {
      method: options?.method || 'GET',
      headers: options?.body ? { 'Content-Type': 'application/json' } : {},
      body: options?.body,
      signal: controller.signal,
    });
    const data = await res.json();
    if (!res.ok) {
      const errMsg = data?.error?.message || data?.error?.code || data?.message || data?.error || `HTTP ${res.status}`;
      return { data, ok: false, status: res.status, error: String(errMsg) };
    }
    return { data, ok: true, status: res.status };
  } catch (err: any) {
    const msg = err?.name === 'AbortError' ? `timeout (${ms / 1000}s)` : (err?.cause?.code === 'ECONNREFUSED' ? 'connection refused' : (err?.message || 'network error'));
    return { data: null, ok: false, status: 0, error: msg };
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
    const resp = await cuiFetch(proxy.localPort, '/api/conversations?limit=50&sortBy=updated&order=desc');
    if (!resp.ok || !resp.data?.conversations) return;
    for (const c of resp.data.conversations) {
      if (filterProject && !c.projectPath?.includes(filterProject)) continue;
      results.push({
        sessionId: c.sessionId,
        accountId: proxy.id,
        accountLabel: ({ rafael: 'Engelmann', engelmann: 'Gmail', office: 'Office', local: 'Lokal' } as Record<string, string>)[proxy.id] || proxy.id,
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
  const [convResp, permResp] = await Promise.all([
    cuiFetch(port, `/api/conversations/${req.params.sessionId}`),
    cuiFetch(port, `/api/permissions?streamingId=&status=pending`),
  ]);

  if (!convResp.ok) { res.status(502).json({ error: convResp.error || 'CUI unreachable' }); return; }

  // Transform CUI message format, detect rate limits, filter noise
  const allMessages = convResp.data.messages || [];
  // Detect if the LAST message is a rate limit (show to user, don't filter!)
  let rateLimited = false;
  let rateLimitText = '';
  for (let i = allMessages.length - 1; i >= Math.max(0, allMessages.length - 3); i--) {
    const m = allMessages[i];
    const isSynthetic = m.isApiErrorMessage === true || m.message?.model === '<synthetic>';
    if (isSynthetic) {
      rateLimited = true;
      rateLimitText = m.message?.content?.[0]?.text || m.error || 'Rate limit reached';
      break;
    }
    if (m.message?.role === 'assistant') break; // Stop at first real assistant message
  }
  // Find index of last real assistant message to distinguish trailing vs old synthetic messages
  let lastAssistantIdx = -1;
  for (let i = allMessages.length - 1; i >= 0; i--) {
    const m = allMessages[i];
    if (m.message?.role === 'assistant' && !m.isApiErrorMessage && m.message?.model !== '<synthetic>') {
      lastAssistantIdx = i;
      break;
    }
  }
  const rawMessages = allMessages.filter((m: any, i: number) => {
    const isSynthetic = m.isApiErrorMessage === true || m.message?.model === '<synthetic>';
    // Keep trailing synthetic messages (after last real assistant) so user sees rate limits
    if (rateLimited && isSynthetic && i > lastAssistantIdx) return true;
    // Filter all other synthetic messages
    if (isSynthetic) return false;
    // Filter orphaned "continue" user messages (unstick attempts before/after errors)
    const content = typeof m.message?.content === 'string' ? m.message.content.trim().toLowerCase() : '';
    if (content === 'continue' && m.message?.role === 'user') {
      const next = allMessages[i + 1];
      if (!next) return false; // trailing continue with no response
      if (next.isApiErrorMessage === true || next.message?.model === '<synthetic>') return false;
    }
    return true;
  });
  const messages = rawMessages.slice(-tail).map((m: any) => {
    // Map synthetic error messages to a special role so frontend can style them
    const isSynthetic = m.isApiErrorMessage === true || m.message?.model === '<synthetic>';
    if (isSynthetic) {
      return {
        role: 'rate_limit' as const,
        content: m.message?.content?.[0]?.text || m.error || 'Rate limit reached',
        timestamp: m.timestamp || '',
      };
    }
    return {
      role: m.message?.role || m.type || 'user',
      content: m.message?.content || m.content || '',
      timestamp: m.timestamp || '',
    };
  });

  // Filter permissions to only include ones for THIS conversation's streaming session
  const convStreamingId = convResp.data.streamingId || convResp.data.metadata?.streamingId || '';
  const allPermissions: any[] = permResp.data?.permissions || [];
  const sessionPermissions = convStreamingId
    ? allPermissions.filter((p: any) => p.streamingId === convStreamingId)
    : []; // No streamingId → conversation not streaming → no pending permissions

  // Detect if conversation is idle (last message is assistant text, not waiting for tool_result)
  const lastRaw = rawMessages.length > 0 ? rawMessages[rawMessages.length - 1] : null;
  const lastRole = lastRaw?.message?.role;
  const lastContent = lastRaw?.message?.content;
  let hasPendingToolUse = false;
  if (Array.isArray(lastContent)) {
    hasPendingToolUse = lastContent.some((b: any) => b.type === 'tool_use');
  }
  const isAgentDone = lastRole === 'assistant' && !hasPendingToolUse && sessionPermissions.length === 0;

  res.json({
    messages,
    summary: convResp.data.summary || '',
    status: convResp.data.metadata?.status || 'completed',
    projectPath: convResp.data.projectPath || '',
    permissions: sessionPermissions,
    totalMessages: rawMessages.length,
    isAgentDone,
    rateLimited,
    rateLimitText: rateLimited ? rateLimitText : undefined,
  });
});

// 3. Send message to existing conversation
app.post('/api/mission/send', async (req, res) => {
  const { accountId, sessionId, message, workDir, useLocal } = req.body;
  if (!accountId || !sessionId || !message) {
    res.status(400).json({ error: 'accountId, sessionId, message required' });
    return;
  }
  // useLocal flag: route through local CUI server instead of remote
  const effectiveAccountId = useLocal ? 'local' : accountId;
  const port = getProxyPort(effectiveAccountId);
  if (!port) { res.status(400).json({ error: 'unknown account' }); return; }

  const resolvedWorkDir = workDir || '/root';

  // Auto-clean synthetic error messages (rate limit, billing) from JSONL before resuming
  const cleaned = unstickConversation(sessionId);
  if (cleaned > 0) console.log(`[Send] Auto-cleaned ${cleaned} error messages from ${sessionId}`);

  let resp = await cuiFetch(port, '/api/conversations/start', {
    method: 'POST',
    timeoutMs: 60000,
    body: JSON.stringify({
      workingDirectory: resolvedWorkDir,
      initialPrompt: message,
      resumedSessionId: sessionId,
    }),
  });

  // Auto-recover: if resume fails (e.g. missing system init in JSONL), start a fresh session
  let resumeFailed = false;
  if (!resp.ok && resp.error?.includes('system init')) {
    console.log(`[Send] Resume failed for ${sessionId}: ${resp.error} — starting fresh session`);
    resp = await cuiFetch(port, '/api/conversations/start', {
      method: 'POST',
      timeoutMs: 60000,
      body: JSON.stringify({
        workingDirectory: resolvedWorkDir,
        initialPrompt: message,
      }),
    });
    resumeFailed = true;
  }

  if (!resp.ok || !resp.data?.sessionId) {
    const errMsg = resp.error || 'CUI unreachable';
    logUserInput({ type: 'send', accountId, workDir, message, sessionId, result: 'error', error: errMsg });
    res.status(502).json({ error: errMsg });
    return;
  }
  const sendResult = resp.data;
  if (resumeFailed) {
    console.log(`[Send] Auto-recovered: old=${sessionId} → new=${sendResult.sessionId}`);
  }
  logUserInput({ type: 'send', accountId, workDir, message, sessionId: sendResult.sessionId || sessionId, result: 'ok' });
  saveAssignment(sendResult.sessionId || sessionId, accountId);
  setLastPrompt(sendResult.sessionId || sessionId);

  // Track state
  broadcast({ type: 'cui-state', cuiId: accountId, state: 'processing' });
  setSessionState(accountId, accountId, 'working', undefined, sendResult.sessionId || sessionId);

  // Monitor the new stream
  if (sendResult.streamingId) {
    monitorStream(`http://localhost:${port}`, sendResult.streamingId, accountId, {});
  }
    checkSessionForRateLimit(sendResult.sessionId || sessionId, accountId);

  // Track account assignment for this conversation
  saveAssignment(sendResult.sessionId || sessionId, accountId);

  res.json({ ok: true, streamingId: sendResult.streamingId, sessionId: sendResult.sessionId || sessionId, resumeFailed });
});

// 4. Approve/deny permission
app.post('/api/mission/permissions/:accountId/:permissionId', async (req, res) => {
  const port = getProxyPort(req.params.accountId);
  if (!port) { res.status(400).json({ error: 'unknown account' }); return; }

  const resp = await cuiFetch(port, `/api/permissions/${req.params.permissionId}/decision`, {
    method: 'POST',
    body: JSON.stringify({ action: req.body.action || 'approve' }),
  });

  if (!resp.ok) { res.status(502).json({ error: resp.error || 'permission decision failed' }); return; }
  res.json(resp.data);
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
  const sid = req.params.sessionId;
  saveAssignment(sid, accountId);
  // Auto-unstick: remove rate-limit messages so the conversation can continue on the new account
  const removed = unstickConversation(sid);
  if (removed > 0) console.log(`[Assign] Unsticked ${sid}: removed ${removed} rate-limit messages`);
  res.json({ ok: true, sessionId: sid, accountId, unsticked: removed });
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

// --- Unstick: remove API error messages + orphaned user messages from conversation JSONL ---
// Handles: rate_limit, billing_error, unknown, invalid_request, etc.
// Also removes trailing orphaned user/queue-operation messages that have no assistant response.
// This prevents the "multiple consecutive user messages" problem that causes context loss.
function unstickConversation(sessionId: string): number {
  const cuiProjectsDir = join(homedir(), '.claude', 'projects');
  if (!existsSync(cuiProjectsDir)) return 0;
  let totalRemoved = 0;
  const projectDirs = readdirSync(cuiProjectsDir);
  for (const dir of projectDirs) {
    const dirPath = join(cuiProjectsDir, dir);
    try { if (!statSync(dirPath).isDirectory()) continue; } catch { continue; }
    const filePath = join(dirPath, `${sessionId}.jsonl`);
    if (!existsSync(filePath)) continue;
    try {
      const lines = readFileSync(filePath, 'utf-8').split('\n');
      const removeIndices = new Set<number>();
      // Phase 1: Remove ALL synthetic error messages anywhere in the conversation
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        try {
          const obj = JSON.parse(line);
          if (obj.isApiErrorMessage === true) { removeIndices.add(i); continue; }
          const msg = obj.message;
          if (msg && typeof msg === 'object' && msg.model === '<synthetic>') { removeIndices.add(i); continue; }
        } catch { continue; }
      }
      // Phase 2: Remove trailing orphaned user/queue-operation entries (no assistant response after them)
      // Walk backwards from the end, remove user messages and queue-operations until we hit an assistant message.
      // Keep ONE trailing user message if it's the most recent (will be the "resume" trigger).
      const remaining = lines.map((l, i) => ({ line: l, idx: i })).filter(x => !removeIndices.has(x.idx));
      let trailingUserCount = 0;
      for (let k = remaining.length - 1; k >= 0; k--) {
        const line = remaining[k].line.trim();
        if (!line) continue;
        try {
          const obj = JSON.parse(line);
          const role = obj.message?.role || obj.type;
          if (role === 'assistant') break; // Found last assistant message — stop
          if (role === 'user') {
            trailingUserCount++;
            if (trailingUserCount > 1) {
              // Keep only the LAST user message, remove earlier orphaned ones
              removeIndices.add(remaining[k].idx);
            }
          }
          if (obj.type === 'queue-operation' && trailingUserCount > 0) {
            // Remove queue-operations associated with orphaned user messages
            removeIndices.add(remaining[k].idx);
          }
        } catch { break; }
      }
      if (removeIndices.size > 0) {
        writeFileSync(filePath, lines.filter((_, i) => !removeIndices.has(i)).join('\n'));
        totalRemoved += removeIndices.size;
        if (trailingUserCount > 1) {
          console.log(`[Unstick] ${sessionId}: removed ${trailingUserCount - 1} orphaned user messages`);
        }
      }
    } catch { /* skip unreadable */ }
  }
  return totalRemoved;
}

// 5f. Remove rate-limit messages from stuck conversations (bulk)
app.post('/api/mission/unstick', (_req, res) => {
  const cuiProjectsDir = join(homedir(), '.claude', 'projects');
  if (!existsSync(cuiProjectsDir)) {
    res.status(404).json({ error: 'CUI projects directory not found' });
    return;
  }
  const fixed: { session: string; removed: number }[] = [];
  try {
    const projectDirs = readdirSync(cuiProjectsDir);
    for (const dir of projectDirs) {
      const dirPath = join(cuiProjectsDir, dir);
      try { if (!statSync(dirPath).isDirectory()) continue; } catch { continue; }
      const files = readdirSync(dirPath).filter(f => f.endsWith('.jsonl') && /^[0-9a-f]{8}-/.test(f));
      for (const file of files) {
        const sessionId = file.replace('.jsonl', '');
        const removed = unstickConversation(sessionId);
        if (removed > 0) fixed.push({ session: sessionId, removed });
      }
    }
  } catch (e: any) {
    res.status(500).json({ error: `Failed to scan: ${e.message}` });
    return;
  }
  console.log(`[Unstick] Fixed ${fixed.length} conversations`);
  res.json({ ok: true, fixed: fixed.length, details: fixed });
});

// 5g. Activate conversations in panels
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
  const { accountId, workDir, subject, message, useLocal } = req.body;
  if (!accountId || !message) {
    res.status(400).json({ error: 'accountId, message required' });
    return;
  }
  // useLocal flag: route through local CUI server instead of remote
  const effectiveAccountId = useLocal ? 'local' : accountId;
  const port = getProxyPort(effectiveAccountId);
  if (!port) { res.status(400).json({ error: 'unknown account' }); return; }

  const resolvedWorkDir = workDir || '/root';

  // Start conversation (60s timeout — Claude v1.0.128 spawn takes ~34s)
  const startResp = await cuiFetch(port, '/api/conversations/start', {
    method: 'POST',
    timeoutMs: 60000,
    body: JSON.stringify({
      workingDirectory: resolvedWorkDir,
      initialPrompt: message,
    }),
  });

  if (!startResp.ok || !startResp.data?.sessionId) {
    const errMsg = startResp.error || 'CUI unreachable';
    logUserInput({ type: 'start', accountId, workDir, subject, message, result: 'error', error: errMsg });
    res.status(502).json({ error: errMsg });
    return;
  }

  const startData = startResp.data;
  logUserInput({ type: 'start', accountId, workDir, subject, message, sessionId: startData.sessionId, result: 'ok' });

  // Save subject as local title (CUI API doesn't support custom_name)
  if (subject) {
    saveTitle(startData.sessionId, subject);
  }
  // Track account assignment + prompt time
  saveAssignment(startData.sessionId, accountId);
  setLastPrompt(startData.sessionId);

  broadcast({ type: 'cui-state', cuiId: accountId, state: 'processing' });
  if (startData.streamingId) {
    monitorStream(`http://localhost:${port}`, startData.streamingId, accountId, {});
  }
    checkSessionForRateLimit(startData.sessionId, accountId);

  res.json({ ok: true, sessionId: startData.sessionId, streamingId: startData.streamingId });
});

// 6b. Input log: retrieve all logged user inputs
app.get('/api/mission/input-log', (_req, res) => {
  if (!existsSync(INPUT_LOG_FILE)) { res.json({ entries: [] }); return; }
  try {
    const lines = readFileSync(INPUT_LOG_FILE, 'utf8').trim().split('\n').filter(Boolean);
    const entries = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    res.json({ entries, total: entries.length });
  } catch { res.json({ entries: [], total: 0 }); }
});

// 7. Stop conversation (with nuclear child-process kill)
const ACCOUNT_PM2_MAP: Record<string, string> = { rafael: 'cui-1', engelmann: 'cui-2', office: 'cui-3' };

app.post('/api/mission/conversation/:accountId/:sessionId/stop', async (req, res) => {
  const { accountId, sessionId } = req.params;
  const port = getProxyPort(accountId);
  if (!port) { res.status(400).json({ error: 'unknown account' }); return; }

  // 1. Send stop to Claude Code binary (stops current LLM generation)
  const resp = await cuiFetch(port, `/api/conversations/${sessionId}/stop`, { method: 'POST' });
  console.log(`[Stop] ${accountId}/${sessionId.slice(0,8)}: API stop ${resp.ok ? 'OK' : 'FAIL (' + resp.error + ')'}`);

  // 2. Nuclear kill: terminate all child processes of the binary (bash, subagents, etc.)
  const pmName = ACCOUNT_PM2_MAP[accountId];
  let killed = 0;
  if (pmName) {
    try {
      const { execSync } = require('child_process');
      // Get binary PID from PM2
      const pm2Json = execSync(`su - claude-user -c 'pm2 jlist' 2>/dev/null`, { encoding: 'utf8', timeout: 5000 });
      const pm2Apps = JSON.parse(pm2Json);
      const pmApp = pm2Apps.find((a: any) => a.name === pmName);
      const binaryPid = pmApp?.pid;
      if (binaryPid && binaryPid > 0) {
        // Find all descendant PIDs via pstree (NOT the binary itself)
        const tree = execSync(
          `pstree -p ${binaryPid} 2>/dev/null | grep -oP '\(\K[0-9]+(?=\))' | grep -v '^${binaryPid}$' || true`,
          { encoding: 'utf8', timeout: 5000 }
        ).trim();
        const uniquePids = [...new Set(tree.split('\n').filter(Boolean).map(Number).filter(p => p > 0 && p !== binaryPid))];
        if (uniquePids.length > 0) {
          execSync(`kill -TERM ${uniquePids.join(' ')} 2>/dev/null || true`, { timeout: 3000 });
          killed = uniquePids.length;
          // SIGKILL stragglers after 1.5s
          setTimeout(() => {
            try { execSync(`kill -KILL ${uniquePids.join(' ')} 2>/dev/null || true`, { timeout: 3000 }); }
            catch { /* already dead */ }
          }, 1500);
        }
        console.log(`[Stop] ${accountId}: killed ${killed} child processes of ${pmName} (PID ${binaryPid})`);
      } else {
        console.log(`[Stop] ${accountId}: ${pmName} not running (no PID)`);
      }
    } catch (err: any) {
      console.error(`[Stop] ${accountId}: child kill error: ${err.message}`);
    }
  }

  res.json({ ...(resp.data || {}), stopped: true, childrenKilled: killed });
});

// 8. Auto-title: set conversation name from first user message
app.post('/api/mission/auto-titles', async (_req, res) => {
  let updated = 0;
  const errors: string[] = [];

  // Get all conversations
  const allConvs: Array<{ sessionId: string; accountId: string; port: number; summary: string; customName: string }> = [];
  await Promise.all(CUI_PROXIES.map(async (proxy) => {
    const resp = await cuiFetch(proxy.localPort, '/api/conversations?limit=50&sortBy=updated&order=desc');
    if (!resp.ok || !resp.data?.conversations) return;
    for (const c of resp.data.conversations) {
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
      const detailResp = await cuiFetch(conv.port, `/api/conversations/${conv.sessionId}`);
      if (!detailResp.ok || !detailResp.data?.messages) continue;
      const detail = detailResp.data;

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
      const listResp = await cuiFetch(proxy.localPort, '/api/conversations?limit=20&sortBy=updated&order=desc');
      if (!listResp.ok || !listResp.data?.conversations) return;
      for (const c of listResp.data.conversations) {
        const detailResp = await cuiFetch(proxy.localPort, `/api/conversations/${c.sessionId}`);
        const rawMsgs = detailResp.data?.messages || [];
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
      if (!p.workDir) continue;
      try {
        const [statusResult, logResult] = await Promise.all([
          execAsync(`cd ${p.workDir} && git status --short 2>/dev/null || echo '(kein Git repo)'`),
          execAsync(`cd ${p.workDir} && git log --oneline -5 2>/dev/null || echo '(keine commits)'`),
        ]);
        gitStatus[p.id] = { status: statusResult.stdout.trim(), log: logResult.stdout.trim() };
      } catch {
        gitStatus[p.id] = { status: '(error)', log: '' };
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
      mkdirSync(remoteWorkDir, { recursive: true });
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
  // Use simple script that reads DIRECTLY from test-credentials.json (Single Source of Truth)
  exec('npx tsx scripts/generate-shared-notes-simple.ts', { cwd, timeout: 30000 }, (err, stdout, stderr) => {
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

// Image upload directory (server runs on dev server — all local)
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

  const results: { localPath: string; name: string }[] = [];

  // Save all images locally (server IS the dev server)
  mkdirSync(REMOTE_IMG_DIR, { recursive: true });
  for (const img of images) {
    const ext = img.name?.match(/\.[^.]+$/)?.[0] || '.png';
    const safeName = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}${ext}`;
    const localPath = join(REMOTE_IMG_DIR, safeName);
    const base64Data = img.data.replace(/^data:[^;]+;base64,/, '');
    writeFileSync(localPath, Buffer.from(base64Data, 'base64'));
    results.push({ localPath, name: safeName });
  }

  console.log(`[Images] Saved ${results.length} images to ${REMOTE_IMG_DIR}`);

  // Build the Read command for Claude
  const paths = results.map(r => r.localPath);
  const readCommand = paths.length === 1
    ? `Schau dir dieses Bild an: ${paths[0]}`
    : `Schau dir diese ${paths.length} Bilder an:\n${paths.map(p => `- ${p}`).join('\n')}`;

  res.json({
    ok: true,
    count: results.length,
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
  const personasPath = '/root/projekte/orchestrator/team/personas';
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

// GET /api/team/events - Load activity events from events.json
app.get('/api/team/events', async (_req, res) => {
  const eventsPath = '/root/projekte/werkingflow/autopilot/cui/data/active/team/events.json';
  try {
    const content = await readFile(eventsPath, 'utf-8');
    const data = JSON.parse(content);
    // Wrap array in object if needed (VirtualOffice expects { events: [...] })
    const response = Array.isArray(data) ? { events: data } : data;
    res.json(response);
  } catch (err: any) {
    console.error('Failed to load events.json:', err);
    res.status(500).json({ error: 'Failed to load events', events: [] });
  }
});

// GET /api/team/reviews - Load reviews from reviews.json
app.get('/api/team/reviews', async (_req, res) => {
  const reviewsPath = '/root/projekte/werkingflow/autopilot/cui/data/active/team/reviews.json';
  try {
    const content = await readFile(reviewsPath, 'utf-8');
    const data = JSON.parse(content);
    // Accept both array format and { reviews: [...] } format
    const reviews = Array.isArray(data) ? data : (data.reviews || []);
    console.log('[Reviews API] Loaded', reviews.length, 'reviews from', reviewsPath);
    res.json(reviews);
  } catch (err: any) {
    console.error('[Reviews API] Failed to load reviews.json:', err);
    res.status(500).json([]);
  }
});

// GET /api/team/task-board - Load tasks from tasks.json (for Task Board)
app.get('/api/team/task-board', async (_req, res) => {
  const tasksPath = '/root/projekte/werkingflow/autopilot/cui/data/active/team/tasks.json';
  try {
    const content = await readFile(tasksPath, 'utf-8');
    const data = JSON.parse(content);
    res.json(data); // Returns { tasks: [...] }
  } catch (err: any) {
    console.error('Failed to load tasks.json:', err);
    res.status(500).json({ error: 'Failed to load tasks', tasks: [] });
  }
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
    const personasPath = '/root/projekte/orchestrator/team/personas';
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

  try {
    const sourceFilename = sourcePath.split('/').pop() || 'file';
    const targetPath = targetDir.endsWith('/')
      ? `${targetDir}${sourceFilename}`
      : `${targetDir}/${sourceFilename}`;

    // All paths are local (server runs on dev server)
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

    // file-change broadcasts removed — no frontend consumer
    res.json({ ok: true, targetPath: resolvedTarget, operation: op });
  } catch (err: any) {
    res.status(500).json({ error: `File operation failed: ${err.message}` });
  }
});

// --- CUI Sync (git pull + build + systemd restart) ---
const WORKSPACE_ROOT = resolve(import.meta.dirname ?? __dirname, '..');
let _syncInProgress = false;

app.post('/api/cui-sync', async (_req, res) => {
  if (_syncInProgress) {
    res.status(409).json({ error: 'Sync already in progress' });
    return;
  }
  _syncInProgress = true;
  broadcast({ type: 'cui-sync', status: 'started' });

  const PATH_PREFIX = '/usr/local/bin:' + (process.env.PATH || '');
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

    // 4. Schedule restart (after response is sent) — systemd will restart the process
    setTimeout(() => {
      console.log('[Sync] Build complete, exiting for systemd restart');
      process.exit(0);
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
  join(WORKSPACE_ROOT, 'server'),
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
  // No per-file console.log — only log summary when broadcasting
  if (!_pendingChanges.includes(rel)) _pendingChanges.push(rel);

  // Debounce: notify frontend after 5s quiet period (was 2s — too aggressive during Syncthing bursts)
  if (_changeDebounce) clearTimeout(_changeDebounce);
  _changeDebounce = setTimeout(() => {
    console.log(`[ChangeWatch] Update available: ${_pendingChanges.length} files changed`);
    broadcast({ type: 'cui-update-available', files: _pendingChanges.slice(0, 20), count: _pendingChanges.length });
  }, 5000);
});

console.log('[ChangeWatch] Watching src/ and server/ for changes (notify-only, no auto-build)');

// API: get pending changes
app.get('/api/cui-sync/pending', (_req, res) => {
  res.json({ pending: _pendingChanges.length > 0, files: _pendingChanges.slice(0, 20), count: _pendingChanges.length, syncing: _syncInProgress });
});

// --- Syncthing Control API ---
// Controls the LOCAL Syncthing instance on this server (127.0.0.1:8384)
const SYNCTHING_URL = 'http://127.0.0.1:8384';
const SYNCTHING_API_KEY = process.env.SYNCTHING_API_KEY || 'ZHieF7vzTmgXQ7gcUZysPo5KM7fhCKdk';

async function syncthingFetch(path: string, method = 'GET'): Promise<any> {
  const res = await fetch(`${SYNCTHING_URL}${path}`, {
    method,
    headers: { 'X-API-Key': SYNCTHING_API_KEY },
  });
  if (!res.ok) throw new Error(`Syncthing API ${path}: ${res.status} ${res.statusText}`);
  const text = await res.text();
  return text ? JSON.parse(text) : {};
}

// GET /api/syncthing/status — paused state, last sync time, connection info
app.get('/api/syncthing/status', async (_req, res) => {
  try {
    const [system, connections, folderStats, devices] = await Promise.all([
      syncthingFetch('/rest/system/status'),
      syncthingFetch('/rest/system/connections'),
      syncthingFetch('/rest/stats/folder'),
      syncthingFetch('/rest/config/devices'),
    ]);

    // Find last synced file across all folders
    let lastSyncAt = '';
    let lastFile = '';
    for (const [, stats] of Object.entries(folderStats) as [string, any][]) {
      const at = stats.lastFile?.at || '';
      if (at > lastSyncAt && at > '2000') { // Ignore zero dates
        lastSyncAt = at;
        lastFile = stats.lastFile?.filename || '';
      }
    }

    // Check connections
    const conns = connections.connections || {};
    let anyConnected = false;
    for (const [, conn] of Object.entries(conns) as [string, any][]) {
      if (conn.connected) anyConnected = true;
    }

    // Check if any remote device is paused (skip own device)
    const remoteDevices = (devices as any[]).filter((d: any) => d.deviceID !== system.myID);
    const allPaused = remoteDevices.length > 0 && remoteDevices.every((d: any) => d.paused);

    res.json({
      paused: allPaused,
      connected: anyConnected,
      lastSyncAt: lastSyncAt || null,
      lastFile: lastFile || null,
      uptime: system.uptime,
      myID: system.myID?.substring(0, 7),
    });
  } catch (err: any) {
    res.status(502).json({ error: `Syncthing unreachable: ${err.message}` });
  }
});

// POST /api/syncthing/pause — pause all device connections
app.post('/api/syncthing/pause', async (_req, res) => {
  try {
    const devices: any[] = await syncthingFetch('/rest/config/devices');
    for (const device of devices) {
      if (!device.paused) {
        device.paused = true;
        await fetch(`${SYNCTHING_URL}/rest/config/devices/${device.deviceID}`, {
          method: 'PATCH',
          headers: { 'X-API-Key': SYNCTHING_API_KEY, 'Content-Type': 'application/json' },
          body: JSON.stringify({ paused: true }),
        });
      }
    }
    console.log('[Syncthing] All devices paused');
    res.json({ ok: true, paused: true });
  } catch (err: any) {
    res.status(502).json({ error: `Syncthing pause failed: ${err.message}` });
  }
});

// POST /api/syncthing/resume — resume all device connections
app.post('/api/syncthing/resume', async (_req, res) => {
  try {
    const devices: any[] = await syncthingFetch('/rest/config/devices');
    for (const device of devices) {
      if (device.paused) {
        device.paused = false;
        await fetch(`${SYNCTHING_URL}/rest/config/devices/${device.deviceID}`, {
          method: 'PATCH',
          headers: { 'X-API-Key': SYNCTHING_API_KEY, 'Content-Type': 'application/json' },
          body: JSON.stringify({ paused: false }),
        });
      }
    }
    console.log('[Syncthing] All devices resumed');
    res.json({ ok: true, paused: false });
  } catch (err: any) {
    res.status(502).json({ error: `Syncthing resume failed: ${err.message}` });
  }
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
const WR_LOCAL_URL = process.env.WERKING_REPORT_LOCAL_URL ?? 'http://localhost:3008';
const WR_ADMIN_SECRET = process.env.WERKING_REPORT_ADMIN_SECRET ?? process.env.ADMIN_SECRET ?? '';

// Runtime-switchable env mode (persists across restarts via file)
type WrEnvMode = 'production' | 'staging' | 'local';
const WR_ENV_MODE_FILE = '/tmp/cui-wr-env-mode.json';

/**
 * Auto-detect WR mode based on environment.
 * Priority: 1) Saved file, 2) NODE_ENV, 3) Port detection, 4) Production default
 */
function loadWrEnvMode(): WrEnvMode {
  // 1. Check saved preference
  try {
    if (existsSync(WR_ENV_MODE_FILE)) {
      const data = JSON.parse(readFileSync(WR_ENV_MODE_FILE, 'utf8'));
      if (data.mode === 'staging' || data.mode === 'local' || data.mode === 'production') {
        return data.mode;
      }
    }
  } catch {}

  // 2. Auto-detect based on NODE_ENV
  if (process.env.NODE_ENV === 'development') {
    // In dev mode, default to local if WR is running on port 3008
    try {
      const { execSync } = require('child_process');
      const portCheck = execSync('ss -tlnp 2>/dev/null | grep ":3008" || true', { encoding: 'utf8' });
      if (portCheck.includes('3008')) {
        console.log('[WR Env] Auto-detected local WR server on port 3008');
        return 'local';
      }
    } catch {}
  }

  // 3. Default: production (Vercel)
  return 'production';
}
function saveWrEnvMode(mode: WrEnvMode) {
  try { writeFileSync(WR_ENV_MODE_FILE, JSON.stringify({ mode })); } catch {}
}
let wrEnvMode: WrEnvMode = loadWrEnvMode();
function wrBase(): string {
  return wrEnvMode === 'staging' ? WR_STAGING_URL
    : wrEnvMode === 'local' ? WR_LOCAL_URL
    : WR_PROD_URL;
}
console.log(`[WR Env] Loaded mode: ${wrEnvMode} → ${wrBase()}`);

function wrAdminHeaders(): Record<string, string> {
  if (!WR_ADMIN_SECRET) throw new Error('WERKING_REPORT_ADMIN_SECRET not set');
  return { 'x-admin-secret': WR_ADMIN_SECRET, 'Content-Type': 'application/json' };
}

/**
 * Safe proxy helper: forwards request to WR backend, handles HTML errors gracefully.
 * Returns JSON always — never forwards raw HTML to the client.
 */
async function wrProxy(url: string, init?: RequestInit): Promise<{ status: number; body: unknown }> {
  const response = await fetch(url, { ...init, headers: { ...wrAdminHeaders(), ...init?.headers } });
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    return { status: response.status, body: await response.json() };
  }
  // Non-JSON response (HTML error page, 404, etc.)
  const text = await response.text();
  const snippet = text.slice(0, 200).replace(/<[^>]*>/g, '').trim();
  return {
    status: response.status >= 400 ? response.status : 502,
    body: { error: `Non-JSON response (HTTP ${response.status}): ${snippet || 'empty response'}` },
  };
}

// GET /api/admin/wr/env — current env mode
app.get('/api/admin/wr/env', (_req, res) => {
  res.json({ mode: wrEnvMode, urls: { production: WR_PROD_URL, staging: WR_STAGING_URL, local: WR_LOCAL_URL } });
});

// POST /api/admin/wr/env — switch env mode
app.post('/api/admin/wr/env', (req, res) => {
  const { mode } = req.body as { mode?: string };
  if (mode !== 'production' && mode !== 'staging' && mode !== 'local') {
    res.status(400).json({ error: 'mode must be "production", "staging", or "local"' });
    return;
  }
  wrEnvMode = mode as WrEnvMode;
  saveWrEnvMode(wrEnvMode); // persist across restarts
  console.log(`[Admin Proxy] WR env switched to: ${wrEnvMode} → ${wrBase()}`);
  broadcast({ type: 'wr-env-changed', mode: wrEnvMode });
  res.json({ ok: true, mode: wrEnvMode, url: wrBase() });
});

app.get('/api/admin/wr/users', async (_req, res) => {
  try { const r = await wrProxy(`${wrBase()}/api/admin/users`); res.status(r.status).json(r.body); }
  catch (err: any) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/wr/users/:id/approve', async (req, res) => {
  try { const r = await wrProxy(`${wrBase()}/api/admin/users/${req.params.id}/approve`, { method: 'POST' }); res.status(r.status).json(r.body); }
  catch (err: any) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/wr/users/:id/verify', async (req, res) => {
  try { const r = await wrProxy(`${wrBase()}/api/admin/users/${req.params.id}/verify`, { method: 'POST' }); res.status(r.status).json(r.body); }
  catch (err: any) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/wr/billing/overview', async (_req, res) => {
  try { const r = await wrProxy(`${wrBase()}/api/admin/billing/overview`); res.status(r.status).json(r.body); }
  catch (err: any) { res.status(500).json({ error: err.message }); }
});

// Top-Up
app.post('/api/admin/wr/billing/top-up', async (req, res) => {
  try {
    const r = await wrProxy(`${wrBase()}/api/admin/billing/top-up`, {
      method: 'POST',
      body: JSON.stringify(req.body),
    });
    res.status(r.status).json(r.body);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Billing Events
app.get('/api/admin/wr/billing/events/:tenantId', async (req, res) => {
  try {
    const r = await wrProxy(`${wrBase()}/api/admin/billing/events/${req.params.tenantId}`);
    res.status(r.status).json(r.body);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Invoices
app.get('/api/admin/wr/billing/invoices', async (req, res) => {
  try {
    const tenantId = req.query.tenantId;
    const url = tenantId
      ? `${wrBase()}/api/admin/billing/invoices?tenantId=${tenantId}`
      : `${wrBase()}/api/admin/billing/invoices`;
    const r = await wrProxy(url);
    res.status(r.status).json(r.body);
  }
  catch (err: any) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/wr/billing/invoices/:id', async (req, res) => {
  try {
    const tenantId = req.query.tenantId;
    if (!tenantId) return res.status(400).json({ error: 'tenantId required' });
    const r = await wrProxy(`${wrBase()}/api/admin/billing/invoices/${req.params.id}?tenantId=${tenantId}`);
    res.status(r.status).json(r.body);
  }
  catch (err: any) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/wr/billing/invoices/:id/send', async (req, res) => {
  try {
    const tenantId = req.query.tenantId;
    if (!tenantId) return res.status(400).json({ error: 'tenantId required' });
    const r = await wrProxy(`${wrBase()}/api/admin/billing/invoices/${req.params.id}/send?tenantId=${tenantId}`, { method: 'POST' });
    res.status(r.status).json(r.body);
  }
  catch (err: any) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/wr/billing/invoices/:id/pdf', async (req, res) => {
  try {
    const tenantId = req.query.tenantId;
    if (!tenantId) return res.status(400).json({ error: 'tenantId required' });
    const response = await fetch(
      `${wrBase()}/api/admin/billing/invoices/${req.params.id}/pdf?tenantId=${tenantId}`,
      { headers: wrAdminHeaders() }
    );
    if (!response.ok) {
      const text = await response.text();
      return res.status(response.status).json({ error: text || 'Failed to generate PDF' });
    }
    // Forward HTML response with correct content-type
    const html = await response.text();
    res.setHeader('Content-Type', 'text/html');
    res.setHeader('Content-Disposition', `inline; filename="invoice-${req.params.id}.html"`);
    res.send(html);
  }
  catch (err: any) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/wr/usage/stats', async (req, res) => {
  try { const r = await wrProxy(`${wrBase()}/api/admin/usage/stats?period=${req.query.period || 'month'}`); res.status(r.status).json(r.body); }
  catch (err: any) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/wr/usage/activity', async (_req, res) => {
  try { const r = await wrProxy(`${wrBase()}/api/admin/usage/activity`); res.status(r.status).json(r.body); }
  catch (err: any) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/wr/usage/activity/users', async (req, res) => {
  try {
    const tenantId = req.query.tenantId;
    const r = await wrProxy(`${wrBase()}/api/admin/usage/activity/users?tenantId=${tenantId}`);
    res.status(r.status).json(r.body);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/wr/feedback', async (_req, res) => {
  try { const r = await wrProxy(`${wrBase()}/api/admin/feedback`); res.status(r.status).json(r.body); }
  catch (err: any) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/wr/system-health', async (_req, res) => {
  try { const r = await wrProxy(`${wrBase()}/api/admin/system-health`); res.status(r.status).json(r.body); }
  catch (err: any) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/wr/usage/trend', async (_req, res) => {
  try { const r = await wrProxy(`${wrBase()}/api/admin/usage/trend`); res.status(r.status).json(r.body); }
  catch (err: any) { res.status(500).json({ error: err.message }); }
});

// ============================================================
// ADMIN APIS - Extended Platform Admin Proxy Routes
// ============================================================

// Dashboard / Stats
app.get('/api/admin/wr/stats', async (_req, res) => {
  try { const r = await wrProxy(`${wrBase()}/api/admin/stats`); res.status(r.status).json(r.body); }
  catch (err: any) { res.status(500).json({ error: err.message }); }
});
app.get('/api/admin/wr/health', async (_req, res) => {
  try { const r = await wrProxy(`${wrBase()}/api/admin/health`); res.status(r.status).json(r.body); }
  catch (err: any) { res.status(500).json({ error: err.message }); }
});
app.get('/api/admin/wr/infrastructure', async (_req, res) => {
  try { const r = await wrProxy(`${wrBase()}/api/admin/infrastructure`); res.status(r.status).json(r.body); }
  catch (err: any) { res.status(500).json({ error: err.message }); }
});
app.get('/api/admin/wr/supabase-health', async (_req, res) => {
  try { const r = await wrProxy(`${wrBase()}/api/admin/supabase-health`); res.status(r.status).json(r.body); }
  catch (err: any) { res.status(500).json({ error: err.message }); }
});

// Tenant CRUD
app.get('/api/admin/wr/tenants', async (req, res) => {
  try { const qs = new URLSearchParams(req.query as Record<string, string>).toString(); const r = await wrProxy(`${wrBase()}/api/admin/tenants${qs ? '?' + qs : ''}`); res.status(r.status).json(r.body); }
  catch (err: any) { res.status(500).json({ error: err.message }); }
});
app.post('/api/admin/wr/tenants', async (req, res) => {
  try { const r = await wrProxy(`${wrBase()}/api/admin/tenants`, { method: 'POST', body: JSON.stringify(req.body) }); res.status(r.status).json(r.body); }
  catch (err: any) { res.status(500).json({ error: err.message }); }
});
app.put('/api/admin/wr/tenants/:id', async (req, res) => {
  try { const r = await wrProxy(`${wrBase()}/api/admin/tenants/${req.params.id}`, { method: 'PUT', body: JSON.stringify(req.body) }); res.status(r.status).json(r.body); }
  catch (err: any) { res.status(500).json({ error: err.message }); }
});
app.delete('/api/admin/wr/tenants/:id', async (req, res) => {
  try { const r = await wrProxy(`${wrBase()}/api/admin/tenants/${req.params.id}`, { method: 'DELETE' }); res.status(r.status).json(r.body); }
  catch (err: any) { res.status(500).json({ error: err.message }); }
});

// Developer Tokens
app.get('/api/admin/wr/developer-tokens', async (_req, res) => {
  try { const r = await wrProxy(`${wrBase()}/api/admin/developer-tokens`); res.status(r.status).json(r.body); }
  catch (err: any) { res.status(500).json({ error: err.message }); }
});
app.post('/api/admin/wr/developer-tokens', async (req, res) => {
  try { const r = await wrProxy(`${wrBase()}/api/admin/developer-tokens`, { method: 'POST', body: JSON.stringify(req.body) }); res.status(r.status).json(r.body); }
  catch (err: any) { res.status(500).json({ error: err.message }); }
});
app.delete('/api/admin/wr/developer-tokens/:id', async (req, res) => {
  try { const r = await wrProxy(`${wrBase()}/api/admin/developer-tokens/${req.params.id}`, { method: 'DELETE' }); res.status(r.status).json(r.body); }
  catch (err: any) { res.status(500).json({ error: err.message }); }
});

// Audit Logs
app.get('/api/admin/wr/audit', async (req, res) => {
  try { const qs = new URLSearchParams(req.query as Record<string, string>).toString(); const r = await wrProxy(`${wrBase()}/api/admin/audit${qs ? '?' + qs : ''}`); res.status(r.status).json(r.body); }
  catch (err: any) { res.status(500).json({ error: err.message }); }
});

// Platform Config
app.get('/api/admin/wr/config', async (_req, res) => {
  try { const r = await wrProxy(`${wrBase()}/api/admin/config`); res.status(r.status).json(r.body); }
  catch (err: any) { res.status(500).json({ error: err.message }); }
});
app.post('/api/admin/wr/config', async (req, res) => {
  try { const r = await wrProxy(`${wrBase()}/api/admin/config`, { method: 'POST', body: JSON.stringify(req.body) }); res.status(r.status).json(r.body); }
  catch (err: any) { res.status(500).json({ error: err.message }); }
});

// AI Usage
app.get('/api/admin/wr/ai-usage', async (_req, res) => {
  try { const r = await wrProxy(`${wrBase()}/api/admin/ai-usage`); res.status(r.status).json(r.body); }
  catch (err: any) { res.status(500).json({ error: err.message }); }
});

// Billing (extended)
app.get('/api/admin/wr/billing', async (_req, res) => {
  try { const r = await wrProxy(`${wrBase()}/api/admin/billing`); res.status(r.status).json(r.body); }
  catch (err: any) { res.status(500).json({ error: err.message }); }
});

// Vercel Deploy Trigger
app.post('/api/admin/wr/deploy', async (req, res) => {
  try { const r = await wrProxy(`${wrBase()}/api/admin/services/vercel/deploy`, { method: 'POST', body: JSON.stringify(req.body) }); res.status(r.status).json(r.body); }
  catch (err: any) { res.status(500).json({ error: err.message }); }
});

// Hetzner Restart
app.post('/api/admin/wr/hetzner/restart', async (req, res) => {
  try { const r = await wrProxy(`${wrBase()}/api/admin/services/hetzner/restart`, { method: 'POST', body: JSON.stringify(req.body) }); res.status(r.status).json(r.body); }
  catch (err: any) { res.status(500).json({ error: err.message }); }
});

// User creation (via Supabase admin API directly from CUI server)
app.post('/api/admin/wr/users/create', async (req, res) => {
  const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
  const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    res.status(500).json({ error: 'Supabase credentials not configured' });
    return;
  }
  try {
    const { email, password, name, role } = req.body;
    if (!email || !password) {
      res.status(400).json({ error: 'email and password required' });
      return;
    }
    const response = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
      method: 'POST',
      headers: {
        'apikey': SERVICE_ROLE_KEY,
        'Authorization': `Bearer ${SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email,
        password,
        email_confirm: true,
        user_metadata: { name: name || '', role: role || 'user' },
      }),
    });
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (err: any) {
    console.error('[Admin] POST /api/admin/wr/users/create error:', err);
    res.status(500).json({ error: err.message });
  }
});

// User deletion
app.delete('/api/admin/wr/users/:id', async (req, res) => {
  const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
  const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    res.status(500).json({ error: 'Supabase credentials not configured' });
    return;
  }
  try {
    const response = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${req.params.id}`, {
      method: 'DELETE',
      headers: {
        'apikey': SERVICE_ROLE_KEY,
        'Authorization': `Bearer ${SERVICE_ROLE_KEY}`,
      },
    });
    if (response.status === 204) {
      res.json({ ok: true });
      return;
    }
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (err: any) {
    console.error('[Admin] DELETE /api/admin/wr/users/:id error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Impersonation routes
app.get('/api/admin/wr/impersonation', async (_req, res) => {
  try { const r = await wrProxy(`${wrBase()}/api/admin/impersonation`); res.status(r.status).json(r.body); }
  catch (err: any) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/wr/users/:id/impersonate', async (req, res) => {
  try { const r = await wrProxy(`${wrBase()}/api/admin/users/${req.params.id}/impersonate`, { method: 'POST' }); res.status(r.status).json(r.body); }
  catch (err: any) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/admin/wr/impersonation/:id/end', async (req, res) => {
  try { const r = await wrProxy(`${wrBase()}/api/admin/impersonation/${req.params.id}/end`, { method: 'DELETE' }); res.status(r.status).json(r.body); }
  catch (err: any) { res.status(500).json({ error: err.message }); }
});

// GET /api/ops/deployments — Vercel deployment status for all tracked apps
const VERCEL_APPS = [
  { name: 'werking-report', projectSlug: 'werking-report' },
  { name: 'werking-energy', projectSlug: 'werking-energy' },
  { name: 'platform', projectSlug: 'platform-werkingflow' },
  { name: 'engelmann', projectSlug: 'engelmann' },
  { name: 'werking-safety', projectSlug: 'werking-safety' },
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

// Error reports from frontend screenshot capture
const screenshotErrors = new Map<string, { error: string; at: string }>();

// POST /api/screenshot/:panel/error — frontend reports screenshot failure
app.post('/api/screenshot/:panel/error', (req, res) => {
  const { panel } = req.params;
  const { error } = req.body as { error?: string };
  console.error(`[Screenshot] Frontend error for "${panel}": ${error}`);
  screenshotErrors.set(panel, { error: error || 'unknown', at: new Date().toISOString() });
  res.json({ ok: true });
});

// Panel listing from frontend DOM introspection
let lastPanelList: { panels: Array<{ nodeId: string; visible: boolean; size: string }>; timestamp: string } | null = null;

// POST /api/screenshot/panels — frontend reports available panels
app.post('/api/screenshot/panels', (req, res) => {
  lastPanelList = req.body as typeof lastPanelList;
  console.log(`[Panels] DOM reports ${lastPanelList?.panels?.length ?? 0} panels`);
  res.json({ ok: true });
});

// GET /api/panels — trigger frontend to list all panel node IDs in the DOM
app.get('/api/panels', async (_req, res) => {
  lastPanelList = null;
  broadcast({ type: 'control:list-panels' });
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 200));
    if (lastPanelList) {
      res.json(lastPanelList);
      return;
    }
  }
  res.status(408).json({ error: 'No panel list received from frontend (is a browser connected?)' });
});

// POST /api/control/screenshot/request — trigger frontend to capture a panel screenshot
// panel: component name (e.g. "admin-wr") OR nodeId (full or 6-char short)
// wait: optional ms to wait (default 12000 — allows auto-add + render)
// contentWait: optional ms the frontend waits after panel is visible before capturing (default 2000)
// saveTo: optional absolute file path to save the PNG to
app.post('/api/control/screenshot/request', async (req, res) => {
  const { panel, wait, contentWait, saveTo } = req.body as { panel?: string; wait?: number; contentWait?: number; saveTo?: string };
  if (!panel) { res.status(400).json({ error: 'panel required' }); return; }
  const waitMs = Math.min(wait ?? 12000, 30000);
  screenshotErrors.delete(panel);
  // Step 1: Ensure panel exists and is visible (LayoutManager adds/activates it)
  broadcast({ type: 'control:ensure-panel', component: panel });
  broadcast({ type: 'control:select-tab', target: panel });
  // Step 2: Wait for panel to render, then request screenshot
  await new Promise(r => setTimeout(r, 1500));
  broadcast({ type: 'control:screenshot-request', panel, contentWait: contentWait ?? 2000 });
  // Wait for screenshot OR error to arrive
  const before = panelScreenshots.get(panel)?.capturedAt;
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 200));
    const err = screenshotErrors.get(panel);
    if (err) {
      res.status(422).json({ error: err.error, panel });
      return;
    }
    const current = panelScreenshots.get(panel);
    if (current && current.capturedAt !== before) {
      // Optionally copy to saveTo path
      if (saveTo && current.filePath) {
        try { copyFileSync(current.filePath, saveTo); } catch (e: any) {
          console.error(`[Screenshot] Failed to copy to ${saveTo}:`, e.message);
        }
      }
      res.json({ ok: true, panel, capturedAt: current.capturedAt, url: `/api/screenshot/${panel}.png`, ...(saveTo ? { savedTo: saveTo } : {}) });
      return;
    }
  }
  res.status(408).json({ error: `Screenshot timeout after ${waitMs}ms — panel may not be visible or no browser connected` });
});

// Shared Playwright helper: open CUI, navigate to project + tab, return page & browser
async function openCuiPanel(opts: { project?: string; tab?: string; nodeId?: string; wait?: number }) {
  const playwright = await import('playwright-core');
  const browser = await playwright.chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  await page.goto('http://localhost:4005', { timeout: 20000 });
  await page.waitForSelector('.flexlayout__layout', { timeout: 10000 });
  await page.waitForTimeout(2000);

  // Navigate to project tab if specified
  if (opts.project) {
    await page.evaluate((proj) => {
      for (const btn of document.querySelectorAll('button')) {
        if ((btn.title || '').toLowerCase().includes(proj.toLowerCase())) { btn.click(); break; }
      }
    }, opts.project);
    await page.waitForTimeout(2000);
  }

  // Click on specific tab if specified
  if (opts.tab) {
    await page.evaluate((tabName) => {
      for (const t of document.querySelectorAll('.flexlayout__tab_button_content')) {
        if (t.textContent === tabName) { (t as HTMLElement).click(); break; }
      }
    }, opts.tab);
    await page.waitForTimeout(opts.wait ?? 3000);
  }

  return { browser, page };
}

// GET /api/capture — Server-side screenshot using Playwright (no WebSocket needed)
// Query params:
//   target=full | target=<nodeId> | project=Team&tab=Virtual Office
//   wait=3000 (ms to wait for content to load)
//   mode=png (default) | mode=json (returns metadata + base64)
app.get('/api/capture', async (req, res) => {
  const target = req.query.target as string || 'full';
  const project = req.query.project as string;
  const tab = req.query.tab as string;
  const wait = Math.min(parseInt(req.query.wait as string) || 3000, 15000);

  try {
    const { browser, page } = await openCuiPanel({ project, tab, wait });

    let screenshot: Buffer;
    let desc: string;

    if (target === 'full') {
      screenshot = await page.screenshot({ type: 'png', fullPage: false }) as Buffer;
      desc = project ? `${project}/${tab || 'default'}` : 'full';
    } else {
      // Find element by nodeId (full or partial)
      const selector = await page.evaluate((id) => {
        // Exact match
        let el = document.querySelector(`[data-node-id="${id}"]`);
        if (el) return `[data-node-id="${id}"]`;
        // Partial match
        for (const e of document.querySelectorAll('[data-node-id]')) {
          const nid = e.getAttribute('data-node-id') || '';
          if (nid.startsWith(id)) return `[data-node-id="${nid}"]`;
        }
        return null;
      }, target);

      if (!selector) {
        const available = await page.evaluate(() =>
          Array.from(document.querySelectorAll('[data-node-id]')).map(e => e.getAttribute('data-node-id'))
        );
        await browser.close();
        res.status(404).json({ error: `Panel "${target}" not found`, available });
        return;
      }

      const el = page.locator(selector);
      screenshot = await el.screenshot({ type: 'png' }) as Buffer;
      desc = `node-${target}`;
    }

    await browser.close();

    // Save to file
    const filePath = `${SCREENSHOT_DIR}/${desc.replace(/[^a-zA-Z0-9-]/g, '_')}-live-${Date.now()}.png`;
    writeFileSync(filePath, screenshot);

    // Store in panelScreenshots map so it's retrievable via /api/screenshot/:panel.png
    const meta: PanelScreenshot = { panel: target, capturedAt: new Date().toISOString(), width: 0, height: 0, filePath };
    panelScreenshots.set(target, meta);

    console.log(`[Screenshot] Playwright: ${desc} (${screenshot.length} bytes) → ${filePath}`);

    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'no-cache');
    res.send(screenshot);
  } catch (error: any) {
    console.error('[Screenshot] Playwright error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Backward-compatible alias
app.get('/api/dev/screenshot-live', (req, res) => {
  const nodeId = req.query.nodeId as string;
  const panel = req.query.panel as string;
  const target = nodeId || panel || 'full';
  res.redirect(`/api/capture?target=${encodeURIComponent(target)}&wait=${req.query.wait || '3000'}`);
});

// GET /api/capture/panels — List all panels via Playwright
app.get('/api/capture/panels', async (req, res) => {
  const project = req.query.project as string;
  try {
    const { browser, page } = await openCuiPanel({ project });

    // Get all projects
    const projects = await page.evaluate(() => {
      const results: string[] = [];
      for (const btn of document.querySelectorAll('button')) {
        const title = btn.title || '';
        const m = title.match(/^(.+?)\s*—/);
        if (m) results.push(m[1].trim());
      }
      return results;
    });

    // Get panels for current project
    const panels = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[data-node-id]')).map(el => {
        const rect = el.getBoundingClientRect();
        return {
          nodeId: el.getAttribute('data-node-id'),
          visible: rect.width > 0 && rect.height > 0,
          size: `${Math.round(rect.width)}x${Math.round(rect.height)}`,
        };
      })
    );

    // Get tab names
    const tabs = await page.evaluate(() => {
      const seen = new Set<string>();
      return Array.from(document.querySelectorAll('.flexlayout__tab_button_content'))
        .filter(el => { const r = el.getBoundingClientRect(); return r.top > 25 && r.top < 100; })
        .map(el => el.textContent?.trim() || '')
        .filter(t => { if (seen.has(t) || !t) return false; seen.add(t); return true; });
    });

    await browser.close();

    res.json({ projects, currentProject: project || projects[0], tabs, panels });
  } catch (error: any) {
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

// --- Dev Server Watchdog Proxy ---
// Proxies /watchdog/* to the watchdog panel running on the remote dev server
const WATCHDOG_HOST = 'localhost';
const WATCHDOG_PORT = 9090;
app.use('/watchdog', (req, res) => {
  const targetPath = req.url === '/' || req.url === '' ? '/' : req.url;
  const proxyReq = httpRequest({
    hostname: WATCHDOG_HOST,
    port: WATCHDOG_PORT,
    path: targetPath,
    method: req.method,
    headers: { ...req.headers, host: `${WATCHDOG_HOST}:${WATCHDOG_PORT}` },
  }, (proxyRes) => {
    res.writeHead(proxyRes.statusCode || 200, proxyRes.headers);
    proxyRes.pipe(res);
  });
  proxyReq.on('error', () => {
    res.status(502).json({ error: `Dev Server Watchdog not reachable (${WATCHDOG_HOST}:${WATCHDOG_PORT})` });
  });
  req.pipe(proxyReq);
});

// --- Rebuild & Restart Endpoints ---

// Helper: restart CUI server after build
function restartCuiServer() {
  console.log('[Restart] Triggering external restart script...');

  // Use external restart script for clean restart (kill old, start new)
  const { spawn } = require('child_process');
  const restartScript = join(WORKSPACE_ROOT, 'restart-server.sh');

  spawn('bash', [restartScript], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env }
  }).unref();

  console.log('[Restart] Restart script launched, exiting in 500ms...');

  // Exit after launching restart script
  setTimeout(() => {
    console.log('[Restart] Exiting now');
    process.exit(0);
  }, 500);
}

// Helper: trigger watchdog to restart all enabled dev servers
function triggerWatchdogCheck() {
  try {
    const postReq = httpRequest({ hostname: WATCHDOG_HOST, port: WATCHDOG_PORT, path: '/api/check', method: 'POST', timeout: 3000 }, () => {
      console.log('[Rebuild] Watchdog check triggered');
    });
    postReq.on('error', () => { console.log('[Rebuild] Watchdog not available (skipped)'); });
    postReq.end();
  } catch { /* watchdog not running, skip */ }
}

// POST /api/rebuild — legacy rebuild (redirects to robust cui-rebuild)
app.post('/api/rebuild', (_req, res) => {
  console.log('[Rebuild] Spawning cui-rebuild (detached)...');
  broadcast({ type: 'cui-rebuilding' });
  res.json({ status: 'rebuilding', message: 'cui-rebuild gestartet (Server startet gleich neu)...' });
  setTimeout(() => {
    const child = spawn('systemd-run', ['--scope', '--', 'cui-rebuild'], { detached: true, stdio: ['ignore', 'ignore', 'ignore'] });
    child.unref();
    console.log('[Rebuild] cui-rebuild spawned via systemd-run, PID', child.pid);
  }, 500);
});

// Panel configuration with start commands
const PANEL_CONFIGS = [
  { name: 'Platform', port: 3004, path: '/root/projekte/werkingflow/platform', startCmd: 'npm run build:local' },
  { name: 'Dashboard', port: 3333, path: '/root/projekte/werkingflow/dashboard', startCmd: 'python3 -m dashboard.app &' },
  { name: 'Werking-Report', port: 3008, path: '/root/projekte/werking-report', startCmd: 'npm run build:local' },
  { name: 'Werking-Energy', port: 3007, path: '/root/projekte/apps/werking-energy', startCmd: 'npm run build:local' },
  { name: 'Engelmann', port: 3009, path: '/root/projekte/engelmann-ai-hub', startCmd: 'npm run build:local' },
  { name: 'Safety', port: 3006, path: '/root/projekte/werking-safety/frontend', startCmd: 'npm run build:local' },
];

// GET /api/panel-health — Check which panel dependencies are running
app.get('/api/panel-health', async (_req, res) => {
  const checks = await Promise.all(PANEL_CONFIGS.map(async (panel) => {
    try {
      // Use nc (netcat) to check if port is listening
      const checkPort = () => new Promise<boolean>((resolve) => {
        const proc = spawn('nc', ['-z', 'localhost', String(panel.port)], {
          stdio: ['ignore', 'ignore', 'ignore']
        });

        proc.on('close', (code) => {
          resolve(code === 0);
        });

        proc.on('error', () => {
          resolve(false);
        });

        // Timeout after 1s
        setTimeout(() => {
          proc.kill();
          resolve(false);
        }, 1000);
      });

      const isRunning = await checkPort();
      return { ...panel, running: isRunning };
    } catch {
      return { ...panel, running: false };
    }
  }));

  const running = checks.filter(c => c.running);
  const missing = checks.filter(c => !c.running);

  res.json({
    ok: missing.length === 0,
    total: PANEL_CONFIGS.length,
    running: running.length,
    missing: missing.length,
    panels: checks,
    message: missing.length === 0 ? 'All panels running' : `${missing.length} offline: ${missing.map(p => p.name).join(', ')}`
  });
});

// GET /api/health-check-proxy — Proxy for external backend health checks (CORS bypass)
app.get('/api/health-check-proxy', async (req, res) => {
  const targetUrl = req.query.url as string;

  if (!targetUrl) {
    return res.status(400).json({ error: 'Missing url parameter' });
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3000);

    const response = await fetch(targetUrl, {
      method: 'GET',
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    res.json({
      ok: response.ok,
      status: response.status,
      url: targetUrl
    });
  } catch (err: any) {
    res.json({
      ok: false,
      error: err.message,
      url: targetUrl
    });
  }
});

// POST /api/start-all-panels — Start all missing panel backends
app.post('/api/start-all-panels', (_req, res) => {
  console.log('[Start-Panels] Launching start script...');
  try {
    const startScript = join(WORKSPACE_ROOT, 'start-all-panels.sh');
    const child = spawn('bash', [startScript], { detached: true, stdio: 'ignore', env: process.env });
    child.unref();
    console.log('[Start-Panels] Script launched');
    res.json({ ok: true, message: 'Starting all missing panels', note: 'Check status in 10-30s' });
  } catch (err: any) {
    console.error('[Start-Panels] Failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/rebuild-frontend — called by ProjectTabs Rebuild button
// Spawns cui-rebuild as detached background process (because it restarts this server)
app.post('/api/rebuild-frontend', async (_req, res) => {
  console.log('[Rebuild-Frontend] Spawning cui-rebuild (detached)...');
  broadcast({ type: 'cui-rebuilding' });

  // Respond immediately — the server will be killed by cui-rebuild
  res.json({ ok: true, detail: 'cui-rebuild started (server will restart)' });

  // Use systemd-run to escape the cgroup (systemd KillMode=control-group kills all children)
  setTimeout(() => {
    const child = spawn('systemd-run', ['--scope', '--', 'cui-rebuild'], {
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    child.unref();
    console.log('[Rebuild-Frontend] cui-rebuild spawned via systemd-run, PID', child.pid);
  }, 500);
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

// --- Agent API Proxy to Hetzner ---
// Server runs on dev server — agents are local, no proxy needed.

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
    const messages = [];

    // Split on "\n---\n" - results in alternating headers/body pairs
    const parts = content.split(/\n---\n/).filter(p => p.trim());

    // Process pairs: parts[0,2,4...] = headers, parts[1,3,5...] = body
    for (let i = 0; i < parts.length - 1; i += 2) {
      let headers = parts[i].replace(/^---\n/, '').trim(); // Remove leading --- if present
      const body = parts[i + 1]?.trim() || '';

      // Parse headers
      const vonMatch = headers.match(/Von:\s*(.+)/i);
      const betreffMatch = headers.match(/Betreff:\s*(.+)/i);
      const datumMatch = headers.match(/Datum:\s*(.+)/i);

      if (vonMatch || betreffMatch) { // Only add if we found at least one header
        messages.push({
          from: vonMatch?.[1]?.trim() ?? 'Unknown',
          subject: betreffMatch?.[1]?.trim() ?? 'No Subject',
          date: datumMatch?.[1]?.trim() ?? '',
          body
        });
      }
    }

    res.json({ persona_id: safe, messages });
  } catch { res.json({ persona_id: safe, messages: [] }); }
});

// GET /api/agents/approvals/:personaId - Agent-specific pending approvals
app.get('/api/agents/approvals/:personaId', async (req, res) => {
  const safe = req.params.personaId.replace(/[^a-z0-9-]/g, '');
  try {
    const approvalDir = `${AGENTS_DIR}/approvals/${safe}`;
    const files = await fsAgentPromises.readdir(approvalDir).catch(() => []);
    const pendingFiles = files.filter(f => f.endsWith('.pending'));

    const approvals = await Promise.all(pendingFiles.map(async (file) => {
      try {
        const content = await fsAgentPromises.readFile(`${approvalDir}/${file}`, 'utf-8');
        const stat = await fsAgentPromises.stat(`${approvalDir}/${file}`);
        return {
          file,
          summary: content.slice(0, 200),
          timestamp: stat.mtime.toISOString()
        };
      } catch {
        return null;
      }
    }));

    res.json({ persona_id: safe, approvals: approvals.filter(Boolean) });
  } catch { res.json({ persona_id: safe, approvals: [] }); }
});

// GET /api/agents/approvals - Global pending approvals (legacy)
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

const CLAUDE_AGENT_REGISTRY: Record<string, { name: string; schedule: string; task_type: string }> = {
  'rafbot':          { name: 'Rafbot',           schedule: 'on-demand',      task_type: 'META' },
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
    let approvals_count = 0;
    try {
      const appDir = `${AGENTS_DIR}/approvals/${id}`;
      const files = await fsAgentPromises.readdir(appDir).catch(() => [] as string[]);
      approvals_count = files.filter(f => f.endsWith('.pending')).length;
    } catch { /**/ }
    return {
      id,
      persona_id: id,
      persona_name: info.name,
      schedule: info.schedule,
      task_type: info.task_type,
      status: runningClaudes.has(id) ? 'working' as const : 'idle' as const,
      last_run,
      last_outcome,
      last_actions: 0,
      last_action_types: [] as string[],
      last_trigger: null as string | null,
      next_run: '',
      has_pending_approvals: approvals_count > 0,
      approvals_count,
      inbox_count,
    };
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
  // Always pipe prompt via stdin (avoids ARG_MAX limits for long prompts)
  const isRoot = process.getuid?.() === 0;
  const cmd = isRoot ? 'sudo' : 'claude';
  const args = isRoot
    ? ['-u', 'claude-user', 'claude', '--dangerously-skip-permissions', '--print']
    : ['--dangerously-skip-permissions', '--print'];
  const proc = spawn(cmd, args, { cwd: '/root/projekte/werkingflow', stdio: ['pipe', 'pipe', 'pipe'], env: spawnEnv });
  if (!proc.stdin) throw new Error(`Failed to open stdin for ${persona_id}`);
  proc.stdin.write(fullPrompt);
  proc.stdin.end();
  const writeLog = (s: string) => fsAgentPromises.appendFile(logFile, s).catch(() => {});
  writeLog(`[${now}] ${info.name} gestartet — ${taskDesc}\n${'─'.repeat(60)}\n\n`);
  proc.stdout?.on('data', (d: Buffer) => writeLog(d.toString()));
  proc.stderr?.on('data', (d: Buffer) => writeLog(`[ERR] ${d.toString()}`));
  proc.on('close', (code) => { runningClaudes.delete(persona_id); writeLog(`\n${'─'.repeat(60)}\n[DONE] Exit: ${code}\n`); console.log(`[ClaudeAgent:${persona_id}] done (${code})`); });
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

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
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

// --- Persona Tagging Endpoints ---
const PERSONA_TAG_SCRIPT = '/root/projekte/orchestrator/scripts/update-persona-tags.sh';
const ORCHESTRATOR_DATA_DIR = '/root/projekte/orchestrator/data';

// POST /api/persona-tags/update — Start persona tagging update
app.post('/api/persona-tags/update', async (_req, res) => {
  try {
    console.log('[Persona Tags] Starting update...');

    // Spawn script in background (only on server where script exists)
    const child = spawn(PERSONA_TAG_SCRIPT, [], {
      detached: true,
      stdio: 'ignore',
      cwd: '/root/projekte/orchestrator'
    });

    // CRITICAL: handle spawn errors to prevent process crash (ENOENT on local dev)
    child.on('error', (err) => {
      console.error(`[Persona Tags] Spawn error: ${err.message}`);
    });

    child.unref();

    res.json({ status: 'started' });
  } catch (err: any) {
    console.error('[Persona Tags] Update error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/persona-tags/status — Get tagging status for all apps
app.get('/api/persona-tags/status', async (_req, res) => {
  try {
    const apps = ['werking-report', 'engelmann', 'werking-energy', 'werking-safety'];
    const statusData: Record<string, any> = {};

    for (const app of apps) {
      const enrichedPath = `${ORCHESTRATOR_DATA_DIR}/${app}/enriched.json`;
      const tagsPath = `${ORCHESTRATOR_DATA_DIR}/${app}/persona-tags.json`;

      if (existsSync(enrichedPath)) {
        try {
          const enrichedContent = readFileSync(enrichedPath, 'utf-8');
          const enrichedData = JSON.parse(enrichedContent);
          const totalIds = enrichedData.summary?.total_ids || 0;

          statusData[app] = {
            total_ids: totalIds,
            has_tags: existsSync(tagsPath),
            enriched_mtime: statSync(enrichedPath).mtimeMs / 1000,
          };

          if (existsSync(tagsPath)) {
            statusData[app].tags_mtime = statSync(tagsPath).mtimeMs / 1000;
          }
        } catch (err) {
          console.error(`[Persona Tags] Error reading ${app}:`, err);
        }
      }
    }

    res.json(statusData);
  } catch (err: any) {
    console.error('[Persona Tags] Status error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Demo activity events (simulated agent actions)
const demoActivities = [
  { persona_id: 'sarah-koch', persona_name: 'Sarah Koch', action: 'started', task: 'OAuth implementation review' },
  { persona_id: 'klaus-schmidt', persona_name: 'Klaus Schmidt', action: 'completed', task: 'Production deployment' },
  { persona_id: 'herbert-sicher', persona_name: 'Herbert Sicher', action: 'started', task: 'Security audit Q1' },
  { persona_id: 'lisa-mueller', persona_name: 'Lisa Müller', action: 'completed', task: 'Test coverage analysis' },
  { persona_id: 'mira-marketing', persona_name: 'Mira Marketing', action: 'started', task: 'Brand strategy update' },
  { persona_id: 'vera-vertrieb', persona_name: 'Vera Vertrieb', action: 'completed', task: 'Pricing strategy revision' },
  { persona_id: 'finn-finanzen', persona_name: 'Finn Finanzen', action: 'started', task: 'Q1 budget review' },
  { persona_id: 'chris-customer', persona_name: 'Chris Customer', action: 'completed', task: 'Onboarding playbook v2' }
];

let activityIndex = 0;

// GET /api/agents/activity-stream — SSE stream of agent activities
app.get('/api/agents/activity-stream', (_req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Send initial connected event
  res.write(`data: ${JSON.stringify({
    timestamp: new Date().toISOString(),
    type: 'connected',
    message: 'Activity stream connected'
  })}\n\n`);

  // Send a demo activity event every 10 seconds
  const interval = setInterval(() => {
    const activity = demoActivities[activityIndex % demoActivities.length];
    activityIndex++;

    res.write(`data: ${JSON.stringify({
      timestamp: new Date().toISOString(),
      type: 'activity',
      persona_id: activity.persona_id,
      persona_name: activity.persona_name,
      action: activity.action,
      task: activity.task
    })}\n\n`);
  }, 10000); // Every 10 seconds

  // Cleanup on client disconnect
  _req.on('close', () => {
    clearInterval(interval);
  });
});

// GET /api/agents/recommendations — smart action recommendations
app.get('/api/agents/recommendations', async (_req, res) => {
  try {
    const urgent: Array<any> = [];
    const recommended: Array<any> = [];

    // 1. Check business approvals for old items (URGENT if >3 days)
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
            description: `Pending for ${ageDays} days - may be blocking ${entry.persona}`,
            ageDays,
            personaId: entry.persona,
            personaName: entry.persona
          });
        } else if (ageDays > 1) {
          recommended.push({
            title: `Review: ${entry.file.split('/').pop().replace('.pending', '')}`,
            description: `Pending for ${ageDays} days from ${entry.persona}`,
            ageDays,
            personaId: entry.persona,
            personaName: entry.persona
          });
        }
      });
    } catch {}

    // 2. Check for agents with scheduled runs that are overdue
    try {
      const agentStatusRes = await fetch('http://localhost:4005/api/agents/claude/status');
      if (agentStatusRes.ok) {
        const { agents } = await agentStatusRes.json();

        agents.forEach((agent: any) => {
          // Check if agent has schedule and last run was >7 days ago
          if (agent.last_run) {
            const daysSinceRun = Math.floor((Date.now() - new Date(agent.last_run).getTime()) / 86400000);

            if (daysSinceRun > 7 && agent.schedule && agent.schedule !== 'on-demand') {
              recommended.push({
                title: `Run ${agent.persona_name}`,
                description: `Last run was ${daysSinceRun} days ago (scheduled: ${agent.schedule})`,
                personaId: agent.persona_id,
                personaName: agent.persona_name
              });
            }
          } else if (agent.schedule && agent.schedule !== 'on-demand') {
            // Never run but has schedule
            recommended.push({
              title: `First run: ${agent.persona_name}`,
              description: `Never run yet (scheduled: ${agent.schedule})`,
              personaId: agent.persona_id,
              personaName: agent.persona_name
            });
          }
        });
      }
    } catch {}

    // 3. Count idle vs working agents for tips
    let idleCount = 0;
    let workingCount = 0;
    try {
      const agentStatusRes = await fetch('http://localhost:4005/api/agents/claude/status');
      if (agentStatusRes.ok) {
        const { agents } = await agentStatusRes.json();
        idleCount = agents.filter((a: any) => a.status === 'idle').length;
        workingCount = agents.filter((a: any) => a.status === 'working').length;
      }
    } catch {}

    res.json({
      urgent,
      recommended,
      tips: {
        idle_agents: idleCount,
        working_agents: workingCount,
        blocking_count: urgent.length
      }
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// GET /api/agents/persona/:id — get parsed persona data
app.get('/api/agents/persona/:id', async (req, res) => {
  const { id } = req.params;
  const personaPath = `/root/projekte/orchestrator/team/personas/${id}.md`;

  try {
    const content = await fsAgentPromises.readFile(personaPath, 'utf-8');

    // Simple inline parser (matches personaParser.ts logic)
    const persona: Record<string, any> = {
      id,
      name: '',
      role: '',
      mbti: '',
      strengths: [],
      weaknesses: [],
      responsibilities: [],
      collaboration: [],
      scenarios: []
    };

    // Extract name and role from header
    const headerMatch = content.match(/^#\s+(.+?)\s+-\s+(.+?)$/m);
    if (headerMatch) {
      persona.name = headerMatch[1].trim();
      persona.role = headerMatch[2].trim();
    }

    // Extract MBTI
    const mbtiMatch = content.match(/\*\*MBTI\*\*:\s+(.+?)$/m);
    if (mbtiMatch) persona.mbti = mbtiMatch[1].trim();

    // Extract Specialty
    const specialtyMatch = content.match(/\*\*Spezialgebiet\*\*:\s+(.+?)$/m);
    if (specialtyMatch) persona.specialty = specialtyMatch[1].trim();

    // Extract Reports To
    const reportsToMatch = content.match(/\*\*Berichtet an\*\*:\s+(.+?)$/m);
    if (reportsToMatch) persona.reportsTo = reportsToMatch[1].trim();

    // Extract metadata
    const teamMatch = content.match(/\*\*Team\*\*:\s+(.+?)$/m);
    if (teamMatch) persona.team = teamMatch[1].trim();

    const deptMatch = content.match(/\*\*Department\*\*:\s+(.+?)$/m);
    if (deptMatch) persona.department = deptMatch[1].trim();

    // Extract motto
    const mottoMatch = content.match(/>\s+"(.+?)"/);
    if (mottoMatch) persona.motto = mottoMatch[1].trim();

    // Extract Strengths
    const strengthsSection = content.match(/###\s+Stärken\s*([\s\S]*?)(?=###|##|$)/);
    if (strengthsSection) {
      const items = strengthsSection[1].match(/^-\s+(.+?)$/gm);
      if (items) persona.strengths = items.map((item: string) => item.replace(/^-\s+/, '').trim());
    }

    // Extract Weaknesses
    const weaknessesSection = content.match(/###\s+Schwächen\s*([\s\S]*?)(?=###|##|$)/);
    if (weaknessesSection) {
      const items = weaknessesSection[1].match(/^-\s+(.+?)$/gm);
      if (items) persona.weaknesses = items.map((item: string) => item.replace(/^-\s+/, '').trim());
    }

    // Extract Responsibilities
    const responsSection = content.match(/##\s+Verantwortlichkeiten\s*([\s\S]*?)(?=##|$)/);
    if (responsSection) {
      const items = responsSection[1].match(/^\d+\.\s+\*\*(.+?)\*\*\s+—\s+(.+?)$/gm);
      if (items) {
        persona.responsibilities = items.map((item: string) => {
          const match = item.match(/^\d+\.\s+\*\*(.+?)\*\*\s+—\s+(.+?)$/);
          return match ? `${match[1]}: ${match[2]}` : item;
        });
      }
    }

    // Extract Collaboration
    const collabSection = content.match(/##\s+Zusammenarbeit\s*([\s\S]*?)(?=##|$)/);
    if (collabSection) {
      const rows = collabSection[1].match(/^\|\s+\*\*(.+?)\*\*\s+\|\s+(.+?)\s+\|$/gm);
      if (rows) {
        persona.collaboration = rows.map((row: string) => {
          const match = row.match(/^\|\s+\*\*(.+?)\*\*\s+\|\s+(.+?)\s+\|$/);
          return match ? { person: match[1].trim(), reason: match[2].trim() } : null;
        }).filter(Boolean);
      }
    }

    res.json(persona);
  } catch (err) {
    res.status(404).json({ error: 'Persona not found' });
  }
});

// --- CPU Profile API (triggers renderer-side V8 profiling via WebSocket) ---
let pendingProfileResolve: ((result: unknown) => void) | null = null;
app.post('/api/cpu-profile', (_req, res) => {
  broadcast({ type: 'control:cpu-profile' });
  const timeout = setTimeout(() => {
    pendingProfileResolve = null;
    res.json({ error: 'timeout - no response from renderer within 10s' });
  }, 10000);
  pendingProfileResolve = (result) => {
    clearTimeout(timeout);
    pendingProfileResolve = null;
    res.json(result);
  };
});

// GET /api/agents/team/structure — get team org chart + RACI matrix
app.get('/api/agents/team/structure', async (_req, res) => {
  try {
    // Try to load pre-built hierarchy from hierarchy.json first
    const hierarchyPath = '/root/projekte/werkingflow/autopilot/cui/data/active/team/hierarchy.json';

    try {
      const hierarchyContent = await fsAgentPromises.readFile(hierarchyPath, 'utf-8');
      const hierarchyData = JSON.parse(hierarchyContent);

      // Load RACI matrix separately
      const raciPath = '/root/projekte/werkingflow/autopilot/cui/data/active/team/raci-matrix.json';
      let raciMatrix: Array<any> = [];

      try {
        const raciContent = await fsAgentPromises.readFile(raciPath, 'utf-8');
        const raciData = JSON.parse(raciContent);
        raciMatrix = (raciData.tasks || []).map((t: any) => ({
          task: t.task,
          owner: t.owner || '',
          responsible: t.responsible || [],
          approver: t.approver || [],
          consulted: t.consulted || []
        }));
      } catch (raciErr) {
        console.warn('Could not load raci-matrix.json:', raciErr);
      }

      // Return hierarchy + RACI
      return res.json({
        orgChart: hierarchyData.orgChart || [],
        raciMatrix,
        personas: [] // Can add persona details if needed
      });
    } catch (hierarchyErr) {
      // Fallback: build from persona files (legacy)
      console.warn('hierarchy.json not found, building from personas:', hierarchyErr);
    }

    // Fallback: build hierarchy from persona markdown files
    const personasDir = '/root/projekte/orchestrator/team/personas';
    const files = await fsAgentPromises.readdir(personasDir);
    const mdFiles = files.filter(f => f.endsWith('.md'));

    const personas: Array<any> = [];

    for (const file of mdFiles) {
      const id = file.replace('.md', '');
      const content = await fsAgentPromises.readFile(`${personasDir}/${file}`, 'utf-8');

      const persona: Record<string, any> = { id, responsibilities: [], collaboration: [] };

      // Extract name, role, reportsTo
      const headerMatch = content.match(/^#\s+(.+?)\s+-\s+(.+?)$/m);
      if (headerMatch) {
        persona.name = headerMatch[1].trim();
        persona.role = headerMatch[2].trim();
      }

      const reportsToMatch = content.match(/\*\*Berichtet an\*\*:\s+(.+?)$/m);
      if (reportsToMatch) persona.reportsTo = reportsToMatch[1].trim();

      const teamMatch = content.match(/\*\*Team\*\*:\s+(.+?)$/m);
      if (teamMatch) persona.team = teamMatch[1].trim();

      const deptMatch = content.match(/\*\*Department\*\*:\s+(.+?)$/m);
      if (deptMatch) persona.department = deptMatch[1].trim();

      // Extract responsibilities
      const responsSection = content.match(/##\s+Verantwortlichkeiten\s*([\s\S]*?)(?=##|$)/);
      if (responsSection) {
        const items = responsSection[1].match(/^\d+\.\s+\*\*(.+?)\*\*\s+—\s+(.+?)$/gm);
        if (items) {
          persona.responsibilities = items.map((item: string) => {
            const match = item.match(/^\d+\.\s+\*\*(.+?)\*\*\s+—\s+(.+?)$/);
            return match ? `${match[1]}: ${match[2]}` : item;
          });
        }
      }

      // Extract collaboration
      const collabSection = content.match(/##\s+Zusammenarbeit\s*([\s\S]*?)(?=##|$)/);
      if (collabSection) {
        const rows = collabSection[1].match(/^\|\s+\*\*(.+?)\*\*\s+\|\s+(.+?)\s+\|$/gm);
        if (rows) {
          persona.collaboration = rows.map((row: string) => {
            const match = row.match(/^\|\s+\*\*(.+?)\*\*\s+\|\s+(.+?)\s+\|$/);
            return match ? { person: match[1].trim(), reason: match[2].trim() } : null;
          }).filter(Boolean);
        }
      }

      personas.push(persona);
    }

    // Build org chart with smart name matching
    const nodeMap = new Map();
    const nameToIdMap = new Map(); // Map display names to IDs

    personas.forEach(p => {
      nodeMap.set(p.id, { id: p.id, name: p.name, role: p.role, children: [] });

      // Build name-to-ID mapping (e.g., "Max" -> "max-weber", "Max (CTO)" -> "max-weber")
      if (p.name) {
        const firstName = p.name.split(' ')[0].toLowerCase();
        nameToIdMap.set(firstName, p.id);
        nameToIdMap.set(p.name.toLowerCase(), p.id);
      }
    });

    // Add special aliases for common references (with parens removed)
    nameToIdMap.set('rafael', 'rafbot');
    nameToIdMap.set('rafael ceo', 'rafbot');  // "Rafael (CEO)" → "rafael ceo"
    nameToIdMap.set('rafael engelmann', 'rafbot');  // Rafbot reports to "Rafael Engelmann (Real)" → treat as self
    nameToIdMap.set('rafael engelmann real', 'rafbot');
    nameToIdMap.set('max', 'max-weber');
    nameToIdMap.set('max cto', 'max-weber');  // "Max (CTO)" → "max cto"
    nameToIdMap.set('vera', 'vera-vertrieb');
    nameToIdMap.set('vera sales', 'vera-vertrieb');  // "Vera (Sales)" → "vera sales"
    nameToIdMap.set('otto', 'otto-operations');
    nameToIdMap.set('otto coo', 'otto-operations');  // "Otto (COO)" → "otto coo"

    const roots: Array<any> = [];
    personas.forEach(p => {
      const node = nodeMap.get(p.id);
      if (p.reportsTo) {
        // Try to find parent by name (e.g., "Max (CTO)" -> "max-weber")
        // Remove parens, take first part before dash/slash, trim
        // Examples: "Rafael (CEO) - direkt" → "rafael ceo", "Vera (Sales) / Rafael (CEO)" → "vera sales"
        const reportsToClean = p.reportsTo.toLowerCase().replace(/[()]/g, '').split(/[-/]/)[0].trim();
        const reportsToFirstWord = reportsToClean.split(/\s+/)[0].trim(); // "max cto" -> "max"

        // Try exact match first, then first word only
        let parentId = nameToIdMap.get(reportsToClean) || nameToIdMap.get(reportsToFirstWord);

        if (parentId) {
          const parent = nodeMap.get(parentId);
          if (parent && parent !== node) {
            parent.children.push(node);
          } else {
            roots.push(node);
          }
        } else {
          // No parent found - make it a root
          roots.push(node);
        }
      } else {
        roots.push(node);
      }
    });

    // Build RACI matrix - load from raci-matrix.json if available, otherwise build from personas
    let raciMatrix: Array<any> = [];

    try {
      const raciPath = '/root/projekte/werkingflow/autopilot/cui/data/active/team/raci-matrix.json';
      const raciContent = await fsAgentPromises.readFile(raciPath, 'utf-8');
      const raciData = JSON.parse(raciContent);

      // Transform from JSON format to API format
      raciMatrix = (raciData.tasks || []).map((t: any) => ({
        task: t.task,
        owner: t.owner || '',
        responsible: t.responsible || [],
        approver: t.approver || [],
        consulted: t.consulted || []
      }));
    } catch (raciErr) {
      // Fallback: build from persona responsibilities
      console.warn('Could not load raci-matrix.json, building from personas:', raciErr);

      const taskMap = new Map();
      personas.forEach(p => {
        p.responsibilities.forEach((resp: string) => {
          const [task] = resp.split(':');
          const taskKey = task.trim().toLowerCase();

          if (!taskMap.has(taskKey)) {
            taskMap.set(taskKey, {
              task: task.trim(),
              owner: p.name,
              responsible: [p.name],
              approver: [],
              consulted: []
            });
          }
        });
      });

      raciMatrix.push(...Array.from(taskMap.values()));
    }

    res.json({ orgChart: roots, raciMatrix, personas });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// --- Claude Code Usage Stats (CC-Usage) ---
const CC_ACCOUNTS = [
  { id: "engelmann", displayName: "Engelmann", homeDir: "/home/claude-user/.cui-account2" },
  { id: "rafael", displayName: "Gmail", homeDir: "/home/claude-user/.cui-account1" },
  { id: "office", displayName: "Office", homeDir: "/home/claude-user/.cui-account3" },
];
const SCRAPED_FILE = resolve(import.meta.dirname ?? ".", "..", "claude-usage-scraped.json");
const WEEKLY_LIMIT_ESTIMATE = 45_000_000; // Conservative Pro plan estimate

app.get("/api/claude-code/stats-v2", async (_req, res) => {
  try {
    // Load scraped data if available
    let scrapedMap: Record<string, any> = {};
    try {
      if (existsSync(SCRAPED_FILE)) {
        const scraped = JSON.parse(readFileSync(SCRAPED_FILE, "utf-8"));
        for (const entry of scraped) {
          const key = entry.account?.toLowerCase().replace(/@.*/, "").replace(/\..+/, "");
          if (key) scrapedMap[key] = entry;
        }
      }
    } catch { /* scraped data optional */ }

    const now = Date.now();
    const ONE_HOUR = 3600_000;
    const ONE_DAY = 86400_000;
    const ONE_WEEK = 7 * ONE_DAY;
    const accounts: any[] = [];
    const alerts: any[] = [];

    for (const acc of CC_ACCOUNTS) {
      const projectsDir = join(acc.homeDir, ".claude", "projects");
      let workspaces: string[] = [];
      let totalSessions = 0;
      let totalInputTokens = 0;
      let totalOutputTokens = 0;
      let totalCacheCreation = 0;
      let totalCacheRead = 0;
      let lastActivity: string | null = null;
      let models: Record<string, number> = {};
      let recentTokens = 0; // last 24h
      let windowTokens = 0; // last 5h
      let lastWindowMsg: string | null = null;

      try {
        if (existsSync(projectsDir)) {
          workspaces = readdirSync(projectsDir).filter(d => {
            try { return statSync(join(projectsDir, d)).isDirectory(); } catch { return false; }
          });

          for (const ws of workspaces) {
            const wsDir = join(projectsDir, ws);
            let jsonlFiles: string[] = [];
            try {
              jsonlFiles = readdirSync(wsDir).filter(f => f.endsWith(".jsonl") && /^[0-9a-f]{8}-/.test(f));
            } catch { continue; }

            totalSessions += jsonlFiles.length;

            for (const file of jsonlFiles) {
              try {
                const content = readFileSync(join(wsDir, file), "utf-8");
                const lines = content.split("\n").filter(Boolean);

                for (const line of lines) {
                  try {
                    const entry = JSON.parse(line);
                    if (entry.type !== "assistant" || !entry.message?.usage) continue;

                    const usage = entry.message.usage;
                    const model = entry.message.model || "unknown";
                    const ts = entry.timestamp ? new Date(entry.timestamp).getTime() : 0;

                    const input = (usage.input_tokens || 0);
                    const output = (usage.output_tokens || 0);
                    const cacheCreate = (usage.cache_creation_input_tokens || 0);
                    const cacheRead = (usage.cache_read_input_tokens || 0);

                    totalInputTokens += input;
                    totalOutputTokens += output;
                    totalCacheCreation += cacheCreate;
                    totalCacheRead += cacheRead;

                    models[model] = (models[model] || 0) + input + output;

                    if (entry.timestamp && (!lastActivity || entry.timestamp > lastActivity)) {
                      lastActivity = entry.timestamp;
                    }

                    // Recent activity tracking
                    if (ts > now - ONE_DAY) {
                      recentTokens += input + output;
                    }
                    if (ts > now - 5 * ONE_HOUR) {
                      windowTokens += input + output;
                      if (!lastWindowMsg || (entry.timestamp && entry.timestamp > lastWindowMsg)) {
                        lastWindowMsg = entry.timestamp;
                      }
                    }
                  } catch { /* skip malformed lines */ }
                }
              } catch { /* skip unreadable files */ }
            }
          }
        }
      } catch { /* account dir issues */ }

      const totalTokens = totalInputTokens + totalOutputTokens;
      const burnRatePerHour = recentTokens > 0 ? recentTokens / 24 : 0;
      const weeklyProjection = burnRatePerHour * 24 * 7;

      // Merge with scraped data
      const scraped = scrapedMap[acc.id];
      let weeklyLimitPercent = weeklyProjection > 0 ? (weeklyProjection / WEEKLY_LIMIT_ESTIMATE) * 100 : 0;
      let weeklyLimitActual = 0;
      let dataSource: string = "jsonl-estimated";
      let scrapedTimestamp: string | null = null;
      let nextWindowReset: string | null = null;

      if (scraped) {
        weeklyLimitPercent = scraped.weeklyAllModels?.percent ?? weeklyLimitPercent;
        weeklyLimitActual = scraped.weeklyAllModels?.percent ? Math.round(WEEKLY_LIMIT_ESTIMATE * scraped.weeklyAllModels.percent / 100) : 0;
        dataSource = totalTokens > 0 ? "hybrid" : "scraped";
        scrapedTimestamp = scraped.timestamp || null;
      }

      // Calculate 5h window reset
      if (lastWindowMsg) {
        const windowStart = new Date(lastWindowMsg).getTime();
        nextWindowReset = new Date(windowStart + 5 * ONE_HOUR).toISOString();
      }

      // Status determination
      let status: string = "safe";
      if (weeklyLimitPercent >= 80) { status = "critical"; }
      else if (weeklyLimitPercent >= 50) { status = "warning"; }
      // Also check extra usage budget exhaustion
      if (scraped?.extraUsage?.balance === "0.00 EUR" && (scraped?.extraUsage?.percent ?? 0) >= 100) {
        status = "critical";
      }

      // Generate alerts
      if (status === "critical") {
        const isExtraBudgetDepleted = scraped?.extraUsage?.balance === "0.00 EUR" && (scraped?.extraUsage?.percent ?? 0) >= 100;
        const isWeeklyFull = weeklyLimitPercent >= 80;
        const reason = isExtraBudgetDepleted && !isWeeklyFull
          ? `Extra-Budget aufgebraucht (${scraped?.extraUsage?.spent} / ${scraped?.extraUsage?.limit}). Account blockiert!`
          : isExtraBudgetDepleted && isWeeklyFull
          ? `Weekly ${weeklyLimitPercent.toFixed(0)}% + Extra-Budget aufgebraucht. Account blockiert!`
          : `Weekly usage at ${weeklyLimitPercent.toFixed(0)}%. Consider switching workload.`;
        alerts.push({
          severity: "critical",
          title: `${acc.displayName}: Limit erreicht`,
          description: reason,
          accountName: acc.displayName,
        });
      }

      // Calculate storage
      let storageBytes = 0;
      try {
        if (existsSync(projectsDir)) {
          const dirs = readdirSync(projectsDir);
          for (const d of dirs) {
            try {
              const files = readdirSync(join(projectsDir, d));
              for (const f of files) {
                try { storageBytes += statSync(join(projectsDir, d, f)).size; } catch {}
              }
            } catch {}
          }
        }
      } catch {}

      accounts.push({
        accountId: acc.id,
        accountName: acc.displayName,
        workspaces,
        totalTokens,
        totalSessions,
        totalInputTokens,
        totalOutputTokens,
        totalCacheCreation,
        totalCacheRead,
        lastActivity,
        models,
        storageBytes,
        burnRatePerHour: Math.round(burnRatePerHour),
        weeklyProjection: Math.round(weeklyProjection),
        weeklyLimitPercent: Math.round(weeklyLimitPercent * 10) / 10,
        weeklyLimitActual,
        status,
        nextWindowReset,
        currentWindowTokens: windowTokens,
        dataSource,
        scrapedTimestamp,
        scraped: scraped ? { plan: scraped.plan, currentSession: scraped.currentSession, weeklyAllModels: scraped.weeklyAllModels, weeklySonnet: scraped.weeklySonnet, extraUsage: scraped.extraUsage } : null,
      });
    }
    // Combined JSONL stats (all accounts share the same projects dir via symlink)
    const first = accounts[0];
    const combinedJsonl = first ? {
      totalTokens: first.totalTokens,
      totalSessions: first.totalSessions,
      totalInputTokens: first.totalInputTokens,
      totalOutputTokens: first.totalOutputTokens,
      totalCacheCreation: first.totalCacheCreation,
      totalCacheRead: first.totalCacheRead,
      burnRatePerHour: first.burnRatePerHour,
      models: first.models,
      storageBytes: first.storageBytes,
      lastActivity: first.lastActivity,
      workspaceCount: first.workspaces.length,
    } : null;

    res.json({
      accounts,
      combinedJsonl,
      alerts,
      weeklyLimit: WEEKLY_LIMIT_ESTIMATE,
      timestamp: new Date().toISOString(),
    });
  } catch (err: any) {
    console.error("[CC-Usage] Stats error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ========================================
// Bridge Monitor API Endpoints
// ========================================

const BRIDGE_URL = 'http://49.12.72.66:8000';
const BRIDGE_API_KEY = process.env.AI_BRIDGE_API_KEY || '';

async function bridgeFetch(path: string, options: any = {}) {
  const headers = {
    'Authorization': `Bearer ${BRIDGE_API_KEY}`,
    ...options.headers,
  };
  const response = await fetch(`${BRIDGE_URL}${path}`, { ...options, headers, signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`Bridge API error: ${response.status}`);
  return response.json();
}

// Overview: Quick stats + Sankey data
// Simple proxy endpoints to new Bridge metrics API

app.get('/api/bridge/metrics/overview', async (_req, res) => {
  try {
    const data = await bridgeFetch('/metrics/overview');
    res.json(data);
  } catch (err: any) {
    console.error('[Bridge] Overview error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/bridge/metrics/usage', async (req, res) => {
  try {
    const limit = req.query.limit ? `?limit=${req.query.limit}` : '';
    const data = await bridgeFetch(`/metrics/usage${limit}`);
    res.json(data);
  } catch (err: any) {
    console.error('[Bridge] Usage error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/bridge/metrics/cost', async (_req, res) => {
  try {
    const data = await bridgeFetch('/metrics/cost');
    res.json(data);
  } catch (err: any) {
    console.error('[Bridge] Cost error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/bridge/metrics/limits', async (_req, res) => {
  try {
    const data = await bridgeFetch('/metrics/limits');
    res.json(data);
  } catch (err: any) {
    console.error('[Bridge] Limits error:', err.message);
    // Fallback: Return empty data if endpoint doesn't exist (404)
    res.json({
      providers: [],
      history: [],
      lastUpdated: new Date().toISOString(),
      _note: 'Bridge endpoint not available - showing empty state',
    });
  }
});

app.get('/api/bridge/metrics/activity', async (req, res) => {
  try {
    const limit = req.query.limit ? `?limit=${req.query.limit}` : '';
    const data = await bridgeFetch(`/metrics/activity${limit}`);
    res.json(data);
  } catch (err: any) {
    console.error('[Bridge] Activity error:', err.message);
    res.status(500).json({ error: err.message });
  }
});
// --- Serve Frontend in Production ---
if (PROD) {
  const distPath = resolve(import.meta.dirname ?? __dirname, '..', 'dist');
// --- Plan File Reader (for CUI Lite ExitPlanMode) ---
app.get("/api/file-read", (req, res) => {
  const filePath = req.query.path as string;
  if (!filePath || !filePath.startsWith("/root/")) {
    res.status(400).send("Invalid path");
    return;
  }
  if (!filePath.includes(".claude/") || !filePath.endsWith(".md")) {
    res.status(403).send("Forbidden: only .claude/*.md files");
    return;
  }
  try {
    const text = readFileSync(filePath, "utf8");
    res.type("text/plain").send(text);
  } catch {
    res.status(404).send("File not found");
  }
});

// --- Bridge Metrics (Direct DB Access) ---
// IMPORTANT: Register BEFORE static middleware to prevent SPA fallback from intercepting
// NEW: Metrics from PostgreSQL (faster, more reliable than Bridge API)
app.get('/api/bridge-db/metrics/overview', async (req, res) => {
  try {
    const hours = parseInt(req.query.hours as string) || 24;
    const stats = await metricsDb.getRealtimeStats(hours);
    res.json({
      health: 'healthy', // Assume healthy if DB responds
      worker: 'aggregated', // DB aggregates all workers
      uptime_hours: hours,
      total_requests: stats.total_requests || 0,
      avg_response_time: stats.avg_response_time_ms ? stats.avg_response_time_ms / 1000 : 0,
      success_rate: stats.success_rate || 100,
      active_sessions: stats.active_sessions || 0,
      timestamp: stats.timestamp || new Date().toISOString(),
    });
  } catch (err: any) {
    console.error('[Metrics DB] Overview error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/bridge-db/metrics/cost', async (req, res) => {
  try {
    const days = parseInt(req.query.days as string) || 30;
    const breakdown = await metricsDb.getCostBreakdown(days);
    const stats = await metricsDb.getRealtimeStats(days * 24);

    res.json({
      total_requests: stats.total_requests || 0,
      estimated_tokens: stats.total_tokens || 0,
      estimated_cost_usd: parseFloat(stats.total_cost_usd || '0'),
      breakdown: breakdown.reduce((acc: any, row: any) => {
        acc[row.model] = {
          requests: row.requests,
          tokens: row.tokens,
          cost_usd: parseFloat(row.cost_usd || '0'),
        };
        return acc;
      }, {}),
      note: `Statistics from last ${days} days (PostgreSQL)`,
      timestamp: new Date().toISOString(),
    });
  } catch (err: any) {
    console.error('[Metrics DB] Cost error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/bridge-db/metrics/usage', async (req, res) => {
  try {
    const days = parseInt(req.query.days as string) || 7;
    const endpoints = await metricsDb.getEndpointUsage(days);
    const stats = await metricsDb.getRealtimeStats(days * 24);

    res.json({
      total_requests: stats.total_requests || 0,
      endpoints: endpoints.map((row: any) => ({
        endpoint: row.endpoint,
        requests: row.requests,
        avg_response_time: row.avg_response_time_ms ? row.avg_response_time_ms / 1000 : 0,
      })),
      timestamp: new Date().toISOString(),
    });
  } catch (err: any) {
    console.error('[Metrics DB] Usage error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/bridge-db/metrics/activity', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit as string) || 50;
    const requests = await metricsDb.getActivityFeed(limit);

    res.json({
      total_today: requests.length,
      requests: requests.map((row: any) => ({
        timestamp: row.timestamp,
        endpoint: row.endpoint,
        model: row.model,
        tokens: row.total_tokens,
        cost_usd: parseFloat(row.cost_usd || '0'),
        response_time_ms: row.response_time_ms,
        success: row.success,
        error: row.error_type,
        worker: row.worker_instance,
      })),
      timestamp: new Date().toISOString(),
    });
  } catch (err: any) {
    console.error('[Metrics DB] Activity error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Admin: Trigger daily stats refresh
app.post('/api/bridge-db/admin/refresh-stats', async (req, res) => {
  try {
    const targetDate = req.body?.date; // Optional: YYYY-MM-DD
    const result = await metricsDb.refreshDailyStats(targetDate);
    res.json(result);
  } catch (err: any) {
    console.error('[Metrics DB] Refresh error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

  if (existsSync(distPath)) {
    // Hashed assets (JS/CSS) can be cached forever
    app.use('/assets', express.static(join(distPath, 'assets'), { maxAge: '1y', immutable: true }));
    // index.html must never be cached (it references hashed assets)
    app.use(express.static(distPath, { etag: false, lastModified: false, setHeaders: (res, filePath) => {
      if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    }}));
    // SPA fallback — also no-cache
    app.use((_req, res) => {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
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


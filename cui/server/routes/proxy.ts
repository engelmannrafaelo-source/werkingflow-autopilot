/**
 * CUI reverse proxy module — extracted from index.ts lines ~38-700.
 *
 * Contains: CUI proxy definitions, SSE proxy, stream monitoring,
 * rate limit detection, message POST interception, HTML injection,
 * and the proxy server setup loop.
 */

import { createServer, request as httpRequest } from 'http';
import type { IncomingMessage, ServerResponse } from 'http';
import { readFileSync } from 'fs';
import httpProxy from 'http-proxy';

import type { ConvAttentionState, AttentionReason, SessionState } from './shared/types.js';

// --- CUI Reverse Proxies ---
// Each CUI account gets a local proxy port so iframes load same-origin (no cookie issues)
export const CUI_PROXIES = [
  { id: 'rafael',    localPort: 5001, target: 'http://127.0.0.1:4001' },
  { id: 'engelmann', localPort: 5002, target: 'http://127.0.0.1:4002' },
  { id: 'office',    localPort: 5003, target: 'http://127.0.0.1:4003' },
  { id: 'local',     localPort: 5004, target: 'http://127.0.0.1:4004' },
];

// --- Dependencies injected via setupCuiProxies() ---
const NOT_INITIALIZED = () => { throw new Error('[Proxy] Module not initialized — call setupCuiProxies() first'); };
let _broadcast: (data: Record<string, unknown>) => void = NOT_INITIALIZED as any;
let _setSessionState: (key: string, accountId: string, state: ConvAttentionState, reason?: AttentionReason, sessionId?: string) => void = NOT_INITIALIZED as any;
let _sessionStates: Map<string, SessionState> = new Map();
let _detectAttentionMarkers: (text: string) => { state: ConvAttentionState; reason?: AttentionReason } | null = NOT_INITIALIZED as any;
let _findJsonlPath: (sessionId: string) => string | null = NOT_INITIALIZED as any;
let _setLastPrompt: (sessionId: string) => void = NOT_INITIALIZED as any;

// SSE proxy: monitors upstream for attention markers (plan/question/done).
// CRITICAL: Only sends SSE headers to browser if upstream has an active stream (200 OK).
// For dead streams (non-200), forwards the error response so the CUI app knows there's no stream.
// This prevents the SSE reconnect loop that causes the "Stopschild" (disabled input) bug.
export function sseProxy(targetBase: string, req: IncomingMessage, res: ServerResponse, cuiId?: string) {
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
    // Dead stream: upstream returns non-200 -> forward error to browser (no SSE pretending)
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
        const attention = _detectAttentionMarkers(text);
        if (attention) {
          console.log(`[SSE] ${streamId} attention: ${attention.state}/${attention.reason ?? '-'}`);
          if (attention.state === 'idle') {
            _broadcast({ type: 'cui-state', cuiId, state: 'done' });
            _broadcast({ type: 'cui-response-ready', cuiId });
            _setSessionState(cuiId, cuiId, 'idle', 'done');
          } else {
            _setSessionState(cuiId, cuiId, attention.state, attention.reason);
          }
        }
      }
    });

    proxyRes.on('end', () => {
      if (heartbeat) clearInterval(heartbeat);
      console.log(`[SSE] End ${streamId} (${chunkCount} chunks monitored)`);
      if (cuiId && chunkCount > 0) {
        _broadcast({ type: 'cui-state', cuiId, state: 'done' });
        _broadcast({ type: 'cui-response-ready', cuiId });
        const current = _sessionStates.get(cuiId);
        if (!current || current.state !== 'needs_attention') {
          _setSessionState(cuiId, cuiId, 'idle', 'done');
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
      if (cuiId) _broadcast({ type: 'cui-state', cuiId, state: 'done' });
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

// Helper: set idle/done only if not in rate_limit state (prevents overwriting rate limit)
export function setIdleIfNotRateLimited(cuiId: string) {
  const current = _sessionStates.get(cuiId);
  if (current?.reason === 'rate_limit') {
    console.log(`[Monitor] ${cuiId}: keeping rate_limit state (not overwriting with done)`);
    return;
  }
  _broadcast({ type: 'cui-state', cuiId, state: 'done' });
  _broadcast({ type: 'cui-response-ready', cuiId });
  _setSessionState(cuiId, cuiId, 'idle', 'done');
}

// --- Auto-Refresh: Monitor CUI streams for response completion ---
// Returns Promise so callers can await completion. Unawaited calls work fine (fire-and-forget).
export function monitorStream(targetBase: string, streamingId: string, cuiId: string, authHeaders: Record<string, string>): Promise<'ended' | 'error' | 'timeout'> {
  return new Promise((resolve) => {
    let resolved = false;
    const done = (result: 'ended' | 'error' | 'timeout') => {
      if (resolved) return;
      resolved = true;
      resolve(result);
    };

    const url = new URL(`/api/stream/${streamingId}`, targetBase);
    const headers: Record<string, string> = { 'Accept': 'text/event-stream' };
    if (authHeaders.authorization) headers['Authorization'] = authHeaders.authorization;
    if (authHeaders.cookie) headers['Cookie'] = authHeaders.cookie;

    const monitorReq = httpRequest(url, { method: 'GET', headers }, (monitorRes) => {
      if (monitorRes.statusCode !== 200) {
        // Stream not available — set idle after delay
        setTimeout(() => {
          setIdleIfNotRateLimited(cuiId);
          done('error');
        }, 8000);
        return;
      }
      monitorRes.on('data', (chunk: Buffer) => {
        const attention = _detectAttentionMarkers(chunk.toString());
        if (attention) {
          if (attention.state === 'idle') {
            setIdleIfNotRateLimited(cuiId);
            monitorReq.destroy();
            done('ended');
          } else {
            console.log(`[Monitor] ${cuiId}: ${attention.reason}`);
            _setSessionState(cuiId, cuiId, attention.state, attention.reason);
          }
        }
      });
      monitorRes.on('end', () => {
        setIdleIfNotRateLimited(cuiId);
        done('ended');
      });
    });
    monitorReq.on('error', () => {
      // Connection error — set idle after delay
      setTimeout(() => {
        setIdleIfNotRateLimited(cuiId);
        done('error');
      }, 8000);
    });
    monitorReq.end();
    // Safety timeout: if stream hasn't ended in 45s, set idle
    setTimeout(() => {
      const current = _sessionStates.get(cuiId);
      if (current?.state === 'working') {
        console.log(`[Monitor] ${cuiId}: 45s timeout, setting idle`);
        setIdleIfNotRateLimited(cuiId);
      }
      monitorReq.destroy();
      done('timeout');
    }, 45000);
  });
}

// Check if a just-started session immediately hit a rate limit
// CUI binary writes a synthetic error entry to JSONL and exits within 3s
export function checkSessionForRateLimit(sessionId: string, cuiId: string, delayMs = 5000) {
  setTimeout(() => {
    try {
      const jsonlPath = _findJsonlPath(sessionId);
      if (!jsonlPath) return;
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
            _broadcast({ type: "cui-state", cuiId, state: "error", message: "Rate Limit: Account hat das Nutzungslimit erreicht. Bitte anderen Account verwenden." });
            _broadcast({ type: "cui-rate-limit-hit", cuiId, sessionId, error: errorText });
            _setSessionState(cuiId, cuiId, "idle", "rate_limit");
            return;
          }
        } catch (err) { console.warn('[Proxy] JSONL parse error in rate limit check:', err instanceof Error ? err.message : err); }
      }
    } catch (err) {
      console.error("[RateLimit] Check failed:", (err as Error).message);
    }
  }, delayMs);
}

// Verify if a send actually produced an assistant response in the JSONL
export function verifySendSuccess(sessionId: string): 'success' | 'no_response' | 'rate_limit' | 'no_file' {
  const jsonlPath = _findJsonlPath(sessionId);
  if (!jsonlPath) return 'no_file';
  const content = readFileSync(jsonlPath, "utf-8");
  const lines = content.trim().split("\n").filter(Boolean);
  // Walk backwards through last 10 lines
  const start = Math.max(0, lines.length - 10);
  for (let i = lines.length - 1; i >= start; i--) {
    try {
      const entry = JSON.parse(lines[i]);
      // Rate limit = synthetic error
      if (entry.isApiErrorMessage === true || entry.message?.model === '<synthetic>') return 'rate_limit';
      // Assistant response = success
      if (entry.message?.role === 'assistant' && entry.message?.model !== '<synthetic>') return 'success';
      // User message without assistant after it = no response yet
      if (entry.message?.role === 'user') return 'no_response';
    } catch (err) { console.warn('[Proxy] JSONL parse error in send verification:', err instanceof Error ? err.message : err); continue; }
  }
  return 'no_response';
}

// Manual proxy for message POST to capture streamingId for auto-refresh
export function messagePostProxy(targetBase: string, cuiId: string, req: IncomingMessage, res: ServerResponse) {
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
              _broadcast({ type: 'cui-state', cuiId, state: 'done' });
              _broadcast({ type: 'cui-response-ready', cuiId });
              _setSessionState(cuiId, cuiId, 'idle', 'done');
            }, 10000);
          }
        } catch (err) {
          console.warn(`[${cuiId}] Non-JSON POST response:`, err instanceof Error ? err.message : err);
          setTimeout(() => {
            _broadcast({ type: 'cui-state', cuiId, state: 'done' });
            _broadcast({ type: 'cui-response-ready', cuiId });
            _setSessionState(cuiId, cuiId, 'idle', 'done');
          }, 10000);
        }
      });
    });
    proxyReq.on('error', (err) => {
      console.error(`[${cuiId}] Message POST proxy error:`, err.message);
      if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `CUI Binary ${cuiId} nicht erreichbar: ${err.message}` }));
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
export const CUI_INJECT_SCRIPT = `<script>(function(){
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
      var m=bg.match(/\\d+/g);
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
              .replace(/\\\`([^\\\`]+)\\\`/g,'<code style="background:'+c.code+';padding:1px 4px;border-radius:3px;font-size:12px">$1</code>')
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
export function serveInjectedHtml(targetBase: string, req: IncomingMessage, res: ServerResponse) {
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
export function logRequest(cuiId: string, req: IncomingMessage) {
  if (req.method === 'POST') {
    console.log(`[${cuiId}] POST ${req.url?.slice(0, 80)}`);
  }
}

// Rate-limit proxy error logging (1x/min per proxy) but always broadcast error state
const proxyErrorLog: Record<string, number> = {};

/** Read-only accessor for proxy error timestamps (for diagnostics). */
export function getProxyErrorLog(): Readonly<Record<string, number>> {
  return proxyErrorLog;
}

/**
 * Create and start all CUI reverse proxy servers.
 *
 * Dependencies are injected so this module does not import state.ts directly
 * (avoids circular dependency — state.ts does not depend on proxy.ts).
 */
export function setupCuiProxies(deps: {
  broadcast: (data: Record<string, unknown>) => void;
  setSessionState: (key: string, accountId: string, state: ConvAttentionState, reason?: AttentionReason, sessionId?: string) => void;
  sessionStates: Map<string, SessionState>;
  detectAttentionMarkers: (text: string) => { state: ConvAttentionState; reason?: AttentionReason } | null;
  findJsonlPath: (sessionId: string) => string | null;
  setLastPrompt: (sessionId: string) => void;
}) {
  // Wire up module-level references used by all functions above
  _broadcast = deps.broadcast;
  _setSessionState = deps.setSessionState;
  _sessionStates = deps.sessionStates;
  _detectAttentionMarkers = deps.detectAttentionMarkers;
  _findJsonlPath = deps.findJsonlPath;
  _setLastPrompt = deps.setLastPrompt;

  for (const cui of CUI_PROXIES) {
    const proxy = httpProxy.createProxyServer({ target: cui.target, ws: true });
    proxy.on('error', (err, req, res) => {
      const now = Date.now();
      // Broadcast error to frontend so it's visible
      _broadcast({ type: 'cui-state', cuiId: cui.id, state: 'error', message: (err as Error).message });
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
        if (urlMatch?.[1]) _setLastPrompt(urlMatch[1]);
        _broadcast({ type: 'cui-state', cuiId: cui.id, state: 'processing' });
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

    proxyServer.on('error', (err: any) => {
      console.error(`[Proxy] ${cui.id}: Failed to listen on port ${cui.localPort}:`, err.message);
    });
  }
}

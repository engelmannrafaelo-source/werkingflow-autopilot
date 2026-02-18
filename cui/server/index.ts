import express from 'express';
import { createServer, request as httpRequest, IncomingMessage, ServerResponse } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { resolve, extname, relative, join } from 'path';
import { readFileSync, readdirSync, statSync, existsSync, mkdirSync, writeFileSync, unlinkSync } from 'fs';
import { homedir } from 'os';
import { watch } from 'chokidar';
import mime from 'mime-types';
import httpProxy from 'http-proxy';
import documentManager, { registerWebSocketClient } from './document-manager.js';

const PORT = parseInt(process.env.PORT ?? '4005', 10);
const PROD = process.env.NODE_ENV === 'production';

// --- CUI Reverse Proxies ---
// Each CUI account gets a local proxy port so iframes load same-origin (no cookie issues)
const CUI_PROXIES = [
  { id: 'rafael',    localPort: 5001, target: 'http://100.121.161.109:4001' },
  { id: 'engelmann', localPort: 5002, target: 'http://100.121.161.109:4002' },
  { id: 'office',    localPort: 5003, target: 'http://100.121.161.109:4003' },
  { id: 'local',     localPort: 5004, target: 'http://localhost:4004' },
];

// Manual SSE proxy: http-proxy buffers SSE events internally, so we bypass it for /api/stream/
// cuiId is optional - when provided, tracks processing/done state
function sseProxy(targetBase: string, req: IncomingMessage, res: ServerResponse, cuiId?: string) {
  const streamId = req.url!.split('/api/stream/')[1]?.slice(0, 8) ?? '?';
  console.log(`[SSE] → Connect ${streamId} to ${targetBase}${cuiId ? ` (${cuiId})` : ''}`);
  const url = new URL(req.url!, targetBase);
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (v && typeof v === 'string') headers[k] = v;
  }
  headers.host = url.host;
  delete headers['accept-encoding']; // no compression for SSE

  const proxyReq = httpRequest(url, { method: req.method, headers }, (proxyRes) => {
    console.log(`[SSE] ← Upstream ${streamId} status=${proxyRes.statusCode}`);
    res.writeHead(proxyRes.statusCode ?? 200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Credentials': 'true',
    });
    // Disable Nagle so each chunk flushes immediately
    res.socket?.setNoDelay(true);
    let chunkCount = 0;
    let stateSet = false;
    proxyRes.on('data', (chunk: Buffer) => {
      chunkCount++;
      const text = chunk.toString();
      const preview = text.slice(0, 80).replace(/\n/g, '\\n');
      console.log(`[SSE] chunk#${chunkCount} ${streamId}: ${preview}`);
      res.write(chunk);

      // Track CUI state from SSE data flow
      if (cuiId && !stateSet) {
        // First meaningful data chunk = actively processing
        stateSet = true;
        broadcast({ type: 'cui-state', cuiId, state: 'processing' });
      }

      // Detect stream completion events
      if (cuiId && (text.includes('"type":"result"') || text.includes('"stop_reason"') ||
          text.includes('"type":"message_stop"') || text.includes('"type":"closed"'))) {
        broadcast({ type: 'cui-state', cuiId, state: 'done' });
        broadcast({ type: 'cui-response-ready', cuiId });
      }
    });
    proxyRes.on('end', () => {
      console.log(`[SSE] ✓ End ${streamId} (${chunkCount} chunks)`);
      if (cuiId && chunkCount > 0) {
        broadcast({ type: 'cui-state', cuiId, state: 'done' });
        broadcast({ type: 'cui-response-ready', cuiId });
      }
      res.end();
    });
  });
  proxyReq.on('error', (err) => {
    console.error(`[SSE] ✗ Error ${streamId}:`, err.message);
    if (cuiId) broadcast({ type: 'cui-state', cuiId, state: 'done' });
    if (!res.headersSent) res.writeHead(502);
    res.end();
  });
  req.on('close', () => {
    console.log(`[SSE] Client disconnected ${streamId}`);
    proxyReq.destroy();
  });
  proxyReq.end();
}

// --- Auto-Refresh: Monitor CUI streams for response completion ---
function monitorStream(targetBase: string, streamingId: string, cuiId: string, authHeaders: Record<string, string>) {
  console.log(`[Monitor] Watching stream ${streamingId} for ${cuiId}`);
  const url = new URL(`/api/stream/${streamingId}`, targetBase);
  const headers: Record<string, string> = { 'Accept': 'text/event-stream' };
  if (authHeaders.authorization) headers['Authorization'] = authHeaders.authorization;
  if (authHeaders.cookie) headers['Cookie'] = authHeaders.cookie;

  const monitorReq = httpRequest(url, { method: 'GET', headers }, (monitorRes) => {
    console.log(`[Monitor] Connected to stream ${streamingId}, status=${monitorRes.statusCode}`);
    if (monitorRes.statusCode !== 200) {
      setTimeout(() => broadcast({ type: 'cui-response-ready', cuiId }), 8000);
      return;
    }
    monitorRes.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      if (text.includes('"type":"result"') || text.includes('"stop_reason"') ||
          text.includes('"type":"message_stop"') || text.includes('"type":"closed"')) {
        console.log(`[Monitor] Response complete for ${cuiId}`);
        broadcast({ type: 'cui-response-ready', cuiId });
        broadcast({ type: 'cui-state', cuiId, state: 'done' });
        monitorReq.destroy();
      }
    });
    monitorRes.on('end', () => {
      console.log(`[Monitor] Stream ended for ${cuiId}`);
      broadcast({ type: 'cui-response-ready', cuiId });
      broadcast({ type: 'cui-state', cuiId, state: 'done' });
    });
  });
  monitorReq.on('error', (err) => {
    console.error(`[Monitor] Error: ${err.message}`);
    setTimeout(() => broadcast({ type: 'cui-response-ready', cuiId }), 8000);
  });
  monitorReq.end();
  setTimeout(() => monitorReq.destroy(), 120000);
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
            // Fallback: broadcast after delay
            setTimeout(() => broadcast({ type: 'cui-response-ready', cuiId }), 10000);
          }
        } catch {
          console.log(`[${cuiId}] Non-JSON POST response, fallback broadcast`);
          setTimeout(() => broadcast({ type: 'cui-response-ready', cuiId }), 10000);
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

// Log ALL requests for debugging
function logRequest(cuiId: string, req: IncomingMessage) {
  const method = req.method;
  const url = req.url?.slice(0, 80);
  if (url?.includes('/api/')) {
    console.log(`[${cuiId}] ${method} ${url}`);
  }
}

for (const cui of CUI_PROXIES) {
  const proxy = httpProxy.createProxyServer({ target: cui.target, ws: true });
  proxy.on('error', (err) => {
    console.error(`[Proxy ${cui.id}] Error:`, err.message);
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
      broadcast({ type: 'cui-state', cuiId: cui.id, state: 'processing' });
      messagePostProxy(cui.target, cui.id, req, res);
      return;
    }

    proxy.web(req, res);
  });

  proxyServer.on('upgrade', (req, socket, head) => {
    proxy.ws(req, socket, head);
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
    const data = await cuiFetch(proxy.localPort, '/api/conversations?limit=30&sortBy=updated&order=desc');
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

  // Sort by updatedAt desc, ongoing first
  results.sort((a, b) => {
    if (a.status !== b.status) return a.status === 'ongoing' ? -1 : 1;
    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  });

  res.json({ conversations: results, total: results.length });
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
  const rawMessages = convData.messages || [];
  const messages = rawMessages.slice(-tail).map((m: any) => ({
    role: m.message?.role || m.type || 'user',
    content: m.message?.content || m.content || '',
    timestamp: m.timestamp || '',
  }));

  res.json({
    messages,
    summary: convData.summary || '',
    status: convData.metadata?.status || 'completed',
    projectPath: convData.projectPath || '',
    permissions: permData?.permissions || [],
    totalMessages: rawMessages.length,
  });
});

// 3. Send message to existing conversation
app.post('/api/mission/send', async (req, res) => {
  const { accountId, sessionId, message, workDir } = req.body;
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
      resumedSessionId: sessionId,
    }),
  });

  if (!result) { res.status(502).json({ error: 'CUI unreachable' }); return; }

  // Track state
  broadcast({ type: 'cui-state', cuiId: accountId, state: 'processing' });

  // Monitor the new stream
  if (result.streamingId) {
    monitorStream(`http://localhost:${port}`, result.streamingId, accountId, {});
  }

  res.json({ ok: true, streamingId: result.streamingId, sessionId: result.sessionId || sessionId });
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

// 5. Set conversation name (Betreff) — saved locally (CUI API ignores custom_name)
app.post('/api/mission/conversation/:accountId/:sessionId/name', async (req, res) => {
  const name = req.body.custom_name || '';
  saveTitle(req.params.sessionId, name);
  res.json({ ok: true, sessionId: req.params.sessionId, custom_name: name });
});

// 6. Start new conversation with subject
app.post('/api/mission/start', async (req, res) => {
  const { accountId, workDir, subject, message } = req.body;
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
    }),
  });

  if (!result?.sessionId) { res.status(502).json({ error: 'CUI unreachable' }); return; }

  // Save subject as local title (CUI API doesn't support custom_name)
  if (subject) {
    saveTitle(result.sessionId, subject);
  }

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

// Shared notes (read-only, auto-generated)
app.get('/api/shared-notes', (_req, res) => {
  const sharedPath = join(NOTES_DIR, 'shared.md');
  if (!existsSync(sharedPath)) {
    res.json({ content: '# Shared Notes\n\n*Run `npm run generate:shared-notes` to populate*' });
    return;
  }
  res.json({ content: readFileSync(sharedPath, 'utf8') });
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

  // For remote accounts: SCP to server
  if (isRemote) {
    const server = REMOTE_SERVERS[accountId];
    try {
      await execAsync(`ssh root@${server} "mkdir -p ${REMOTE_IMG_DIR}"`);
      for (const r of results) {
        await execAsync(`scp "${r.localPath}" root@${server}:${REMOTE_IMG_DIR}/${r.name}`);
        r.remotePath = `${REMOTE_IMG_DIR}/${r.name}`;
      }
      console.log(`[Images] Uploaded ${results.length} images to ${server}:${REMOTE_IMG_DIR}`);
    } catch (err: any) {
      console.error(`[Images] SCP failed: ${err.message}`);
      res.status(500).json({ error: `SCP failed: ${err.message}` });
      return;
    }
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

  return {
    id,
    name: nameMatch?.[1] || id,
    role: nameMatch?.[2] || 'Team Member',
    mbti: mbtiMatch?.[1] || 'XXXX',
    status: 'idle', // Default - später aus worklist parsen
    worklistPath: `/root/projekte/orchestrator/team/worklists/${id}.md`,
    lastUpdated: new Date().toISOString(),
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
  const execOpts = { cwd: WORKSPACE_ROOT, env: { ...process.env, PATH: PATH_PREFIX }, timeout: 120_000 };

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

    // 2. npm install (in case dependencies changed)
    await execAsync('npm install --prefer-offline 2>&1', execOpts);
    broadcast({ type: 'cui-sync', status: 'installing' });

    // 3. Build frontend
    const { stdout: buildOut } = await execAsync('npm run build 2>&1', execOpts);
    const builtMatch = buildOut.match(/built in ([\d.]+s)/);
    broadcast({ type: 'cui-sync', status: 'built', detail: builtMatch?.[1] || 'ok' });

    _syncInProgress = false;
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

// --- Continuous Auto-Sync: Watch src/ and server/ for changes, auto-rebuild ---
const AUTO_SYNC_DEBOUNCE = 3000;
let _autoSyncTimer: ReturnType<typeof setTimeout> | null = null;
let _autoSyncEnabled = true;

function triggerAutoSync() {
  if (!_autoSyncEnabled || _syncInProgress) return;
  _syncInProgress = true;
  const startTs = Date.now();
  console.log('[AutoSync] Changes detected, rebuilding...');
  broadcast({ type: 'cui-sync', status: 'started', auto: true });

  const PATH_PREFIX = '/opt/homebrew/bin:/usr/local/bin:' + (process.env.PATH || '');
  // Force NODE_ENV=development so npm installs devDependencies (vite, tsx, etc.)
  const execOpts = { cwd: WORKSPACE_ROOT, env: { ...process.env, PATH: PATH_PREFIX, NODE_ENV: 'development' }, timeout: 120_000 };

  (async () => {
    try {
      await execAsync('npm install --prefer-offline 2>&1', execOpts);
      broadcast({ type: 'cui-sync', status: 'installing', auto: true });

      const { stdout: buildOut } = await execAsync('npm run build 2>&1', { ...execOpts, env: { ...execOpts.env, NODE_ENV: 'production' } });
      const builtMatch = buildOut.match(/built in ([\d.]+s)/);
      const elapsed = ((Date.now() - startTs) / 1000).toFixed(1);
      console.log(`[AutoSync] Build complete in ${elapsed}s (vite: ${builtMatch?.[1] || 'ok'})`);
      broadcast({ type: 'cui-sync', status: 'built', detail: builtMatch?.[1] || 'ok', auto: true });

      _syncInProgress = false;

      setTimeout(async () => {
        try {
          await execAsync('pm2 restart cui-workspace', { env: { ...process.env, PATH: PATH_PREFIX } });
          console.log('[AutoSync] pm2 restart triggered');
        } catch (err: any) {
          console.error('[AutoSync] pm2 restart failed:', err.message);
        }
      }, 500);
    } catch (err: any) {
      _syncInProgress = false;
      console.error('[AutoSync] Build failed:', err.message);
      broadcast({ type: 'cui-sync', status: 'error', detail: err.message, auto: true });
    }
  })();
}

const autoSyncWatcher = watch([
  join(WORKSPACE_ROOT, 'src'),
  join(WORKSPACE_ROOT, 'server'),
], {
  ignored: /(node_modules|dist|\.git|__pycache__)/,
  persistent: true,
  ignoreInitial: true,
  depth: 10,
});

autoSyncWatcher.on('error', (err) => {
  console.warn('[AutoSync] Watcher error:', (err as NodeJS.ErrnoException).message);
});

autoSyncWatcher.on('all', (event, filePath) => {
  if (!/\.(ts|tsx|css|html|json)$/.test(filePath)) return;
  if (filePath.includes('/dist/') || filePath.includes('/node_modules/')) return;
  console.log(`[AutoSync] ${event}: ${relative(WORKSPACE_ROOT, filePath)}`);
  if (_autoSyncTimer) clearTimeout(_autoSyncTimer);
  _autoSyncTimer = setTimeout(triggerAutoSync, AUTO_SYNC_DEBOUNCE);
});

console.log(`[AutoSync] Watching src/ and server/ for changes (debounce: ${AUTO_SYNC_DEBOUNCE}ms)`);

app.get('/api/cui-sync/auto', (_req, res) => {
  res.json({ enabled: _autoSyncEnabled, syncing: _syncInProgress });
});

app.post('/api/cui-sync/auto', (req, res) => {
  if (typeof req.body.enabled === 'boolean') {
    _autoSyncEnabled = req.body.enabled;
    console.log(`[AutoSync] ${_autoSyncEnabled ? 'ENABLED' : 'DISABLED'}`);
  }
  res.json({ enabled: _autoSyncEnabled });
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

// --- Serve Frontend in Production ---
if (PROD) {
  const distPath = resolve(import.meta.dirname ?? __dirname, '..', 'dist');
  if (existsSync(distPath)) {
    app.use(express.static(distPath));
    // SPA fallback
    app.use((_req, res) => {
      res.sendFile(join(distPath, 'index.html'));
    });
  }
}

// --- Start ---
server.listen(PORT, () => {
  console.log(`CUI Workspace ${PROD ? '(production)' : '(dev)'} on http://localhost:${PORT}`);
});

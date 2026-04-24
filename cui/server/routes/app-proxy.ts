/**
 * App Proxy — Reverse proxy for local app ports through the CUI server.
 *
 * Solves the "localhost in iframe" problem: When CUI runs as a web app (not Electron),
 * the browser panel's iframe can't access localhost on the server. This proxy routes
 * /app-proxy/:port/* → localhost:<port>/* through the CUI server, keeping everything
 * on the same HTTPS domain.
 *
 * Security:
 * - Requires CUI authentication (JWT cookie)
 * - Only whitelisted app ports allowed (no access to Infisical, SSH, etc.)
 * - HTML responses get URL rewriting + fetch interceptor injection
 */

import { Router, Request, Response } from 'express';
import { request as httpRequest } from 'http';
import { requireAuth } from '../auth/middleware.js';

// Only allow known app ports — NEVER expose infrastructure ports
const ALLOWED_PORTS = new Set([
  3004,  // Platform
  3005,  // WerkING Noise
  3006,  // WerkING Safety
  3007,  // WerkING Energy
  3008,  // WerkING Report
  3009,  // Engelmann
  3011,  // Acro Community
  3012,  // Acroyoga
]);

/**
 * Build the JavaScript interceptor that gets injected into proxied HTML pages.
 * This patches fetch, history API, and link clicks to route through the proxy.
 */
function buildInterceptorScript(prefix: string): string {
  return `<script data-app-proxy="interceptor">(function(){
var P='${prefix}';
function fix(u){return(typeof u==='string'&&u.startsWith('/')&&!u.startsWith(P))?P+u:u;}
var F=window.fetch;
window.fetch=function(u,o){if(typeof u==='string')u=fix(u);return F.call(this,u,o);};
var X=XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open=function(m,u){arguments[1]=fix(u);return X.apply(this,arguments);};
var PS=history.pushState,RS=history.replaceState;
history.pushState=function(s,t,u){if(u)arguments[2]=fix(u);return PS.apply(this,arguments);};
history.replaceState=function(s,t,u){if(u)arguments[2]=fix(u);return RS.apply(this,arguments);};
document.addEventListener('click',function(e){
  var a=e.target&&e.target.closest?e.target.closest('a'):null;
  if(!a||!a.href)return;
  try{var url=new URL(a.href);
    if(url.origin===location.origin&&!url.pathname.startsWith(P)){
      e.preventDefault();location.href=P+url.pathname+url.search+url.hash;
    }
  }catch(ex){}
},true);
var CE=document.createElement.bind(document);
document.createElement=function(t){var el=CE.apply(document,arguments);
  if(t==='script'||t==='link'||t==='img'){
    var sd=Object.getOwnPropertyDescriptor(HTMLScriptElement.prototype,'src')||
           Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype,'src')||{};
    var origSet=sd.set;
    if(origSet){Object.defineProperty(el,'src',{set:function(v){origSet.call(this,fix(v));},get:sd.get,configurable:true});}
    if(t==='link'){var hd=Object.getOwnPropertyDescriptor(HTMLLinkElement.prototype,'href')||{};
      if(hd.set){Object.defineProperty(el,'href',{set:function(v){hd.set.call(this,fix(v));},get:hd.get,configurable:true});}}
  }return el;};
})();</script>`;
}

/**
 * Rewrite absolute paths in HTML to route through the proxy prefix.
 * Handles src="/_next/...", href="/api/...", etc.
 */
function rewriteHtml(html: string, prefix: string): string {
  // Rewrite double-quoted attributes: src="/...", href="/...", action="/..."
  html = html.replace(/((?:src|href|action)\s*=\s*")\/(?!app-proxy\/)/gi, `$1${prefix}/`);
  // Rewrite single-quoted attributes
  html = html.replace(/((?:src|href|action)\s*=\s*')\/(?!app-proxy\/)/gi, `$1${prefix}/`);
  // Rewrite url() in inline styles
  html = html.replace(/(url\(\s*['"]?)\/(?!app-proxy\/)/gi, `$1${prefix}/`);

  // Inject interceptor before </head>
  const interceptor = buildInterceptorScript(prefix);
  if (html.includes('</head>')) {
    html = html.replace('</head>', interceptor + '</head>');
  } else if (html.includes('<body')) {
    html = html.replace('<body', interceptor + '<body');
  } else {
    html = interceptor + html;
  }

  return html;
}

export default function createAppProxyRouter(): Router {
  const router = Router();

  router.use('/app-proxy/:port', requireAuth, (req: Request, res: Response) => {
    const port = parseInt(req.params.port as string, 10);

    if (isNaN(port) || !ALLOWED_PORTS.has(port)) {
      res.status(403).json({
        error: `Port ${port} is not allowed`,
        allowed: Array.from(ALLOWED_PORTS).sort(),
      });
      return;
    }

    // Express strips the mount path from req.url in router.use()
    // For /app-proxy/3007/_next/foo → req.url = /_next/foo
    const targetPath = req.url || '/';
    const prefix = `/app-proxy/${port}`;

    // Debug: log first request per port to verify path handling
    if (targetPath === '/') {
      console.log(`[App-Proxy] Proxying :${port}${targetPath} (baseUrl=${req.baseUrl}, originalUrl=${req.originalUrl})`);
    }

    // Strip accept-encoding to get uncompressed HTML for rewriting
    const proxyHeaders: Record<string, string | string[] | undefined> = { ...req.headers };
    proxyHeaders['host'] = `localhost:${port}`;
    const wantsHtml = req.headers.accept?.includes('text/html');
    if (wantsHtml) {
      proxyHeaders['accept-encoding'] = 'identity';
    }
    // Remove cookie forwarding for security (don't leak CUI JWT to apps)
    delete proxyHeaders['cookie'];

    const proxyReq = httpRequest({
      hostname: 'localhost',
      port,
      path: targetPath,
      method: req.method,
      headers: proxyHeaders,
    }, (proxyRes) => {
      const contentType = proxyRes.headers['content-type'] || '';
      const isHtml = contentType.includes('text/html');
      const statusCode = proxyRes.statusCode || 502;

      // Rewrite redirect Location headers
      if (proxyRes.headers['location']) {
        const loc = proxyRes.headers['location'];
        if (loc.startsWith('/') && !loc.startsWith(prefix)) {
          proxyRes.headers['location'] = prefix + loc;
        }
      }

      if (isHtml) {
        // Collect HTML response, rewrite URLs, inject interceptor
        const chunks: Buffer[] = [];
        proxyRes.on('data', (chunk: Buffer) => chunks.push(chunk));
        proxyRes.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf-8');
          const rewritten = rewriteHtml(raw, prefix);

          // Build clean headers (remove transfer-encoding/content-length since we changed body)
          const headers: Record<string, string | string[] | undefined> = { ...proxyRes.headers };
          delete headers['content-length'];
          delete headers['transfer-encoding'];
          delete headers['content-encoding'];
          headers['content-length'] = String(Buffer.byteLength(rewritten, 'utf-8'));

          res.writeHead(statusCode, headers);
          res.end(rewritten);
        });
        proxyRes.on('error', () => {
          if (!res.headersSent) res.status(502).json({ error: 'Proxy stream error' });
        });
      } else {
        // Non-HTML: pass through (JS, CSS, images, API JSON, etc.)
        res.writeHead(statusCode, proxyRes.headers);
        proxyRes.pipe(res);
      }
    });

    proxyReq.on('error', (err) => {
      console.error(`[App-Proxy] Cannot connect to localhost:${port}:`, err.message);
      if (!res.headersSent) {
        res.status(502).json({
          error: `App on port ${port} is not reachable`,
          detail: err.message,
        });
      }
    });

    // Pipe request body (for POST, PUT, etc.)
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      req.pipe(proxyReq);
    } else {
      proxyReq.end();
    }
  });

  return router;
}


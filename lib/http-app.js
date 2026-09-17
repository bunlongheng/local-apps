// Minimal express-compatible app on node:http.
//
// Exists to drop express + compression from the runtime. This service only ever used a
// thin slice of the framework (29 routes, single `:param` segments, JSON bodies, a static
// dir, and `res.status().json()`), so implementing that slice directly leaves all 29
// handlers in server.js written exactly as they were.
//
// Measured A/B, both builds same uptime and same interleaved load, 2-app config:
//   express   33.5 MB steady / 35.8 MB peak
//   this      29.8 MB steady / 29.8 MB peak
// So ~4 MB steady and ~6 MB peak, not the ~9 MB a bare `require('express')` benchmark
// suggests. The framework's own footprint overlaps heavily with what the app allocates.
//
// Deliberate differences from express:
//   - gzip lives in res.json() and serveStatic() instead of a global middleware, so
//     the SSE stream at /api/events is never wrapped (express needed compression's
//     compressible() filter to avoid the same trap).
//   - async handler rejections route to the error middleware. Express 4 does not do
//     this; it leaves them as unhandled rejections.
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { URLSearchParams } = require('url');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

// Compress text payloads only, and only past the point where a gzip frame is
// smaller than the bytes it replaces.
const GZIP_MIN_BYTES = 1024;
const gzippable = (type) => /^(text\/|application\/(json|javascript|manifest))/.test(type);
const acceptsGzip = (req) => /\bgzip\b/.test(req.headers['accept-encoding'] || '');

// A malformed percent-escape must be a 400, never an uncaught URIError: decorate() runs
// before the middleware chain, so a throw here would take down the whole process.
function safeDecode(s) { try { return decodeURIComponent(s); } catch { return null; } }

function decorate(req, res) {
  const qIndex = req.url.indexOf('?');
  req.path = safeDecode(qIndex === -1 ? req.url : req.url.slice(0, qIndex));
  req.query = Object.fromEntries(new URLSearchParams(qIndex === -1 ? '' : req.url.slice(qIndex + 1)));
  req.params = {};
  req.body = {};   // jsonBody() fills it for JSON requests; handlers never see undefined
  req.hostname = (req.headers.host || '').split(':')[0];
  req.get = (name) => req.headers[String(name).toLowerCase()];

  res.status = (code) => { res.statusCode = code; return res; };
  res.header = (name, value) => { res.setHeader(name, value); return res; };
  res.json = (payload) => {
    const body = Buffer.from(JSON.stringify(payload));
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    if (body.length >= GZIP_MIN_BYTES && acceptsGzip(req)) {
      const packed = zlib.gzipSync(body);
      res.setHeader('Content-Encoding', 'gzip');
      res.setHeader('Content-Length', packed.length);
      return res.end(req.method === 'HEAD' ? undefined : packed);
    }
    res.setHeader('Content-Length', body.length);
    return res.end(req.method === 'HEAD' ? undefined : body);
  };
}

// '/api/machines/:id/apps' -> /^\/api\/machines\/([^/]+)\/apps\/?$/ plus the key list.
function compile(pattern) {
  const keys = [];
  const source = pattern
    .replace(/[.+*?^${}()|[\]\\]/g, '\\$&')
    .replace(/\/:([A-Za-z0-9_]+)/g, (_, key) => { keys.push(key); return '/([^/]+)'; });
  return { regex: new RegExp(`^${source}/?$`), keys };
}

function createApp() {
  const stack = [];        // { match(req) -> params|null, fn }
  const errorHandlers = [];

  const runChain = (req, res) => {
    let i = 0;
    const next = (err) => {
      if (err) return runErrors(err, req, res);
      const layer = stack[i++];
      if (!layer) return notFound(req, res);
      const params = layer.match(req);
      if (params === null) return next();
      req.params = params;
      try {
        const out = layer.fn(req, res, next);
        if (out && typeof out.then === 'function') out.then(undefined, next);
      } catch (e) { next(e); }
    };
    next();
  };

  const runErrors = (err, req, res) => {
    let i = 0;
    const next = (e) => {
      const handler = errorHandlers[i++];
      if (!handler) {
        if (res.headersSent) return res.end();
        return res.status(500).json({ error: 'internal error' });
      }
      try { handler(e || err, req, res, next); } catch (e2) { next(e2); }
    };
    next(err);
  };

  const notFound = (req, res) => {
    if (res.headersSent) return res.end();
    res.statusCode = 404;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end(`Cannot ${req.method} ${req.path}\n`);
  };

  const app = {
    use(fn) {
      if (fn.length === 4) errorHandlers.push(fn);
      else stack.push({ match: () => ({}), fn });
      return app;
    },
    listen(port, host, cb) {
      const server = http.createServer((req, res) => {
        decorate(req, res);
        if (req.path === null) { res.statusCode = 400; res.setHeader('Content-Type', 'text/plain; charset=utf-8'); return res.end('Bad Request\n'); }
        runChain(req, res);
      });
      return server.listen(port, host, cb);
    },
  };

  for (const method of ['get', 'post', 'put', 'delete', 'patch']) {
    app[method] = (pattern, fn) => {
      const { regex, keys } = compile(pattern);
      stack.push({
        fn,
        match: (req) => {
          // HEAD is served by the GET handler, as express does; res.json/serveStatic omit the body.
          const verb = req.method === 'HEAD' ? 'GET' : req.method;
          if (verb !== method.toUpperCase()) return null;
          const m = regex.exec(req.path);
          if (!m) return null;
          return Object.fromEntries(keys.map((k, idx) => [k, safeDecode(m[idx + 1]) ?? m[idx + 1]]));
        },
      });
      return app;
    };
  }

  return app;
}

// express.json() equivalent. Same 100kb ceiling, same "reject malformed" behaviour.
function jsonBody({ limit = 100 * 1024 } = {}) {
  return function parseJson(req, res, next) {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'DELETE') return next();
    if (!/application\/json/i.test(req.headers['content-type'] || '')) return next();
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        res.status(413).json({ error: 'payload too large' });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (res.headersSent) return;
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) { req.body = {}; return next(); }
      try { req.body = JSON.parse(raw); } catch { return res.status(400).json({ error: 'invalid JSON body' }); }
      next();
    });
    req.on('error', next);
  };
}

// express.static() equivalent for a single directory: index.html for a directory hit,
// traversal-safe resolution, gzip for text, and fall through to the next layer on a miss.
function serveStatic(root) {
  const base = path.resolve(root);
  return function staticFiles(req, res, next) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();

    const target = path.resolve(base, `.${req.path}`);
    if (target !== base && !target.startsWith(base + path.sep)) return next();

    let file = target;
    let stat;
    try {
      stat = fs.statSync(file);
      if (stat.isDirectory()) {
        file = path.join(file, 'index.html');
        stat = fs.statSync(file);
      }
    } catch { return next(); }
    if (!stat.isFile()) return next();

    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    res.setHeader('Content-Type', type);
    res.setHeader('Last-Modified', stat.mtime.toUTCString());
    // Conditional GET: the dashboard re-requests app.js/app.css on every open; unchanged is 304.
    const since = Date.parse(req.headers['if-modified-since'] || '');
    if (!Number.isNaN(since) && Math.floor(stat.mtimeMs / 1000) * 1000 <= since) { res.statusCode = 304; return res.end(); }

    if (req.method === 'HEAD') { res.setHeader('Content-Length', stat.size); return res.end(); }

    if (stat.size >= GZIP_MIN_BYTES && gzippable(type) && acceptsGzip(req)) {
      res.setHeader('Content-Encoding', 'gzip');
      return fs.createReadStream(file).pipe(zlib.createGzip()).pipe(res);
    }
    res.setHeader('Content-Length', stat.size);
    fs.createReadStream(file).pipe(res);
  };
}

module.exports = { createApp, jsonBody, serveStatic };

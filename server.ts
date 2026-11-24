import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import zlib from 'node:zlib';
import dotenv from 'dotenv';
import express, {type NextFunction, type Request, type Response} from 'express';
import {cleanupExpiredRecords, closeDatabaseSafely} from './server/db.ts';
import {handleRouteError} from './server/middleware/auth.ts';
import {registerAccountRoutes} from './server/routes/account.ts';
import {registerAuthRoutes} from './server/routes/auth.ts';
import {registerChatLifecycleRoutes} from './server/routes/chat-lifecycle.ts';
import {registerDeviceRoutes} from './server/routes/devices.ts';
import {registerGroupRoutes} from './server/routes/groups.ts';
import {registerMiscRoutes} from './server/routes/misc.ts';
import {registerRoleRoutes} from './server/routes/roles.ts';
import {registerScheduleRoutes} from './server/routes/schedules.ts';
import {registerUnifiedInboxRoutes} from './server/routes/unified-inbox.ts';
import {handleUpstreamGowaEvent} from './server/services/chat-sync.ts';
import {GowaWsBridge} from './server/ws-bridge.ts';

dotenv.config({quiet: true});

const DB_MAINTENANCE_INTERVAL_MS = 1000 * 60 * 60 * 6; // every 6 hours
const COMPRESS_MIN_BYTES = 1024;
const COMPRESSIBLE_MIME_RE =
  /^(text\/|application\/(json|javascript|ecmascript|xml|wasm)|image\/svg\+xml)/i;

function isCompressibleResponse(res: Response): boolean {
  if (res.getHeader('Content-Encoding')) return false;
  const contentType = res.getHeader('Content-Type');
  const mime = typeof contentType === 'string' ? contentType : String(contentType ?? '');
  return COMPRESSIBLE_MIME_RE.test(mime);
}

function createCompressionMiddleware(): express.RequestHandler {
  return (req, res, next) => {
    if (req.method === 'HEAD' || req.path === '/ws') {
      next();
      return;
    }
    const acceptEncoding = String(req.headers['accept-encoding'] ?? '');
    if (!/\bgzip\b/i.test(acceptEncoding)) {
      next();
      return;
    }

    const originalWrite = res.write.bind(res);
    const originalEnd = res.end.bind(res);
    const chunks: Buffer[] = [];
    let bufferedBytes = 0;
    let passthrough = false;

    const flushRaw = () => {
      for (const chunk of chunks) {
        originalWrite(chunk);
      }
      chunks.length = 0;
      passthrough = true;
    };

    const normalizeChunk = (chunk: unknown, encoding?: BufferEncoding): Buffer | null => {
      if (chunk === undefined || chunk === null) return null;
      if (Buffer.isBuffer(chunk)) return chunk;
      if (chunk instanceof Uint8Array) return Buffer.from(chunk);
      return Buffer.from(String(chunk), encoding || 'utf8');
    };

    res.write = ((chunk: unknown, encodingOrCb?: BufferEncoding | (() => void), cb?: () => void) => {
      const encoding = typeof encodingOrCb === 'string' ? encodingOrCb : undefined;
      const callback = typeof encodingOrCb === 'function' ? encodingOrCb : cb;

      if (passthrough) {
        return encoding
          ? originalWrite(chunk as string, encoding, callback)
          : originalWrite(chunk as Buffer, callback);
      }

      if (!isCompressibleResponse(res)) {
        flushRaw();
        return encoding
          ? originalWrite(chunk as string, encoding, callback)
          : originalWrite(chunk as Buffer, callback);
      }

      const buf = normalizeChunk(chunk, encoding);
      if (buf && buf.length > 0) {
        chunks.push(buf);
        bufferedBytes += buf.length;
      }
      if (bufferedBytes > 2 * 1024 * 1024) {
        flushRaw();
      }
      if (callback) callback();
      return true;
    }) as Response['write'];

    res.end = ((chunk?: unknown, encodingOrCb?: BufferEncoding | (() => void), cb?: () => void) => {
      const encoding = typeof encodingOrCb === 'string' ? encodingOrCb : undefined;
      const callback = typeof encodingOrCb === 'function' ? encodingOrCb : cb;

      if (passthrough) {
        return encoding
          ? originalEnd(chunk as string, encoding, callback)
          : originalEnd(chunk as Buffer, callback);
      }

      const tail = normalizeChunk(chunk, encoding);
      if (tail && tail.length > 0) {
        chunks.push(tail);
        bufferedBytes += tail.length;
      }

      if (bufferedBytes < COMPRESS_MIN_BYTES || !isCompressibleResponse(res) || res.statusCode === 204 || res.statusCode === 304) {
        const combined = chunks.length > 0 ? Buffer.concat(chunks) : undefined;
        chunks.length = 0;
        return originalEnd(combined, callback);
      }

      const raw = Buffer.concat(chunks);
      chunks.length = 0;
      const gz = zlib.gzipSync(raw, {level: 6});
      res.removeHeader('Content-Length');
      res.setHeader('Content-Encoding', 'gzip');
      res.append('Vary', 'Accept-Encoding');
      res.setHeader('Content-Length', String(gz.byteLength));
      return originalEnd(gz, callback);
    }) as Response['end'];

    next();
  };
}

async function startServer(): Promise<void> {
  const app = express();
  const server = http.createServer(app);
  const wsBridge = new GowaWsBridge(server, {
    onUpstreamEvent: (deviceId, event) => {
      handleUpstreamGowaEvent(deviceId, event, (lifecyclePayload) => {
        wsBridge.broadcast(lifecyclePayload);
      });
    },
  });

  app.disable('x-powered-by');
  app.use(createCompressionMiddleware());
  app.use(express.json({limit: '8mb'}));
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });

  app.use(registerAuthRoutes(wsBridge));
  app.use(registerRoleRoutes());
  app.use(registerDeviceRoutes(wsBridge));
  app.use(registerChatLifecycleRoutes(wsBridge));
  app.use(registerUnifiedInboxRoutes(wsBridge));
  app.use(registerScheduleRoutes());
  app.use(registerGroupRoutes());
  app.use(registerAccountRoutes());
  app.use(registerMiscRoutes());

  app.use('/api', (_req, res) => {
    res.status(404).json({code: 'NOT_FOUND', message: 'مسار API غير موجود'});
  });

  // Catch Express router/parser errors on /api/* (e.g. malformed %E0%A4%A URIError or invalid JSON body)
  app.use('/api', (err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    if (err instanceof URIError) {
      res.status(400).json({code: 'VALIDATION_ERROR', message: 'معرّف المسار غير صالح'});
      return;
    }
    if (
      typeof err === 'object' &&
      err !== null &&
      (('status' in err && (err as {status?: number}).status === 413) ||
        ('type' in err && (err as {type?: string}).type === 'entity.too.large'))
    ) {
      res.status(413).json({
        code: 'PAYLOAD_TOO_LARGE',
        message: 'حجم الملف أو البيانات يتجاوز الحد الأقصى المسموح به (20 ميجابايت)',
      });
      return;
    }
    if (err instanceof SyntaxError && 'status' in err && (err as {status?: number}).status === 400) {
      res.status(400).json({code: 'VALIDATION_ERROR', message: 'صيغة JSON غير صالحة'});
      return;
    }
    handleRouteError(res, err);
  });

  const isProd = process.env.NODE_ENV === 'production';
  if (!isProd) {
    const {createServer: createViteServer} = await import('vite');
    const vite = await createViteServer({
      server: {middlewareMode: true},
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    const assetsDir = path.join(distDir, 'assets');
    app.use(
      express.static(distDir, {
        etag: true,
        setHeaders: (res, filePath) => {
          if (filePath.startsWith(assetsDir + path.sep)) {
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
          } else if (path.basename(filePath) === 'index.html') {
            res.setHeader('Cache-Control', 'no-cache');
          }
        },
      }),
    );
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api/') || req.path === '/ws') {
        next();
        return;
      }
      const indexFile = path.join(distDir, 'index.html');
      if (fs.existsSync(indexFile)) {
        res.setHeader('Cache-Control', 'no-cache');
        res.sendFile(indexFile);
      } else {
        res.status(404).send('Not built');
      }
    });
  }

  const port = Number(process.env.PORT || 3000);
  server.listen(port, '0.0.0.0', () => {
    console.log(`gowa-lite listening on http://0.0.0.0:${port}`);
  });

  try {
    cleanupExpiredRecords();
  } catch (err) {
    console.error('[db maintenance] initial cleanup failed', err);
  }
  const maintenanceTimer = setInterval(() => {
    try {
      cleanupExpiredRecords();
    } catch (err) {
      console.error('[db maintenance] periodic cleanup failed', err);
    }
  }, DB_MAINTENANCE_INTERVAL_MS);
  maintenanceTimer.unref?.();

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(maintenanceTimer);
    wsBridge.shutdown();
    server.close(() => {
      closeDatabaseSafely();
    });
    server.closeIdleConnections?.();
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

void startServer();

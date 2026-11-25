import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import compression from 'compression';
import dotenv from 'dotenv';
import express, {type NextFunction, type Request, type Response} from 'express';
import {cleanupExpiredRecords, closeDatabaseSafely} from './server/db.ts';
import {handleRouteError} from './server/middleware/auth.ts';
import {registerAccountRoutes} from './server/routes/account.ts';
import {registerAuthRoutes} from './server/routes/auth.ts';
import {registerChatLifecycleRoutes} from './server/routes/chat-lifecycle.ts';
import {registerDeviceRoutes} from './server/routes/devices.ts';
import {registerGowaWebhookRoutes} from './server/routes/gowa-webhook.ts';
import {registerGroupRoutes} from './server/routes/groups.ts';
import {registerMiscRoutes} from './server/routes/misc.ts';
import {registerRoleRoutes} from './server/routes/roles.ts';
import {registerScheduleRoutes} from './server/routes/schedules.ts';
import {registerUnifiedInboxRoutes} from './server/routes/unified-inbox.ts';
import {parseTrustProxySetting} from './server/security.ts';
import {handleUpstreamGowaEvent} from './server/services/chat-sync.ts';
import {GowaWsBridge} from './server/ws-bridge.ts';

dotenv.config({quiet: true});

const DB_MAINTENANCE_INTERVAL_MS = 1000 * 60 * 60 * 6; // every 6 hours

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
  app.set('trust proxy', parseTrustProxySetting(process.env.TRUST_PROXY));
  if (process.env.ENABLE_COMPRESSION !== 'false') {
    app.use(
      compression({
        threshold: 1024,
        filter: (req, res) => {
          if (req.path === '/ws' || req.method === 'HEAD') return false;
          return compression.filter(req, res);
        },
      }),
    );
  }
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });
  app.use(registerGowaWebhookRoutes(wsBridge));
  app.use(express.json({limit: '8mb'}));

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
  app.use('/api', (err: unknown, req: Request, res: Response, next: NextFunction) => {
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
      const errLimit =
        'limit' in err && typeof (err as {limit?: unknown}).limit === 'number'
          ? Number((err as {limit?: number}).limit)
          : null;
      const maxMb = errLimit
        ? Math.max(1, Math.round(errLimit / (1024 * 1024)))
        : req.path.endsWith('/send-media')
          ? 20
          : 8;
      res.status(413).json({
        code: 'PAYLOAD_TOO_LARGE',
        message: `حجم الملف أو البيانات يتجاوز الحد الأقصى المسموح به (${maxMb} ميجابايت)`,
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

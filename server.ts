import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import express, {type NextFunction, type Request, type Response} from 'express';
import {cleanupExpiredRecords, closeDatabaseSafely} from './server/db.ts';
import {handleRouteError} from './server/middleware/auth.ts';
import {registerAccountRoutes} from './server/routes/account.ts';
import {registerAuthRoutes} from './server/routes/auth.ts';
import {registerDeviceRoutes} from './server/routes/devices.ts';
import {registerGroupRoutes} from './server/routes/groups.ts';
import {registerMiscRoutes} from './server/routes/misc.ts';
import {registerScheduleRoutes} from './server/routes/schedules.ts';
import {registerUnifiedInboxRoutes} from './server/routes/unified-inbox.ts';
import {handleUpstreamGowaEvent} from './server/services/chat-sync.ts';
import {GowaWsBridge} from './server/ws-bridge.ts';

const DB_MAINTENANCE_INTERVAL_MS = 1000 * 60 * 60 * 6; // every 6 hours

async function startServer(): Promise<void> {
  const app = express();
  const server = http.createServer(app);
  const wsBridge = new GowaWsBridge(server, {
    onUpstreamEvent: handleUpstreamGowaEvent,
  });

  app.disable('x-powered-by');
  app.use(express.json({limit: '8mb'}));
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });

  app.use(registerAuthRoutes(wsBridge));
  app.use(registerDeviceRoutes(wsBridge));
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
    app.use(express.static(distDir));
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api/') || req.path === '/ws') {
        next();
        return;
      }
      const indexFile = path.join(distDir, 'index.html');
      if (fs.existsSync(indexFile)) {
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

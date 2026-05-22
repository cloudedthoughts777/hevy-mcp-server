import express, { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { createServer as createHttpsServer } from 'https';
import { createServer as createHttpServer } from 'http';
import { readFileSync } from 'fs';
import { secureCompare, sanitizeErrorMessage } from '../utils/security.js';
import { logger } from '../utils/logger.js';

export interface HttpTransportConfig {
  port: number;
  host: string;
  mcpPath: string;
  authToken?: string;
  enableHttps?: boolean;
  httpsKeyPath?: string;
  httpsCertPath?: string;
}

/**
 * Factory that produces a fresh MCP Server instance.
 *
 * A `Server` (Protocol) binds 1:1 to a transport — `connect()` overwrites its
 * internal transport reference — so every Streamable HTTP session needs its own
 * server instance to avoid cross-talk between concurrent clients.
 */
export type ServerFactory = () => Server;

/**
 * Build the Express app for the Streamable HTTP transport (MCP spec 2025-03-26).
 *
 * Unlike the legacy HTTP+SSE transport (see `sse.ts`), modern MCP clients —
 * including the Claude / claude.ai connector infrastructure — POST `initialize`
 * directly to a single endpoint. The server replies with an `Mcp-Session-Id`
 * header; subsequent requests carry that header. GET opens an optional
 * server->client SSE stream, DELETE terminates the session.
 */
export function createHttpTransport(
  serverFactory: ServerFactory,
  config: HttpTransportConfig
): express.Application {
  const app = express();
  const isProduction = process.env.NODE_ENV === 'production';

  // Active sessions: session ID -> transport.
  const transports = new Map<string, StreamableHTTPServerTransport>();

  // Security headers with Helmet.
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'"],
          imgSrc: ["'self'", 'data:'],
        },
      },
      hsts: {
        maxAge: 31536000, // 1 year
        includeSubDomains: true,
        preload: true,
      },
    })
  );

  // JSON body parsing with size limit. The Streamable HTTP transport needs the
  // already-parsed body passed into handleRequest().
  app.use(express.json({ limit: '1mb' }));

  // Request timeout (5 minutes for long-running AI operations).
  app.use((req: Request, res: Response, next: NextFunction) => {
    req.setTimeout(5 * 60 * 1000);
    res.setTimeout(5 * 60 * 1000);
    next();
  });

  // Request logging.
  app.use((req: Request, res: Response, next: NextFunction) => {
    const startTime = Date.now();
    res.on('finish', () => {
      logger.apiRequest(req.method, req.path, res.statusCode, Date.now() - startTime);
    });
    next();
  });

  // CORS. `Mcp-Session-Id` must be both accepted on requests and exposed on
  // responses so browser-based clients can read the session header.
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Content-Type, Authorization, mcp-session-id, mcp-protocol-version'
    );
    res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');

    if (req.method === 'OPTIONS') {
      res.sendStatus(200);
      return;
    }
    next();
  });

  // Rate limiting (generous for AI agents; health check exempt).
  app.use(
    rateLimit({
      windowMs: 15 * 60 * 1000,
      max: 1000,
      message: 'Too many requests from this IP, please try again later',
      standardHeaders: true,
      legacyHeaders: false,
      skip: (req) => req.path === '/health',
      handler: (req, res) => {
        logger.rateLimitExceeded(req.ip, req.path);
        res.status(429).json({ error: 'Too many requests', message: 'Please try again later' });
      },
    })
  );

  // Optional bearer-token auth with constant-time comparison.
  if (config.authToken) {
    const authLimiter = rateLimit({
      windowMs: 15 * 60 * 1000,
      max: 50,
      skipSuccessfulRequests: true,
    });

    app.use((req, res, next) => {
      if (req.path === '/health') {
        return next();
      }
      authLimiter(req, res, () => {
        const token = req.headers.authorization?.replace('Bearer ', '');
        if (!token || !secureCompare(token, config.authToken!)) {
          logger.authFailure('invalid_token', req.ip);
          res.status(401).json({ error: 'Unauthorized' });
          return;
        }
        logger.authAttempt(true, req.ip, req.headers['mcp-session-id'] as string);
        next();
      });
    });
  }

  // Health check.
  app.get('/health', (_req: Request, res: Response) => {
    res.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      transport: 'streamable-http',
      activeSessions: transports.size,
    });
  });

  // POST: client -> server messages (including `initialize`).
  app.post(config.mcpPath, async (req: Request, res: Response) => {
    try {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      let transport = sessionId ? transports.get(sessionId) : undefined;

      if (!transport) {
        if (sessionId) {
          // A session ID was supplied but is unknown/expired.
          res.status(404).json({
            jsonrpc: '2.0',
            error: { code: -32001, message: 'Session not found' },
            id: null,
          });
          return;
        }

        if (!isInitializeRequest(req.body)) {
          // No session and not an initialize request — nothing to attach to.
          res.status(400).json({
            jsonrpc: '2.0',
            error: { code: -32000, message: 'Bad Request: no valid session ID provided' },
            id: null,
          });
          return;
        }

        // New session: spin up a dedicated transport + server pair.
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            transports.set(id, transport!);
            logger.sessionCreated(id, req.ip);
          },
        });

        transport.onclose = () => {
          const id = transport!.sessionId;
          if (id && transports.delete(id)) {
            logger.sessionExpired(id, 'closed');
          }
        };

        await serverFactory().connect(transport);
      }

      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      logger.error('Error handling POST request', { path: req.path }, error as Error);
      if (res.headersSent) {
        res.end();
        return;
      }
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: sanitizeErrorMessage(error, isProduction) },
        id: null,
      });
    }
  });

  // GET: opens the optional server -> client SSE stream for an existing session.
  // DELETE: explicitly terminates a session.
  const handleSessionRequest = async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    const transport = sessionId ? transports.get(sessionId) : undefined;

    if (!transport) {
      res.status(400).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Bad Request: invalid or missing session ID' },
        id: null,
      });
      return;
    }

    try {
      await transport.handleRequest(req, res);
    } catch (error) {
      logger.error('Error handling session request', { path: req.path }, error as Error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: sanitizeErrorMessage(error, isProduction) },
          id: null,
        });
      }
    }
  };

  app.get(config.mcpPath, handleSessionRequest);
  app.delete(config.mcpPath, handleSessionRequest);

  // Global error handler.
  app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
    logger.error('Unhandled error', { path: req.path, method: req.method }, err);
    if (res.headersSent) {
      return next(err);
    }
    res.status(500).json({
      error: 'Internal server error',
      message: sanitizeErrorMessage(err, isProduction),
    });
  });

  return app;
}

/**
 * Start the Streamable HTTP server, with optional HTTPS.
 */
export async function initializeHttpTransport(
  serverFactory: ServerFactory,
  config: HttpTransportConfig
): Promise<void> {
  const app = createHttpTransport(serverFactory, config);

  return new Promise((resolve, reject) => {
    try {
      let httpServer;

      if (config.enableHttps && config.httpsKeyPath && config.httpsCertPath) {
        httpServer = createHttpsServer(
          {
            key: readFileSync(config.httpsKeyPath),
            cert: readFileSync(config.httpsCertPath),
          },
          app
        );
        logger.info('Starting HTTPS server', { host: config.host, port: config.port });
      } else {
        httpServer = createHttpServer(app);
        logger.info('Starting HTTP server', { host: config.host, port: config.port });
        if (process.env.NODE_ENV === 'production') {
          logger.warn('Running without HTTPS in production - not recommended!');
        }
      }

      httpServer.listen(config.port, config.host, () => {
        const protocol = config.enableHttps ? 'https' : 'http';
        logger.info('Hevy MCP Server started', {
          protocol,
          host: config.host,
          port: config.port,
          mcpPath: config.mcpPath,
          transport: 'streamable-http',
        });

        console.error(`Hevy MCP Server running on ${protocol}://${config.host}:${config.port}`);
        console.error(
          `MCP endpoint: ${protocol}://${config.host}:${config.port}${config.mcpPath}`
        );
        console.error(`Health check: ${protocol}://${config.host}:${config.port}/health`);

        resolve();
      });

      httpServer.on('error', (error) => {
        logger.error('Server error', {}, error);
        reject(error);
      });
    } catch (error) {
      logger.error('Failed to start server', {}, error as Error);
      reject(error);
    }
  });
}

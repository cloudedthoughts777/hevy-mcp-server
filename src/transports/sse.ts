import express, { Request, Response, NextFunction } from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { createServer as createHttpsServer } from 'https';
import { createServer as createHttpServer } from 'http';
import { readFileSync } from 'fs';
import { secureCompare, sanitizeErrorMessage } from '../utils/security.js';
import { logger } from '../utils/logger.js';

export interface SSETransportConfig {
  port: number;
  host: string;
  ssePath: string;
  heartbeatInterval: number;
  authToken?: string;
  sessionTimeout?: number; // in milliseconds, default 30 days
  enableHttps?: boolean;
  httpsKeyPath?: string;
  httpsCertPath?: string;
}

interface Session {
  id: string;
  createdAt: number;
  lastActivity: number;
  ip?: string;
}

// Session storage (in-memory, could be Redis for production)
const sessions = new Map<string, Session>();

// Store transports by sessionId for message routing
const transports = new Map<string, SSEServerTransport>();

// Clean up expired sessions periodically
setInterval(() => {
  const now = Date.now();
  const thirtyDays = 30 * 24 * 60 * 60 * 1000; // default timeout

  for (const [sessionId, session] of sessions.entries()) {
    if (now - session.lastActivity > thirtyDays) {
      sessions.delete(sessionId);
      logger.sessionExpired(sessionId, 'inactivity');
    }
  }
}, 60 * 60 * 1000); // Check every hour

/**
 * Initialize SSE transport for Poke.com
 * This transport uses Server-Sent Events for real-time communication
 */
export function createSSETransport(
  server: Server,
  config: SSETransportConfig
): express.Application {
  const app = express();
  const isProduction = process.env.NODE_ENV === 'production';
  const sessionTimeout = config.sessionTimeout || 30 * 24 * 60 * 60 * 1000; // 30 days default

  // Security headers with Helmet
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

  // Enable JSON body parsing with size limits
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));

  // Request timeout middleware
  app.use((req: Request, res: Response, next: NextFunction) => {
    // Set timeout for all requests (5 minutes for long-running AI operations)
    req.setTimeout(5 * 60 * 1000);
    res.setTimeout(5 * 60 * 1000);
    next();
  });

  // Request logging middleware
  app.use((req: Request, res: Response, next: NextFunction) => {
    const startTime = Date.now();

    res.on('finish', () => {
      const duration = Date.now() - startTime;
      logger.apiRequest(req.method, req.path, res.statusCode, duration);
    });

    next();
  });

  // CORS headers for remote access
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, mcp-session-id');

    if (req.method === 'OPTIONS') {
      res.sendStatus(200);
      return;
    }
    next();
  });

  // Rate limiting (skip health check for Railway and monitoring)
  const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 1000, // Generous limit for AI agents (1000 requests per 15 min)
    message: 'Too many requests from this IP, please try again later',
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => req.path === '/health', // Exempt health check from rate limiting
    handler: (req, res) => {
      logger.rateLimitExceeded(req.ip, req.path);
      res.status(429).json({
        error: 'Too many requests',
        message: 'Please try again later',
      });
    },
  });

  // Apply rate limiting to all routes (except health check)
  app.use(limiter);

  // Stricter rate limiting for authentication
  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 50, // 50 auth attempts per 15 minutes
    skipSuccessfulRequests: true,
  });

  // Session validation middleware
  const validateSession = (req: Request, res: Response, next: NextFunction) => {
    const sessionId = req.headers['mcp-session-id'] as string;

    if (!sessionId) {
      return next();
    }

    const session = sessions.get(sessionId);
    if (!session) {
      return next();
    }

    // Check if session expired
    const now = Date.now();
    if (now - session.lastActivity > sessionTimeout) {
      sessions.delete(sessionId);
      logger.sessionExpired(sessionId, 'timeout');
      res.status(401).json({ error: 'Session expired' });
      return;
    }

    // Update last activity
    session.lastActivity = now;
    sessions.set(sessionId, session);

    next();
  };

  // Authentication middleware with constant-time comparison
  if (config.authToken) {
    app.use((req, res, next) => {
      // Skip auth for health check
      if (req.path === '/health') {
        return next();
      }

      // Apply auth rate limiting
      authLimiter(req, res, () => {
        const authHeader = req.headers.authorization;
        const token = authHeader?.replace('Bearer ', '');

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

  // Session management middleware
  app.use(validateSession);

  // Health check endpoint
  app.get('/health', (req: Request, res: Response) => {
    res.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      transport: 'sse',
    });
  });

  // SSE endpoint
  app.get(config.ssePath, async (req: Request, res: Response) => {
    const sessionId = (req.headers['mcp-session-id'] as string) || generateSessionId();

    logger.info('SSE connection established', { sessionId, ip: req.ip });

    // Create or update session
    if (!sessions.has(sessionId)) {
      const session: Session = {
        id: sessionId,
        createdAt: Date.now(),
        lastActivity: Date.now(),
        ip: req.ip,
      };
      sessions.set(sessionId, session);
      logger.sessionCreated(sessionId, req.ip);
    }

    const transport = new SSEServerTransport(config.ssePath, res);

    // Store transport by sessionId for message routing
    const transportSessionId = (transport as any).sessionId;
    if (transportSessionId) {
      // Set the session ID header for the client
      res.setHeader('Mcp-Session-Id', transportSessionId);

      transports.set(transportSessionId, transport);
      logger.info('Transport stored for session', { sessionId: transportSessionId });
    }

    await server.connect(transport);

    // Keep the connection alive with heartbeats
    const heartbeat = setInterval(() => {
      try {
        res.write(': heartbeat\n\n');

        // Update session activity
        const session = sessions.get(sessionId);
        if (session) {
          session.lastActivity = Date.now();
          sessions.set(sessionId, session);
        }
      } catch (error) {
        clearInterval(heartbeat);
      }
    }, config.heartbeatInterval);

    // Cleanup on connection close
    req.on('close', () => {
      logger.info('SSE connection closed', { sessionId });
      clearInterval(heartbeat);
      transport.close();
      // Don't delete session - allow reconnection within timeout period
    });
  });

  // POST endpoint for messages
  app.post(config.ssePath, async (req: Request, res: Response) => {
    try {
      // Get sessionId from header (preferred) or query parameter (backward compatibility)
      const sessionId =
        (req.headers['mcp-session-id'] as string) ||
        (req.query.sessionId as string);

      if (!sessionId) {
        console.error('POST request missing sessionId (checked header and query parameter)');
        res.status(400).json({ error: 'Missing sessionId in Mcp-Session-Id header or sessionId query parameter' });
        return;
      }

      // Find the transport for this session
      const transport = transports.get(sessionId);

      if (!transport) {
        console.error(`No transport found for sessionId: ${sessionId}`);
        console.error(`Available sessions: ${Array.from(transports.keys()).join(', ')}`);
        res.status(404).json({ error: 'Session not found' });
        return;
      }

      // Let the transport handle the incoming message
      console.error(`Handling POST message for session: ${sessionId}`);
      await transport.handlePostMessage(req, res, req.body);
    } catch (error) {
      logger.error('Error handling POST request', { path: req.path }, error as Error);

      // The transport may have already started streaming the SSE response,
      // in which case the headers are sent and we cannot write a status/body.
      if (res.headersSent) {
        res.end();
        return;
      }

      const sanitizedMessage = sanitizeErrorMessage(error, isProduction);
      res.status(500).json({
        error: 'Internal server error',
        message: sanitizedMessage,
      });
    }
  });

  // Global error handler
  app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
    logger.error('Unhandled error', { path: req.path, method: req.method }, err);

    // If the response has already started, defer to Express' default
    // handler, which will close the connection without re-sending headers.
    if (res.headersSent) {
      return next(err);
    }

    const sanitizedMessage = sanitizeErrorMessage(err, isProduction);
    res.status(500).json({
      error: 'Internal server error',
      message: sanitizedMessage,
    });
  });

  return app;
}

/**
 * Generate a unique session ID
 */
function generateSessionId(): string {
  return `sess_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`;
}

/**
 * Start the SSE server with optional HTTPS support
 */
export async function initializeSSETransport(
  server: Server,
  config: SSETransportConfig
): Promise<void> {
  const app = createSSETransport(server, config);

  return new Promise((resolve, reject) => {
    try {
      let httpServer;

      if (config.enableHttps && config.httpsKeyPath && config.httpsCertPath) {
        // HTTPS server
        const options = {
          key: readFileSync(config.httpsKeyPath),
          cert: readFileSync(config.httpsCertPath),
        };

        httpServer = createHttpsServer(options, app);
        logger.info('Starting HTTPS server', {
          host: config.host,
          port: config.port
        });
      } else {
        // HTTP server
        httpServer = createHttpServer(app);
        logger.info('Starting HTTP server', {
          host: config.host,
          port: config.port
        });

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
          ssePath: config.ssePath,
        });

        console.error(`Hevy MCP Server running on ${protocol}://${config.host}:${config.port}`);
        console.error(`SSE endpoint: ${protocol}://${config.host}:${config.port}${config.ssePath}`);
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

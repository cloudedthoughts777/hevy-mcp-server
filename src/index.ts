#!/usr/bin/env node

import dotenv from 'dotenv';
import { createHevyMCPServer } from './server.js';
import { initializeStdioTransport } from './transports/stdio.js';
import { initializeSSETransport } from './transports/sse.js';
import { initializeHttpTransport } from './transports/http.js';
import { ConfigurationError } from './utils/errors.js';

// Load environment variables
dotenv.config();

async function main() {
  try {
    // Get configuration from environment variables
    const apiKey = process.env.HEVY_API_KEY;
    const apiBaseUrl = process.env.HEVY_API_BASE_URL;
    const transport = process.env.TRANSPORT || 'stdio';
    const port = parseInt(process.env.PORT || '3000', 10);
    // Use 0.0.0.0 for Railway/production, 127.0.0.1 for local development
    const host = process.env.HOST || (process.env.RAILWAY_ENVIRONMENT ? '0.0.0.0' : '127.0.0.1');
    // MCP_PATH is the modern name; SSE_PATH kept for backward compatibility.
    const mcpPath = process.env.MCP_PATH || process.env.SSE_PATH || '/mcp';
    const ssePath = mcpPath;
    const heartbeatInterval = parseInt(process.env.HEARTBEAT_INTERVAL || '30000', 10);
    const authToken = process.env.AUTH_TOKEN;
    const sessionTimeout = parseInt(
      process.env.SESSION_TIMEOUT || String(30 * 24 * 60 * 60 * 1000),
      10
    ); // 30 days default
    const enableHttps = process.env.ENABLE_HTTPS === 'true';
    const httpsKeyPath = process.env.HTTPS_KEY_PATH;
    const httpsCertPath = process.env.HTTPS_CERT_PATH;

    // Validate required configuration
    if (!apiKey) {
      throw new ConfigurationError(
        'HEVY_API_KEY is required. Please set it in your .env file or environment variables.'
      );
    }

    const validTransports = ['stdio', 'http', 'sse', 'both'];
    if (!validTransports.includes(transport)) {
      throw new ConfigurationError(
        `Invalid TRANSPORT value: ${transport}. Must be one of: ${validTransports.join(', ')}.`
      );
    }

    console.error('Initializing Hevy MCP Server...');
    console.error(`Transport mode: ${transport}`);

    // Factory for fresh MCP Server instances. The Streamable HTTP transport
    // needs one server per session; stdio and legacy SSE use a single instance.
    const serverFactory = () => createHevyMCPServer({ apiKey, apiBaseUrl });

    // Initialize transport(s) based on configuration.
    if (transport === 'stdio' || transport === 'both') {
      console.error('Starting stdio transport...');
      await initializeStdioTransport(serverFactory());
    }

    // 'http' is the modern Streamable HTTP transport (MCP spec 2025-03-26) and
    // the one required by the Claude / claude.ai connector infrastructure.
    if (transport === 'http' || transport === 'both') {
      console.error('Starting Streamable HTTP transport...');
      await initializeHttpTransport(serverFactory, {
        port,
        host,
        mcpPath,
        authToken,
        enableHttps,
        httpsKeyPath,
        httpsCertPath,
      });
    }

    // 'sse' is the deprecated HTTP+SSE transport, kept for legacy clients only.
    if (transport === 'sse') {
      console.error('Starting legacy SSE transport (deprecated)...');
      await initializeSSETransport(serverFactory(), {
        port,
        host,
        ssePath,
        heartbeatInterval,
        authToken,
        sessionTimeout,
        enableHttps,
        httpsKeyPath,
        httpsCertPath,
      });
    }

    console.error('Hevy MCP Server initialized successfully!');
  } catch (error) {
    console.error('Failed to start Hevy MCP Server:');
    if (error instanceof ConfigurationError) {
      console.error(`Configuration Error: ${error.message}`);
    } else if (error instanceof Error) {
      console.error(error.message);
      console.error(error.stack);
    } else {
      console.error(String(error));
    }
    process.exit(1);
  }
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.error('\nShutting down Hevy MCP Server...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.error('\nShutting down Hevy MCP Server...');
  process.exit(0);
});

// Start the server
main();

# Hevy MCP Server


A Model Context Protocol (MCP) server that connects to the official Hevy API and exposes workout data to AI assistants. Supports multiple transport modes: `stdio` for local clients (Claude Desktop), and `http` — the modern Streamable HTTP transport (MCP spec 2025-03-26) — for remote access via Claude / claude.ai connectors. A legacy `sse` transport is retained for backward compatibility only.

Built by [@meimakes](https://x.com/meimakes)


## Deployment

This fork is **self-hosted under systemd** with **manual deploys only** — the `railway.json` / `railway.toml` files and the Railway deploy button below are leftover scaffolding from the upstream template and do **not** drive this fork's deployment. There is no auto-deploy on push.

To deploy code changes to a self-hosted systemd instance:

```bash
git pull origin main
npm install                                  # only if package.json changed
npm run build
sudo systemctl restart <your-service-unit>
journalctl -u <your-service-unit> -n 30 --no-pager
```

### Deploy your own instance

For anyone forking this repo and wanting a fresh hosted instance, Railway is the quickest one-click option:

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/il6CM2?referralCode=a6V1Do&utm_medium=integration&utm_source=template&utm_campaign=generic)

Or self-host on any Node.js-capable box (see [Installation](#installation) below).

## Features

### MCP Tools

#### Workout Management
- `get-workouts` - Get paginated workout list with date filtering
- `get-workout` - Get single workout by ID with full details
- `create-workout` - Create new workout with exercises and sets
- `update-workout` - Update existing workout
- `get-workout-count` - Get total workout count for stats
- `get-workout-events` - Get workout update/delete events since date

#### Routine Management
- `get-routines` - List all saved routines
- `get-routine` - Get single routine by ID
- `create-routine` - Create new workout routine template
- `update-routine` - Update existing routine
- `delete-routine` - Remove routine

#### Exercise Data
- `get-exercise-templates` - Browse available exercises (standard + custom)
- `get-exercise-template` - Get single exercise by ID
- `get-exercise-progress` - Track progress for specific exercises over time
- `get-exercise-stats` - Get personal records and 1RM estimates

#### Folder Organization
- `get-routine-folders` - List routine folders
- `get-routine-folder` - Get folder by ID
- `create-routine-folder` - Create new folder
- `update-routine-folder` - Update folder name
- `delete-routine-folder` - Remove folder

## Prerequisites

1. **Hevy PRO Subscription** - Required for API access
2. **Hevy API Key** - Get it at https://hevy.com/settings?developer
3. **Node.js** - Version 18 or higher

## Installation

### 1. Clone and Install Dependencies

```bash
git clone https://github.com/meimakes/hevy-mcp-server
cd hevy-mcp-server
npm install
```

### 2. Configure Environment

```bash
cp .env.example .env
```

Edit `.env` and add your Hevy API key:

```bash
HEVY_API_KEY=your_hevy_api_key_here
HEVY_API_BASE_URL=https://api.hevyapp.com

# Transport configuration
TRANSPORT=http                     # http | stdio | sse | both
PORT=3004                          # Port for http/sse mode
HOST=127.0.0.1                     # Host for http/sse mode

# HTTP configuration (for remote MCP connectors)
MCP_PATH=/mcp                      # MCP endpoint path
HEARTBEAT_INTERVAL=30000           # ms - keep-alive, legacy SSE transport only
AUTH_TOKEN=                        # See Security section below
```

> **Transport choice:** Use `http` for remote access — it is the Streamable HTTP
> transport required by the Claude / claude.ai connector infrastructure. The
> legacy `sse` transport is kept only for old clients; modern connectors POST
> `initialize` directly and will fail against an SSE-only server.

#### Security: AUTH_TOKEN Configuration

**When exposing the server over the public internet, set an AUTH_TOKEN to prevent unauthorized access to your Hevy data.** Clients must then send `Authorization: Bearer <token>`.

Generate a secure token using either method:

**Option 1: Using the built-in script**
```bash
npm run generate-token
```

**Option 2: Using OpenSSL**
```bash
openssl rand -hex 32
```

Then add the generated token to your `.env` file:
```bash
AUTH_TOKEN=your_generated_token_here
```

When connecting from Poke.com, include the token in the Authorization header:
```
Authorization: Bearer your_generated_token_here
```

**Security Notes:**
- ✅ **Recommended** for `http`/`sse` mode with public access
- ❌ **Optional** for stdio mode (Claude Desktop)
- ❌ **Optional** for `http`/`sse` mode on localhost only
- ⚠️  Never commit your `.env` file or share your AUTH_TOKEN

### 3. Build the Project

```bash
npm run build
```

## Usage

### For Claude Desktop (stdio mode)

#### 1. Run the server in development mode:

```bash
npm run dev
```

#### 2. Configure Claude Desktop

Edit your Claude Desktop config file:
- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude

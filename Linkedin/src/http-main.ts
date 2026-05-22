#!/usr/bin/env node

import http from 'node:http';
import crypto from 'node:crypto';
import { LinkedInClient, StaticTokenProvider } from './linkedin-client.js';
import { Logger } from './logger.js';
// Partner-level API access required — type imports commented out until LinkedIn partner approval:
// import type {
//   LinkedInPosition,
//   LinkedInEducation,
//   LinkedInCertification,
//   LinkedInPublication,
//   LinkedInLanguage,
// } from './types.js';

// ─── Tool schemas (MCP inputSchema format) ───────────────────────────────────

const TOOLS = [
  {
    name: 'get_linkedin_profile',
    description: "Get the authenticated user's LinkedIn profile information",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_linkedin_posts',
    description: "Get the user's recent LinkedIn posts",
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Maximum number of posts to retrieve (default: 10)' },
      },
    },
  },
  {
    name: 'get_linkedin_connections',
    description: "Get the user's LinkedIn connections list. Note: full connection list requires partner-level r_network scope; currently returns a summary entry.",
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Maximum number of connections to retrieve (default: 50)' },
      },
    },
  },
  {
    name: 'share_linkedin_post',
    description: 'Share a new post on LinkedIn',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The text content of the post' },
      },
      required: ['text'],
    },
  },
  {
    name: 'search_linkedin_people',
    description: 'Search for people on LinkedIn',
    inputSchema: {
      type: 'object',
      properties: {
        keywords: { type: 'string', description: 'Search keywords' },
        limit: { type: 'number', description: 'Maximum number of results (default: 10)' },
      },
      required: ['keywords'],
    },
  },
  {
    // Custom tool: dedicated connection size fetch via GET /v2/connections/urn:li:person:{id}
    // Returns { memberId, firstDegreeSize, message }. Requires r_1st_connections_size scope.
    name: 'get_linkedin_connection_size',
    description: "Get the total number of first-degree LinkedIn connections (connection size) for the authenticated user",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'delete_linkedin_post',
    description: 'Delete a published LinkedIn post permanently.',
    inputSchema: {
      type: 'object',
      properties: {
        post_urn: { type: 'string', description: 'The URN/ID of the post to delete (e.g. urn:li:ugcPost:...)' },
      },
      required: ['post_urn'],
    },
  },
  {
    name: 'update_linkedin_post',
    description: 'Update an already-published LinkedIn post with new content. Deletes the original post and publishes the updated version. Use when the user asks to edit, update, or revise a post that was already published.',
    inputSchema: {
      type: 'object',
      properties: {
        post_urn: { type: 'string', description: 'The URN/ID of the existing post to update (e.g. urn:li:ugcPost:...)' },
        text: { type: 'string', description: 'The new text content for the updated post' },
      },
      required: ['post_urn', 'text'],
    },
  },
  // Partner-level API access required — tools commented out until LinkedIn partner approval:
  // { name: 'add_linkedin_skill', ... }
  // { name: 'delete_linkedin_skill', ... }
  // { name: 'add_linkedin_position', ... }
  // { name: 'update_linkedin_position', ... }
  // { name: 'delete_linkedin_position', ... }
  // { name: 'add_linkedin_education', ... }
  // { name: 'delete_linkedin_education', ... }
  // { name: 'add_linkedin_certification', ... }
  // { name: 'delete_linkedin_certification', ... }
  // { name: 'add_linkedin_publication', ... }
  // { name: 'delete_linkedin_publication', ... }
  // { name: 'add_linkedin_language', ... }
  // { name: 'delete_linkedin_language', ... }
];

// ─── Tool dispatch ────────────────────────────────────────────────────────────

type Args = Record<string, unknown>;

async function dispatch(name: string, a: Args, client: LinkedInClient): Promise<string> {
  switch (name) {
    case 'get_linkedin_profile':
      return JSON.stringify(await client.getProfile(), null, 2);

    case 'get_linkedin_posts':
      return JSON.stringify(await client.getPosts((a['limit'] as number) || 10), null, 2);

    case 'get_linkedin_connections':
      return JSON.stringify(await client.getConnections((a['limit'] as number) || 50), null, 2);

    case 'share_linkedin_post':
      return JSON.stringify(await client.sharePost(a['text'] as string), null, 2);

    case 'search_linkedin_people':
      return JSON.stringify(await client.searchPeople(a['keywords'] as string, (a['limit'] as number) || 10), null, 2);

    case 'get_linkedin_connection_size': {
      const result = await client.getConnectionSize();
      return JSON.stringify({
        memberId: result.memberId,
        firstDegreeSize: result.firstDegreeSize,
        message: `You have ${result.firstDegreeSize} first-degree LinkedIn connections.`,
      }, null, 2);
    }

    case 'delete_linkedin_post': {
      const result = await client.deletePost(a['post_urn'] as string);
      return JSON.stringify({
        success: true,
        message: `Post "${result.deletedId}" has been permanently deleted from LinkedIn.`,
      }, null, 2);
    }

    case 'update_linkedin_post': {
      const result = await client.updatePost(a['post_urn'] as string, a['text'] as string);
      return JSON.stringify({
        success: true,
        message: 'Post updated: the original was removed and the updated version has been published.',
        newPostId: result.newId,
        newPostUrl: result.newUrl,
      }, null, 2);
    }

    // Partner-level API access required — dispatch cases commented out until LinkedIn partner approval:
    // case 'add_linkedin_skill': ...
    // case 'delete_linkedin_skill': ...
    // case 'add_linkedin_position': ...
    // case 'update_linkedin_position': ...
    // case 'delete_linkedin_position': ...
    // case 'add_linkedin_education': ...
    // case 'delete_linkedin_education': ...
    // case 'add_linkedin_certification': ...
    // case 'delete_linkedin_certification': ...
    // case 'add_linkedin_publication': ...
    // case 'delete_linkedin_publication': ...
    // case 'add_linkedin_language': ...
    // case 'delete_linkedin_language': ...

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ─── HTTP MCP server ──────────────────────────────────────────────────────────

interface RpcRequest {
  jsonrpc: string;
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

async function main(): Promise<void> {
  const logger = new Logger((process.env.LOG_LEVEL as 'debug' | 'info' | 'warn' | 'error') || 'info');

  const port = parseInt(process.env.LINKEDIN_MCP_PORT ?? '5051', 10);
  const host = process.env.LINKEDIN_MCP_HOST ?? '127.0.0.1';

  // session_id -> { lastActive, client }
  const sessions = new Map<string, { lastActive: number; client: LinkedInClient }>();

  setInterval(() => {
    const cutoff = Date.now() - 10 * 60 * 1000;
    for (const [id, s] of sessions) {
      if (s.lastActive < cutoff) sessions.delete(id);
    }
  }, 60_000);

  const handleRequest = async (
    rawBody: string,
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> => {
    let rpc: RpcRequest;
    try {
      rpc = JSON.parse(rawBody) as RpcRequest;
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }));
      return;
    }

    const sid = req.headers['mcp-session-id'] as string | undefined;
    const isNotification = rpc.id == null;

    const send = (result: unknown, newSid?: string): void => {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (newSid) headers['Mcp-Session-Id'] = newSid;
      res.writeHead(isNotification ? 202 : 200, headers);
      if (isNotification) {
        res.end();
      } else {
        res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id ?? null, result }));
      }
    };

    const sendError = (code: number, message: string): void => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id ?? null, error: { code, message } }));
    };

    try {
      if (rpc.method === 'initialize') {
        // Read LinkedIn access token from Authorization header (Bearer <token>)
        const authHeader = (req.headers['authorization'] as string | undefined) ?? '';
        const accessToken = authHeader.startsWith('Bearer ')
          ? authHeader.slice(7).trim()
          : (process.env.LINKEDIN_ACCESS_TOKEN ?? '');

        if (!accessToken) {
          sendError(-32600, 'LinkedIn access token required. Provide Authorization: Bearer <token>.');
          return;
        }

        const newSid = crypto.randomUUID();
        const client = new LinkedInClient(new StaticTokenProvider(accessToken), logger);
        sessions.set(newSid, { lastActive: Date.now(), client });
        send(
          {
            protocolVersion: '2025-03-26',
            capabilities: { tools: {} },
            serverInfo: { name: 'linkedin-mcp', version: '1.4.0' },
          },
          newSid,
        );
        return;
      }

      if (rpc.method === 'notifications/initialized') {
        if (sid && sessions.has(sid)) sessions.get(sid)!.lastActive = Date.now();
        send(null);
        return;
      }

      if (!sid || !sessions.has(sid)) {
        sendError(-32600, 'Session not found. Call initialize first.');
        return;
      }
      const session = sessions.get(sid)!;
      session.lastActive = Date.now();
      const client = session.client;

      if (rpc.method === 'tools/list') {
        send({ tools: TOOLS });
        return;
      }

      if (rpc.method === 'tools/call') {
        const params = rpc.params ?? {};
        const toolName = params['name'] as string;
        const toolArgs = (params['arguments'] ?? {}) as Args;
        const text = await dispatch(toolName, toolArgs, client);
        send({ content: [{ type: 'text', text }] });
        return;
      }

      sendError(-32601, `Method not found: ${rpc.method}`);
    } catch (err) {
      logger.error('MCP request handler error', err);
      sendError(-32603, err instanceof Error ? err.message : 'Internal error');
    }
  };

  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', tools: TOOLS.length }));
      return;
    }
    if (req.method !== 'POST' || req.url !== '/mcp') {
      res.writeHead(404);
      res.end();
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => void handleRequest(Buffer.concat(chunks).toString(), req, res));
  });

  server.listen(port, host, () => {
    logger.info(`LinkedIn MCP HTTP server (linkedin-mcp-main) listening on http://${host}:${port}/mcp`);
    logger.info(`${TOOLS.length} tools available`);
  });
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});

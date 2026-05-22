import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { LinkedInClient, TokenProvider, StaticTokenProvider } from './linkedin-client.js';
import { Logger } from './logger.js';
// Partner-level API access required — type imports commented out until LinkedIn partner approval:
// import { ServerConfig, LinkedInPosition, LinkedInLanguage, LinkedInEducation, LinkedInCertification, LinkedInPublication } from './types.js';
import { ServerConfig } from './types.js';

// Tool result type to avoid deep type inference issues
type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
};

export class LinkedInMCPServer {
  private server: McpServer;
  private linkedInClient: LinkedInClient;
  private logger: Logger;

  constructor(config: ServerConfig, tokenProvider?: TokenProvider) {
    this.logger = new Logger(config.logLevel);

    // Initialize McpServer
    this.server = new McpServer(
      {
        name: 'linkedin-mcp-server',
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    // Initialize LinkedIn client with the provided TokenProvider, or fall back to a static token
    const provider = tokenProvider
      ?? (config.linkedInAccessToken
        ? new StaticTokenProvider(config.linkedInAccessToken)
        : null);

    if (!provider) {
      throw new Error('LinkedIn access token or token provider is required');
    }
    this.linkedInClient = new LinkedInClient(provider, this.logger);

    this.setupTools();
  }

  private setupTools(): void {
    // Social & Content Tools
    // Note: McpServer.tool() is marked deprecated but is still the correct API to use
    // The deprecation warning is for a different use case; this is the recommended way for our server

    this.server.tool(
      'get_linkedin_profile',
      'Get the authenticated user\'s LinkedIn profile information',
      {},
      async (): Promise<ToolResult> => {
        this.logger.info('Tool called: get_linkedin_profile');
        try {
          const profile = await this.linkedInClient.getProfile();
          return {
            content: [{ type: 'text', text: JSON.stringify(profile, null, 2) }],
          };
        } catch (error) {
          this.logger.error('Error in get_linkedin_profile:', error);
          throw error;
        }
      }
    );

    this.server.tool(
      'get_linkedin_posts',
      'Get the user\'s recent LinkedIn posts',
      {
        limit: z.number().optional().describe('Maximum number of posts to retrieve (default: 10)'),
      },
      async ({ limit }): Promise<ToolResult> => {
        this.logger.info('Tool called: get_linkedin_posts');
        try {
          const posts = await this.linkedInClient.getPosts(limit || 10);
          return {
            content: [{ type: 'text', text: JSON.stringify(posts, null, 2) }],
          };
        } catch (error) {
          this.logger.error('Error in get_linkedin_posts:', error);
          throw error;
        }
      }
    );

    this.server.tool(
      'get_linkedin_connections',
      'Get the user\'s LinkedIn connections',
      {
        limit: z.number().optional().describe('Maximum number of connections to retrieve (default: 50)'),
      },
      async ({ limit }): Promise<ToolResult> => {
        this.logger.info('Tool called: get_linkedin_connections');
        try {
          const connections = await this.linkedInClient.getConnections(limit || 50);
          return {
            content: [{ type: 'text', text: JSON.stringify(connections, null, 2) }],
          };
        } catch (error) {
          this.logger.error('Error in get_linkedin_connections:', error);
          throw error;
        }
      }
    );

    // Custom tool: calls GET /v2/connections/urn:li:person:{memberId} directly with the user's access token.
    // Returns the raw firstDegreeSize count. Requires r_1st_connections_size OAuth scope.
    // Use this when the user asks "how many connections do I have?" or "what is my connection count/size?".
    this.server.tool(
      'get_linkedin_connection_size',
      'Get the total number of first-degree LinkedIn connections (connection size) for the authenticated user',
      {},
      async (): Promise<ToolResult> => {
        this.logger.info('Tool called: get_linkedin_connection_size');
        try {
          const result = await this.linkedInClient.getConnectionSize();
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                memberId: result.memberId,
                firstDegreeSize: result.firstDegreeSize,
                message: `You have ${result.firstDegreeSize} first-degree LinkedIn connections.`,
              }),
            }],
          };
        } catch (error) {
          this.logger.error('Error in get_linkedin_connection_size:', error);
          throw error;
        }
      }
    );

    this.server.tool(
      'share_linkedin_post',
      'Share a new post on LinkedIn',
      {
        text: z.string().describe('The text content of the post'),
      },
      async ({ text }): Promise<ToolResult> => {
        this.logger.info('Tool called: share_linkedin_post');
        try {
          if (!text) {
            throw new Error('Text is required for sharing a post');
          }
          const result = await this.linkedInClient.sharePost(text);
          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          };
        } catch (error) {
          this.logger.error('Error in share_linkedin_post:', error);
          throw error;
        }
      }
    );

    this.server.tool(
      'search_linkedin_people',
      'Search for people on LinkedIn',
      {
        keywords: z.string().describe('Search keywords'),
        limit: z.number().optional().describe('Maximum number of results (default: 10)'),
      },
      async ({ keywords, limit }): Promise<ToolResult> => {
        this.logger.info('Tool called: search_linkedin_people');
        try {
          if (!keywords) {
            throw new Error('Keywords are required for searching people');
          }
          const people = await this.linkedInClient.searchPeople(keywords, limit || 10);
          return {
            content: [{ type: 'text', text: JSON.stringify(people, null, 2) }],
          };
        } catch (error) {
          this.logger.error('Error in search_linkedin_people:', error);
          throw error;
        }
      }
    );

    // Partner-level API access required — all profile write tools commented out until LinkedIn partner approval.
    // Includes: add/delete skill, add/update/delete position, add/delete education,
    // add/delete certification, add/delete publication, add/delete language.
  }

  async start(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    this.logger.info('LinkedIn MCP Server started');
  }

  async stop(): Promise<void> {
    await this.server.close();
    this.logger.info('LinkedIn MCP Server stopped');
  }
}

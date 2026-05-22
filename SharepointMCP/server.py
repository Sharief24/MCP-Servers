"""Main implementation of the SharePoint MCP Server."""

import argparse
import os
import sys
import logging
from contextlib import asynccontextmanager
from collections.abc import AsyncIterator

import uvicorn
from mcp.server.fastmcp import FastMCP
from starlette.middleware.cors import CORSMiddleware

from config.settings import APP_NAME, DEBUG
from tools.site_tools import register_site_tools

# Set logging level
logging_level = logging.DEBUG if DEBUG else logging.INFO
logging.basicConfig(
    level=logging_level, format="%(asctime)s - %(name)s - %(levelname)s - %(message)s"
)
logger = logging.getLogger("sharepoint_mcp")


@asynccontextmanager
async def sharepoint_lifespan(server: FastMCP) -> AsyncIterator[None]:
    """No-op lifespan — auth is handled per request via the access_token parameter."""
    logger.info(
        "SharePoint MCP server started. "
        "Pass access_token in each tool call for authentication."
    )
    yield None
    logger.info("SharePoint MCP server stopped.")


# Create MCP server at module level so CLI can find it
mcp = FastMCP(APP_NAME, lifespan=sharepoint_lifespan)

# Register tools
register_site_tools(mcp)


def main():
    """Main entry point for the SharePoint MCP server."""
    parser = argparse.ArgumentParser(description="SharePoint MCP Server")
    parser.add_argument(
        "--transport",
        choices=["stdio", "sse", "streamable-http"],
        default=os.getenv("MCP_TRANSPORT", "stdio"),
        help="Transport protocol (default: stdio)",
    )
    parser.add_argument(
        "--host",
        default=os.getenv("MCP_HOST", "0.0.0.0"),
        help="Bind host for HTTP transports (default: 0.0.0.0)",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=int(os.getenv("MCP_PORT", "8000")),
        help="Bind port for HTTP transports (default: 8000)",
    )
    parser.add_argument(
        "--ssl-certfile",
        default=os.getenv("SSL_CERTFILE"),
        help="Path to SSL certificate file for HTTPS",
    )
    parser.add_argument(
        "--ssl-keyfile",
        default=os.getenv("SSL_KEYFILE"),
        help="Path to SSL key file for HTTPS",
    )
    args = parser.parse_args()

    try:
        logger.info(f"Starting {APP_NAME} server (transport={args.transport})...")

        if args.transport == "stdio":
            mcp.run(transport="stdio")
            return

        # For HTTP transports, wrap Starlette app with CORS middleware
        mcp.settings.host = args.host
        mcp.settings.port = args.port
        logger.info(f"HTTP server binding to {args.host}:{args.port}")

        if args.transport == "streamable-http":
            starlette_app = mcp.streamable_http_app()
        else:
            # sse
            mcp.run(transport=args.transport)
            return

        # Wrap with CORS so browser-based React JS clients can connect
        cors_app = CORSMiddleware(
            app=starlette_app,
            allow_origins=["*"],
            allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
            allow_headers=["*"],
            expose_headers=["mcp-session-id"],
        )

        if bool(args.ssl_certfile) ^ bool(args.ssl_keyfile):
            raise ValueError(
                "Both --ssl-certfile and --ssl-keyfile must be provided to enable HTTPS."
            )

        uvicorn.run(
            cors_app,
            host=args.host,
            port=args.port,
            proxy_headers=True,
            forwarded_allow_ips="*",
            ssl_certfile=args.ssl_certfile,
            ssl_keyfile=args.ssl_keyfile,
        )

    except Exception as e:
        logger.error(f"Error occurred during MCP server startup: {e}")
        raise


# Main execution
if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        logger.error(f"Fatal error in SharePoint MCP server: {e}")
        sys.exit(1)

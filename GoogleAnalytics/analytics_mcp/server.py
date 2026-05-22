#!/usr/bin/env python

# Copyright 2025 Google LLC All Rights Reserved.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#      http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""Entry point for the Google Analytics MCP server."""

import argparse
import asyncio
import logging
import os
import sys

import analytics_mcp.coordinator as coordinator
from mcp.server.lowlevel import NotificationOptions
from mcp.server.models import InitializationOptions
import mcp.server.stdio
import mcp.server


logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger("analytics_mcp")


def _make_init_options() -> InitializationOptions:
    """Returns the InitializationOptions shared by all transport modes."""
    return InitializationOptions(
        server_name=coordinator.app.name,
        server_version="1.0.0",
        capabilities=coordinator.app.get_capabilities(
            notification_options=NotificationOptions(),
            experimental_capabilities={},
        ),
    )


async def run_stdio():
    """Runs the MCP server over standard I/O."""
    logger.info("Starting MCP Stdio Server: %s", coordinator.app.name)
    async with mcp.server.stdio.stdio_server() as (read_stream, write_stream):
        await coordinator.app.run(read_stream, write_stream, _make_init_options())


async def run_streamable_http(host: str, port: int):
    """Runs the MCP server using Streamable HTTP transport (modern MCP standard)."""
    import uvicorn
    from contextlib import asynccontextmanager
    from starlette.applications import Starlette
    from starlette.middleware.cors import CORSMiddleware
    from starlette.requests import Request
    from starlette.responses import JSONResponse
    from starlette.routing import Mount, Route
    from mcp.server.streamable_http_manager import StreamableHTTPSessionManager

    session_manager = StreamableHTTPSessionManager(
        app=coordinator.app,
        event_store=None,
        json_response=False,
    )

    async def health(request: Request):
        return JSONResponse({"status": "ok", "service": "google-analytics-mcp"})

    @asynccontextmanager
    async def lifespan(app):
        async with session_manager.run():
            yield

    starlette_app = Starlette(
        lifespan=lifespan,
        routes=[
            Route("/health", health),
            Mount("/mcp", app=session_manager.handle_request),
        ],
    )

    cors_app = CORSMiddleware(
        app=starlette_app,
        allow_origins=["*"],
        allow_methods=["GET", "POST", "DELETE", "OPTIONS"],
        allow_headers=["*"],
        expose_headers=["mcp-session-id"],
    )

    logger.info(
        "Starting %s Streamable HTTP server on %s:%s", coordinator.app.name, host, port
    )
    config = uvicorn.Config(cors_app, host=host, port=port, log_level="info")
    server = uvicorn.Server(config)
    await server.serve()


def main():
    """Main entry point — supports stdio and SSE transports."""
    parser = argparse.ArgumentParser(description="Google Analytics MCP Server")
    parser.add_argument(
        "--transport",
        choices=["stdio", "streamable-http"],
        default=os.getenv("MCP_TRANSPORT", "stdio"),
        help="Transport protocol (default: stdio)",
    )
    parser.add_argument(
        "--host",
        default=os.getenv("MCP_HOST", "0.0.0.0"),
        help="Bind host for SSE transport (default: 0.0.0.0)",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=int(os.getenv("MCP_PORT", "8000")),
        help="Bind port for SSE transport (default: 8000)",
    )
    args = parser.parse_args()

    try:
        if args.transport == "stdio":
            asyncio.run(run_stdio())
        else:
            asyncio.run(run_streamable_http(args.host, args.port))
    except KeyboardInterrupt:
        print(f"\nMCP Server ({args.transport}) stopped by user.", file=sys.stderr)
    except Exception:
        print(
            f"MCP Server ({args.transport}) encountered an error:", file=sys.stderr
        )
        import traceback
        traceback.print_exc()
    finally:
        print(f"MCP Server ({args.transport}) process exiting.", file=sys.stderr)


if __name__ == "__main__":
    main()

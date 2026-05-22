#!/bin/bash
set -e
echo "Setting up GoogleAnalytics MCP Server..."

# Create virtual environment
python3 -m venv venv

# Activate the virtual environment
source venv/bin/activate

# Upgrade pip
pip install --upgrade pip

# Install requirements
pip install -r requirements.txt

echo ""
echo "Setup complete!"
echo "Activate with  : source venv/bin/activate"
echo "Run (stdio)    : python -m analytics_mcp.server"
echo "Run (HTTP/SSE) : python -m analytics_mcp.server --transport sse --port 8000"

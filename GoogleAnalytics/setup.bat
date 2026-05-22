@echo off
echo Setting up GoogleAnalytics MCP Server...

REM Create virtual environment using Anaconda Python
C:\ProgramData\anaconda3\python.exe -m venv venv

REM Activate the virtual environment
call venv\Scripts\activate.bat

REM Upgrade pip
python -m pip install --upgrade pip

REM Install requirements
pip install -r requirements.txt

echo.
echo Setup complete!
echo Activate with  : venv\Scripts\activate.bat
echo Run (stdio)    : python -m analytics_mcp.server
echo Run (HTTP/SSE) : python -m analytics_mcp.server --transport sse --port 8000

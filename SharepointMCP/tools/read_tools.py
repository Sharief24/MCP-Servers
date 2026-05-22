"""SharePoint read-only tools."""

import base64
import json
import logging

from mcp.server.fastmcp import FastMCP

from tools._tool_helpers import _build_context, _parse_site_url
from utils.document_processor import DocumentProcessor
from utils.graph_client import GraphClient

logger = logging.getLogger("sharepoint_tools")


def register_read_tools(mcp: FastMCP):
    """Register read-only SharePoint tools with the MCP server."""

    @mcp.tool()
    async def get_site_info(access_token: str, site_url: str) -> str:
        """Get basic information about the SharePoint site.

        Args:
            access_token: Bearer access token for Microsoft Graph API
            site_url: Full SharePoint site URL (e.g. https://contoso.sharepoint.com/sites/mysite)
        """
        logger.info("Tool called: get_site_info")
        try:
            sp_ctx = _build_context(access_token)
            graph_client = GraphClient(sp_ctx)

            domain, site_name = _parse_site_url(site_url)
            logger.info(f"Getting info for site: {site_name} in domain: {domain}")

            site_info = await graph_client.get_site_info(domain, site_name)
            result = {
                "name": site_info.get("displayName", "Unknown"),
                "description": site_info.get("description", "No description"),
                "created": site_info.get("createdDateTime", "Unknown"),
                "last_modified": site_info.get("lastModifiedDateTime", "Unknown"),
                "web_url": site_info.get("webUrl", site_url),
                "id": site_info.get("id", "Unknown"),
            }
            logger.info(f"Successfully retrieved site info for: {result['name']}")
            return json.dumps(result, indent=2)
        except Exception as e:
            logger.error(f"Error in get_site_info: {str(e)}")
            raise

    @mcp.tool()
    async def list_document_libraries(access_token: str, site_url: str) -> str:
        """List all document libraries in the SharePoint site.

        Args:
            access_token: Bearer access token for Microsoft Graph API
            site_url: Full SharePoint site URL (e.g. https://contoso.sharepoint.com/sites/mysite)
        """
        logger.info("Tool called: list_document_libraries")
        try:
            sp_ctx = _build_context(access_token)
            graph_client = GraphClient(sp_ctx)

            domain, site_name = _parse_site_url(site_url)
            logger.info(
                f"Listing document libraries for site: {site_name} in domain: {domain}"
            )

            result = await graph_client.list_document_libraries(domain, site_name)
            drives = result.get("value", [])
            formatted_drives = [
                {
                    "name": drive.get("name", "Unknown"),
                    "description": drive.get("description", "No description"),
                    "web_url": drive.get("webUrl", "Unknown"),
                    "drive_type": drive.get("driveType", "Unknown"),
                    "id": drive.get("id", "Unknown"),
                }
                for drive in drives
            ]
            logger.info(
                f"Successfully retrieved {len(formatted_drives)} document libraries"
            )
            return json.dumps(formatted_drives, indent=2)
        except Exception as e:
            logger.error(f"Error in list_document_libraries: {str(e)}")
            raise

    @mcp.tool()
    async def search_sharepoint(access_token: str, site_url: str, query: str) -> str:
        """Search content in the SharePoint site.

        Args:
            access_token: Bearer access token for Microsoft Graph API
            site_url: Full SharePoint site URL (e.g. https://contoso.sharepoint.com/sites/mysite)
            query: Search query string
        """
        logger.info(f"Tool called: search_sharepoint with query: {query}")
        try:
            sp_ctx = _build_context(access_token)
            graph_client = GraphClient(sp_ctx)

            domain, site_name = _parse_site_url(site_url)
            logger.info(f"Searching for '{query}' in site: {site_name}")

            site_info = await graph_client.get_site_info(domain, site_name)
            site_id = site_info.get("id")
            if not site_id:
                raise Exception("Error: Could not retrieve site ID")

            search_url = f"sites/{site_id}/search"
            search_data = {
                "requests": [
                    {
                        "entityTypes": ["driveItem", "listItem", "list"],
                        "query": {"queryString": query},
                    }
                ]
            }
            logger.debug(f"Search request: {search_data}")
            search_results = await graph_client.post(search_url, search_data)

            formatted_results = []
            for result in search_results.get("value", [])[0].get("hitsContainers", []):
                for hit in result.get("hits", []):
                    formatted_results.append(
                        {
                            "title": hit.get("resource", {}).get("name", "Unknown"),
                            "url": hit.get("resource", {}).get("webUrl", "Unknown"),
                            "type": hit.get("resource", {}).get(
                                "@odata.type", "Unknown"
                            ),
                            "summary": hit.get("summary", "No summary available"),
                        }
                    )
            logger.info(f"Search returned {len(formatted_results)} results")
            return json.dumps(formatted_results, indent=2)
        except Exception as e:
            logger.error(f"Error in search_sharepoint: {str(e)}")
            raise

    @mcp.tool()
    async def get_document_content(
        access_token: str, site_id: str, drive_id: str, item_id: str, filename: str
    ) -> str:
        """Read and parse the content of a SharePoint document so it can be summarised or analysed.

        Use this tool whenever the user asks to read, summarise, analyse, or extract data from
        a document (xlsx, docx, pdf, csv, txt).  The file bytes are automatically parsed into
        human-readable structured JSON — column names, row data, text paragraphs, etc. — so the
        LLM can reason over the content directly.

        Do NOT use download_file for this purpose; download_file returns raw base64 and is only
        useful for binary round-trips (e.g. download → edit → re-upload).

        Args:
            access_token: Bearer access token for Microsoft Graph API
            site_id: ID of the site
            drive_id: ID of the document library
            item_id: ID of the document (use get_item_metadata to look this up by path)
            filename: Name of the file including extension (e.g. "Sprint Planning Tracker.xlsx")
        """
        logger.info(f"Tool called: get_document_content for file: {filename}")
        try:
            sp_ctx = _build_context(access_token)
            graph_client = GraphClient(sp_ctx)

            content = await graph_client.get_document_content(
                site_id, drive_id, item_id
            )
            processed_content = DocumentProcessor.process_document(content, filename)
            logger.info(f"Successfully processed document content for: {filename}")
            return json.dumps(processed_content, indent=2)
        except Exception as e:
            logger.error(f"Error in get_document_content: {str(e)}")
            raise

    @mcp.tool()
    async def list_folder_contents(
        access_token: str, site_id: str, drive_id: str, folder_path: str = ""
    ) -> str:
        """List files and folders at a given path in a SharePoint document library.

        Args:
            access_token: Bearer access token for Microsoft Graph API
            site_id: ID of the site
            drive_id: ID of the document library (drive)
            folder_path: Folder path relative to drive root (e.g. "General" or
                "Docs/2026"). Leave empty to list the root of the drive.
        """
        logger.info(f"Tool called: list_folder_contents path='{folder_path or '/'}'")
        try:
            sp_ctx = _build_context(access_token)
            graph_client = GraphClient(sp_ctx)

            result = await graph_client.list_folder_contents(
                site_id, drive_id, folder_path
            )
            items = result.get("value", [])
            formatted = [
                {
                    "name": item.get("name", "Unknown"),
                    "type": "folder" if "folder" in item else "file",
                    "size": item.get("size", 0),
                    "id": item.get("id", "Unknown"),
                    "web_url": item.get("webUrl", "Unknown"),
                    "last_modified": item.get("lastModifiedDateTime", "Unknown"),
                }
                for item in items
            ]
            logger.info(
                f"Successfully listed {len(formatted)} items at path '{folder_path or '/'}'"
            )
            return json.dumps(formatted, indent=2)
        except Exception as e:
            logger.error(f"Error in list_folder_contents: {str(e)}")
            raise

    @mcp.tool()
    async def get_document_by_path(
        access_token: str, site_id: str, drive_id: str, file_path: str, filename: str
    ) -> str:
        """Read and parse the content of a SharePoint document by its path so it can be summarised or analysed.

        Prefer this over get_document_content when you already know the file path but not the item ID.
        Returns the same structured JSON output (column names, row data, text, etc.) — ready for the
        LLM to reason over without any further decoding.

        Do NOT use download_file for reading or summarising documents.

        Args:
            access_token: Bearer access token for Microsoft Graph API
            site_id: ID of the site
            drive_id: ID of the document library (drive)
            file_path: File path relative to drive root (e.g. "06-Project Plans/03 - Sprint Plan/Sprint Planning Tracker.xlsx")
            filename: File name including extension, used to detect document type (e.g. "Sprint Planning Tracker.xlsx")
        """
        logger.info(f"Tool called: get_document_by_path path='{file_path}'")
        try:
            sp_ctx = _build_context(access_token)
            graph_client = GraphClient(sp_ctx)

            content = await graph_client.get_document_content_by_path(
                site_id, drive_id, file_path
            )
            processed_content = DocumentProcessor.process_document(content, filename)
            logger.info(
                f"Successfully processed document content for path: '{file_path}'"
            )
            return json.dumps(processed_content, indent=2)
        except Exception as e:
            logger.error(f"Error in get_document_by_path: {str(e)}")
            raise

    @mcp.tool()
    async def get_item_metadata(
        access_token: str, site_id: str, drive_id: str, item_path: str
    ) -> str:
        """Get metadata of a file or folder by its path in a SharePoint document library.

        Returns the item's id, name, size, web URL, and timestamps.
        Use the returned id with get_document_content to retrieve file content.

        Args:
            access_token: Bearer access token for Microsoft Graph API
            site_id: ID of the site
            drive_id: ID of the document library (drive)
            item_path: Item path relative to drive root (e.g. "General/report.docx"
                or "General")
        """
        logger.info(f"Tool called: get_item_metadata path='{item_path}'")
        try:
            sp_ctx = _build_context(access_token)
            graph_client = GraphClient(sp_ctx)

            item = await graph_client.get_item_metadata_by_path(
                site_id, drive_id, item_path
            )
            result = {
                "id": item.get("id", "Unknown"),
                "name": item.get("name", "Unknown"),
                "size": item.get("size", 0),
                "web_url": item.get("webUrl", "Unknown"),
                "created_by": item.get("createdBy", {})
                .get("user", {})
                .get("displayName", "Unknown"),
                "created_datetime": item.get("createdDateTime", "Unknown"),
                "last_modified_datetime": item.get("lastModifiedDateTime", "Unknown"),
            }
            if "folder" in item:
                result["type"] = "folder"
                result["child_count"] = item["folder"].get("childCount", 0)
            elif "file" in item:
                result["type"] = "file"
                result["mime_type"] = item["file"].get("mimeType", "Unknown")

            logger.info(f"Successfully retrieved metadata for path: '{item_path}'")
            return json.dumps(result, indent=2)
        except Exception as e:
            logger.error(f"Error in get_item_metadata: {str(e)}")
            raise

    @mcp.tool()
    async def download_file(
        access_token: str, site_id: str, drive_id: str, item_id: str, filename: str
    ) -> str:
        """Download a file from SharePoint and return its raw bytes as a base64 string.

        WARNING: This tool returns BINARY DATA encoded as base64. The LLM cannot read or
        summarise the content from base64 — use get_document_content or get_document_by_path
        instead when you need to read, summarise, or analyse a document.

        This tool is ONLY intended for binary round-trips: download → external edit → re-upload
        via upload_document.

        Args:
            access_token: Bearer access token for Microsoft Graph API
            site_id: ID of the site
            drive_id: ID of the document library
            item_id: ID of the file
            filename: Name of the file (used for logging)
        """
        logger.info(f"Tool called: download_file for file: {filename}")
        try:
            sp_ctx = _build_context(access_token)
            graph_client = GraphClient(sp_ctx)

            content = await graph_client.get_document_content(
                site_id, drive_id, item_id
            )
            encoded = base64.b64encode(content).decode("utf-8")
            logger.info(
                f"Successfully downloaded file: {filename} ({len(content)} bytes)"
            )
            return json.dumps(
                {
                    "filename": filename,
                    "size_bytes": len(content),
                    "content_base64": encoded,
                },
                indent=2,
            )
        except Exception as e:
            logger.error(f"Error in download_file: {str(e)}")
            raise

    @mcp.tool()
    async def get_lists(access_token: str, site_id: str) -> str:
        """List all SharePoint lists (and document libraries) in a site.

        Returns list names, IDs, and templates so you can query items.
        For subsites, use the compound site ID format: siteCollectionId,webId

        Args:
            access_token: Bearer access token for Microsoft Graph API
            site_id: The site ID. For subsites use compound format
                (e.g. "f474e3b9-...,0b580fc8-...")
        """
        logger.info(f"Tool called: get_lists for site: {site_id}")
        try:
            sp_ctx = _build_context(access_token)
            graph_client = GraphClient(sp_ctx)

            result = await graph_client.get_lists(site_id)
            lists = result.get("value", [])
            formatted = [
                {
                    "id": lst.get("id", "Unknown"),
                    "name": lst.get("displayName", "Unknown"),
                    "description": lst.get("description", ""),
                    "web_url": lst.get("webUrl", "Unknown"),
                    "template": lst.get("list", {}).get("template", "Unknown"),
                    "created": lst.get("createdDateTime", "Unknown"),
                    "last_modified": lst.get("lastModifiedDateTime", "Unknown"),
                }
                for lst in lists
            ]
            logger.info(f"Successfully retrieved {len(formatted)} lists")
            return json.dumps(formatted, indent=2)
        except Exception as e:
            logger.error(f"Error in get_lists: {str(e)}")
            raise

    @mcp.tool()
    async def get_list_items(
        access_token: str,
        site_id: str,
        list_id: str,
        top: int = 100,
        filter_query: str = "",
    ) -> str:
        """Get items from a SharePoint list with all their column/field values.

        This queries the Graph API /sites/{siteId}/lists/{listId}/items endpoint
        with $expand=fields to return all column values including Status, Title, etc.

        Args:
            access_token: Bearer access token for Microsoft Graph API
            site_id: The site ID. For subsites use compound format
                (e.g. "f474e3b9-...,0b580fc8-...")
            list_id: The list ID (GUID) or display name
            top: Maximum items to return (default 100, max 5000)
            filter_query: Optional OData filter (e.g. "fields/Status eq 'Active'")
        """
        logger.info(f"Tool called: get_list_items for list: {list_id}")
        try:
            sp_ctx = _build_context(access_token)
            graph_client = GraphClient(sp_ctx)

            result = await graph_client.get_list_items(
                site_id, list_id, top=top, filter_query=filter_query
            )
            items = result.get("value", [])
            formatted = [
                {
                    "id": item.get("id", "Unknown"),
                    "web_url": item.get("webUrl", ""),
                    "created": item.get("createdDateTime", ""),
                    "last_modified": item.get("lastModifiedDateTime", ""),
                    "fields": item.get("fields", {}),
                }
                for item in items
            ]
            logger.info(f"Successfully retrieved {len(formatted)} list items")
            return json.dumps(formatted, indent=2)
        except Exception as e:
            logger.error(f"Error in get_list_items: {str(e)}")
            raise

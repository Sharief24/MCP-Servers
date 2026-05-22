"""Shared helpers for MCP tool modules."""

from typing import Tuple

from auth.sharepoint_auth import SharePointContext, _decode_token_expiry


def _build_context(access_token: str) -> SharePointContext:
    """Build a per-request SharePointContext from the provided access token."""
    if not access_token or not access_token.strip():
        raise ValueError(
            "access_token is required. Pass a valid Bearer token in each tool call."
        )
    expiry = _decode_token_expiry(access_token)
    return SharePointContext(access_token=access_token, token_expiry=expiry)


def _parse_site_url(site_url: str) -> Tuple[str, str]:
    """Parse a SharePoint site URL into (domain, site_name).

    Examples:
        https://contoso.sharepoint.com/sites/mysite  -> ("contoso.sharepoint.com", "mysite")
        https://contoso.sharepoint.com/              -> ("contoso.sharepoint.com", "root")
    """
    if not site_url or not site_url.strip():
        raise ValueError(
            "site_url is required. Pass the full SharePoint site URL in each tool call."
        )
    parts = site_url.replace("https://", "").rstrip("/").split("/")
    domain = parts[0]
    site_name = parts[2] if len(parts) > 2 else "root"
    return domain, site_name

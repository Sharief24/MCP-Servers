"""SharePoint authentication handler module."""

import base64
from dataclasses import dataclass, field
from datetime import datetime, timedelta
import json
import logging

import msal
import requests
from config.settings import SHAREPOINT_CONFIG

# Set up logging
logging.basicConfig(
    level=logging.DEBUG, format="%(asctime)s - %(name)s - %(levelname)s - %(message)s"
)
logger = logging.getLogger("sharepoint_auth")


@dataclass
class SharePointContext:
    """Context object for SharePoint connection."""

    access_token: str
    token_expiry: datetime
    graph_url: str = "https://graph.microsoft.com/v1.0"
    refresh_token: str = field(default="")
    tenant_id: str = field(default="")
    client_id: str = field(default="")
    client_secret: str = field(default="")

    @property
    def headers(self) -> dict[str, str]:
        """Get authorization headers for API calls."""
        # ヘッダーの内容をログに出力（トークンは一部のみ表示）
        token_preview = (
            f"{self.access_token[:10]}...{self.access_token[-10:]}"
            if self.access_token
            else "None"
        )
        logger.debug(f"Using token (preview): {token_preview}")

        return {
            "Authorization": f"Bearer {self.access_token}",
            "Content-Type": "application/json",
        }

    def is_token_valid(self) -> bool:
        """Check if the access token is still valid."""
        # Add safety check to handle None expiry
        if not self.token_expiry:
            return False
        is_valid = datetime.now() < self.token_expiry
        logger.debug(f"Token valid: {is_valid}, Expires: {self.token_expiry}")
        return is_valid

    def test_connection(self) -> bool:
        """Test the connection to SharePoint."""
        try:
            # Extract site domain and name from site URL
            site_parts = (
                SHAREPOINT_CONFIG["site_url"].replace("https://", "").split("/")
            )
            domain = site_parts[0]
            site_name = site_parts[2] if len(site_parts) > 2 else "root"

            # Get site information via Microsoft Graph API
            # For root site, use different endpoint format
            if site_name == "root" or not site_name:
                site_url = f"{self.graph_url}/sites/{domain}:"
            else:
                site_url = f"{self.graph_url}/sites/{domain}:/sites/{site_name}"
            logger.debug(f"Testing connection to: {site_url}")

            response = requests.get(site_url, headers=self.headers)

            if response.status_code != 200:
                logger.error(
                    f"Connection test failed: HTTP {response.status_code} - {response.text}"
                )
                return False

            logger.info(f"Connection test successful: {response.status_code}")
            return True
        except Exception as e:
            logger.error(f"Error during connection test: {e}")
            return False

    def test_write_permissions(self) -> bool:
        """Test if the current token has write permissions."""
        try:
            logger.debug("Testing write permissions...")

            # Extract site domain and name from site URL
            site_parts = (
                SHAREPOINT_CONFIG["site_url"].replace("https://", "").split("/")
            )
            domain = site_parts[0]
            site_name = site_parts[2] if len(site_parts) > 2 else "root"

            # First get site ID
            # For root site, use different endpoint format
            if site_name == "root" or not site_name:
                site_url = f"{self.graph_url}/sites/{domain}:"
            else:
                site_url = f"{self.graph_url}/sites/{domain}:/sites/{site_name}"
            response = requests.get(site_url, headers=self.headers)

            if response.status_code != 200:
                logger.error(
                    f"Failed to get site ID: {response.status_code} - {response.text}"
                )
                return False

            site_id = response.json().get("id")
            if not site_id:
                logger.error("Site ID not found in response")
                return False

            # Try to create a simple folder in a document library
            # First, get document libraries
            drives_url = f"{self.graph_url}/sites/{site_id}/drives"
            response = requests.get(drives_url, headers=self.headers)

            if response.status_code != 200:
                logger.error(
                    f"Failed to get document libraries: {response.status_code} - {response.text}"
                )
                return False

            drives = response.json().get("value", [])
            if not drives:
                logger.error("No document libraries found")
                return False

            # Try to create a test folder in the first document library
            drive_id = drives[0].get("id")
            folder_url = (
                f"{self.graph_url}/sites/{site_id}/drives/{drive_id}/root/children"
            )

            test_folder_name = f"test-folder-{datetime.now().strftime('%Y%m%d%H%M%S')}"
            folder_data = {
                "name": test_folder_name,
                "folder": {},
                "@microsoft.graph.conflictBehavior": "rename",
            }

            response = requests.post(folder_url, headers=self.headers, json=folder_data)

            if response.status_code not in (200, 201):
                logger.error(
                    f"Failed to create test folder: {response.status_code} - {response.text}"
                )
                if response.status_code == 401 or response.status_code == 403:
                    logger.error("Insufficient permissions for write operations")
                return False

            logger.info(f"Write permission test successful: {response.status_code}")

            # Try to delete the test folder
            folder_id = response.json().get("id")
            delete_url = (
                f"{self.graph_url}/sites/{site_id}/drives/{drive_id}/items/{folder_id}"
            )

            delete_response = requests.delete(delete_url, headers=self.headers)
            if delete_response.status_code not in (200, 204):
                logger.warning(
                    f"Could not delete test folder: {delete_response.status_code}"
                )
            else:
                logger.info("Test folder deleted successfully")

            return True

        except Exception as e:
            logger.error(f"Error during write permission test: {e}")
            return False

    def decode_and_log_token_permissions(self) -> None:
        """Decode token and log the permissions it contains."""
        try:
            import base64

            # Split token into parts
            token_parts = self.access_token.split(".")
            if len(token_parts) < 2:
                logger.error("Invalid token format")
                return

            # Decode the payload (second part)
            payload = token_parts[1]
            # Add padding if necessary
            payload += "=" * ((4 - len(payload) % 4) % 4)
            decoded = base64.b64decode(payload)
            claims = json.loads(decoded)

            # Log token information
            logger.info("Token information:")
            logger.info(f"Token expires: {claims.get('exp', 'unknown')}")
            logger.info(f"Token issued: {claims.get('iat', 'unknown')}")
            logger.info(f"Token issuer: {claims.get('iss', 'unknown')}")

            # Check for roles (app permissions) or scp (delegated permissions)
            roles = claims.get("roles", [])
            scp = claims.get("scp", "")

            if roles:
                logger.info("Application permissions (roles):")
                for role in roles:
                    logger.info(f"  - {role}")

                # Check for write permissions
                write_permissions = [
                    p for p in roles if "ReadWrite" in p or "Manage" in p
                ]
                if write_permissions:
                    logger.info("Write permissions found:")
                    for p in write_permissions:
                        logger.info(f"  - {p}")
                else:
                    logger.warning("No write permissions found in token")

            if scp:
                logger.info(f"Delegated permissions (scp): {scp}")

            if not roles and not scp:
                logger.error(
                    "No roles or scp claims found in token - operations will likely fail"
                )

        except Exception as e:
            logger.error(f"Error decoding token: {e}")


def _decode_token_expiry(access_token: str) -> datetime:
    """Decode the expiry time from a JWT access token's `exp` claim."""
    try:
        parts = access_token.split(".")
        if len(parts) < 2:
            raise ValueError("Not a valid JWT")
        payload = parts[1]
        # Restore base64 padding
        payload += "=" * ((4 - len(payload) % 4) % 4)
        claims = json.loads(base64.b64decode(payload))
        exp = claims.get("exp")
        if exp:
            return datetime.fromtimestamp(int(exp))
    except Exception as e:
        logger.warning(f"Could not decode token expiry, defaulting to 1 hour: {e}")
    return datetime.now() + timedelta(hours=1)


def _do_refresh_token_grant(
    refresh_token: str,
    tenant_id: str,
    client_id: str,
    client_secret: str = "",
) -> dict:
    """Exchange a refresh token for a new access token via OAuth2 token endpoint."""
    url = f"https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token"
    data = {
        "grant_type": "refresh_token",
        "client_id": client_id,
        "refresh_token": refresh_token,
        "scope": "https://graph.microsoft.com/.default offline_access",
    }
    if client_secret:
        data["client_secret"] = client_secret
    response = requests.post(url, data=data, timeout=30)
    return response.json()


def validate_config() -> None:
    """Validate SharePoint configuration.

    Accepts two auth modes:
    - Token-based: ACCESS_TOKEN (+ optional REFRESH_TOKEN) + SITE_URL
    - Client credentials: TENANT_ID + CLIENT_ID + CLIENT_SECRET + SITE_URL
    """
    if not SHAREPOINT_CONFIG.get("site_url"):
        raise ValueError("Missing required configuration: site_url")

    site_url = SHAREPOINT_CONFIG["site_url"]
    if not site_url.startswith("https://") or ".sharepoint.com" not in site_url.lower():
        raise ValueError(f"Invalid SharePoint site URL: {site_url}")

    if SHAREPOINT_CONFIG.get("access_token"):
        # Token-based auth — nothing else is strictly required at startup
        logger.info("Auth mode: token-based (ACCESS_TOKEN provided)")
        return

    # Client credentials flow — all three fields are required
    missing = [
        k
        for k in ("tenant_id", "client_id", "client_secret")
        if not SHAREPOINT_CONFIG.get(k)
    ]
    if missing:
        raise ValueError(
            f"Missing required configuration: {', '.join(missing)}. "
            "Provide either ACCESS_TOKEN or TENANT_ID + CLIENT_ID + CLIENT_SECRET."
        )
    logger.info("Auth mode: client credentials (CLIENT_SECRET provided)")


async def get_auth_context() -> SharePointContext:
    """Get SharePoint authentication context.

    Supports two modes (checked in order):
    1. Token-based  — ACCESS_TOKEN env var is set; optionally REFRESH_TOKEN for
       automatic renewal when the token expires.
    2. Client credentials — TENANT_ID + CLIENT_ID + CLIENT_SECRET env vars.
    """
    validate_config()

    # ── Mode 1: pre-acquired access token ────────────────────────────────────
    if SHAREPOINT_CONFIG.get("access_token"):
        access_token = SHAREPOINT_CONFIG["access_token"]
        expiry = _decode_token_expiry(access_token)

        token_preview = f"{access_token[:10]}...{access_token[-10:]}"
        logger.info(f"Using provided ACCESS_TOKEN (preview): {token_preview}")
        logger.info(f"Token expires at: {expiry}")

        context = SharePointContext(
            access_token=access_token,
            token_expiry=expiry,
            refresh_token=SHAREPOINT_CONFIG.get("refresh_token", ""),
            tenant_id=SHAREPOINT_CONFIG.get("tenant_id", ""),
            client_id=SHAREPOINT_CONFIG.get("client_id", ""),
            client_secret=SHAREPOINT_CONFIG.get("client_secret", ""),
        )

        context.decode_and_log_token_permissions()

        logger.info("Testing connection with provided token...")
        if not context.test_connection():
            logger.warning("Connection test failed, but continuing anyway...")

        return context

    # ── Mode 2: client credentials flow ──────────────────────────────────────
    app = msal.ConfidentialClientApplication(
        SHAREPOINT_CONFIG["client_id"],
        authority=f"https://login.microsoftonline.com/{SHAREPOINT_CONFIG['tenant_id']}",
        client_credential=SHAREPOINT_CONFIG["client_secret"],
    )

    logger.info("Acquiring new token via client credentials flow")
    result = app.acquire_token_for_client(scopes=SHAREPOINT_CONFIG["scope"])

    if "access_token" not in result:
        error_code = result.get("error", "unknown")
        error_description = result.get("error_description", "Unknown error")
        logger.error(f"Authentication failed: {error_code} - {error_description}")

        if "AADSTS" in error_description:
            if "AADSTS50034" in error_description:
                logger.error("User account doesn't exist or is invalid")
            elif "AADSTS50126" in error_description:
                logger.error("Invalid username or password")
            elif "AADSTS65001" in error_description:
                logger.error("Application does not have the required permissions")
            elif "AADSTS70011" in error_description:
                logger.error(
                    "Application specified in the request is not found in the tenant"
                )

        raise Exception(f"Authentication failed: {error_code} - {error_description}")

    token_preview = f"{result['access_token'][:10]}...{result['access_token'][-10:]}"
    logger.info(f"Token acquired successfully: {token_preview}")

    expiry = datetime.now() + timedelta(seconds=result.get("expires_in", 3600))
    logger.info(f"Authentication successful, token expires at {expiry}")

    context = SharePointContext(
        access_token=result["access_token"],
        token_expiry=expiry,
        tenant_id=SHAREPOINT_CONFIG["tenant_id"],
        client_id=SHAREPOINT_CONFIG["client_id"],
        client_secret=SHAREPOINT_CONFIG["client_secret"],
    )

    context.decode_and_log_token_permissions()

    logger.info("Testing connection with acquired token...")
    if not context.test_connection():
        logger.warning("Connection test failed, but continuing anyway...")

    logger.info("Testing write permissions...")
    if not context.test_write_permissions():
        logger.warning("Write permission test failed. Some operations may not work.")
    else:
        logger.info("Write permission test successful. Token has write permissions.")

    return context


async def refresh_token_if_needed(context: SharePointContext) -> None:
    """Refresh the access token if it has expired.

    Tries (in order):
    1. OAuth2 refresh-token grant — when context.refresh_token and context.tenant_id
       and context.client_id are all set.
    2. Client credentials re-authentication — as a fallback.
    """
    if context.is_token_valid():
        return

    logger.info("Token expired, refreshing...")

    # ── Strategy 1: refresh token grant ──────────────────────────────────────
    if context.refresh_token and context.tenant_id and context.client_id:
        try:
            result = _do_refresh_token_grant(
                refresh_token=context.refresh_token,
                tenant_id=context.tenant_id,
                client_id=context.client_id,
                client_secret=context.client_secret,
            )
            if "access_token" in result:
                context.access_token = result["access_token"]
                context.token_expiry = datetime.now() + timedelta(
                    seconds=result.get("expires_in", 3600)
                )
                # Microsoft may rotate the refresh token
                if "refresh_token" in result:
                    context.refresh_token = result["refresh_token"]
                logger.info("Token refreshed successfully via refresh token grant")
                return
            else:
                error = result.get("error", "unknown")
                logger.warning(
                    f"Refresh token grant failed ({error}), "
                    "falling back to client credentials"
                )
        except Exception as e:
            logger.warning(
                f"Refresh token grant raised an exception: {e}, "
                "falling back to client credentials"
            )

    # ── Strategy 2: client credentials re-auth ───────────────────────────────
    try:
        new_context = await get_auth_context()
        context.access_token = new_context.access_token
        context.token_expiry = new_context.token_expiry
        logger.info("Token refreshed successfully via client credentials")
    except Exception as e:
        logger.error(f"Error refreshing token: {e}")
        raise

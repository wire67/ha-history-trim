"""The History Trim integration.

Adds a sidebar panel that looks like core's History page but supports
filtering rows by a numeric threshold, a table view, and per-row deletion
from the recorder database - intended for locating and removing corrupt
sensor readings (e.g. a spike of 3000 degrees from a temperature sensor).
"""
from __future__ import annotations

import logging
from pathlib import Path

import voluptuous as vol

from homeassistant.components import panel_custom
from homeassistant.components.http import StaticPathConfig
from homeassistant.components.recorder import get_instance
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, ServiceCall
from homeassistant.helpers import config_validation as cv

from .const import (
    DOMAIN,
    JS_FILENAME,
    JS_STATIC_PATH,
    PANEL_ICON,
    PANEL_TITLE,
    PANEL_URL,
    PANEL_VERSION,
    SERVICE_PURGE_OUTLIERS,
)
from .websocket_api import async_register_websocket_commands

_LOGGER = logging.getLogger(__name__)

CONFIG_SCHEMA = cv.empty_config_schema(DOMAIN)

PURGE_OUTLIERS_SCHEMA = vol.Schema(
    {
        vol.Required("entity_id"): cv.entity_ids,
        vol.Required("start_time"): cv.datetime,
        vol.Optional("end_time"): cv.datetime,
        vol.Optional("mode", default="outside"): vol.In(
            ["above", "below", "outside", "inside"]
        ),
        vol.Optional("min_threshold"): vol.Coerce(float),
        vol.Optional("max_threshold"): vol.Coerce(float),
    }
)


async def async_setup(hass: HomeAssistant, config: dict) -> bool:
    """Set up the History Trim integration (YAML / auto-import only)."""
    hass.data.setdefault(DOMAIN, {})

    panel_dir = Path(__file__).parent / "panel"
    await hass.http.async_register_static_paths(
        [StaticPathConfig(JS_STATIC_PATH, str(panel_dir), False)]
    )

    await panel_custom.async_register_panel(
        hass,
        webcomponent_name="history-trim-panel",
        frontend_url_path=PANEL_URL,
        module_url=f"{JS_STATIC_PATH}/{JS_FILENAME}?v={PANEL_VERSION}",
        sidebar_title=PANEL_TITLE,
        sidebar_icon=PANEL_ICON,
        require_admin=True,
        embed_iframe=False,
    )

    async_register_websocket_commands(hass)

    async def _async_handle_purge_outliers(call: ServiceCall) -> None:
        """Service handler: bulk-delete rows matching a threshold filter."""
        # Imported lazily to avoid importing recorder internals at module
        # load time (keeps startup fast and import errors scoped to use).
        from .websocket_api import _delete_rows_sync, _fetch_history_sync

        entity_ids = call.data["entity_id"]
        start_time = call.data["start_time"]
        end_time = call.data.get("end_time")
        mode = call.data.get("mode", "outside")
        min_threshold = call.data.get("min_threshold")
        max_threshold = call.data.get("max_threshold")

        rows = await get_instance(hass).async_add_executor_job(
            _fetch_history_sync,
            hass,
            entity_ids,
            start_time,
            end_time,
            mode,
            min_threshold,
            max_threshold,
        )
        row_ids = [row["row_id"] for row in rows]
        if not row_ids:
            _LOGGER.info("purge_outliers: no matching rows found for %s", entity_ids)
            return

        deleted = await get_instance(hass).async_add_executor_job(
            _delete_rows_sync, hass, row_ids
        )
        _LOGGER.warning(
            "purge_outliers: deleted %d state row(s) for %s (mode=%s, min=%s, max=%s)",
            deleted,
            entity_ids,
            mode,
            min_threshold,
            max_threshold,
        )

    hass.services.async_register(
        DOMAIN,
        SERVICE_PURGE_OUTLIERS,
        _async_handle_purge_outliers,
        schema=PURGE_OUTLIERS_SCHEMA,
    )

    return True


# No config entries are used by this integration (YAML-only, no user
# credentials/config needed), but these stubs keep config_flow tooling happy
# if a config entry ever shows up (e.g. from an old install).
async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    return True

"""Websocket API for History Trim.

All database access happens inside functions that are dispatched to the
recorder's own executor via ``get_instance(hass).async_add_executor_job``.
Never touch the recorder's SQLAlchemy session from the event loop.
"""
from __future__ import annotations

import json
import logging
from typing import Any

import voluptuous as vol

from homeassistant.components import websocket_api
from homeassistant.components.recorder import get_instance
from homeassistant.core import HomeAssistant
from homeassistant.util import dt as dt_util

from .const import WS_TYPE_DELETE_ROW, WS_TYPE_DELETE_ROWS, WS_TYPE_HISTORY

_LOGGER = logging.getLogger(__name__)


def async_register_websocket_commands(hass: HomeAssistant) -> None:
    """Register all websocket commands for this integration."""
    websocket_api.async_register_command(hass, ws_get_history)
    websocket_api.async_register_command(hass, ws_delete_row)
    websocket_api.async_register_command(hass, ws_delete_rows)


# ---------------------------------------------------------------------------
# Filtering helper (pure python, no DB access - easy to unit test)
# ---------------------------------------------------------------------------


def _passes_filter(
    numeric_value: float | None,
    mode: str | None,
    min_threshold: float | None,
    max_threshold: float | None,
) -> bool:
    """Return True if a row should be kept under the requested filter mode."""
    if mode is None or mode == "none":
        return True
    if numeric_value is None:
        # Threshold filters only ever apply to numeric states.
        return False
    if mode == "above":
        return min_threshold is not None and numeric_value > min_threshold
    if mode == "below":
        return max_threshold is not None and numeric_value < max_threshold
    if mode == "outside":
        below = min_threshold is not None and numeric_value < min_threshold
        above = max_threshold is not None and numeric_value > max_threshold
        return below or above
    if mode == "inside":
        ok = True
        if min_threshold is not None:
            ok = ok and numeric_value >= min_threshold
        if max_threshold is not None:
            ok = ok and numeric_value <= max_threshold
        return ok
    return True


def _to_float(value: Any) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


# ---------------------------------------------------------------------------
# Recorder executor jobs (blocking, run off the event loop)
# ---------------------------------------------------------------------------


def _fetch_history_sync(
    hass: HomeAssistant,
    entity_ids: list[str],
    start_time,
    end_time,
    mode: str | None,
    min_threshold: float | None,
    max_threshold: float | None,
) -> list[dict[str, Any]]:
    """Query the recorder database directly for raw state rows.

    We bypass homeassistant.components.recorder.history helpers on purpose:
    they collapse/summarize state history and do not expose the underlying
    row id, which we need in order to delete an individual corrupt row.
    """
    # Imported lazily: these are recorder-internal models and the import
    # path can change between core versions.
    from homeassistant.components.recorder.db_schema import (
        StateAttributes,
        States,
        StatesMeta,
    )
    from homeassistant.components.recorder.util import session_scope

    results: list[dict[str, Any]] = []

    with session_scope(hass=hass, read_only=True) as session:
        query = (
            session.query(
                States.state_id,
                States.state,
                States.last_updated_ts,
                States.last_changed_ts,
                StatesMeta.entity_id,
                StateAttributes.shared_attrs,
            )
            .join(StatesMeta, States.metadata_id == StatesMeta.metadata_id)
            .outerjoin(
                StateAttributes, States.attributes_id == StateAttributes.attributes_id
            )
            .filter(StatesMeta.entity_id.in_(entity_ids))
            .filter(States.last_updated_ts >= start_time.timestamp())
        )
        if end_time is not None:
            query = query.filter(States.last_updated_ts <= end_time.timestamp())

        query = query.order_by(States.last_updated_ts.desc())

        for row in query:
            numeric_value = _to_float(row.state)

            if not _passes_filter(numeric_value, mode, min_threshold, max_threshold):
                continue

            attrs: dict[str, Any] = {}
            if row.shared_attrs:
                try:
                    attrs = json.loads(row.shared_attrs)
                except (ValueError, TypeError):
                    attrs = {}

            last_updated_ts = row.last_updated_ts
            last_changed_ts = row.last_changed_ts or last_updated_ts

            results.append(
                {
                    "row_id": row.state_id,
                    "entity_id": row.entity_id,
                    "state": row.state,
                    "numeric_value": numeric_value,
                    "last_changed": dt_util.utc_from_timestamp(
                        last_changed_ts
                    ).isoformat()
                    if last_changed_ts
                    else None,
                    "last_updated": dt_util.utc_from_timestamp(
                        last_updated_ts
                    ).isoformat()
                    if last_updated_ts
                    else None,
                    "attributes": attrs,
                }
            )

    return results


def _delete_row_sync(hass: HomeAssistant, row_id: int) -> bool:
    """Delete a single row from the states table. Returns True if deleted."""
    from homeassistant.components.recorder.db_schema import States
    from homeassistant.components.recorder.util import session_scope

    with session_scope(hass=hass) as session:
        row = session.query(States).filter(States.state_id == row_id).first()
        if row is None:
            return False
        session.delete(row)
    return True


def _delete_rows_sync(hass: HomeAssistant, row_ids: list[int]) -> int:
    """Delete multiple rows in one transaction. Returns count deleted."""
    from homeassistant.components.recorder.db_schema import States
    from homeassistant.components.recorder.util import session_scope

    with session_scope(hass=hass) as session:
        deleted = (
            session.query(States)
            .filter(States.state_id.in_(row_ids))
            .delete(synchronize_session=False)
        )
    return deleted


# ---------------------------------------------------------------------------
# Websocket command handlers
# ---------------------------------------------------------------------------


@websocket_api.websocket_command(
    {
        vol.Required("type"): WS_TYPE_HISTORY,
        vol.Required("entity_ids"): [str],
        vol.Required("start_time"): str,
        vol.Optional("end_time"): str,
        vol.Optional("mode", default="none"): vol.In(
            ["none", "above", "below", "outside", "inside"]
        ),
        vol.Optional("min_threshold"): vol.Coerce(float),
        vol.Optional("max_threshold"): vol.Coerce(float),
    }
)
@websocket_api.async_response
async def ws_get_history(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict
) -> None:
    """Handle a request for filtered history rows."""
    try:
        start_time = dt_util.parse_datetime(msg["start_time"])
        if start_time is None:
            raise ValueError("invalid start_time")
        end_time = None
        if msg.get("end_time"):
            end_time = dt_util.parse_datetime(msg["end_time"])

        rows = await get_instance(hass).async_add_executor_job(
            _fetch_history_sync,
            hass,
            msg["entity_ids"],
            start_time,
            end_time,
            msg.get("mode"),
            msg.get("min_threshold"),
            msg.get("max_threshold"),
        )
        connection.send_result(msg["id"], {"rows": rows})
    except Exception as err:  # noqa: BLE001
        _LOGGER.exception("Error fetching filtered history")
        connection.send_error(msg["id"], "history_trim_error", str(err))


@websocket_api.websocket_command(
    {
        vol.Required("type"): WS_TYPE_DELETE_ROW,
        vol.Required("row_id"): int,
    }
)
@websocket_api.require_admin
@websocket_api.async_response
async def ws_delete_row(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict
) -> None:
    """Handle deletion of a single state row."""
    try:
        deleted = await get_instance(hass).async_add_executor_job(
            _delete_row_sync, hass, msg["row_id"]
        )
        connection.send_result(msg["id"], {"deleted": deleted})
    except Exception as err:  # noqa: BLE001
        _LOGGER.exception("Error deleting row %s", msg["row_id"])
        connection.send_error(msg["id"], "history_trim_delete_error", str(err))


@websocket_api.websocket_command(
    {
        vol.Required("type"): WS_TYPE_DELETE_ROWS,
        vol.Required("row_ids"): [int],
    }
)
@websocket_api.require_admin
@websocket_api.async_response
async def ws_delete_rows(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict
) -> None:
    """Handle bulk deletion of state rows (e.g. 'delete all filtered rows')."""
    try:
        count = await get_instance(hass).async_add_executor_job(
            _delete_rows_sync, hass, msg["row_ids"]
        )
        connection.send_result(msg["id"], {"deleted": count})
    except Exception as err:  # noqa: BLE001
        _LOGGER.exception("Error deleting rows")
        connection.send_error(msg["id"], "history_trim_delete_error", str(err))

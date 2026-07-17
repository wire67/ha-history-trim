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

from .const import (
    WS_TYPE_DELETE_ROW,
    WS_TYPE_DELETE_ROWS,
    WS_TYPE_HISTORY,
    WS_TYPE_STATISTICS,
)

_LOGGER = logging.getLogger(__name__)


def async_register_websocket_commands(hass: HomeAssistant) -> None:
    """Register all websocket commands for this integration."""
    websocket_api.async_register_command(hass, ws_get_history)
    websocket_api.async_register_command(hass, ws_delete_row)
    websocket_api.async_register_command(hass, ws_delete_rows)
    websocket_api.async_register_command(hass, ws_get_statistics)


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
        # The states table has a self-referential FK: States.old_state_id
        # points at the state_id of the *previous* state for that entity.
        # If some other (usually newer) row's old_state_id points at the
        # row we're about to delete, SQLite will refuse the delete with a
        # FOREIGN KEY constraint failure. Null out any such back-references
        # first - this mirrors what recorder's own purge job does.
        session.query(States).filter(States.old_state_id == row_id).update(
            {States.old_state_id: None}, synchronize_session=False
        )
        session.delete(row)
    return True


def _delete_rows_sync(hass: HomeAssistant, row_ids: list[int]) -> int:
    """Delete multiple rows in one transaction. Returns count deleted."""
    from homeassistant.components.recorder.db_schema import States
    from homeassistant.components.recorder.util import session_scope

    with session_scope(hass=hass) as session:
        # Same fix as _delete_row_sync, batched: clear every old_state_id
        # that references any row we're about to remove.
        session.query(States).filter(States.old_state_id.in_(row_ids)).update(
            {States.old_state_id: None}, synchronize_session=False
        )
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


# ---------------------------------------------------------------------------
# Long-term statistics outlier detection (read-only)
#
# We deliberately do NOT reimplement statistics *adjustment* here - that
# requires correctly propagating a correction through both the
# `statistics` and `statistics_short_term` tables, which is exactly the
# kind of recorder-internal logic that's easy to get subtly wrong. Fixing
# a flagged outlier is instead done from the frontend by calling Home
# Assistant's own existing `recorder/adjust_sum_statistics` websocket
# command directly - the same command the core "Adjust a statistic" UI
# uses - so we inherit core's own tested logic instead of duplicating it.
# ---------------------------------------------------------------------------


def _fetch_statistics_sync(
    hass: HomeAssistant,
    entity_ids: list[str],
    start_time,
    end_time,
    outlier_factor: float,
) -> list[dict[str, Any]]:
    """Fetch hourly long-term statistics and flag outlier hours.

    Only entities with a running `sum` (state_class total / total_increasing
    - e.g. energy, water, gas meters) are considered: those are the ones
    that feed the Energy dashboard's consumption bars, and "consumption for
    this hour" is derived as sum[i] - sum[i-1]. Plain "measurement" class
    statistics (mean/min/max only, e.g. temperature) have no running total
    to flag spikes against and are skipped.

    Outlier detection uses a simple, robust (non-parametric) method: for
    each entity, compute the median hourly delta and the median absolute
    deviation (MAD) from that median, then flag any hour whose delta is
    more than `outlier_factor` MADs away from the median. This is
    intentionally simple rather than a full statistical model - it's meant
    to surface obvious spikes (a sensor briefly reporting a huge jump), not
    to be a rigorous anomaly detector.
    """
    import statistics as pystats

    from homeassistant.components.recorder.db_schema import Statistics, StatisticsMeta
    from homeassistant.components.recorder.util import session_scope

    results: list[dict[str, Any]] = []

    with session_scope(hass=hass, read_only=True) as session:
        query = (
            session.query(
                Statistics.id,
                Statistics.start_ts,
                Statistics.sum,
                Statistics.mean,
                Statistics.min,
                Statistics.max,
                StatisticsMeta.statistic_id,
                StatisticsMeta.unit_of_measurement,
                StatisticsMeta.has_sum,
            )
            .join(StatisticsMeta, Statistics.metadata_id == StatisticsMeta.id)
            .filter(StatisticsMeta.statistic_id.in_(entity_ids))
            .filter(Statistics.start_ts >= start_time.timestamp())
        )
        if end_time is not None:
            query = query.filter(Statistics.start_ts <= end_time.timestamp())
        query = query.order_by(StatisticsMeta.statistic_id, Statistics.start_ts)

        by_entity: dict[str, list] = {}
        for row in query:
            by_entity.setdefault(row.statistic_id, []).append(row)

        for statistic_id, rows in by_entity.items():
            if not rows or not rows[0].has_sum:
                continue  # not a cumulative sensor - nothing to flag here

            unit = rows[0].unit_of_measurement
            prev_sum: float | None = None
            entity_rows: list[dict[str, Any]] = []
            deltas: list[float] = []

            for row in rows:
                delta = None
                if row.sum is not None and prev_sum is not None:
                    delta = row.sum - prev_sum
                if row.sum is not None:
                    prev_sum = row.sum

                entity_rows.append(
                    {
                        "id": row.id,
                        "entity_id": statistic_id,
                        "start": dt_util.utc_from_timestamp(row.start_ts).isoformat(),
                        "sum": row.sum,
                        "delta": delta,
                        "unit_of_measurement": unit,
                    }
                )
                if delta is not None:
                    deltas.append(delta)

            median = pystats.median(deltas) if deltas else None
            mad = None
            if deltas:
                mad = pystats.median(abs(d - median) for d in deltas)
            # A near-zero MAD means the baseline is extremely steady, which
            # would make the outlier test hypersensitive to tiny wobbles.
            # Fall back to a fraction of the median magnitude in that case.
            effective_mad = mad if mad and mad > 0 else abs(median) * 0.5 if median else 0

            for r in entity_rows:
                is_outlier = False
                if r["delta"] is not None and median is not None and effective_mad > 0:
                    is_outlier = abs(r["delta"] - median) > outlier_factor * effective_mad
                r["is_outlier"] = is_outlier
                r["baseline_delta"] = median
                results.append(r)

    return results


@websocket_api.websocket_command(
    {
        vol.Required("type"): WS_TYPE_STATISTICS,
        vol.Required("entity_ids"): [str],
        vol.Required("start_time"): str,
        vol.Optional("end_time"): str,
        vol.Optional("outlier_factor", default=5.0): vol.Coerce(float),
    }
)
@websocket_api.async_response
async def ws_get_statistics(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict
) -> None:
    """Handle a request for hourly statistics with outlier flags."""
    try:
        start_time = dt_util.parse_datetime(msg["start_time"])
        if start_time is None:
            raise ValueError("invalid start_time")
        end_time = None
        if msg.get("end_time"):
            end_time = dt_util.parse_datetime(msg["end_time"])

        rows = await get_instance(hass).async_add_executor_job(
            _fetch_statistics_sync,
            hass,
            msg["entity_ids"],
            start_time,
            end_time,
            msg["outlier_factor"],
        )
        connection.send_result(msg["id"], {"rows": rows})
    except Exception as err:  # noqa: BLE001
        _LOGGER.exception("Error fetching statistics")
        connection.send_error(msg["id"], "history_trim_statistics_error", str(err))

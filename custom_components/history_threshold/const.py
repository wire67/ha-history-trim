"""Constants for the History Trim integration."""

DOMAIN = "ha_history_trim"

PANEL_URL = "ha-history-trim"
PANEL_TITLE = "History Trim"
PANEL_ICON = "mdi:filter-variant"

# URL prefix under which the panel's static JS is served
JS_STATIC_PATH = "/ha_history_trim_panel"
JS_FILENAME = "ha-history-trim-panel.js"

SERVICE_PURGE_OUTLIERS = "purge_outliers"

WS_TYPE_HISTORY = "ha_history_trim/history"
WS_TYPE_DELETE_ROW = "ha_history_trim/delete_row"
WS_TYPE_DELETE_ROWS = "ha_history_trim/delete_rows"

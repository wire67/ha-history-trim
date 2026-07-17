"""Constants for the History Trim integration."""

DOMAIN = "history_trim"

PANEL_URL = "history-trim"
PANEL_TITLE = "History Trim"
PANEL_ICON = "mdi:filter-variant"

# URL prefix under which the panel's static JS is served
JS_STATIC_PATH = "/history_trim_panel"
JS_FILENAME = "history-trim-panel.js"

SERVICE_PURGE_OUTLIERS = "purge_outliers"

WS_TYPE_HISTORY = "history_trim/history"
WS_TYPE_DELETE_ROW = "history_trim/delete_row"
WS_TYPE_DELETE_ROWS = "history_trim/delete_rows"

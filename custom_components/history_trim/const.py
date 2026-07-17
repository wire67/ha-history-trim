"""Constants for the History Trim integration."""

DOMAIN = "history_trim"

PANEL_URL = "history-trim"
PANEL_TITLE = "History Trim"
PANEL_ICON = "mdi:filter-variant"

# URL prefix under which the panel's static JS is served
JS_STATIC_PATH = "/history_trim_panel"
JS_FILENAME = "history-trim-panel.js"

# Bump this any time panel/history-trim-panel.js changes. It's appended to
# the module URL as a cache-busting query string, since browsers (and any
# service worker) will otherwise happily keep serving an old cached copy
# of the JS file forever after you update it on disk.
PANEL_VERSION = "1.3.0"

SERVICE_PURGE_OUTLIERS = "purge_outliers"

WS_TYPE_HISTORY = "history_trim/history"
WS_TYPE_DELETE_ROW = "history_trim/delete_row"
WS_TYPE_DELETE_ROWS = "history_trim/delete_rows"
WS_TYPE_STATISTICS = "history_trim/statistics"

# History Trim

A custom Home Assistant integration that adds a sidebar panel styled after
the core **History** page, with three additions core doesn't offer:

1. **Threshold filtering** – only show rows above/below/inside/outside a
   numeric value, so you can isolate outlier readings (e.g. a temperature
   sensor that briefly reported `3276.7°C`).
2. **Table view** – a flat, sortable-by-scroll table of raw state rows
   (entity, state, timestamp, attributes), as an alternative to the graph.
3. **Row deletion** – a delete button on each row (and a "delete all shown"
   button) that permanently removes that row from the recorder database.
   A `history_trim.purge_outliers` service is also included for
   automation-driven cleanup.

> ⚠️ **Deleting recorder rows is irreversible.** There is no undo. Always
> confirm you're targeting the right entities/time range/threshold before
> deleting. Consider taking a backup of your `home-assistant_v2.db` (or your
> external recorder DB) before bulk operations.

---

## How it works (architecture)

Home Assistant's built-in History page cannot be filtered by value and
doesn't expose delete controls, and core's frontend history components
aren't built to be reused directly by third-party panels. So this
integration ships its own minimal panel that talks to a small custom
backend:

```
custom_components/history_trim/
├── __init__.py          Sets up the panel, static file serving, websocket
│                         commands, and the purge_outliers service.
├── const.py              Shared constants.
├── manifest.json          Integration metadata/dependencies.
├── services.yaml           Service definition shown in Developer Tools.
└── panel/
    └── history-trim-panel.js   The frontend panel (vanilla JS, no
                                      build step, no external dependencies).
```

**Backend (`websocket_api.py`)** queries the recorder's `states` /
`states_meta` / `state_attributes` tables directly via SQLAlchemy (through
`homeassistant.components.recorder.util.session_scope`), because the
higher-level `recorder.history` helpers summarize/collapse state history and
don't expose the row primary key (`state_id`) needed to delete a specific
row. All database work runs inside `get_instance(hass).async_add_executor_job`
on the recorder's own executor thread — never on the event loop.

Two websocket commands do the work:

- `history_trim/history` — fetch raw rows for a list of entities and a
  time range, filtered by threshold `mode` (`above`, `below`, `outside`,
  `inside`, or `none`) and `min_threshold` / `max_threshold`.
- `history_trim/delete_row` / `history_trim/delete_rows` — delete
  one or more rows by `state_id`. Both require admin privileges
  (`@websocket_api.require_admin`).

**Frontend (`history-trim-panel.js`)** is a single self-contained
custom element (`<history-trim-panel>`) using Shadow DOM and no
external imports, so it has no build step and no CDN dependency — it just
needs to be served as a static file, which `__init__.py` sets up
automatically. It renders:

- An entity picker (searchable checkbox list, since a full HA entity picker
  component isn't guaranteed to be registered before this panel loads).
  Typing multiple words matches each word independently against either the
  friendly name or the entity id (e.g. "kitchen temp" matches
  `sensor.kitchen_temperature` even though the words appear in a different
  order than the id itself), and any already-checked entities are sorted
  to the top of the list so they stay visible while you keep searching.
- Start/end time inputs.
- A threshold mode selector and min/max fields.
- A **Table** view and a **Graph** view (a lightweight canvas line chart
  with dashed threshold reference lines, min/max labels on both axes, and
  a hover tooltip showing the exact value and timestamp of the point
  under the cursor), toggled with buttons matching core's view-switcher
  style.
- A 🗑 delete button per table row, plus "Delete all shown" for bulk
  cleanup, both requiring a confirmation dialog.

### Compatibility note

This integration reaches into recorder-internal SQLAlchemy models
(`homeassistant.components.recorder.db_schema`), which is not a stable
public API and can change between Home Assistant core releases. It was
written against the schema used by modern (2024.x+) core, where states are
split across `states`, `states_meta`, and `state_attributes` tables, and
statistics are split across `statistics` and `statistics_meta`. If you
upgrade Home Assistant and the panel starts failing to load history or
outliers, check the Home Assistant log for `history_trim` errors — the
recorder schema may have changed and the relevant query in
`websocket_api.py` will need a small update to match. The one part that's
*not* home-grown is the actual statistics correction (the Outliers tab's
fix buttons call core's own `recorder/adjust_sum_statistics` websocket
command), so that part should keep working even if the schema shifts
underneath the read-only outlier scan.

### If you edit the panel JS yourself

The frontend module is loaded with a cache-busting `?v=...` query string
taken from `PANEL_VERSION` in `const.py`. If you customize
`history-trim-panel.js` and your changes don't seem to show up after a
restart, bump `PANEL_VERSION` too — otherwise your browser (or a service
worker) may keep serving its previously cached copy of the file under the
old URL.

---

## Installation

### Option A: Manual

1. Copy the `custom_components/history_trim` folder from this package
   into your Home Assistant config directory, so you end up with:
   ```
   <config>/custom_components/history_trim/__init__.py
   <config>/custom_components/history_trim/const.py
   <config>/custom_components/history_trim/manifest.json
   <config>/custom_components/history_trim/services.yaml
   <config>/custom_components/history_trim/panel/history-trim-panel.js
   ```
2. Add the following to `configuration.yaml`:
   ```yaml
   history_trim:
   ```
3. Restart Home Assistant.
4. A new **History Trim** entry will appear in the sidebar (visible to
   admin users only).

### Option B: HACS (custom repository)

1. In HACS, go to **Integrations → ⋮ → Custom repositories**.
2. Add `https://github.com/wire67/ha-history-trim` with category **Integration**.
3. "History Trim" now shows up as a normal HACS integration card — open it
   and click **Download** (bottom right) to actually pull the files into
   `config/custom_components/history_trim/`. Adding the custom repository
   only makes it visible to HACS; it does not install anything by itself.
4. Add `history_trim:` to `configuration.yaml`.
5. Restart Home Assistant (HACS installs the files but you still need to
   enable the integration via YAML and restart, since it has no config
   flow).

---

## Usage

1. Open **History Trim** in the sidebar.
2. Filter/select the entities you suspect have corrupt data.
3. Set a start time (and optionally an end time).
4. Pick a filter **mode**:
   - `above` – state value greater than **Min threshold**.
   - `below` – state value less than **Max threshold**.
   - `outside` – value is below **Min** *or* above **Max** (typical setup
     for isolating corrupt/out-of-range spikes when you know a sensor's
     normal operating range).
   - `inside` – value is within **Min**–**Max**.
   - `none` – no threshold filter, behaves like core History (all rows).
5. Click **Load history**.
6. Switch between **Table**, **Graph**, and **Outliers** view.
7. In table view, click 🗑 on any row to delete just that row, or **Delete
   all shown** to remove every row currently matching your filter. Both
   ask for confirmation first.

### Fixing Energy dashboard outliers

The **Outliers** tab is separate from the table/graph above: it doesn't
touch raw history at all, it looks at **long-term statistics** — the
hourly data the Energy dashboard actually reads (see [Limitations](#limitations--things-to-know)
below for why that's a different thing from history).

1. Select the cumulative sensors you care about (energy/water/gas meters —
   anything with `state_class: total` or `total_increasing`).
2. Set a time range and, optionally, adjust **Outlier sensitivity** — this
   is how many "median absolute deviations" a hour's consumption has to be
   from that entity's typical hourly delta before it's flagged. Higher =
   stricter (fewer, more obvious outliers); lower = more sensitive.
3. Switch to the **Outliers** tab and click **Scan for outliers**.
4. Each flagged hour shows its actual consumption next to the entity's
   typical hourly delta, with three ways to fix it:
   - **Zero this hour** – treat the hour's consumption as 0 (use when you're
     confident the whole spike is bogus).
   - **Reset to typical** – replace this hour's consumption with the
     entity's median hourly delta.
   - **Custom** – type the consumption value this hour *should* have shown
     and click Apply.

   All three call Home Assistant's own `recorder/adjust_sum_statistics`
   websocket command directly (the same one core's own "Adjust a
   statistic" UI in Developer Tools → Statistics uses), so the correction
   is applied using core's tested logic, not a reimplementation of it. You
   get a confirmation dialog first — like row deletion, this is permanent.

### Automating cleanup

Call the `history_trim.purge_outliers` service (from Developer Tools →
Actions, or in an automation/script) to delete matching rows without
opening the panel:

```yaml
action: history_trim.purge_outliers
data:
  entity_id: sensor.outdoor_temperature
  start_time: "2026-07-01T00:00:00"
  mode: outside
  min_threshold: -40
  max_threshold: 60
```

---

## Limitations / things to know

- Only numeric states can be threshold-filtered; non-numeric rows (e.g.
  `on`/`off`) are excluded whenever a threshold mode other than `none` is
  active.
- Deleting a `states` row does not renumber or fix `old_state_id` links on
  neighboring rows; Home Assistant's history/logbook simply won't show the
  deleted point anymore. This mirrors what recorder's own purge does. Any
  other row whose `old_state_id` pointed at the deleted row has that link
  nulled out automatically (otherwise SQLite raises a foreign key
  constraint error on delete).
- Deleting or filtering `states` rows never touches long-term statistics
  (`statistics` / `statistics_short_term`, the tables the Energy dashboard
  actually reads). Use the **Outliers** tab for that instead — it reads and
  corrects statistics directly, separately from the history table/graph.
- Outlier detection in the Statistics tab only looks at cumulative
  (`total`/`total_increasing`) sensors, since "consumption" is derived from
  the delta between consecutive hourly sums. Plain `measurement`-class
  statistics (e.g. temperature) have no running total to compare against
  and are skipped.
- The `recorder/adjust_sum_statistics` command used by the Outliers tab's
  fix buttons shifts the running total for that entity from the corrected
  hour *onward* by the adjustment amount — it's the same behavior as core's
  own "Adjust a statistic" UI, including the same caveat: the correction
  changes the cumulative total but the graph's per-hour bar for other hours
  isn't independently recomputed.
- The entity picker loads all entities into a checkbox list; on very large
  installations (thousands of entities) the filter box is there to help you
  narrow it down quickly.
- Your last-used entities, time range, mode, and min/max thresholds are
  remembered via the browser's `localStorage` and pre-filled the next time
  you open the panel. This is per-browser (not synced between devices or
  admin accounts) and never leaves your browser.

## License

Provided as-is, no warranty. Review and test in a non-production instance
before relying on it to delete data.

/**
 * History Trim panel.
 *
 * A self-contained custom element (no build step, no external imports) that
 * mirrors the layout of core's History page: entity picker, time range,
 * a filter row, and a results area that can be shown as a table or a
 * simple line graph. Table rows have a delete button that removes the row
 * from the recorder database via a websocket call.
 */

const COLORS = [
  "#03a9f4", "#ff9800", "#4caf50", "#e91e63", "#9c27b0",
  "#795548", "#009688", "#ffc107", "#3f51b5", "#f44336",
];

const FORM_STORAGE_KEY = "history_trim.form_state";

class HistoryTrimPanel extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });

    this._hass = null;
    this._initialized = false;

    this._view = "table"; // "table" | "graph" | "outliers"
    this._rows = [];
    this._loading = false;
    this._error = null;

    this._statRows = [];
    this._statLoading = false;
    this._statError = null;

    const saved = this._loadFormState();
    this._selectedEntities = saved.selectedEntities || [];
    this._entityFilterText = "";
    this._mode = saved.mode || "above";
    this._minThreshold = saved.minThreshold ?? "";
    this._maxThreshold = saved.maxThreshold ?? "";
    this._startTime = saved.startTime || this._defaultStart();
    this._endTime = saved.endTime ?? "";
    this._outlierFactor = saved.outlierFactor ?? "5";
  }

  _loadFormState() {
    try {
      const raw = window.localStorage.getItem(FORM_STORAGE_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch (err) {
      // Storage unavailable (private browsing, etc.) - fall back to defaults.
      return {};
    }
  }

  _saveFormState() {
    try {
      window.localStorage.setItem(
        FORM_STORAGE_KEY,
        JSON.stringify({
          selectedEntities: this._selectedEntities,
          mode: this._mode,
          minThreshold: this._minThreshold,
          maxThreshold: this._maxThreshold,
          startTime: this._startTime,
          endTime: this._endTime,
          outlierFactor: this._outlierFactor,
        })
      );
    } catch (err) {
      // Ignore - persistence is a convenience, not a requirement.
    }
  }

  set hass(hass) {
    const firstRun = !this._hass;
    this._hass = hass;

    if (firstRun) {
      this._initialized = true;
      this._render();
    }
  }

  get hass() {
    return this._hass;
  }

  set narrow(_value) {
    /* layout is responsive via CSS, nothing extra required */
  }

  set panel(_panel) {
    /* not used, present for HA panel_custom contract */
  }

  connectedCallback() {
    this._render();
  }

  _defaultStart() {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    d.setSeconds(0, 0);
    return this._toLocalInputValue(d);
  }

  _toLocalInputValue(date) {
    const pad = (n) => String(n).padStart(2, "0");
    return (
      `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
      `T${pad(date.getHours())}:${pad(date.getMinutes())}`
    );
  }

  // -------------------------------------------------------------------
  // Data
  // -------------------------------------------------------------------

  async _fetchHistory() {
    if (!this._hass) return;
    if (this._selectedEntities.length === 0) {
      this._error = "Select at least one entity first.";
      this._render();
      return;
    }
    if (!this._startTime) {
      this._error = "Start time is required.";
      this._render();
      return;
    }

    this._loading = true;
    this._error = null;
    this._render();

    const msg = {
      type: "history_trim/history",
      entity_ids: this._selectedEntities,
      start_time: new Date(this._startTime).toISOString(),
      mode: this._mode,
    };
    if (this._endTime) {
      msg.end_time = new Date(this._endTime).toISOString();
    }
    if (this._minThreshold !== "") {
      msg.min_threshold = parseFloat(this._minThreshold);
    }
    if (this._maxThreshold !== "") {
      msg.max_threshold = parseFloat(this._maxThreshold);
    }

    try {
      const result = await this._hass.callWS(msg);
      this._rows = result.rows;
    } catch (err) {
      this._error = (err && err.message) || String(err);
    }
    this._loading = false;
    this._render();
  }

  async _fetchStatistics() {
    if (!this._hass) return;
    if (this._selectedEntities.length === 0) {
      this._statError = "Select at least one entity first.";
      this._render();
      return;
    }
    if (!this._startTime) {
      this._statError = "Start time is required.";
      this._render();
      return;
    }

    this._statLoading = true;
    this._statError = null;
    this._render();

    const factor = parseFloat(this._outlierFactor);
    const msg = {
      type: "history_trim/statistics",
      entity_ids: this._selectedEntities,
      start_time: new Date(this._startTime).toISOString(),
      outlier_factor: Number.isFinite(factor) && factor > 0 ? factor : 5,
    };
    if (this._endTime) {
      msg.end_time = new Date(this._endTime).toISOString();
    }

    try {
      const result = await this._hass.callWS(msg);
      this._statRows = result.rows;
    } catch (err) {
      this._statError = (err && err.message) || String(err);
    }
    this._statLoading = false;
    this._render();
  }

  /**
   * Apply a correction to a flagged hour by calling Home Assistant's own
   * `recorder/adjust_sum_statistics` websocket command directly - the same
   * command core's "Adjust a statistic" UI uses. `adjustment` is the delta
   * to add to the running sum from this hour onward (a negative number to
   * remove an inflated spike).
   */
  async _applyStatAdjustment(row, adjustment) {
    if (!Number.isFinite(adjustment) || adjustment === 0) {
      window.alert("Enter a non-zero adjustment.");
      return;
    }
    const ok = window.confirm(
      `Adjust "${row.entity_id}" by ${adjustment.toFixed(3)} ${
        row.unit_of_measurement || ""
      } starting at ${new Date(row.start).toLocaleString()}?\n\n` +
        "This permanently shifts the recorded running total from this hour " +
        "onward and cannot be undone from here."
    );
    if (!ok) return;

    try {
      await this._hass.callWS({
        type: "recorder/adjust_sum_statistics",
        statistic_id: row.entity_id,
        start: row.start,
        adjustment,
        adjustment_unit_of_measurement: row.unit_of_measurement || null,
      });
      // Optimistic local update: reflect the correction immediately without
      // a full re-scan, and clear the outlier flag on this row.
      row.delta = row.delta + adjustment;
      row.is_outlier = false;
      row.fixed = true;
      this._render();
    } catch (err) {
      window.alert(
        "Failed to adjust statistic: " + ((err && err.message) || err)
      );
    }
  }

  async _deleteRow(rowId) {
    const ok = window.confirm(
      "Permanently delete this row from the recorder database?\n\n" +
        "This cannot be undone."
    );
    if (!ok) return;

    try {
      await this._hass.callWS({
        type: "history_trim/delete_row",
        row_id: rowId,
      });
      this._rows = this._rows.filter((r) => r.row_id !== rowId);
      this._render();
    } catch (err) {
      window.alert("Failed to delete row: " + ((err && err.message) || err));
    }
  }

  async _deleteAllFiltered() {
    if (this._rows.length === 0) return;
    const ok = window.confirm(
      `Permanently delete all ${this._rows.length} row(s) currently shown?\n\n` +
        "This cannot be undone."
    );
    if (!ok) return;

    try {
      const rowIds = this._rows.map((r) => r.row_id);
      await this._hass.callWS({
        type: "history_trim/delete_rows",
        row_ids: rowIds,
      });
      this._rows = [];
      this._render();
    } catch (err) {
      window.alert("Failed to delete rows: " + ((err && err.message) || err));
    }
  }

  _toggleEntity(entityId) {
    const idx = this._selectedEntities.indexOf(entityId);
    if (idx === -1) {
      this._selectedEntities = [...this._selectedEntities, entityId];
    } else {
      this._selectedEntities = this._selectedEntities.filter((e) => e !== entityId);
    }
    this._saveFormState();
    this._render();
  }

  // -------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------

  _render() {
    if (!this._hass) return;

    const allEntityIds = Object.keys(this._hass.states).sort();
    const filterLower = this._entityFilterText.toLowerCase();
    const visibleEntityIds = filterLower
      ? allEntityIds.filter((id) => id.toLowerCase().includes(filterLower))
      : allEntityIds;

    this.shadowRoot.innerHTML = `
      <style>${this._styles()}</style>
      <div class="toolbar">
        <div class="toolbar-title">History Trim</div>
      </div>
      <div class="content">
        <div class="card filters">
          <div class="section-title">Entities (${this._selectedEntities.length} selected)</div>
          <input
            id="entity-filter"
            class="text-input"
            type="text"
            placeholder="Filter entities…"
            value="${this._escape(this._entityFilterText)}"
          />
          <div class="entity-list">
            ${visibleEntityIds
              .slice(0, 300)
              .map((id) => {
                const checked = this._selectedEntities.includes(id);
                const name =
                  (this._hass.states[id].attributes &&
                    this._hass.states[id].attributes.friendly_name) ||
                  id;
                return `
                  <label class="entity-item">
                    <input type="checkbox" data-entity="${this._escape(id)}" ${
                  checked ? "checked" : ""
                } />
                    <span class="entity-name">${this._escape(name)}</span>
                    <span class="entity-id">${this._escape(id)}</span>
                  </label>
                `;
              })
              .join("")}
            ${
              visibleEntityIds.length > 300
                ? `<div class="hint">Showing first 300 matches - refine the filter above.</div>`
                : ""
            }
          </div>

          <div class="section-title">Time range</div>
          <label class="field-label">Start</label>
          <input id="start-time" class="text-input" type="datetime-local" value="${this._startTime}" />
          <label class="field-label">End (optional, defaults to now)</label>
          <input id="end-time" class="text-input" type="datetime-local" value="${this._endTime}" />

          <div class="section-title">Threshold filter</div>
          <label class="field-label">Mode</label>
          <select id="mode" class="text-input">
            <option value="above" ${this._mode === "above" ? "selected" : ""}>Above minimum</option>
            <option value="below" ${this._mode === "below" ? "selected" : ""}>Below maximum</option>
            <option value="outside" ${this._mode === "outside" ? "selected" : ""}>Outside min/max range (corrupt data)</option>
            <option value="inside" ${this._mode === "inside" ? "selected" : ""}>Inside min/max range</option>
            <option value="none" ${this._mode === "none" ? "selected" : ""}>No filter (show all, like core History)</option>
          </select>
          <div class="threshold-row">
            <div>
              <label class="field-label">Min threshold</label>
              <input id="min-threshold" class="text-input" type="number" step="any" value="${this._escape(
                this._minThreshold
              )}" placeholder="e.g. 0" />
            </div>
            <div>
              <label class="field-label">Max threshold</label>
              <input id="max-threshold" class="text-input" type="number" step="any" value="${this._escape(
                this._maxThreshold
              )}" placeholder="e.g. 100" />
            </div>
          </div>

          <div class="section-title">Statistics outliers</div>
          <label class="field-label">Outlier sensitivity (higher = stricter)</label>
          <input id="outlier-factor" class="text-input" type="number" step="0.5" min="0.5" value="${this._escape(
            this._outlierFactor
          )}" placeholder="5" />
          <div class="hint">
            Used by the "Outliers" tab to flag hours whose consumption is
            far from that entity's typical hourly delta. Only applies to
            cumulative (total / total_increasing) sensors.
          </div>

          <button id="load-btn" class="primary-btn" ${
            (this._view === "outliers" ? this._statLoading : this._loading)
              ? "disabled"
              : ""
          }>
            ${
              this._view === "outliers"
                ? this._statLoading
                  ? "Scanning…"
                  : "Scan for outliers"
                : this._loading
                ? "Loading…"
                : "Load history"
            }
          </button>
          ${this._error ? `<div class="error">${this._escape(this._error)}</div>` : ""}
          ${
            this._statError
              ? `<div class="error">${this._escape(this._statError)}</div>`
              : ""
          }
        </div>

        <div class="card results">
          <div class="results-header">
            <div class="view-toggle">
              <button class="toggle-btn ${this._view === "table" ? "active" : ""}" data-view="table">Table</button>
              <button class="toggle-btn ${this._view === "graph" ? "active" : ""}" data-view="graph">Graph</button>
              <button class="toggle-btn ${this._view === "outliers" ? "active" : ""}" data-view="outliers">Outliers</button>
            </div>
            <div class="results-count">
              ${
                this._view === "outliers"
                  ? `${this._statRows.filter((r) => r.is_outlier).length} outlier(s) of ${
                      this._statRows.length
                    } hour(s)`
                  : `${this._rows.length} row(s)`
              }
            </div>
            ${
              this._view !== "outliers" && this._rows.length > 0
                ? `<button id="delete-all-btn" class="danger-btn">Delete all shown</button>`
                : ""
            }
          </div>
          <div class="results-body">
            ${
              this._view === "table"
                ? this._renderTable()
                : this._view === "outliers"
                ? this._renderOutliers()
                : `<div class="graph-wrap"><canvas id="graph-canvas"></canvas></div>`
            }
          </div>
        </div>
      </div>
    `;

    this._attachListeners();

    if (this._view === "graph") {
      // Draw after the canvas element exists and has layout size.
      requestAnimationFrame(() => this._drawGraph());
    }
  }

  _renderOutliers() {
    if (this._statRows.length === 0) {
      return `<div class="empty">No outlier scan run yet. Set your filters, adjust sensitivity if needed, and click "Scan for outliers".</div>`;
    }
    const flagged = this._statRows.filter((r) => r.is_outlier || r.fixed);
    if (flagged.length === 0) {
      return `<div class="empty">Scanned ${this._statRows.length} hour(s) across your selected entities - no outliers found at this sensitivity.</div>`;
    }
    return `
      <table class="data-table">
        <thead>
          <tr>
            <th>Entity</th>
            <th>Hour</th>
            <th>This hour</th>
            <th>Typical</th>
            <th>Fix</th>
          </tr>
        </thead>
        <tbody>
          ${flagged
            .map((row) => {
              const idx = this._statRows.indexOf(row);
              const unit = row.unit_of_measurement || "";
              const delta = row.delta !== null ? row.delta.toFixed(3) : "—";
              const baseline =
                row.baseline_delta !== null ? row.baseline_delta.toFixed(3) : "—";
              if (row.fixed) {
                return `
                  <tr class="fixed-row">
                    <td class="entity-cell" title="${this._escape(row.entity_id)}">${this._escape(
                  row.entity_id
                )}</td>
                    <td>${this._escape(new Date(row.start).toLocaleString())}</td>
                    <td class="numeric">${delta} ${this._escape(unit)}</td>
                    <td class="numeric">${baseline} ${this._escape(unit)}</td>
                    <td>✅ Fixed</td>
                  </tr>
                `;
              }
              return `
                <tr class="outlier-row">
                  <td class="entity-cell" title="${this._escape(row.entity_id)}">${this._escape(
                row.entity_id
              )}</td>
                  <td>${this._escape(new Date(row.start).toLocaleString())}</td>
                  <td class="numeric flagged">${delta} ${this._escape(unit)}</td>
                  <td class="numeric">${baseline} ${this._escape(unit)}</td>
                  <td>
                    <div class="fix-actions">
                      <button class="fix-btn" data-stat-index="${idx}" data-action="zero">Zero this hour</button>
                      <button class="fix-btn" data-stat-index="${idx}" data-action="typical">Reset to typical</button>
                      <input class="fix-custom-input" type="number" step="any" data-stat-index="${idx}" placeholder="custom Δ" />
                      <button class="fix-btn" data-stat-index="${idx}" data-action="custom">Apply</button>
                    </div>
                  </td>
                </tr>
              `;
            })
            .join("")}
        </tbody>
      </table>
    `;
  }


  _renderTable() {
    if (this._rows.length === 0) {
      return `<div class="empty">No rows loaded yet. Set your filters and click "Load history".</div>`;
    }
    return `
      <table class="data-table">
        <thead>
          <tr>
            <th>Entity</th>
            <th>State</th>
            <th>Last changed</th>
            <th>Attributes</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${this._rows
            .map((row) => {
              const attrsPreview = JSON.stringify(row.attributes || {});
              return `
                <tr>
                  <td class="entity-cell" title="${this._escape(row.entity_id)}">${this._escape(
                row.entity_id
              )}</td>
                  <td class="${row.numeric_value !== null ? "numeric" : ""}">${this._escape(
                String(row.state)
              )}</td>
                  <td>${this._escape(row.last_changed || "")}</td>
                  <td class="attrs-cell" title="${this._escape(attrsPreview)}">${this._escape(
                attrsPreview.length > 60 ? attrsPreview.slice(0, 60) + "…" : attrsPreview
              )}</td>
                  <td>
                    <button class="delete-btn" data-row-id="${row.row_id}" title="Delete this row">
                      🗑
                    </button>
                  </td>
                </tr>
              `;
            })
            .join("")}
        </tbody>
      </table>
    `;
  }

  _drawGraph() {
    const canvas = this.shadowRoot.getElementById("graph-canvas");
    if (!canvas) return;
    const wrap = canvas.parentElement;
    const width = wrap.clientWidth || 600;
    const height = 360;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = width + "px";
    canvas.style.height = height + "px";
    const ctx = canvas.getContext("2d");
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);

    // Tooltip element lives alongside the canvas and is positioned
    // imperatively on hover - it is not part of the innerHTML template so
    // that hovering never triggers a full re-render.
    let tooltip = wrap.querySelector(".graph-tooltip");
    if (!tooltip) {
      tooltip = document.createElement("div");
      tooltip.className = "graph-tooltip";
      wrap.appendChild(tooltip);
    }
    tooltip.style.display = "none";

    const numericRows = this._rows.filter((r) => r.numeric_value !== null);
    if (numericRows.length === 0) {
      ctx.fillStyle = "var(--secondary-text-color, #888)";
      ctx.font = "14px sans-serif";
      ctx.fillText("No numeric rows to graph.", 16, 24);
      return;
    }

    const padding = { top: 16, right: 16, bottom: 46, left: 56 };
    const plotW = width - padding.left - padding.right;
    const plotH = height - padding.top - padding.bottom;

    const byEntity = {};
    for (const row of numericRows) {
      if (!byEntity[row.entity_id]) byEntity[row.entity_id] = [];
      byEntity[row.entity_id].push(row);
    }
    Object.values(byEntity).forEach((rows) =>
      rows.sort((a, b) => new Date(a.last_updated) - new Date(b.last_updated))
    );

    let minT = Infinity;
    let maxT = -Infinity;
    let minV = Infinity;
    let maxV = -Infinity;
    for (const row of numericRows) {
      const t = new Date(row.last_updated).getTime();
      minT = Math.min(minT, t);
      maxT = Math.max(maxT, t);
      minV = Math.min(minV, row.numeric_value);
      maxV = Math.max(maxV, row.numeric_value);
    }
    if (this._minThreshold !== "") minV = Math.min(minV, parseFloat(this._minThreshold));
    if (this._maxThreshold !== "") maxV = Math.max(maxV, parseFloat(this._maxThreshold));
    if (minT === maxT) maxT = minT + 1;
    if (minV === maxV) maxV = minV + 1;
    const vPad = (maxV - minV) * 0.08;
    minV -= vPad;
    maxV += vPad;

    const xFor = (t) => padding.left + ((t - minT) / (maxT - minT)) * plotW;
    const yFor = (v) => padding.top + plotH - ((v - minV) / (maxV - minV)) * plotH;

    // axes
    ctx.strokeStyle = "var(--divider-color, #ddd)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padding.left, padding.top);
    ctx.lineTo(padding.left, padding.top + plotH);
    ctx.lineTo(padding.left + plotW, padding.top + plotH);
    ctx.stroke();

    // Y axis min/max
    ctx.fillStyle = "var(--secondary-text-color, #888)";
    ctx.font = "11px sans-serif";
    ctx.textAlign = "left";
    ctx.fillText(maxV.toFixed(1), 4, padding.top + 8);
    ctx.fillText(minV.toFixed(1), 4, padding.top + plotH);

    // X axis min/max (start / end of the plotted range)
    const xLabelY = padding.top + plotH + 16;
    ctx.textAlign = "left";
    ctx.fillText(new Date(minT).toLocaleString(), padding.left, xLabelY);
    ctx.textAlign = "right";
    ctx.fillText(new Date(maxT).toLocaleString(), padding.left + plotW, xLabelY);
    ctx.textAlign = "left";

    // threshold lines
    ctx.setLineDash([5, 4]);
    ctx.strokeStyle = "#f44336";
    if (this._minThreshold !== "") {
      const y = yFor(parseFloat(this._minThreshold));
      ctx.beginPath();
      ctx.moveTo(padding.left, y);
      ctx.lineTo(padding.left + plotW, y);
      ctx.stroke();
    }
    if (this._maxThreshold !== "") {
      const y = yFor(parseFloat(this._maxThreshold));
      ctx.beginPath();
      ctx.moveTo(padding.left, y);
      ctx.lineTo(padding.left + plotW, y);
      ctx.stroke();
    }
    ctx.setLineDash([]);

    // series
    let colorIdx = 0;
    const legendItems = [];
    const points = []; // flat list of hit-testable dots for the hover tooltip
    for (const [entityId, rows] of Object.entries(byEntity)) {
      const color = COLORS[colorIdx % COLORS.length];
      colorIdx += 1;
      legendItems.push({ entityId, color });

      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      rows.forEach((row, i) => {
        const x = xFor(new Date(row.last_updated).getTime());
        const y = yFor(row.numeric_value);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();

      rows.forEach((row) => {
        const x = xFor(new Date(row.last_updated).getTime());
        const y = yFor(row.numeric_value);
        ctx.beginPath();
        ctx.arc(x, y, 2.5, 0, Math.PI * 2);
        ctx.fill();
        points.push({ x, y, entityId, color, row });
      });
    }

    // legend
    let legendX = padding.left;
    const legendY = height - 8;
    ctx.font = "11px sans-serif";
    legendItems.forEach((item) => {
      ctx.fillStyle = item.color;
      ctx.fillRect(legendX, legendY - 8, 10, 10);
      ctx.fillStyle = "var(--primary-text-color, #333)";
      const label = item.entityId;
      ctx.fillText(label, legendX + 14, legendY);
      legendX += ctx.measureText(label).width + 32;
    });

    // Hover tooltip: find the nearest point within a small pixel radius
    // and show its entity, value, and timestamp.
    const HOVER_RADIUS_SQ = 12 * 12;
    const showTooltipFor = (point) => {
      tooltip.innerHTML = `
        <div class="graph-tooltip-entity">${this._escape(point.entityId)}</div>
        <div class="graph-tooltip-value">${this._escape(String(point.row.state))}</div>
        <div class="graph-tooltip-time">${this._escape(
          new Date(point.row.last_updated).toLocaleString()
        )}</div>
      `;
      const left = Math.min(point.x + 12, width - 160);
      const top = Math.max(point.y - 44, 0);
      tooltip.style.left = `${left}px`;
      tooltip.style.top = `${top}px`;
      tooltip.style.display = "block";
    };

    canvas.onmousemove = (evt) => {
      const rect = canvas.getBoundingClientRect();
      const mx = evt.clientX - rect.left;
      const my = evt.clientY - rect.top;
      let nearest = null;
      let nearestDist = Infinity;
      for (const p of points) {
        const dx = p.x - mx;
        const dy = p.y - my;
        const dist = dx * dx + dy * dy;
        if (dist < nearestDist) {
          nearestDist = dist;
          nearest = p;
        }
      }
      if (nearest && nearestDist <= HOVER_RADIUS_SQ) {
        canvas.style.cursor = "pointer";
        showTooltipFor(nearest);
      } else {
        canvas.style.cursor = "default";
        tooltip.style.display = "none";
      }
    };
    canvas.onmouseleave = () => {
      tooltip.style.display = "none";
    };
  }

  _attachListeners() {
    const root = this.shadowRoot;

    const filterInput = root.getElementById("entity-filter");
    if (filterInput) {
      filterInput.addEventListener("input", (e) => {
        this._entityFilterText = e.target.value;
        this._render();
        // restore focus/cursor since we re-render the whole tree
        const el = this.shadowRoot.getElementById("entity-filter");
        if (el) {
          el.focus();
          el.selectionStart = el.selectionEnd = el.value.length;
        }
      });
    }

    root.querySelectorAll("[data-entity]").forEach((el) => {
      el.addEventListener("change", (e) => {
        this._toggleEntity(e.target.getAttribute("data-entity"));
      });
    });

    const startTime = root.getElementById("start-time");
    if (startTime) {
      startTime.addEventListener("change", (e) => {
        this._startTime = e.target.value;
        this._saveFormState();
      });
    }
    const endTime = root.getElementById("end-time");
    if (endTime) {
      endTime.addEventListener("change", (e) => {
        this._endTime = e.target.value;
        this._saveFormState();
      });
    }
    const mode = root.getElementById("mode");
    if (mode) {
      mode.addEventListener("change", (e) => {
        this._mode = e.target.value;
        this._saveFormState();
      });
    }
    const minThreshold = root.getElementById("min-threshold");
    if (minThreshold) {
      minThreshold.addEventListener("change", (e) => {
        this._minThreshold = e.target.value;
        this._saveFormState();
      });
    }
    const maxThreshold = root.getElementById("max-threshold");
    if (maxThreshold) {
      maxThreshold.addEventListener("change", (e) => {
        this._maxThreshold = e.target.value;
        this._saveFormState();
      });
    }
    const outlierFactor = root.getElementById("outlier-factor");
    if (outlierFactor) {
      outlierFactor.addEventListener("change", (e) => {
        this._outlierFactor = e.target.value;
        this._saveFormState();
      });
    }

    const loadBtn = root.getElementById("load-btn");
    if (loadBtn) {
      loadBtn.addEventListener("click", () =>
        this._view === "outliers" ? this._fetchStatistics() : this._fetchHistory()
      );
    }

    root.querySelectorAll(".toggle-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        this._view = btn.getAttribute("data-view");
        this._render();
      });
    });

    root.querySelectorAll(".delete-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const rowId = parseInt(btn.getAttribute("data-row-id"), 10);
        this._deleteRow(rowId);
      });
    });

    const deleteAllBtn = root.getElementById("delete-all-btn");
    if (deleteAllBtn) {
      deleteAllBtn.addEventListener("click", () => this._deleteAllFiltered());
    }

    root.querySelectorAll(".fix-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const idx = parseInt(btn.getAttribute("data-stat-index"), 10);
        const action = btn.getAttribute("data-action");
        const row = this._statRows[idx];
        if (!row || row.delta === null) return;

        if (action === "zero") {
          this._applyStatAdjustment(row, -row.delta);
        } else if (action === "typical") {
          const baseline = row.baseline_delta ?? 0;
          this._applyStatAdjustment(row, baseline - row.delta);
        } else if (action === "custom") {
          const input = root.querySelector(
            `.fix-custom-input[data-stat-index="${idx}"]`
          );
          const desired = input ? parseFloat(input.value) : NaN;
          if (!Number.isFinite(desired)) {
            window.alert("Enter the desired consumption for this hour first.");
            return;
          }
          this._applyStatAdjustment(row, desired - row.delta);
        }
      });
    });
  }

  _escape(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  _styles() {
    return `
      :host {
        display: block;
        height: 100%;
        background: var(--primary-background-color, #fafafa);
        font-family: var(--paper-font-body1_-_font-family, Roboto, sans-serif);
        color: var(--primary-text-color, #212121);
      }
      .toolbar {
        display: flex;
        align-items: center;
        height: 56px;
        padding: 0 16px;
        background: var(--app-header-background-color, var(--primary-color, #03a9f4));
        color: var(--app-header-text-color, #fff);
      }
      .toolbar-title {
        font-size: 20px;
        font-weight: 400;
      }
      .content {
        display: flex;
        flex-wrap: wrap;
        gap: 16px;
        padding: 16px;
        box-sizing: border-box;
      }
      .card {
        background: var(--card-background-color, #fff);
        border-radius: var(--ha-card-border-radius, 8px);
        box-shadow: var(--ha-card-box-shadow, 0 1px 3px rgba(0,0,0,0.15));
        padding: 16px;
        box-sizing: border-box;
      }
      .filters {
        width: 320px;
        flex-shrink: 0;
      }
      .results {
        flex: 1;
        min-width: 320px;
      }
      .section-title {
        font-size: 12px;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--secondary-text-color, #727272);
        margin: 16px 0 6px 0;
      }
      .section-title:first-child { margin-top: 0; }
      .field-label {
        display: block;
        font-size: 12px;
        color: var(--secondary-text-color, #727272);
        margin-top: 8px;
      }
      .text-input {
        width: 100%;
        box-sizing: border-box;
        padding: 8px;
        margin-top: 4px;
        border: 1px solid var(--divider-color, #ccc);
        border-radius: 4px;
        background: var(--card-background-color, #fff);
        color: var(--primary-text-color, #212121);
        font-size: 14px;
      }
      .threshold-row {
        display: flex;
        gap: 8px;
      }
      .threshold-row > div { flex: 1; }
      .entity-list {
        max-height: 220px;
        overflow-y: auto;
        border: 1px solid var(--divider-color, #eee);
        border-radius: 4px;
        margin-top: 6px;
      }
      .entity-item {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 6px 8px;
        cursor: pointer;
        font-size: 13px;
        border-bottom: 1px solid var(--divider-color, #f2f2f2);
      }
      .entity-item:last-child { border-bottom: none; }
      .entity-item:hover { background: var(--secondary-background-color, #f5f5f5); }
      .entity-name { font-weight: 500; }
      .entity-id { color: var(--secondary-text-color, #888); font-size: 11px; }
      .hint { padding: 6px 8px; font-size: 12px; color: var(--secondary-text-color, #888); }
      .primary-btn {
        margin-top: 16px;
        width: 100%;
        padding: 10px;
        background: var(--primary-color, #03a9f4);
        color: #fff;
        border: none;
        border-radius: 4px;
        font-size: 14px;
        cursor: pointer;
      }
      .primary-btn:disabled { opacity: 0.6; cursor: default; }
      .danger-btn {
        padding: 6px 12px;
        background: var(--error-color, #db4437);
        color: #fff;
        border: none;
        border-radius: 4px;
        font-size: 13px;
        cursor: pointer;
      }
      .error {
        margin-top: 10px;
        color: var(--error-color, #db4437);
        font-size: 13px;
      }
      .results-header {
        display: flex;
        align-items: center;
        gap: 12px;
        margin-bottom: 12px;
      }
      .results-count {
        color: var(--secondary-text-color, #888);
        font-size: 13px;
        flex: 1;
      }
      .view-toggle {
        display: inline-flex;
        border: 1px solid var(--divider-color, #ccc);
        border-radius: 4px;
        overflow: hidden;
      }
      .toggle-btn {
        padding: 6px 14px;
        background: var(--card-background-color, #fff);
        color: var(--primary-text-color, #212121);
        border: none;
        cursor: pointer;
        font-size: 13px;
      }
      .toggle-btn.active {
        background: var(--primary-color, #03a9f4);
        color: #fff;
      }
      .empty {
        padding: 32px;
        text-align: center;
        color: var(--secondary-text-color, #888);
      }
      .data-table {
        width: 100%;
        border-collapse: collapse;
        font-size: 13px;
      }
      .data-table th {
        text-align: left;
        padding: 8px;
        border-bottom: 2px solid var(--divider-color, #ddd);
        color: var(--secondary-text-color, #727272);
        font-weight: 500;
      }
      .data-table td {
        padding: 8px;
        border-bottom: 1px solid var(--divider-color, #f0f0f0);
        max-width: 260px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .data-table td.numeric { font-variant-numeric: tabular-nums; }
      .delete-btn {
        background: none;
        border: 1px solid var(--divider-color, #ccc);
        border-radius: 4px;
        cursor: pointer;
        padding: 4px 8px;
        font-size: 14px;
      }
      .delete-btn:hover {
        background: var(--error-color, #db4437);
        border-color: var(--error-color, #db4437);
      }
      .outlier-row td.flagged {
        color: var(--error-color, #db4437);
        font-weight: 600;
      }
      .fixed-row {
        opacity: 0.6;
      }
      .fix-actions {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 6px;
      }
      .fix-btn {
        padding: 4px 8px;
        font-size: 12px;
        border: 1px solid var(--divider-color, #ccc);
        border-radius: 4px;
        background: var(--card-background-color, #fff);
        color: var(--primary-text-color, #212121);
        cursor: pointer;
        white-space: nowrap;
      }
      .fix-btn:hover {
        background: var(--primary-color, #03a9f4);
        color: #fff;
        border-color: var(--primary-color, #03a9f4);
      }
      .fix-custom-input {
        width: 80px;
        padding: 4px 6px;
        font-size: 12px;
        border: 1px solid var(--divider-color, #ccc);
        border-radius: 4px;
        background: var(--card-background-color, #fff);
        color: var(--primary-text-color, #212121);
      }
      .graph-wrap {
        width: 100%;
        position: relative;
      }
      .graph-tooltip {
        position: absolute;
        display: none;
        pointer-events: none;
        background: rgba(20, 20, 20, 0.92);
        color: #fff;
        padding: 6px 8px;
        border-radius: 4px;
        font-size: 12px;
        line-height: 1.4;
        white-space: nowrap;
        z-index: 10;
        box-shadow: 0 2px 6px rgba(0, 0, 0, 0.3);
      }
      .graph-tooltip-entity {
        font-weight: 500;
        opacity: 0.85;
      }
      .graph-tooltip-value {
        font-size: 14px;
        font-weight: 600;
      }
      .graph-tooltip-time {
        opacity: 0.75;
      }
      canvas { display: block; width: 100%; }
      @media (max-width: 700px) {
        .filters { width: 100%; }
      }
    `;
  }
}

customElements.define("history-trim-panel", HistoryTrimPanel);

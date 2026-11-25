(() => {
  "use strict";

  // Served by the backend (local or deployed) -> same origin.
  // Opened directly as a file -> fall back to the local server.
  const API_BASE = location.protocol.startsWith("http") ? location.origin : "http://127.0.0.1:8000";

  const form = document.getElementById("predict-form");
  const submitBtn = document.getElementById("submit-btn");
  const resetBtn = document.getElementById("reset-btn");
  const errorRetryBtn = document.getElementById("error-retry-btn");

  const stateIdle = document.getElementById("state-idle");
  const stateLoading = document.getElementById("state-loading");
  const stateResult = document.getElementById("state-result");
  const stateError = document.getElementById("state-error");

  const scoreNumberEl = document.getElementById("score-number");
  const scoreBandEl = document.getElementById("score-band");
  const scoreContextEl = document.getElementById("score-context");
  const gaugeFill = document.getElementById("gauge-fill");
  const errorLabelEl = document.getElementById("error-label");
  const errorCopyEl = document.getElementById("error-copy");

  const GAUGE_ARC_LENGTH = 314; // approx pi * r(100)

  // ---------------------------------------------------------
  // Draw tick marks on both gauges (0..10, every 2 units)
  // ---------------------------------------------------------
  function drawTicks() {
    document.querySelectorAll(".gauge-ticks").forEach((g) => {
      g.innerHTML = "";
      const cx = 120, cy = 140, rOuter = 100, rInner = 90;
      for (let i = 0; i <= 10; i += 2) {
        const angle = Math.PI - (i / 10) * Math.PI; // 180deg -> 0deg
        const x1 = cx + rOuter * Math.cos(angle);
        const y1 = cy - rOuter * Math.sin(angle);
        const x2 = cx + rInner * Math.cos(angle);
        const y2 = cy - rInner * Math.sin(angle);
        const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
        line.setAttribute("x1", x1.toFixed(1));
        line.setAttribute("y1", y1.toFixed(1));
        line.setAttribute("x2", x2.toFixed(1));
        line.setAttribute("y2", y2.toFixed(1));
        g.appendChild(line);
      }
    });
  }
  drawTicks();

  // ---------------------------------------------------------
  // Segmented control (stress_level) wiring
  // ---------------------------------------------------------
  const segGroup = document.getElementById("stress_level_group");
  const stressHiddenInput = document.getElementById("stress_level");
  segGroup.querySelectorAll(".seg-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      segGroup.querySelectorAll(".seg-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      stressHiddenInput.value = btn.dataset.value;
      clearFieldError(stressHiddenInput);
    });
  });

  // ---------------------------------------------------------
  // Field-level error helpers
  // ---------------------------------------------------------
  function fieldWrapper(input) {
    return input.closest(".field");
  }

  function setFieldError(input, message) {
    const wrap = fieldWrapper(input);
    if (!wrap) return;
    wrap.classList.add("field-error");
    const msgEl = wrap.querySelector(".error-msg");
    if (msgEl) msgEl.textContent = message;
  }

  function clearFieldError(input) {
    const wrap = fieldWrapper(input);
    if (!wrap) return;
    wrap.classList.remove("field-error");
    const msgEl = wrap.querySelector(".error-msg");
    if (msgEl) msgEl.textContent = "";
  }

  function clearAllErrors() {
    form.querySelectorAll(".field").forEach((f) => f.classList.remove("field-error"));
    form.querySelectorAll(".error-msg").forEach((m) => (m.textContent = ""));
  }

  // ---------------------------------------------------------
  // Client-side validation mirroring the StudentData model
  // ---------------------------------------------------------
  function validate(payload) {
    const errors = [];

    const numericChecks = [
      ["age", 10, 100],
      ["avg_daily_usage_hours", 0, 24],
      ["daily_unlocks", 0, Infinity],
      ["study_hours", 0, 24],
      ["physical_activity_hours", 0, 24],
      ["sleep_hours_per_night", 0, 24],
    ];

    numericChecks.forEach(([key, min, max]) => {
      const input = document.getElementById(key);
      const val = payload[key];
      if (val === "" || val === null || Number.isNaN(val)) {
        errors.push([input, "This field is required."]);
      } else if (val < min || val > max) {
        errors.push([input, `Must be between ${min} and ${max === Infinity ? "0+" : max}.`]);
      }
    });

    ["gender", "country", "academic_level", "most_used_platform", "purpose_of_use"].forEach((key) => {
      const input = document.getElementById(key);
      if (!payload[key] || String(payload[key]).trim() === "") {
        errors.push([input, "This field is required."]);
      }
    });

    if (!payload.stress_level) {
      errors.push([stressHiddenInput, "Pick a stress level."]);
    }

    return errors;
  }

  // ---------------------------------------------------------
  // Gather form data into the exact StudentData shape
  // ---------------------------------------------------------
  function collectPayload() {
    const fd = new FormData(form);
    return {
      age: fd.get("age") === "" ? NaN : parseInt(fd.get("age"), 10),
      gender: fd.get("gender") || "",
      country: (fd.get("country") || "").trim(),
      academic_level: fd.get("academic_level") || "",
      most_used_platform: fd.get("most_used_platform") || "",
      purpose_of_use: fd.get("purpose_of_use") || "",
      avg_daily_usage_hours: fd.get("avg_daily_usage_hours") === "" ? NaN : parseFloat(fd.get("avg_daily_usage_hours")),
      daily_unlocks: fd.get("daily_unlocks") === "" ? NaN : parseInt(fd.get("daily_unlocks"), 10),
      study_hours: fd.get("study_hours") === "" ? NaN : parseFloat(fd.get("study_hours")),
      physical_activity_hours: fd.get("physical_activity_hours") === "" ? NaN : parseFloat(fd.get("physical_activity_hours")),
      sleep_hours_per_night: fd.get("sleep_hours_per_night") === "" ? NaN : parseFloat(fd.get("sleep_hours_per_night")),
      stress_level: fd.get("stress_level") || "",
    };
  }

  // ---------------------------------------------------------
  // UI state switching
  // ---------------------------------------------------------
  function showState(name) {
    [stateIdle, stateLoading, stateResult, stateError].forEach((el) => (el.hidden = true));
    ({ idle: stateIdle, loading: stateLoading, result: stateResult, error: stateError }[name]).hidden = false;
  }

  function setSubmitting(isSubmitting) {
    submitBtn.disabled = isSubmitting;
    submitBtn.classList.toggle("loading", isSubmitting);
  }

  function bandFor(score) {
    if (score < 4) {
      return {
        label: "Signal: strained",
        context: "Your responses suggest elevated strain right now. Small shifts in sleep or screen time can go a long way.",
      };
    }
    if (score < 7) {
      return {
        label: "Signal: balanced",
        context: "Your rhythm looks fairly steady, with some room to recover and reset.",
      };
    }
    return {
      label: "Signal: strong",
      context: "Your habits point to a well-supported, resilient baseline. Keep it up.",
    };
  }

  function renderResult(score) {
    const clamped = Math.max(0, Math.min(10, score));
    const { label, context } = bandFor(clamped);

    scoreNumberEl.textContent = score.toFixed(2);
    scoreBandEl.textContent = label;
    scoreContextEl.textContent = context;

    // reset then animate the arc fill on next frame
    gaugeFill.style.transition = "none";
    gaugeFill.style.strokeDashoffset = String(GAUGE_ARC_LENGTH);
    requestAnimationFrame(() => {
      gaugeFill.style.transition = "";
      const offset = GAUGE_ARC_LENGTH * (1 - clamped / 10);
      gaugeFill.style.strokeDashoffset = String(offset);
    });

    showState("result");
  }

  function renderError(label, copy) {
    errorLabelEl.textContent = label;
    errorCopyEl.textContent = copy;
    showState("error");
  }

  // ---------------------------------------------------------
  // Parse FastAPI / Pydantic 422 error responses into
  // field-level messages where possible
  // ---------------------------------------------------------
  function applyServerValidationErrors(detail) {
    if (!Array.isArray(detail)) return false;
    let matched = false;
    detail.forEach((err) => {
      const field = Array.isArray(err.loc) ? err.loc[err.loc.length - 1] : null;
      const input = field ? document.getElementById(field) : null;
      const target = field === "stress_level" ? stressHiddenInput : input;
      if (target) {
        setFieldError(target, err.msg || "Invalid value.");
        matched = true;
      }
    });
    return matched;
  }

  // ---------------------------------------------------------
  // Submit handler
  // ---------------------------------------------------------
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    clearAllErrors();

    const payload = collectPayload();
    const clientErrors = validate(payload);

    if (clientErrors.length > 0) {
      clientErrors.forEach(([input, msg]) => input && setFieldError(input, msg));
      clientErrors[0][0]?.focus?.();
      return;
    }

    setSubmitting(true);
    showState("loading");

    try {
      const res = await fetch(`${API_BASE}/analyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (res.status === 422) {
        const body = await res.json().catch(() => null);
        const matched = body && applyServerValidationErrors(body.detail);
        renderError(
          "Check your inputs",
          matched
            ? "The API rejected a few fields — details are marked on the form."
            : "The API rejected this submission. Please review your inputs and try again."
        );
        return;
      }

      if (!res.ok) {
        let detailMsg = `The API responded with status ${res.status}.`;
        const body = await res.json().catch(() => null);
        if (body && typeof body.detail === "string") detailMsg = body.detail;
        renderError("Prediction failed", detailMsg);
        return;
      }

      const data = await res.json();
      if (typeof data.score !== "number") {
        renderError("Unexpected response", "The API responded, but the score was missing or malformed.");
        return;
      }

      renderResult(data.score);
      renderInsights(data, payload);
      loadHistory();
    } catch (err) {
      renderError(
        "Can't reach the server",
        `Couldn't connect to ${API_BASE}. Make sure the backend is running (uvicorn main:app --reload) in a terminal.`
      );
    } finally {
      setSubmitting(false);
    }
  });

  // live-clear errors as the user edits
  form.querySelectorAll("input, select").forEach((el) => {
    el.addEventListener("input", () => clearFieldError(el));
    el.addEventListener("change", () => clearFieldError(el));
  });

  resetBtn.addEventListener("click", () => {
    showState("idle");
  });

  errorRetryBtn.addEventListener("click", () => {
    showState("idle");
  });
  // =========================================================
  // NEW FEATURES
  // =========================================================
  const insightsEl = document.getElementById("insights");
  const warningsEl = document.getElementById("score-warnings");

  function esc(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function signed(n) {
    return (n > 0 ? "+" : n < 0 ? "−" : "±") + Math.abs(n).toFixed(2);
  }

  function renderInsights(data, payload) {
    renderWarnings(data.warnings || []);
    renderExplain(data.contributions || []);
    renderTips(data.tips || []);
    setupWhatIf(payload, data.score);
    insightsEl.hidden = false;
  }

  // ---------------------------------------------------------
  // Out-of-range warnings (shown under the score)
  // ---------------------------------------------------------
  function renderWarnings(warnings) {
    if (!warnings.length) {
      warningsEl.hidden = true;
      warningsEl.innerHTML = "";
      return;
    }
    warningsEl.innerHTML =
      "<strong>⚠ Outside the training data</strong>" + warnings.map((w) => `<p>${esc(w)}</p>`).join("");
    warningsEl.hidden = false;
  }

  // ---------------------------------------------------------
  // Feature 1: Why this score? (diverging bar chart)
  // ---------------------------------------------------------
  function renderExplain(contributions) {
    const list = document.getElementById("explain-list");
    const maxAbs = Math.max(0.5, ...contributions.map((c) => Math.abs(c.impact)));
    const rows = contributions.map((c) => {
      const pct = (Math.abs(c.impact) / maxAbs) * 50; // half the track per side
      const cls = c.impact > 0.004 ? "pos" : c.impact < -0.004 ? "neg" : "zero";
      return `
        <div class="explain-row" title="Yours: ${esc(c.value)} · Typical: ${esc(c.typical)}">
          <div class="explain-name">${esc(c.label)}<small>${esc(c.value)} vs ${esc(c.typical)}</small></div>
          <div class="explain-track">${cls === "zero" ? "" : `<div class="explain-bar ${cls}" style="width:0%" data-w="${pct}"></div>`}</div>
          <div class="explain-value ${cls}">${cls === "zero" ? "0.00" : signed(c.impact)}</div>
        </div>`;
    });
    list.innerHTML = `<div class="explain-legend"><span>◀ lowers score</span><span>raises score ▶</span></div>` + rows.join("");
    requestAnimationFrame(() => {
      list.querySelectorAll(".explain-bar").forEach((b) => (b.style.width = b.dataset.w + "%"));
    });
  }

  // ---------------------------------------------------------
  // Feature 2: What-if sliders
  // ---------------------------------------------------------
  const SLIDERS = [
    { key: "sleep_hours_per_night", label: "Sleep", unit: "hrs", min: 3.5, max: 10, step: 0.1 },
    { key: "avg_daily_usage_hours", label: "Screen time", unit: "hrs", min: 1, max: 9, step: 0.1 },
    { key: "daily_unlocks", label: "Phone unlocks", unit: "/day", min: 60, max: 275, step: 1 },
    { key: "study_hours", label: "Study hours", unit: "hrs", min: 0, max: 8.5, step: 0.1 },
    { key: "physical_activity_hours", label: "Physical activity", unit: "hrs", min: 0, max: 4.5, step: 0.1 },
  ];
  const whatIf = { base: null, baseScore: 0, current: null, timer: null, reqId: 0 };
  const slidersEl = document.getElementById("sliders");
  const whatIfStress = document.getElementById("whatif-stress");

  function fmtVal(cfg, v) {
    return cfg.step >= 1 ? `${Math.round(v)}${cfg.unit}` : `${Number(v).toFixed(1)} ${cfg.unit}`;
  }

  function setupWhatIf(payload, score) {
    whatIf.base = { ...payload };
    whatIf.current = { ...payload };
    whatIf.baseScore = score;

    slidersEl.innerHTML = SLIDERS.map((cfg) => {
      const v = payload[cfg.key];
      const min = Math.min(cfg.min, v);
      const max = Math.max(cfg.max, v);
      return `
        <div class="slider-row">
          <label for="wi-${cfg.key}">${cfg.label} <span id="wi-${cfg.key}-val">${fmtVal(cfg, v)}</span></label>
          <input type="range" id="wi-${cfg.key}" data-key="${cfg.key}" min="${min}" max="${max}" step="${cfg.step}" value="${v}" />
        </div>`;
    }).join("");

    slidersEl.querySelectorAll('input[type="range"]').forEach((input) => {
      input.addEventListener("input", () => {
        const cfg = SLIDERS.find((c) => c.key === input.dataset.key);
        const v = cfg.step >= 1 ? parseInt(input.value, 10) : parseFloat(input.value);
        whatIf.current[cfg.key] = v;
        const valEl = document.getElementById(`wi-${cfg.key}-val`);
        valEl.textContent = fmtVal(cfg, v);
        valEl.classList.toggle("changed", v !== whatIf.base[cfg.key]);
        scheduleWhatIf();
      });
    });

    whatIfStress.value = payload.stress_level;
    showWhatIfScore(score);
  }

  whatIfStress.addEventListener("change", () => {
    if (!whatIf.current) return;
    whatIf.current.stress_level = whatIfStress.value;
    scheduleWhatIf();
  });

  document.getElementById("whatif-reset").addEventListener("click", () => {
    if (whatIf.base) setupWhatIf(whatIf.base, whatIf.baseScore);
  });

  function scheduleWhatIf() {
    clearTimeout(whatIf.timer);
    whatIf.timer = setTimeout(runWhatIf, 120);
  }

  async function runWhatIf() {
    const id = ++whatIf.reqId;
    try {
      const res = await fetch(`${API_BASE}/predict`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(whatIf.current),
      });
      if (!res.ok) return;
      const data = await res.json();
      if (id === whatIf.reqId) showWhatIfScore(data.predicted_mental_health_score);
    } catch (_) {
      /* server unreachable: keep last value */
    }
  }

  function showWhatIfScore(score) {
    document.getElementById("whatif-number").textContent = score.toFixed(2);
    const delta = score - whatIf.baseScore;
    const deltaEl = document.getElementById("whatif-delta");
    deltaEl.textContent = Math.abs(delta) < 0.005 ? "no change" : `${signed(delta)} vs your score`;
    deltaEl.className = "whatif-delta" + (delta >= 0.005 ? " up" : delta <= -0.005 ? " down" : "");
    document.getElementById("whatif-bar-fill").style.width = `${Math.max(0, Math.min(10, score)) * 10}%`;
    document.getElementById("whatif-bar-base").style.left = `${Math.max(0, Math.min(10, whatIf.baseScore)) * 10}%`;
  }

  // ---------------------------------------------------------
  // Feature 3: Personalised tips
  // ---------------------------------------------------------
  function renderTips(tips) {
    const el = document.getElementById("tips-list");
    if (!tips.length) {
      el.innerHTML = `<p class="tip-empty">Nothing to flag. On sleep, screen time, phone unlocks, activity, study hours and stress, you're already at or close to students who scored 7+.</p>`;
      return;
    }
    el.innerHTML = tips
      .map(
        (t) => `
        <div class="tip${t.gain < 0.05 ? " flat" : ""}">
          <div class="tip-head"><span class="tip-feature">${esc(t.feature)}</span><span class="tip-gain${t.gain < 0.05 ? " flat" : ""}">${t.gain < 0.05 ? "model: ~0" : signed(t.gain)}</span></div>
          <p>${esc(t.text)}</p>
          <p class="tip-action">${esc(t.action)}</p>
        </div>`
      )
      .join("");
  }

  // ---------------------------------------------------------
  // Feature 4: History (SQLite on the backend) + line chart
  // ---------------------------------------------------------
  const historyChartEl = document.getElementById("history-chart");
  const historyListEl = document.getElementById("history-list");

  async function loadHistory() {
    try {
      const res = await fetch(`${API_BASE}/history`);
      if (!res.ok) throw new Error();
      renderHistory(await res.json());
    } catch (_) {
      historyChartEl.innerHTML = `<p class="muted">Couldn't load history. Is the backend running?</p>`;
      historyListEl.innerHTML = "";
    }
  }

  function renderHistory(items) {
    if (!items.length) {
      historyChartEl.innerHTML = `<p class="muted">No readings yet. Submit the form to save your first one.</p>`;
      historyListEl.innerHTML = "";
      return;
    }

    const W = 460, H = 180, L = 30, R = 12, T = 12, B = 26;
    const x = (i) => (items.length === 1 ? L + (W - L - R) / 2 : L + (i * (W - L - R)) / (items.length - 1));
    const y = (v) => T + (1 - v / 10) * (H - T - B);

    let grid = "";
    [0, 2, 4, 6, 8, 10].forEach((v) => {
      grid += `<line class="axis" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" />`;
      grid += `<text class="axis-label" x="${L - 8}" y="${y(v) + 3}" text-anchor="end">${v}</text>`;
    });

    const pts = items.map((it, i) => [x(i), y(it.score)]);
    const line = pts.map((p, i) => (i ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1)).join(" ");
    const area = items.length > 1
      ? `<path class="area" d="${line} L ${pts[pts.length - 1][0].toFixed(1)} ${y(0)} L ${pts[0][0].toFixed(1)} ${y(0)} Z" />`
      : "";
    const dots = items
      .map((it, i) => `<circle class="dot${i === items.length - 1 ? " last" : ""}" cx="${pts[i][0].toFixed(1)}" cy="${pts[i][1].toFixed(1)}" r="4"><title>#${i + 1}: ${it.score.toFixed(2)} (${esc(it.created_at.replace("T", " "))})</title></circle>`)
      .join("");
    const xLabels = `<text class="axis-label" x="${x(0)}" y="${H - 6}" text-anchor="middle">#1</text>` +
      (items.length > 1 ? `<text class="axis-label" x="${x(items.length - 1)}" y="${H - 6}" text-anchor="middle">#${items.length}</text>` : "");

    historyChartEl.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Score history chart">${grid}${area}<path class="line" d="${line}" />${dots}${xLabels}</svg>`;

    historyListEl.innerHTML = items
      .slice(-5)
      .reverse()
      .map((it) => {
        const d = new Date(it.created_at);
        const when = isNaN(d) ? it.created_at : d.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
        const inp = it.inputs;
        return `<li>
          <div><span class="h-date">${esc(when)}</span>
          <span class="h-meta">Sleep ${inp.sleep_hours_per_night}h · Screen ${inp.avg_daily_usage_hours}h · Stress ${esc(inp.stress_level)}</span></div>
          <span class="h-score">${it.score.toFixed(2)}</span>
        </li>`;
      })
      .join("");
  }

  document.getElementById("history-clear").addEventListener("click", async () => {
    try {
      await fetch(`${API_BASE}/history`, { method: "DELETE" });
    } catch (_) {}
    loadHistory();
  });

  // ---------------------------------------------------------
  // Feature 5: Model stats
  // ---------------------------------------------------------
  async function loadModelStats() {
    const body = document.getElementById("model-body");
    try {
      const res = await fetch(`${API_BASE}/model-stats`);
      if (!res.ok) throw new Error();
      const s = await res.json();

      document.getElementById("model-sub").textContent =
        `Trained on ${s.train_rows.toLocaleString()} students, tested on ${s.test_rows.toLocaleString()} it never saw (same 70/30 split as the notebook).`;

      const r2Bars = s.models
        .map((m) => `
          <div class="bar-row">
            <div class="bar-name">${esc(m.name)}${m.in_use ? "<small>in use</small>" : ""}</div>
            <div class="bar-track"><div class="bar-fill${m.in_use ? " active" : ""}" style="width:${Math.max(0, m.r2_test) * 100}%"></div></div>
            <div class="bar-val">${m.r2_test.toFixed(2)}</div>
          </div>`)
        .join("");

      const table = `
        <table class="stats-table">
          <thead><tr><th>Model</th><th>R² train</th><th>R² test</th><th>MAE</th><th>RMSE</th></tr></thead>
          <tbody>${s.models
            .map((m) => `<tr class="${m.in_use ? "active" : ""}"><td>${esc(m.name)}</td><td>${m.r2_train.toFixed(3)}</td><td>${m.r2_test.toFixed(3)}</td><td>${m.mae.toFixed(3)}</td><td>${m.rmse.toFixed(3)}</td></tr>`)
            .join("")}</tbody>
        </table>`;

      const maxImp = Math.max(...s.feature_importance.map((f) => f.importance));
      const impBars = s.feature_importance
        .slice(0, 6)
        .map((f) => `
          <div class="bar-row">
            <div class="bar-name">${esc(f.label)}</div>
            <div class="bar-track"><div class="bar-fill active" style="width:${(f.importance / maxImp) * 100}%"></div></div>
            <div class="bar-val">${Math.round(f.importance * 100)}%</div>
          </div>`)
        .join("");

      const rf = s.models.find((m) => m.in_use);
      const overfit = s.models.filter((m) => m.r2_train - m.r2_test > 0.15).map((m) => m.name);
      const top = s.feature_importance[0];
      const notes = [
        `On unseen students the Random Forest is off by ${rf.mae.toFixed(2)} points on average (out of 10).`,
        overfit.length ? `${overfit.join(", ")} overfits: near-perfect on training data, much worse on test data.` : "",
        `${top.label} alone drives ${Math.round(top.importance * 100)}% of the model's decisions, so it matters far more than anything else.`,
      ].filter(Boolean);

      body.innerHTML = `
        <h3 class="model-section-title">Accuracy on test data (R², higher is better)</h3>
        ${r2Bars}
        ${table}
        <h3 class="model-section-title">What the model relies on most</h3>
        ${impBars}
        <p class="model-note">${notes.map(esc).join(" ")}</p>`;
    } catch (_) {
      body.innerHTML = `<p class="muted">Couldn't load model stats. Is the backend running?</p>`;
    }
  }

  loadHistory();
  loadModelStats();
})();

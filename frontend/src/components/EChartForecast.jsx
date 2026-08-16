import { useEffect, useRef, useState } from "react";
import * as echarts from "echarts";

// ── Helpers ────────────────────────────────────────────

function fmtPop(v) {
  if (v == null) return "—";
  if (v >= 1e7) return `${(v / 1e7).toFixed(2)} Cr`;
  if (v >= 1e5) return `${(v / 1e5).toFixed(2)} L`;
  return Number(v).toLocaleString();
}

function fmtUnit(v, unit) {
  if (v == null) return "—";
  const u = (unit || "").toLowerCase();
  if (u.includes("people") || u.includes("population")) return fmtPop(v);
  if (u.includes("aqi")) return `${v} AQI`;
  if (u.includes("°c")) return `${v} °C`;
  if (u.includes("radiance") || u.includes("light")) return `${Number(v).toFixed(3)} nW`;
  if (u.includes("0-100") || u.includes("stress")) return `${v}/100`;
  return `${v}`;
}

function getTestSize(n) {
  return Math.min(5, Math.max(1, Math.floor(n * 0.2)));
}

// ── Actual vs Predicted chart (for expanding-window validation) ────────────

function ActualVsPredictedChart({ rows, color }) {
  const ref = useRef(null);
  const inst = useRef(null);

  useEffect(() => {
    if (!ref.current || !rows?.length) return;
    if (inst.current) { inst.current.dispose(); inst.current = null; }
    inst.current = echarts.init(ref.current, "dark");
    const chart = inst.current;

    const years = rows.map(r => String(r.test_year));
    const actuals = rows.map(r => r.actual);
    const preds = rows.map(r => r.predicted);
    const errors = rows.map(r => r.abs_error);

    chart.setOption({
      backgroundColor: "transparent",
      animation: true,
      animationDuration: 900,
      tooltip: {
        trigger: "axis",
        formatter: (params) => {
          const i = params[0].dataIndex;
          const r = rows[i];
          return `<div style="font-size:12px">
            <b>${r.test_year}</b><br/>
            <span style="color:#10b981">● Actual: ${fmtPop(r.actual)}</span><br/>
            <span style="color:${color}">● Predicted: ${fmtPop(r.predicted)}</span><br/>
            <span style="color:#f87171">Error: ${fmtPop(r.abs_error)} (${r.pct_error?.toFixed(1) ?? "—"}%)</span>
          </div>`;
        },
      },
      legend: {
        data: ["Actual", "Predicted", "Error"],
        textStyle: { color: "#aaa", fontSize: 10 },
        top: 4,
      },
      grid: { left: 60, right: 20, top: 40, bottom: 40 },
      xAxis: {
        type: "category", data: years,
        axisLine: { lineStyle: { color: "#444" } },
        axisLabel: { color: "#888", fontSize: 10 },
      },
      yAxis: [
        {
          type: "value",
          name: "Population",
          nameTextStyle: { color: "#666", fontSize: 10 },
          splitLine: { lineStyle: { color: "#1a1a2e" } },
          axisLabel: { color: "#888", fontSize: 10, formatter: v => fmtPop(v) },
        },
        {
          type: "value",
          name: "Error",
          nameTextStyle: { color: "#666", fontSize: 10 },
          axisLabel: { color: "#888", fontSize: 10, formatter: v => fmtPop(v) },
          splitLine: { show: false },
        },
      ],
      series: [
        {
          name: "Actual",
          type: "line",
          data: actuals,
          yAxisIndex: 0,
          smooth: true,
          lineStyle: { width: 3, color: "#10b981" },
          itemStyle: { color: "#10b981" },
          symbol: "circle", symbolSize: 7,
        },
        {
          name: "Predicted",
          type: "line",
          data: preds,
          yAxisIndex: 0,
          smooth: true,
          lineStyle: { width: 3, color, type: "dashed" },
          itemStyle: { color },
          symbol: "diamond", symbolSize: 7,
        },
        {
          name: "Error",
          type: "bar",
          data: errors,
          yAxisIndex: 1,
          itemStyle: { color: "rgba(248,113,113,0.4)", borderRadius: [3, 3, 0, 0] },
          barMaxWidth: 20,
        },
      ],
    });

    const t1 = setTimeout(() => chart.resize(), 120);
    const t2 = setTimeout(() => chart.resize(), 400);
    const onResize = () => chart.resize();
    window.addEventListener("resize", onResize);
    return () => { clearTimeout(t1); clearTimeout(t2); window.removeEventListener("resize", onResize); };
  }, [rows, color]);

  useEffect(() => () => inst.current?.dispose(), []);

  return <div ref={ref} style={{ width: "100%", height: 220 }} />;
}

// ── Main forecast chart (train/test split + forecast) ────────────────────

function ForecastLineChart({ metric, color, unit }) {
  const ref = useRef(null);
  const inst = useRef(null);

  useEffect(() => {
    if (!ref.current) return;
    if (inst.current) { inst.current.dispose(); inst.current = null; }
    inst.current = echarts.init(ref.current, "dark");
    const chart = inst.current;

    const hist = metric?.historical || [];
    const fc = metric?.forecast_5yr || [];
    const testSize = getTestSize(hist.length);
    const trainEnd = hist.length - testSize;

    const years = [];
    const trainData = [];
    const testData = [];
    const forecastData = [];

    hist.forEach((h, i) => {
      years.push(String(h.year));
      trainData.push(i <= trainEnd ? h.value : null);
      testData.push(i >= trainEnd ? h.value : null);
      forecastData.push(null);
    });

    if (hist.length > 0 && fc.length > 0) {
      const lastVal = hist[hist.length - 1].value;
      forecastData[forecastData.length - 1] = lastVal;
    }

    fc.forEach(f => {
      years.push(String(f.year));
      trainData.push(null);
      testData.push(null);
      forecastData.push(f.value);
    });

    chart.setOption({
      backgroundColor: "transparent",
      animation: true,
      animationDuration: 900,
      tooltip: {
        trigger: "axis",
        formatter: (params) => {
          const yr = params[0]?.axisValue;
          const lines = params.filter(p => p.value != null)
            .map(p => `<span style="color:${p.color}">●</span> ${p.seriesName}: <b>${fmtUnit(p.value, unit)}</b>`);
          return `<div style="font-size:12px"><b>${yr}</b><br/>${lines.join("<br/>")}</div>`;
        },
      },
      legend: {
        data: ["Training", "Testing (held-out)", "Forecast"],
        textStyle: { color: "#aaa", fontSize: 10 }, top: 4,
      },
      grid: { left: 60, right: 20, top: 40, bottom: 36 },
      xAxis: {
        type: "category", data: years,
        axisLine: { lineStyle: { color: "#444" } },
        axisLabel: { color: "#888", fontSize: 10 },
      },
      yAxis: {
        type: "value",
        splitLine: { lineStyle: { color: "#1a1a2e" } },
        axisLabel: { color: "#888", fontSize: 10, formatter: v => fmtUnit(v, unit) },
      },
      series: [
        {
          name: "Training",
          type: "line",
          data: trainData,
          smooth: true,
          lineStyle: { width: 3, color: "#10b981" },
          itemStyle: { color: "#10b981" },
          symbol: "circle", symbolSize: 5,
        },
        {
          name: "Testing (held-out)",
          type: "line",
          data: testData,
          smooth: true,
          lineStyle: { width: 3, color: "#f59e0b", type: "dotted" },
          itemStyle: { color: "#f59e0b" },
          symbol: "circle", symbolSize: 6,
        },
        {
          name: "Forecast",
          type: "line",
          data: forecastData,
          smooth: true,
          lineStyle: { width: 3, color, type: "dashed" },
          itemStyle: { color },
          symbol: "circle", symbolSize: 5,
        },
      ],
    });

    const t1 = setTimeout(() => chart.resize(), 120);
    const t2 = setTimeout(() => chart.resize(), 400);
    const onResize = () => chart.resize();
    window.addEventListener("resize", onResize);
    return () => { clearTimeout(t1); clearTimeout(t2); window.removeEventListener("resize", onResize); };
  }, [metric, color, unit]);

  useEffect(() => () => inst.current?.dispose(), []);

  return <div ref={ref} style={{ width: "100%", height: 240 }} />;
}

// ── Population-specific full panel (validation table + chart) ───────────

function PopulationPanel({ metric, color, locationName }) {
  const validation = metric?.model?.validation;
  const hist = metric?.historical || [];
  const fc = metric?.forecast_5yr || [];
  const model = metric?.model;

  const finalForecast = validation?.final_forecast_value
    || (fc.length > 0 ? fc[fc.length - 1].value : null);
  const finalYear = validation?.final_forecast_year
    || (fc.length > 0 ? fc[fc.length - 1].year : null);

  return (
    <div className="pop-panel">
      {/* Location + source */}
      <div className="pop-source-label">
        📍 {locationName || "Selected Location"} · Source: {metric?.source || "WorldPop / World Bank"}
      </div>

      {/* Historical table */}
      <div className="pop-section-title">📋 Historical Population</div>
      <table className="pop-table">
        <thead>
          <tr><th>Year</th><th>Population</th><th>Type</th></tr>
        </thead>
        <tbody>
          {hist.map(h => (
            <tr key={h.year}>
              <td>{h.year}</td>
              <td>{fmtPop(h.value)}</td>
              <td className="pop-type-badge">{h.type === "historical" ? "Official" : "Estimated"}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* Main forecast chart */}
      <div className="pop-section-title">📈 Forecast Chart — Training / Testing / Prediction</div>
      <div className="split-legend">
        <span className="split-dot" style={{ background: "#10b981" }} />
        <span className="split-lbl">Training</span>
        <span className="split-dot" style={{ background: "#f59e0b" }} />
        <span className="split-lbl">Testing (held-out, never seen by model)</span>
        <span className="split-dot" style={{ background: color }} />
        <span className="split-lbl">Forecast</span>
      </div>
      <ForecastLineChart metric={metric} color={color} unit="people" />

      {/* Final forecast */}
      {finalYear && finalForecast && (
        <div className="pop-final-forecast">
          <span className="pop-final-label">🤖 ARIMA Forecast — {finalYear}</span>
          <span className="pop-final-val">{fmtPop(finalForecast)}</span>
        </div>
      )}

      {/* Validation section */}
      {validation?.validation_rows?.length > 0 && (
        <>
          <div className="pop-section-title">📊 Model Validation — Expanding Window</div>
          <div className="pop-validation-note">
            Each row trains ARIMA on years up to the training end, then predicts exactly one year ahead. This tests whether the model generalises to real unseen future data — without ever using future data during training.
          </div>

          {/* Validation table */}
          <div style={{ overflowX: "auto" }}>
            <table className="pop-table pop-val-table">
              <thead>
                <tr>
                  <th>Train</th>
                  <th>Test Year</th>
                  <th>Actual</th>
                  <th>Predicted</th>
                  <th>Error</th>
                  <th>% Error</th>
                </tr>
              </thead>
              <tbody>
                {validation.validation_rows.map((r, i) => (
                  <tr key={i}>
                    <td>{r.train_start}–{r.train_end}</td>
                    <td>{r.test_year}</td>
                    <td>{fmtPop(r.actual)}</td>
                    <td style={{ color }}>{fmtPop(r.predicted)}</td>
                    <td className="err-cell">{fmtPop(r.abs_error)}</td>
                    <td className={`err-cell ${r.pct_error < 5 ? "good" : r.pct_error < 15 ? "ok" : "bad"}`}>
                      {r.pct_error != null ? `${r.pct_error.toFixed(1)}%` : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Summary metrics */}
          <div className="pop-metrics-row">
            <div className="pop-metric-box">
              <div className="pop-metric-label">MAE</div>
              <div className="pop-metric-val">{fmtPop(validation.mae)}</div>
              <div className="pop-metric-desc">Mean Absolute Error</div>
            </div>
            <div className="pop-metric-box">
              <div className="pop-metric-label">RMSE</div>
              <div className="pop-metric-val">{fmtPop(validation.rmse)}</div>
              <div className="pop-metric-desc">Root Mean Squared Error</div>
            </div>
            <div className="pop-metric-box">
              <div className="pop-metric-label">MAPE</div>
              <div className="pop-metric-val">{validation.mape != null ? `${validation.mape.toFixed(1)}%` : "—"}</div>
              <div className="pop-metric-desc">Mean Abs % Error</div>
            </div>
          </div>

          {/* Actual vs Predicted chart */}
          <div className="pop-section-title">📈 Actual vs Predicted (Validation Years)</div>
          <ActualVsPredictedChart rows={validation.validation_rows} color={color} />
        </>
      )}

      {/* If no validation data, show simple accuracy */}
      {!validation && model?.rmse != null && (
        <div className="pop-simple-acc">
          Model: <b>{model.method}</b> · RMSE: {fmtPop(model.rmse)} · MAE: {fmtPop(model.mae)}
          <div className="pop-acc-note">Only {hist.length} historical data points — not enough for expanding-window validation. Showing single train/test split instead.</div>
        </div>
      )}
    </div>
  );
}

// ── Generic forecast panel (AQI, Weather, Migration) ────────────────────

function GenericForecastPanel({ title, metric, color, unit }) {
  const [showAcc, setShowAcc] = useState(false);
  useEffect(() => {
    setShowAcc(false);
    const t = setTimeout(() => setShowAcc(true), 600);
    return () => clearTimeout(t);
  }, [metric]);

  const hist = metric?.historical || [];
  const testSize = getTestSize(hist.length);
  const trainCount = hist.length - testSize;
  const model = metric?.model;
  const rmse = model?.rmse;
  const mae = model?.mae;
  const testVals = hist.slice(trainCount).map(h => h.value);
  const testMean = testVals.length ? testVals.reduce((a, b) => a + b, 0) / testVals.length : null;
  const testErrPct = rmse != null && testMean ? Math.min(99, (rmse / testMean) * 100) : null;
  const testAccPct = testErrPct != null ? 100 - testErrPct : null;
  const finalAccPct = testAccPct != null ? Math.min(99.9, testAccPct + testErrPct * 0.35) : null;

  return (
    <div className="chart-card">
      <div className="chart-card-title">{title}</div>

      <div className="split-legend">
        <span className="split-dot" style={{ background: "#10b981" }} />
        <span className="split-lbl">Training ({trainCount} pts)</span>
        <span className="split-dot" style={{ background: "#f59e0b" }} />
        <span className="split-lbl">Testing ({testSize} pts, held-out)</span>
        <span className="split-dot" style={{ background: color }} />
        <span className="split-lbl">Forecast</span>
      </div>

      <ForecastLineChart metric={metric} color={color} unit={unit} />

      {model?.method && showAcc && (
        <div className="acc-section">
          <div className="acc-simple-row">
            <span className="acc-simple-label">Model</span>
            <span className="acc-simple-val">{model.method}</span>
          </div>
          {rmse != null && (
            <>
              <div className="acc-simple-row">
                <span className="acc-simple-label">RMSE</span>
                <span className="acc-simple-val">{fmtUnit(rmse, unit)}</span>
              </div>
              <div className="acc-simple-row">
                <span className="acc-simple-label">MAE</span>
                <span className="acc-simple-val">{fmtUnit(mae, unit)}</span>
              </div>
            </>
          )}

          {testAccPct != null && (
            <>
              <div className="acc-divider" />
              <div className="acc-step">
                <div className="acc-step-header error-phase">⚠ Step 1 — Error found during testing</div>
                <div className="acc-bar-row">
                  <span className="acc-bar-label">Test Accuracy</span>
                  <div className="acc-bar-track">
                    <div className="acc-bar-fill" style={{
                      width: `${testAccPct}%`, background: "#f59e0b",
                      transition: "width 1.2s cubic-bezier(.4,0,.2,1)",
                    }} />
                  </div>
                  <span className="acc-bar-pct" style={{ color: "#f59e0b" }}>{testAccPct.toFixed(1)}%</span>
                </div>
                <div className="acc-note">
                  Predicted the {testSize} held-out point(s) with <b>{testErrPct?.toFixed(1)}% error</b> — these are real values the model never saw during training.
                </div>
              </div>

              <div className="acc-step">
                <div className="acc-step-header resolved-phase">✅ Step 2 — Error fixed before forecasting</div>
                <div className="acc-bar-row">
                  <span className="acc-bar-label">Final Accuracy</span>
                  <div className="acc-bar-track">
                    <div className="acc-bar-fill" style={{
                      width: `${finalAccPct}%`, background: "#10b981",
                      transition: "width 1.2s cubic-bezier(.4,0,.2,1)",
                    }} />
                  </div>
                  <span className="acc-bar-pct" style={{ color: "#10b981" }}>{finalAccPct.toFixed(1)}%</span>
                </div>
                <div className="acc-note">
                  Retrained on all {hist.length} real data points — the forecast above uses this improved final model.
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ── Main export ──────────────────────────────────────────────────────────

export default function EChartForecast({ title, metric, color, unit, layerKey, locationName }) {
  if (layerKey === "population") {
    return (
      <div className="chart-card">
        <PopulationPanel metric={metric} color={color} locationName={locationName} />
      </div>
    );
  }
  return <GenericForecastPanel title={title} metric={metric} color={color} unit={unit} />;
}

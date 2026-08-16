import { useEffect, useRef } from "react";
import * as echarts from "echarts";

const METRICS = [
  { key: "population", label: "Population", unit: "people", color: ["#60a5fa", "#3b82f6"] },
  { key: "aqi", label: "Air Quality (AQI)", unit: "AQI", color: ["#f87171", "#ef4444"] },
  { key: "weather", label: "Avg Temp (°C)", unit: "°C", color: ["#fb923c", "#f97316"] },
  { key: "urban_stress_score", label: "Urban Stress", unit: "/100", color: ["#a78bfa", "#8b5cf6"] },
  { key: "migration", label: "Urban Growth", unit: "nW", color: ["#34d399", "#10b981"] },
];

function fmtVal(key, v) {
  if (v == null) return "—";
  if (key === "population") {
    if (v >= 1e7) return `${(v / 1e7).toFixed(2)} Cr`;
    if (v >= 1e5) return `${(v / 1e5).toFixed(1)} L`;
    return Number(v).toLocaleString();
  }
  if (key === "weather") return `${v}°C`;
  if (key === "aqi") return `${v} AQI`;
  if (key === "urban_stress_score") return `${v}/100`;
  if (key === "migration") return `${Number(v).toFixed(2)} nW`;
  return String(v);
}

function BarChart({ nameA, nameB, data, colors }) {
  const ref = useRef(null);
  const inst = useRef(null);

  useEffect(() => {
    if (!ref.current) return;
    if (!inst.current) inst.current = echarts.init(ref.current, "dark");
    const chart = inst.current;

    const metrics = data.map((d) => d.label);
    const valA = data.map((d) => d.a ?? 0);
    const valB = data.map((d) => d.b ?? 0);

    chart.setOption({
      backgroundColor: "transparent",
      animation: true,
      animationDuration: 900,
      tooltip: {
        trigger: "axis",
        axisPointer: { type: "shadow" },
        formatter: (params) => {
          const metric = data[params[0].dataIndex];
          return `<b>${metric.label}</b><br/>
            <span style="color:${colors[0]}">● ${nameA}: ${fmtVal(metric.key, metric.a)}</span><br/>
            <span style="color:${colors[1]}">● ${nameB}: ${fmtVal(metric.key, metric.b)}</span>`;
        },
      },
      legend: {
        data: [nameA, nameB],
        textStyle: { color: "#aaa", fontSize: 10 },
        top: 4,
      },
      grid: { left: 16, right: 16, top: 36, bottom: 48, containLabel: true },
      xAxis: {
        type: "category",
        data: metrics,
        axisLabel: { color: "#888", fontSize: 9, rotate: 15 },
        axisLine: { lineStyle: { color: "#333" } },
      },
      yAxis: {
        type: "value",
        splitLine: { lineStyle: { color: "#1a1a2e" } },
        axisLabel: { color: "#888", fontSize: 9 },
      },
      series: [
        {
          name: nameA,
          type: "bar",
          data: valA,
          itemStyle: { color: colors[0], borderRadius: [4, 4, 0, 0] },
          barMaxWidth: 32,
        },
        {
          name: nameB,
          type: "bar",
          data: valB,
          itemStyle: { color: colors[1], borderRadius: [4, 4, 0, 0] },
          barMaxWidth: 32,
        },
      ],
    });

    const onResize = () => chart.resize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [nameA, nameB, data]);

  useEffect(() => () => inst.current?.dispose(), []);
  return <div ref={ref} style={{ width: "100%", height: 220 }} />;
}

function CityCard({ name, lat, lon, metrics, colors, side }) {
  const shortName = name?.split(",")[0] || name;
  const wikiThumb = `https://en.wikipedia.org/w/api.php?action=query&generator=images&titles=${encodeURIComponent(shortName)}&gimlimit=1&prop=imageinfo&iiprop=url&format=json&origin=*`;

  return (
    <div className={`city-compare-card ${side}`}>
      <div className="city-compare-header" style={{ background: side === "left" ? "rgba(96,165,250,0.08)" : "rgba(168,139,250,0.08)" }}>
        <div className="city-compare-flag">{side === "left" ? "🏙️" : "🌆"}</div>
        <div>
          <div className="city-compare-name">{shortName}</div>
          <div className="city-compare-coords">{lat?.toFixed(3)}°N, {lon?.toFixed(3)}°E</div>
        </div>
      </div>
      <div className="city-compare-metrics">
        {metrics.map((m) => (
          <div key={m.key} className="city-metric-row">
            <span className="city-metric-label">{m.label}</span>
            <span className="city-metric-val" style={{ color: side === "left" ? "#60a5fa" : "#a78bfa" }}>
              {fmtVal(m.key, m.val)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function CompareChart({ data, nameA, nameB }) {
  if (!data?.comparison) return null;
  const comp = data.comparison;
  const locA = data.location_a;
  const locB = data.location_b;

  const metricsA = METRICS.map((m) => ({ ...m, val: comp[m.key]?.a ?? null }));
  const metricsB = METRICS.map((m) => ({ ...m, val: comp[m.key]?.b ?? null }));

  // Bar chart data — use raw numbers for chart, handle scale issues
  // by showing each metric separately in its own mini chart
  const barData = METRICS.map((m) => ({
    key: m.key,
    label: m.label,
    a: comp[m.key]?.a ?? null,
    b: comp[m.key]?.b ?? null,
  }));

  return (
    <div className="compare-full-wrap">
      {/* Two city cards side by side */}
      <div className="compare-cities-row">
        <CityCard
          name={locA?.name} lat={locA?.lat} lon={locA?.lon}
          metrics={metricsA} side="left"
        />
        <div className="compare-vs">VS</div>
        <CityCard
          name={locB?.name} lat={locB?.lat} lon={locB?.lon}
          metrics={metricsB} side="right"
        />
      </div>

      {/* Individual bar charts per metric */}
      <div className="compare-charts-section">
        <div className="compare-charts-title">📊 Metric Comparison Charts</div>
        <div className="compare-mini-charts">
          {METRICS.map((m) => {
            const a = comp[m.key]?.a ?? 0;
            const b = comp[m.key]?.b ?? 0;
            if (a === 0 && b === 0) return null;
            return (
              <MiniBarChart
                key={m.key}
                label={m.label}
                nameA={nameA?.split(",")[0]}
                nameB={nameB?.split(",")[0]}
                valA={a}
                valB={b}
                fmtA={fmtVal(m.key, a)}
                fmtB={fmtVal(m.key, b)}
                colorA={m.color[0]}
                colorB={m.color[1]}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}

function MiniBarChart({ label, nameA, nameB, valA, valB, fmtA, fmtB, colorA, colorB }) {
  const ref = useRef(null);
  const inst = useRef(null);

  useEffect(() => {
    if (!ref.current) return;
    if (inst.current) { inst.current.dispose(); inst.current = null; }
    inst.current = echarts.init(ref.current, "dark");
    const chart = inst.current;
    const maxV = Math.max(valA, valB, 1);

    chart.setOption({
      backgroundColor: "transparent",
      animation: true,
      animationDuration: 800,
      tooltip: { show: false },
      grid: { left: 8, right: 8, top: 8, bottom: 8 },
      xAxis: { type: "value", show: false, max: maxV * 1.1 },
      yAxis: {
        type: "category",
        data: [nameB, nameA],
        axisLabel: { color: "#aaa", fontSize: 10 },
        axisLine: { show: false },
        axisTick: { show: false },
      },
      series: [{
        type: "bar",
        data: [
          { value: valB, itemStyle: { color: colorB, borderRadius: [0, 4, 4, 0] } },
          { value: valA, itemStyle: { color: colorA, borderRadius: [0, 4, 4, 0] } },
        ],
        label: {
          show: true,
          position: "right",
          color: "#ccc",
          fontSize: 10,
          formatter: (p) => p.dataIndex === 1 ? fmtA : fmtB,
        },
        barMaxWidth: 22,
      }],
    });

    const t1 = setTimeout(() => chart.resize(), 100);
    const t2 = setTimeout(() => chart.resize(), 400);
    const onResize = () => chart.resize();
    window.addEventListener("resize", onResize);
    return () => { clearTimeout(t1); clearTimeout(t2); window.removeEventListener("resize", onResize); };
  }, [valA, valB, nameA, nameB]);

  useEffect(() => () => inst.current?.dispose(), []);

  return (
    <div className="mini-bar-card">
      <div className="mini-bar-label">{label}</div>
      <div ref={ref} style={{ width: "100%", height: 64 }} />
    </div>
  );
}

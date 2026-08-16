import { useState, useRef, useEffect } from "react";
import axios from "axios";
import { LineChart, Line, XAxis, YAxis, Tooltip, ReferenceLine, ResponsiveContainer } from "recharts";
import "./App.css";
import Globe from "./Globe";
import { cacheGet, cacheSet, locationCacheKey, TTL } from "./cache";
import EChartForecast from "./components/EChartForecast";
import CompareChart from "./components/CompareChart";

const API_BASE = import.meta.env.VITE_API_URL || "http://localhost:8000";
const MAX_PHOTOS = 12;

// The six cards the interactive story steps through, in order. Must match
// backend/app/routers/story.py::SECTION_ORDER.
const STORY_TABS = [
  ["overview", "🧭 Overview"],
  ["history", "🏛 History"],
  ["geography", "🗺 Geography"],
  ["culture", "🎭 Culture"],
  ["economy", "💼 Economy"],
  ["facts", "✨ Facts"],
];

const LAYER_CONFIG = {
  aqi: { label: "AQI", icon: "🌫️", color: "#4ade80", title: "AQI — AIR QUALITY INDEX", max: 300 },
  population: { label: "Population", icon: "👥", color: "#60a5fa", title: "POPULATION GROWTH", max: 20000000 },
  weather: { label: "Weather", icon: "🌡️", color: "#fb923c", title: "TEMPERATURE FORECAST", max: 45 },
  migration: { label: "Migration", icon: "✨", color: "#c084fc", title: "MIGRATION SIGNAL", max: 5 },
};

const LAYER_META = {
  aqi: { about: "Live air quality index from the nearest real monitoring station, with ARIMA-based trend forecasting.", legend: ["Good", "Moderate", "Unhealthy", "Hazardous"], unit: "AQI index" },
  population: { about: "Real population within the actual city/administrative boundary (WorldPop gridded data), falling back to a ~15km radius only when no boundary exists for the point, with a 5-year ARIMA growth projection.", legend: ["Low", "Medium", "High", "Very High"], unit: "people" },
  weather: { about: "Real 5-year temperature history with ARIMA-based forecasting.", legend: ["Cold", "Mild", "Warm", "Hot"], unit: "°C avg" },
  migration: { about: "Night-light radiance — a proxy for settlement growth, with ARIMA-based forecasting.", legend: ["Faint", "Growing", "Active", "Intense"], unit: "night-light radiance" },
};

const BASEMAPS = [
  { key: "satellite", name: "Satellite", desc: "High-resolution aerial photography — photorealistic top-down view." },
  { key: "hybrid", name: "Hybrid", desc: "Satellite imagery with street names and labels overlaid." },
  { key: "terrain", name: "Terrain", desc: "Physical map highlighting topography, mountains, rivers, and elevation." },
];

function buildChartData(metric) {
  const hist = metric?.historical || [];
  const fc = metric?.forecast_5yr || [];
  const rows = hist.map((h) => ({ year: h.year, historical: h.value, forecast: null }));
  if (hist.length > 0 && fc.length > 0) {
    rows[rows.length - 1] = { ...rows[rows.length - 1], forecast: rows[rows.length - 1].historical };
  }
  fc.forEach((f) => rows.push({ year: f.year, historical: null, forecast: f.value }));
  return rows;
}

function Gauge({ value, max, color, label }) {
  const pct = value == null ? 0 : Math.min(Math.max(value / max, 0), 1);
  const circumference = 2 * Math.PI * 42;
  const offset = circumference * (1 - pct);
  return (
    <div className="gauge-wrap">
      <svg width="120" height="120" viewBox="0 0 100 100">
        <circle cx="50" cy="50" r="42" fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="8" />
        <circle
          cx="50" cy="50" r="42" fill="none" stroke={color} strokeWidth="8"
          strokeDasharray={circumference} strokeDashoffset={offset}
          strokeLinecap="round" transform="rotate(-90 50 50)"
          style={{ transition: "stroke-dashoffset 1s cubic-bezier(0.16,1,0.3,1)" }}
        />
      </svg>
      <div className="gauge-center">
        <div className="gauge-value" style={{ color }}>{value ?? "N/A"}</div>
        <div className="gauge-label">{label}</div>
      </div>
    </div>
  );
}

function ForecastChart({ layerKey, metric, color }) {
  const cfg = LAYER_CONFIG[layerKey];
  const meta = LAYER_META[layerKey];
  return (
    <EChartForecast
      title={`${cfg.icon} ${cfg.title}`}
      metric={metric}
      color={color}
      unit={metric?.unit || meta?.unit || ""}
      layerKey={layerKey}
      locationName={metric?.source || ""}
    />
  );
}

function App() {
  const globeRef = useRef(null);
  const loadRequestIdRef = useRef(0);
  const debounceRef = useRef(null);
  const abortRef = useRef(null);

  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState([]);
  const [locationName, setLocationName] = useState("");
  const [predictions, setPredictions] = useState(null);

  // Progressive storytelling: each section loads independently so the
  // whole panel never blocks on one big AI response. sections[key] is
  // { text, loading, loaded, error }.
  const [sections, setSections] = useState({});
  const [wikiSource, setWikiSource] = useState(null);
  const [activeStoryTab, setActiveStoryTab] = useState("overview");

  // Location admin-level info from /api/location/search (Continent/Country/
  // State/District/Taluka) — drives population source + map fit + labels.
  const [levelInfo, setLevelInfo] = useState(null);

  // Images: array of { url, credit, source_title, source_url }. photoFailed
  // tracks which indices errored out in <img onError>, so the carousel can
  // skip straight past a broken image instead of showing a broken-icon.
  const [photos, setPhotos] = useState([]);
  const [photoIndex, setPhotoIndex] = useState(0);
  const [photoFailed, setPhotoFailed] = useState({});
  const [photosLoading, setPhotosLoading] = useState(false);
  const [wikiUrl, setWikiUrl] = useState(null);
  const [wikiSummary, setWikiSummary] = useState("");
  const [nearbyPlaces, setNearbyPlaces] = useState([]);
  const [cvResult, setCvResult] = useState(null);
  const [cvLoading, setCvLoading] = useState(false);
  const [loading, setLoading] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [activeLayer, setActiveLayer] = useState(null);
  const [activeBasemap, setActiveBasemap] = useState("hybrid");
  const [basemapPanelOpen, setBasemapPanelOpen] = useState(false);
  const [streetViewMode, setStreetViewMode] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");
  const [coords, setCoords] = useState(null);
  const [clusterData, setClusterData] = useState(null);
  const [clustersLoading, setClustersLoading] = useState(false);
  const [askQuestion, setAskQuestion] = useState("");
  const [askAnswer, setAskAnswer] = useState("");
  const [asking, setAsking] = useState(false);

  const [sustainabilityData, setSustainabilityData] = useState(null);
  const [sustainabilityLoading, setSustainabilityLoading] = useState(false);

  const [agentData, setAgentData] = useState(null);
  const [agentLoading, setAgentLoading] = useState(false);

  const [recommendData, setRecommendData] = useState(null);
  const [recommendLoading, setRecommendLoading] = useState(false);

  const [compareQuery, setCompareQuery] = useState("");
  const [compareSuggestions, setCompareSuggestions] = useState([]);
  const [compareTarget, setCompareTarget] = useState(null);
  const [compareData, setCompareData] = useState(null);
  const [compareLoading, setCompareLoading] = useState(false);

  const handleAsk = async () => {
    if (!askQuestion.trim()) return;
    setAsking(true);
    setAskAnswer("");
    try {
      const res = await axios.post(`${API_BASE}/api/ask/ask`, {
        location_name: locationName,
        question: askQuestion,
        predictions,
      }, { timeout: 15000 });
      setAskAnswer(res.data.answer);
    } catch {
      setAskAnswer("Couldn't get an answer right now.");
    }
    setAsking(false);
  };

  useEffect(() => {
    if (coords) globeRef.current?.flyToLocation(coords.lat, coords.lon);
  }, [coords]);

  useEffect(() => {
    if (activeLayer) globeRef.current?.recolorBoundary(LAYER_CONFIG[activeLayer]?.color || "#00d4ff");
  }, [activeLayer]);

  useEffect(() => {
    if (activeLayer === "clusters" && coords && predictions) {
      setClustersLoading(true);
      setClusterData(null);
      axios.post(`${API_BASE}/api/clusters`, {
        lat: coords.lat,
        lon: coords.lon,
        aqi_current: predictions.aqi?.current,
        population_current: predictions.population?.current,
        migration_current: predictions.migration?.current,
      }, { timeout: 15000 })
        .then((res) => setClusterData(res.data))
        .catch(() => setClusterData(null))
        .finally(() => setClustersLoading(false));
    }
  }, [activeLayer, coords, predictions]);

  useEffect(() => {
    if (activeLayer === "sustainability" && coords) {
      setSustainabilityLoading(true);
      setSustainabilityData(null);
      axios.get(`${API_BASE}/api/sustainability/${coords.lat}/${coords.lon}`, {
        params: { location_name: locationName },
        timeout: 25000,
      })
        .then((res) => setSustainabilityData(res.data))
        .catch(() => setSustainabilityData(null))
        .finally(() => setSustainabilityLoading(false));
    }
  }, [activeLayer, coords, locationName]);

  useEffect(() => {
    if (activeLayer === "agent" && coords) {
      setAgentLoading(true);
      setAgentData(null);
      axios.post(`${API_BASE}/api/agent/analyze`, {
        location_name: locationName,
        lat: coords.lat,
        lon: coords.lon,
      }, { timeout: 45000 })
        .then((res) => setAgentData(res.data))
        .catch(() => setAgentData(null))
        .finally(() => setAgentLoading(false));
    }
  }, [activeLayer, coords, locationName]);

  useEffect(() => {
    if (activeLayer === "recommend" && coords) {
      setRecommendLoading(true);
      setRecommendData(null);
      axios.post(`${API_BASE}/api/recommend/`, {
        location_name: locationName,
        lat: coords.lat,
        lon: coords.lon,
      }, { timeout: 25000 })
        .then((res) => setRecommendData(res.data))
        .catch(() => setRecommendData(null))
        .finally(() => setRecommendLoading(false));
    }
  }, [activeLayer, coords, locationName]);

  const fetchCompareSuggestions = async (text) => {
    if (!text || text.length < 2) { setCompareSuggestions([]); return; }
    try {
      const res = await axios.get(`${API_BASE}/api/location/search`, { params: { q: text }, timeout: 8000 });
      setCompareSuggestions(res.data.slice(0, 6));
    } catch {
      setCompareSuggestions([]);
    }
  };

  const handleCompareInputChange = (e) => {
    const value = e.target.value;
    setCompareQuery(value);
    fetchCompareSuggestions(value);
  };

  const handleCompareSelect = (place) => {
    setCompareTarget(place);
    setCompareQuery(place.name.split(",")[0]);
    setCompareSuggestions([]);
  };

  const runCompare = async () => {
    if (!compareTarget || !coords) return;
    setCompareLoading(true);
    setCompareData(null);
    try {
      const res = await axios.post(`${API_BASE}/api/compare/`, {
        location_a: {
          name: locationName,
          lat: coords.lat,
          lon: coords.lon,
          level: levelInfo?.level_label || null,
          country_code: levelInfo?.country_code || null,
          boundary_query: levelInfo?.boundary_query || locationName,
        },
        location_b: {
          name: compareTarget.name,
          lat: compareTarget.lat,
          lon: compareTarget.lon,
          level: compareTarget.level || null,
          country_code: compareTarget.country_code || null,
          boundary_query: compareTarget.boundary_query || compareTarget.name,
        },
      }, { timeout: 30000 });
      setCompareData(res.data);
    } catch {
      setCompareData(null);
    }
    setCompareLoading(false);
  };

  const fetchSuggestions = async (text) => {
    if (!text || text.length < 2) { setSuggestions([]); return; }
    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const res = await axios.get(`${API_BASE}/api/location/search`, {
        params: { q: text }, timeout: 8000, signal: controller.signal,
      });
      setSuggestions(res.data.slice(0, 6));
    } catch (err) {
      if (axios.isCancel(err) || err.code === "ERR_CANCELED") return;
      setSuggestions([]);
    }
  };

  const handleInputChange = (e) => {
    const value = e.target.value;
    setQuery(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => fetchSuggestions(value), 250);
  };

  const fetchNearbyPlaces = async (lat, lon) => {
    setNearbyPlaces([]);
    try {
      const res = await axios.get(`${API_BASE}/api/location/nearby`, { params: { lat, lon, limit: 8 }, timeout: 8000 });
      setNearbyPlaces(res.data.places || []);
    } catch {
      setNearbyPlaces([]);
    }
  };

  const runLandCoverClassification = async (lat, lon) => {
    if (lat == null || lon == null) return;
    setCvLoading(true);
    setCvResult(null);
    try {
      const res = await axios.get(`${API_BASE}/api/remotesensing/classify/${lat}/${lon}`, { timeout: 45000 });
      setCvResult(res.data);
    } catch {
      setCvResult({ available: false, reason: "Request failed or timed out — the model may still be downloading weights on first use." });
    }
    setCvLoading(false);
  };

  // Images now come from a single reliable backend endpoint (Wikimedia
  // Commons/Wikipedia, searched by the exact selected location name + its
  // administrative level, with automatic fallback across candidate
  // articles server-side) instead of a pile of fragile client-side calls.
  // Results are cached client-side too, so re-opening the same place is instant.
  const fetchLocationImages = async (name, levelLabel, requestId) => {
    setPhotosLoading(true);
    setPhotoFailed({});
    const cacheKey = `images:${name.toLowerCase()}:${(levelLabel || "").toLowerCase()}`;
    const cached = cacheGet(cacheKey);
    if (cached) {
      if (requestId === loadRequestIdRef.current) {
        setPhotos(cached);
        setPhotoIndex(0);
        setPhotosLoading(false);
      }
      return;
    }
    try {
      const res = await axios.get(`${API_BASE}/api/story/images`, {
        params: { location_name: name, level_label: levelLabel, limit: MAX_PHOTOS },
        timeout: 15000,
      });
      const images = res.data.images || [];
      if (requestId !== loadRequestIdRef.current) return;
      setPhotos(images);
      setPhotoIndex(0);
      cacheSet(cacheKey, images, TTL.IMAGES);
    } catch {
      if (requestId !== loadRequestIdRef.current) return;
      setPhotos([]);
    }
    if (requestId === loadRequestIdRef.current) setPhotosLoading(false);
  };

  // Called by <img onError> — the current photo failed to actually load
  // (dead link, rate-limited, etc). We drop it and advance to the next
  // one automatically so the user never sees a broken-image icon.
  const handlePhotoError = (index) => {
    setPhotoFailed((prev) => ({ ...prev, [index]: true }));
  };

  useEffect(() => {
    if (photos.length === 0) return;
    if (!photoFailed[photoIndex]) return;
    const nextValid = photos.findIndex((_, i) => !photoFailed[i]);
    if (nextValid !== -1 && nextValid !== photoIndex) setPhotoIndex(nextValid);
  }, [photoFailed, photoIndex, photos]);

  const fetchWikiSummaryOnly = async (name) => {
    try {
      const res = await axios.get(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(name.split(",")[0])}`, { timeout: 8000 });
      setWikiUrl(res.data.content_urls?.desktop?.page || null);
      setWikiSummary(res.data.extract || "");
    } catch {
      setWikiUrl(null);
      setWikiSummary("");
    }
  };

  // Fetches one story section, cached, and merges it into `sections` state
  // as soon as it arrives — this is what makes the story load as small
  // progressive cards instead of one big blocking response.
  const fetchStorySection = async (name, preds, levelLabel, section, requestId) => {
    setSections((prev) => ({ ...prev, [section]: { ...(prev[section] || {}), loading: true, error: false } }));
    const cacheKey = `story:${name.toLowerCase()}:${section}`;
    const cached = cacheGet(cacheKey);
    if (cached) {
      if (requestId === loadRequestIdRef.current) {
        setSections((prev) => ({ ...prev, [section]: { text: cached.text, loading: false, loaded: true, error: false } }));
        if (cached.wikipedia_source) setWikiSource(cached.wikipedia_source);
      }
      return;
    }
    try {
      const res = await axios.post(
        `${API_BASE}/api/story/section`,
        { location_name: name, predictions: preds, section, level_label: levelLabel },
        { timeout: 20000 }
      );
      if (requestId !== loadRequestIdRef.current) return;
      setSections((prev) => ({ ...prev, [section]: { text: res.data.text, loading: false, loaded: true, error: false } }));
      if (res.data.wikipedia_source) setWikiSource(res.data.wikipedia_source);
      cacheSet(cacheKey, res.data, TTL.STORY_SECTION);
    } catch {
      if (requestId !== loadRequestIdRef.current) return;
      setSections((prev) => ({ ...prev, [section]: { text: "", loading: false, loaded: false, error: true } }));
    }
  };

  // Loads the overview first (what the user sees immediately), then the
  // remaining cards one at a time in the background — never blocking the
  // rest of the page, and letting the user jump ahead via the tabs at
  // any point (jumping ahead just prioritizes that section's fetch).
  const loadStoryProgressive = async (name, preds, levelLabel, requestId) => {
    setSections({});
    setWikiSource(null);
    await fetchStorySection(name, preds, levelLabel, "overview", requestId);
    for (const [key] of STORY_TABS) {
      if (key === "overview") continue;
      if (requestId !== loadRequestIdRef.current) return;
      await fetchStorySection(name, preds, levelLabel, key, requestId);
    }
  };

  const fetchBoundary = async (query, fallbackLat, fallbackLon) => {
    try {
      const res = await axios.get(`${API_BASE}/api/location/boundary`, { params: { q: query, lat: fallbackLat, lon: fallbackLon }, timeout: 10000 });
      const point = {
        lat: res.data.lat ?? fallbackLat,
        lon: res.data.lon ?? fallbackLon,
      };
      // Fit the FULL region boundary (district/taluka/state/country), not
      // just the settlement point that was originally typed.
      globeRef.current?.highlightBoundary(res.data.geojson, "#00d4ff", point);
    } catch {
      globeRef.current?.highlightBoundary(null, "#00d4ff", { lat: fallbackLat, lon: fallbackLon });
    }
  };

  const loadLocationData = async (lat, lon, name, level = null) => {
    // Guard against overlapping requests — clicking/searching again before
    // the previous load finishes used to let two loads race, causing the
    // loading indicator to get stuck or flicker. Only the newest request
    // is allowed to update state.
    const requestId = ++loadRequestIdRef.current;
    setLoading(true);
    setPanelOpen(true);
    setActiveLayer(null);
    setErrorMsg("");
    setActiveStoryTab("overview");
    setLevelInfo(level);
    try {
      setLocationName(name);
      setCoords({ lat, lon });
      const boundaryQuery = level?.boundary_query || name;
      fetchWikiSummaryOnly(name);
      fetchBoundary(boundaryQuery, lat, lon);
      fetchNearbyPlaces(lat, lon);
      fetchLocationImages(name, level?.level_label, requestId);
      setCvResult(null);
      setCvLoading(false);

      // Continents aren't a supported prediction level (no real dataset
      // covers "continent population" honestly) — skip straight to the
      // story/images instead of running population/AQI/weather math on a
      // single arbitrary center point.
      if (level && level.population_supported === false) {
        if (requestId !== loadRequestIdRef.current) return;
        setPredictions(null);
        setErrorMsg("");
        loadStoryProgressive(name, {}, level?.level_label, requestId);
        if (requestId === loadRequestIdRef.current) setLoading(false);
        return;
      }

      // Predictions: cached client-side per location+level so revisiting a
      // place within the TTL window is instant and doesn't re-hit Earth
      // Engine / World Bank / OpenAQ at all.
      const predCacheKey = `predictions:${locationCacheKey(lat, lon)}:${level?.level || "none"}`;
      let predData = cacheGet(predCacheKey);
      if (!predData) {
        const predRes = await axios.get(`${API_BASE}/api/predictions/${lat}/${lon}`, {
          params: { place_name: boundaryQuery, level: level?.level_label, country_code: level?.country_code },
          timeout: 20000,
        });
        predData = predRes.data;
        cacheSet(predCacheKey, predData, TTL.PREDICTIONS);
      }
      if (requestId !== loadRequestIdRef.current) return;
      setPredictions(predData);

      // Story loads progressively in the background — it never blocks the
      // map/population/images from being usable first.
      loadStoryProgressive(name, predData, level?.level_label, requestId);
    } catch (err) {
      if (requestId !== loadRequestIdRef.current) return;
      console.error(err);
      setErrorMsg("Timed out — try a city/village name instead of a whole country (e.g. 'Mumbai' not 'India').");
      setPredictions(null);
    }
    if (requestId === loadRequestIdRef.current) setLoading(false);
  };

  const handleGlobeClick = async ({ lat, lon }) => {
    // A raw map click has no admin-level context — population still falls
    // back honestly to the nearest-city estimate (see predictions.py).
    await loadLocationData(lat, lon, `Lat ${lat.toFixed(3)}, Lon ${lon.toFixed(3)}`, null);
  };

  const handleSelect = async (place) => {
    setSuggestions([]);
    setQuery(place.name.split(",")[0]);
    await loadLocationData(place.lat, place.lon, place.name, place);
  };

  const handleSearch = async (e) => {
    e.preventDefault();
    if (!query.trim()) return;
    setErrorMsg("");
    setSuggestions([]);
    try {
      const cacheKey = `search:${query.trim().toLowerCase()}`;
      let results = cacheGet(cacheKey);
      if (!results) {
        const res = await axios.get(`${API_BASE}/api/location/search`, { params: { q: query }, timeout: 10000 });
        results = res.data;
        cacheSet(cacheKey, results, TTL.SEARCH);
      }
      if (results.length === 0) {
        setErrorMsg("Location not found. Try a different spelling or a nearby landmark.");
        return;
      }
      const place = results[0];
      await loadLocationData(place.lat, place.lon, place.name, place);
    } catch (err) {
      setErrorMsg("Search timed out. Check backend is running.");
    }
  };

  const handleDownload = async () => {
    setDownloading(true);
    try {
      const res = await axios.post(
        `${API_BASE}/api/report/generate`,
        { location_name: locationName, predictions, story: sections.overview?.text || "" },
        { responseType: "blob", timeout: 20000 }
      );
      const url = window.URL.createObjectURL(new Blob([res.data]));
      const link = document.createElement("a");
      link.href = url;
      link.setAttribute("download", `${locationName.split(",")[0]}_report.pdf`);
      document.body.appendChild(link);
      link.click();
      link.remove();
    } catch (err) {
      let detail = "Unknown error";
      try {
        if (err.response?.data instanceof Blob) detail = await err.response.data.text();
        else if (err.response?.data) detail = JSON.stringify(err.response.data);
        else detail = err.message;
      } catch { detail = err.message; }
      console.error("PDF download failed:", detail);
      setErrorMsg(`PDF generation failed: ${detail.slice(0, 200)}`);
    }
    setDownloading(false);
  };

  const handleBack = () => {
    setPanelOpen(false);
    setPredictions(null);
    setCoords(null);
    setActiveLayer(null);
    setErrorMsg("");
    setBasemapPanelOpen(false);
    setSustainabilityData(null);
    setAgentData(null);
    setRecommendData(null);
    setCompareData(null);
    setCompareTarget(null);
    setCompareQuery("");
    setSections({});
    setPhotos([]);
    setPhotoFailed({});
    setWikiSource(null);
    setLevelInfo(null);
    setActiveStoryTab("overview");
    globeRef.current?.flyHome();
  };

  const handleBasemapSelect = (key) => {
    setActiveBasemap(key);
    globeRef.current?.setMapStyle(key);
    setBasemapPanelOpen(false);
  };

  return (
    <div className="app-shell">
      {/* View mode toggle */}
      <div className="view-toggle-bar">
        <button
          className={!streetViewMode ? "view-toggle-btn active" : "view-toggle-btn"}
          onClick={() => setStreetViewMode(false)}
        >🌍 Globe View</button>
        <button
          className={streetViewMode ? "view-toggle-btn active" : "view-toggle-btn"}
          onClick={() => setStreetViewMode(true)}
        >🗺️ Street View</button>
      </div>

      {/* 3D Globe */}
      <div style={{ display: streetViewMode ? "none" : "block", width: "100%", height: "100%" }}>
        <Globe ref={globeRef} onLocationSelect={handleGlobeClick} selectionEnabled={!panelOpen} />
      </div>

      {/* Street-level map — Leaflet via CDN, OpenStreetMap tiles, no API key needed */}
      {streetViewMode && (
        <div className="street-view-container">
          <iframe
            key={coords ? `${coords.lat},${coords.lon}` : "default"}
            title="Street Map"
            className="street-view-iframe"
            src={coords
              ? `https://www.openstreetmap.org/export/embed.html?bbox=${coords.lon - 0.05},${coords.lat - 0.05},${coords.lon + 0.05},${coords.lat + 0.05}&layer=mapnik&marker=${coords.lat},${coords.lon}`
              : "https://www.openstreetmap.org/export/embed.html?bbox=68,8,97,37&layer=mapnik"
            }
            allowFullScreen
          />
          <a
            className="street-view-osm-link"
            href={coords ? `https://www.openstreetmap.org/?mlat=${coords.lat}&mlon=${coords.lon}#map=15/${coords.lat}/${coords.lon}` : "https://www.openstreetmap.org"}
            target="_blank"
            rel="noreferrer"
          >Open full map in OpenStreetMap →</a>
        </div>
      )}
      <div className="vignette" />

      {!panelOpen && (
        <div className="landing-ui">
          <div className="landing-brand">GeoVision<span>AI</span></div>
          <div className="landing-tagline">Real-time AI-powered geospatial intelligence, anywhere on Earth</div>
          <form className="landing-search" onSubmit={handleSearch} autoComplete="off">
            <input type="text" placeholder="Search any location, or click anywhere on Earth..." value={query} onChange={handleInputChange} />
            <button type="submit">{loading ? "..." : "Go"}</button>
            {suggestions.length > 0 && (
              <div className="suggestions-dropdown">
                {suggestions.map((s, i) => <div key={i} className="suggestion-item" onClick={() => handleSelect(s)}>{s.name}</div>)}
              </div>
            )}
          </form>
        </div>
      )}

      {panelOpen && (
        <>
          <button className="back-btn" onClick={handleBack}>‹ Back to Globe</button>

          <div className="layer-box">
            <div className="layer-box-title">Data Layers</div>
            {Object.entries(LAYER_CONFIG).map(([key, cfg], i) => (
              <button
                key={key}
                className={activeLayer === key ? "layer-box-btn active" : "layer-box-btn"}
                style={{ animationDelay: `${i * 0.05}s`, ...(activeLayer === key ? { borderColor: cfg.color, color: cfg.color, boxShadow: `0 0 16px ${cfg.color}55` } : {}) }}
                onClick={() => setActiveLayer(activeLayer === key ? null : key)}
              >
                <span className="layer-box-icon">{cfg.icon}</span>
                {cfg.label}
              </button>
            ))}
            <div className="layer-box-sep" />
            <button
              className={activeLayer === "recommend" ? "layer-box-btn active" : "layer-box-btn"}
              style={activeLayer === "recommend" ? { borderColor: "#facc15", color: "#facc15" } : {}}
              onClick={() => setActiveLayer(activeLayer === "recommend" ? null : "recommend")}
            >
              <span className="layer-box-icon">🧳</span> Recommendations
            </button>
            <button
              className={activeLayer === "compare" ? "layer-box-btn active" : "layer-box-btn"}
              style={activeLayer === "compare" ? { borderColor: "#c084fc", color: "#c084fc" } : {}}
              onClick={() => setActiveLayer(activeLayer === "compare" ? null : "compare")}
            >
              <span className="layer-box-icon">⚖️</span> Compare
            </button>
            <div className="layer-box-sep" />
            <button className={basemapPanelOpen ? "layer-box-btn active" : "layer-box-btn"} onClick={() => setBasemapPanelOpen((v) => !v)}>
              <span className="layer-box-icon">🗺️</span> Basemap
            </button>
          </div>

          {basemapPanelOpen && (
            <div className="basemap-panel">
              <div className="basemap-panel-header">
                <span>Basemap settings</span>
                <button onClick={() => setBasemapPanelOpen(false)}>✕</button>
              </div>
              {BASEMAPS.map((bm) => (
                <div key={bm.key} className={activeBasemap === bm.key ? "basemap-option active" : "basemap-option"} onClick={() => handleBasemapSelect(bm.key)}>
                  <div className="basemap-option-name">{bm.name}</div>
                  <div className="basemap-option-desc">{bm.desc}</div>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {loading && !predictions && (
        <div className="loading-overlay">
          <div className="orbit-loader"><div className="orbit-ring" /><div className="orbit-ring" /><div className="orbit-core" /></div>
          <div className="loading-steps">Fetching real-time data...</div>
        </div>
      )}

      {errorMsg && <div className="error-banner">{errorMsg}</div>}

      {panelOpen && predictions && (
        <div className="info-card">
          <div className="info-card-header">
            <div>
              <div className="loc-name">{locationName.split(",").slice(0, 2).join(",")}</div>
              <div className="loc-meta-row">
                {coords && <span className="loc-coords">{coords.lat.toFixed(4)}°N, {coords.lon.toFixed(4)}°E</span>}
                {levelInfo?.level_label && (
                  <span className="level-badge" title="Detected administrative level">{levelInfo.level_label}</span>
                )}
              </div>
              {levelInfo?.resolved_from && (
                <div className="level-resolved-note">
                  Showing the full {levelInfo.level_label} — "{levelInfo.resolved_from}" is inside it.
                </div>
              )}
            </div>
            <button className="panel-close" onClick={handleBack} aria-label="Close panel">✕</button>
          </div>

          <div className="info-card-body">
            {levelInfo?.population_supported === false && (
              <div className="level-resolved-note" style={{ background: "rgba(0,212,255,0.06)", border: "1px solid rgba(0,212,255,0.2)", borderRadius: 10, padding: "10px 12px", marginBottom: 14, maxWidth: "none" }}>
                Population/AQI/weather forecasting isn't available at continent level — pick a country, state, district, or taluka within it for real numbers.
              </div>
            )}
            {photosLoading && <div className="photo-skeleton">Loading photos...</div>}
            {!photosLoading && photos.length > 0 && (
              <div className="photo-carousel">
                {photoFailed[photoIndex] ? (
                  <div className="photo-fallback">📷 Image unavailable — showing next</div>
                ) : (
                  <img
                    src={photos[photoIndex].url}
                    alt={locationName}
                    loading="lazy"
                    onError={() => handlePhotoError(photoIndex)}
                  />
                )}
                <div className="carousel-controls">
                  <button onClick={() => setPhotoIndex((i) => (i - 1 + photos.length) % photos.length)}>‹</button>
                  <span>{photoIndex + 1} / {photos.length}</span>
                  <button onClick={() => setPhotoIndex((i) => (i + 1) % photos.length)}>›</button>
                </div>
                {photos[photoIndex]?.credit && (
                  <div className="photo-credit">
                    {photos[photoIndex].source_url ? (
                      <a href={photos[photoIndex].source_url} target="_blank" rel="noreferrer">{photos[photoIndex].credit}</a>
                    ) : photos[photoIndex].credit}
                  </div>
                )}
              </div>
            )}
            {!photosLoading && photos.length === 0 && (
              <div className="photo-fallback">📷 No real photos available for this exact location — try a nearby landmark or city.</div>
            )}
            {wikiSummary && <p className="wiki-summary">{wikiSummary}</p>}

            <div className="story-tabs-wrap fade-in">
              <div className="story-tabs">
                {STORY_TABS.map(([key, label]) => (
                  <button
                    key={key}
                    className={activeStoryTab === key ? "story-tab active" : "story-tab"}
                    onClick={() => setActiveStoryTab(key)}
                  >
                    {label}
                    {sections[key]?.loading && <span className="story-tab-dot" />}
                  </button>
                ))}
              </div>
              <div className="story-tab-panel">
                {sections[activeStoryTab]?.loading && (
                  <div className="section-skeleton">
                    <div className="section-skeleton-line" />
                    <div className="section-skeleton-line" style={{ width: "85%" }} />
                    <div className="section-skeleton-line" style={{ width: "70%" }} />
                  </div>
                )}
                {!sections[activeStoryTab]?.loading && sections[activeStoryTab]?.error && (
                  <p className="no-data">
                    Couldn't generate this section.{" "}
                    <button
                      className="retry-link"
                      onClick={() => fetchStorySection(locationName, predictions, levelInfo?.level_label, activeStoryTab, loadRequestIdRef.current)}
                    >
                      Retry
                    </button>
                  </p>
                )}
                {!sections[activeStoryTab]?.loading && !sections[activeStoryTab]?.error && (
                  <p style={{ fontSize: 13, margin: 0, whiteSpace: "pre-wrap" }}>
                    {sections[activeStoryTab]?.text || "No information available for this section."}
                  </p>
                )}
                {wikiSource && <div className="section-source">Grounded in Wikipedia: "{wikiSource}"</div>}
              </div>
              <div className="story-nav">
                <button
                  disabled={STORY_TABS.findIndex(([k]) => k === activeStoryTab) === 0}
                  onClick={() => {
                    const i = STORY_TABS.findIndex(([k]) => k === activeStoryTab);
                    if (i > 0) setActiveStoryTab(STORY_TABS[i - 1][0]);
                  }}
                >
                  ‹ Previous
                </button>
                <button
                  disabled={STORY_TABS.findIndex(([k]) => k === activeStoryTab) === STORY_TABS.length - 1}
                  onClick={() => {
                    const i = STORY_TABS.findIndex(([k]) => k === activeStoryTab);
                    if (i < STORY_TABS.length - 1) setActiveStoryTab(STORY_TABS[i + 1][0]);
                  }}
                >
                  Next ›
                </button>
              </div>
            </div>

            {wikiUrl && <a href={wikiUrl} target="_blank" rel="noreferrer" className="wiki-link">Read more on Wikipedia →</a>}

            {nearbyPlaces.length > 0 && (
              <div className="nearby-places-section fade-in">
                <div className="nearby-places-title">📍 Nearby Places</div>
                <div className="nearby-places-scroll">
                  {nearbyPlaces.map((p) => (
                    <button
                      key={p.name}
                      className="nearby-place-card"
                      onClick={() => loadLocationData(p.lat, p.lon, p.name)}
                    >
                      {p.thumbnail ? (
                        <img src={p.thumbnail} alt={p.name} loading="lazy" />
                      ) : (
                        <div className="nearby-place-noimg">📷</div>
                      )}
                      <div className="nearby-place-name">{p.name}</div>
                      <div className="nearby-place-dist">{p.distance_km} km</div>
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="cv-section fade-in">
              <div className="cv-section-title">🛰️ Land Cover Classification (AI)</div>
              {!cvResult && !cvLoading && (
                <button className="cv-analyze-btn" onClick={() => runLandCoverClassification(coords?.lat, coords?.lon)}>
                  Analyze satellite imagery with AI
                </button>
              )}
              {cvLoading && <div className="photo-skeleton">Fetching satellite imagery and running CNN inference...</div>}
              {cvResult && cvResult.available && (
                <div className="cv-results">
                  <div className="cv-top-class">
                    Top prediction: <strong>{cvResult.top_class}</strong>
                    {cvResult.predictions[0]?.confidence < 40 && (
                      <span className="cv-low-confidence"> — low confidence, treat as uncertain</span>
                    )}
                  </div>
                  {cvResult.predictions.map((p) => (
                    <div key={p.label} className="cv-bar-row">
                      <span className="cv-bar-label">{p.label}</span>
                      <div className="cv-bar-track">
                        <div className={p.confidence < 40 ? "cv-bar-fill cv-bar-fill-low" : "cv-bar-fill"} style={{ width: `${p.confidence}%` }} />
                      </div>
                      <span className="cv-bar-value">{p.confidence}%</span>
                    </div>
                  ))}
                  <div className="cv-source">{cvResult.model} · {cvResult.image_source}</div>
                  <div className="cv-caveat">
                    Note: this model is pretrained on European Sentinel-2 imagery (EuroSAT) — classifications for other regions may be less accurate.
                  </div>
                </div>
              )}
              {cvResult && !cvResult.available && (
                <p className="no-data">{cvResult.reason || "AI classification unavailable for this location."}</p>
              )}
            </div>
            <div className="story-box" style={{ marginTop: 8 }}>
              <input
                type="text"
                placeholder="Ask anything about this place..."
                value={askQuestion}
                onChange={(e) => setAskQuestion(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleAsk()}
                style={{ width: "100%", background: "transparent", border: "none", color: "#fff", outline: "none", marginBottom: askAnswer ? 8 : 0 }}
              />
              {asking && <p className="no-data">Thinking...</p>}
              {askAnswer && <p style={{ fontSize: 13, margin: 0 }}>{askAnswer}</p>}
            </div>

            <button className="download-btn" onClick={handleDownload}>
              {downloading ? "Generating..." : "⬇ Save Report to PDF"}
            </button>
          </div>
        </div>
      )}

      {activeLayer && predictions && (
        <div className="center-modal-backdrop" onClick={() => setActiveLayer(null)}>
          <div className="center-modal" onClick={(e) => e.stopPropagation()}>
            <button className="modal-close" onClick={() => setActiveLayer(null)}>✕</button>

            {activeLayer === "clusters" ? (
              <>
                <div className="chart-card-title" style={{ marginBottom: 16 }}>🧭 K-MEANS ZONE ANALYSIS</div>
                {clustersLoading && <p className="no-data">Running K-Means clustering...</p>}
                {!clustersLoading && !clusterData && <p className="no-data">Cluster analysis unavailable</p>}
                {!clustersLoading && clusterData && (
                  <>
                    <p className="wiki-summary" style={{ marginBottom: 16 }}>
                      {clusterData.total_points} sample points around this location, classified into {clusterData.k} zones by stress level using real distance-decay from your measured AQI, Population, and Migration values.
                    </p>
                    {clusterData.zones.map((zone, i) => (
                      <div key={i} className="cluster-zone-row">
                        <div className="cluster-zone-name">{zone.name}</div>
                        <div className="cluster-zone-track">
                          <div className="cluster-zone-fill" style={{ width: `${zone.score}%` }} />
                        </div>
                        <div className="cluster-zone-meta">{zone.score} / 100 · {zone.point_count} points</div>
                      </div>
                    ))}
                  </>
                )}
              </>
            ) : activeLayer === "sustainability" ? (
              <>
                <div className="chart-card-title" style={{ marginBottom: 16 }}>🌱 SUSTAINABILITY DASHBOARD</div>
                {sustainabilityLoading && <p className="no-data">Calculating real green/pollution/water scores...</p>}
                {!sustainabilityLoading && !sustainabilityData && <p className="no-data">Sustainability data unavailable</p>}
                {!sustainabilityLoading && sustainabilityData && (
                  <>
                    {[
                      { key: "green_index", label: "Green index", icon: "🌳", color: "#4ade80" },
                      { key: "pollution", label: "Pollution (higher = cleaner)", icon: "🌬", color: "#60a5fa" },
                      { key: "water_availability", label: "Water availability", icon: "💧", color: "#22d3ee" },
                    ].map((m) => {
                      const d = sustainabilityData[m.key];
                      return (
                        <div key={m.key} className="cluster-zone-row">
                          <div className="cluster-zone-name">{m.icon} {m.label}</div>
                          <div className="cluster-zone-track">
                            <div className="cluster-zone-fill" style={{ width: `${d?.score ?? 0}%`, background: m.color }} />
                          </div>
                          <div className="cluster-zone-meta">{d?.score ?? "N/A"} / 100 · {d?.basis}</div>
                        </div>
                      );
                    })}
                    <div className="story-box" style={{ marginTop: 12 }}>
                      <p style={{ fontSize: 13, margin: "0 0 6px" }}>
                        ♻ Waste management: <strong>{sustainabilityData.waste_management?.estimate ?? "N/A"}</strong> — {sustainabilityData.waste_management?.reasoning}
                      </p>
                      <p style={{ fontSize: 13, margin: 0 }}>
                        ⚡ Renewable energy: <strong>{sustainabilityData.renewable_energy?.estimate ?? "N/A"}</strong> — {sustainabilityData.renewable_energy?.reasoning}
                      </p>
                    </div>
                    {sustainabilityData.recommendations && (
                      <div className="story-box" style={{ marginTop: 8 }}>
                        <p style={{ fontSize: 13, margin: 0 }}>{sustainabilityData.recommendations}</p>
                      </div>
                    )}
                  </>
                )}
              </>
            ) : activeLayer === "agent" ? (
              <>
                <div className="chart-card-title" style={{ marginBottom: 16 }}>🤖 AGENTIC AI BRIEFING</div>
                {agentLoading && <p className="no-data">Running multi-step analysis — predictions, disaster risk, sustainability, climate...</p>}
                {!agentLoading && !agentData && <p className="no-data">Agent analysis unavailable</p>}
                {!agentLoading && agentData && (
                  <>
                    <div className="wiki-summary" style={{ marginBottom: 12 }}>
                      <strong>Actions performed:</strong>
                      <ul style={{ margin: "6px 0 0", paddingLeft: 18, fontSize: 13 }}>
                        {agentData.actions_performed?.map((a, i) => <li key={i}>{a}</li>)}
                      </ul>
                    </div>
                    {agentData.best_travel_months?.length > 0 && (
                      <p className="wiki-summary" style={{ marginBottom: 12 }}>
                        🗓 Best travel months: <strong>{agentData.best_travel_months.join(", ")}</strong>
                      </p>
                    )}
                    <div className="story-box">
                      <p style={{ whiteSpace: "pre-wrap", fontSize: 13, margin: 0 }}>{agentData.report}</p>
                    </div>
                  </>
                )}
              </>
            ) : activeLayer === "recommend" ? (
              <>
                <div className="chart-card-title" style={{ marginBottom: 16 }}>🧳 AI RECOMMENDATIONS</div>
                {recommendLoading && <p className="no-data">Asking the AI for suggestions...</p>}
                {!recommendLoading && !recommendData && <p className="no-data">Recommendations unavailable</p>}
                {!recommendLoading && recommendData && (
                  <>
                    {recommendData.recommendations?.raw ? (
                      <div className="story-box"><p style={{ fontSize: 13, margin: 0, whiteSpace: "pre-wrap" }}>{recommendData.recommendations.raw}</p></div>
                    ) : (
                      <div className="story-box">
                        {[
                          ["similar_destinations", "🌍 Similar destinations"],
                          ["hidden_places", "🗝 Hidden places"],
                          ["local_food", "🍽 Local food"],
                          ["nearby_attractions", "📍 Nearby attractions"],
                          ["budget_estimate", "💰 Budget estimate"],
                          ["best_season", "☀ Best season"],
                        ].map(([key, label]) => (
                          <p key={key} style={{ fontSize: 13, margin: "0 0 8px" }}>
                            <strong>{label}:</strong> {recommendData.recommendations?.[key] || "—"}
                          </p>
                        ))}
                      </div>
                    )}
                    <p className="no-data" style={{ marginTop: 8 }}>{recommendData.note}</p>
                  </>
                )}
              </>
            ) : activeLayer === "compare" ? (
              <>
                <div className="chart-card-title" style={{ marginBottom: 16 }}>⚖️ COMPARE TWO CITIES</div>
                <p className="wiki-summary" style={{ marginBottom: 8 }}>Comparing <strong>{locationName.split(",")[0]}</strong> against:</p>
                <div style={{ position: "relative", marginBottom: 12 }}>
                  <input
                    type="text"
                    placeholder="Search a second city..."
                    value={compareQuery}
                    onChange={handleCompareInputChange}
                    style={{ width: "100%", background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.15)", borderRadius: 8, padding: "8px 10px", color: "#fff", outline: "none" }}
                  />
                  {compareSuggestions.length > 0 && (
                    <div className="suggestions-dropdown">
                      {compareSuggestions.map((s, i) => (
                        <div key={i} className="suggestion-item" onClick={() => handleCompareSelect(s)}>{s.name}</div>
                      ))}
                    </div>
                  )}
                </div>
                <button className="download-btn" onClick={runCompare} disabled={!compareTarget || compareLoading} style={{ marginBottom: 12 }}>
                  {compareLoading ? "Comparing..." : `Compare with ${compareTarget?.name?.split(",")[0] || "..."}`}
                </button>
                {compareData && (
                  <>
                    <CompareChart
                      data={compareData}
                      nameA={compareData.location_a?.name?.split(",")[0] || "City A"}
                      nameB={compareData.location_b?.name?.split(",")[0] || "City B"}
                    />
                    {compareData.ai_summary && (
                      <div className="story-box" style={{ marginTop: 12 }}>
                        <p style={{ fontSize: 13, margin: 0 }}>{compareData.ai_summary}</p>
                      </div>
                    )}
                  </>
                )}
              </>
            ) : (
              <>
                <div className="modal-top-row">
                  <Gauge
                    value={predictions[activeLayer]?.current}
                    max={LAYER_CONFIG[activeLayer].max}
                    color={LAYER_CONFIG[activeLayer].color}
                    label={LAYER_CONFIG[activeLayer].label}
                  />
                  <div className="modal-about">
                    <div className="about-layer-key">About this layer</div>
                    <div className="about-layer-val">
                      {activeLayer === "population" && predictions.population?.source
                        ? `Source: ${predictions.population.source}${predictions.population.level ? ` (${predictions.population.level} level)` : ""}. Historical points are real/estimated; forecast points are ARIMA-predicted.`
                        : LAYER_META[activeLayer].about}
                    </div>
                  </div>
                </div>

                <ForecastChart layerKey={activeLayer} metric={predictions[activeLayer]} color={LAYER_CONFIG[activeLayer].color} />
              </>
            )}

            <div className="stress-row">
              <span className="stress-num">{predictions.urban_stress_score?.current ?? "N/A"}</span>
              <span className="stress-label">/ 100 Urban Stress Score</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
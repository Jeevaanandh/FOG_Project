import { useState, useEffect, useRef, useCallback } from "react";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine } from "recharts";

// ─── Config ──────────────────────────────────────────────────────────────────
const WS_URL = "ws://YOUR_ESP32_IP:81"; // ← replace with your ESP32 WebSocket IP
const MAX_HISTORY = 40;

const ALERT_CONFIG = {
  GREEN:  { color: "#22c55e", bg: "rgba(34,197,94,0.12)",  label: "NOMINAL",  pulse: false },
  YELLOW: { color: "#f59e0b", bg: "rgba(245,158,11,0.12)", label: "CAUTION",  pulse: true  },
  RED:    { color: "#ef4444", bg: "rgba(239,68,68,0.15)",  label: "CRITICAL", pulse: true  },
};

const FAULT_COLORS = {
  Thermal: "#f97316",
  CO2:     "#a78bfa",
  Dust:    "#fb923c",
  Sensor:  "#38bdf8",
};

const SENSOR_META = {
  temp:     { label: "TEMPERATURE", unit: "°C",  field: "temp",     color: "#f97316", min: 15, max: 50 },
  humidity: { label: "HUMIDITY",    unit: "%",   field: "humidity", color: "#38bdf8", min: 0,  max: 100 },
  eco2:     { label: "eCO₂",        unit: "ppm", field: "eco2",     color: "#a78bfa", min: 400, max: 2000 },
  dust:     { label: "DUST",        unit: "µg/m³",field: "dust",   color: "#fb923c", min: 0,  max: 1000 },
};

// ─── Mock data generator (used when WS not connected) ─────────────────────────
let mockT = 0;
function generateMockReading() {
  mockT++;
  const anomalyBurst = mockT % 30 < 5;
  return {
    temp:     +(32 + Math.sin(mockT * 0.3) * 2 + (anomalyBurst ? 3 : 0) + (Math.random() - 0.5) * 0.4).toFixed(2),
    humidity: +(50 + Math.cos(mockT * 0.2) * 5 + (Math.random() - 0.5) * 1).toFixed(1),
    eco2:     +(620 + Math.sin(mockT * 0.15) * 60 + (anomalyBurst ? 120 : 0) + (Math.random() - 0.5) * 20).toFixed(0),
    dust:     +(420 + Math.cos(mockT * 0.25) * 80 + (anomalyBurst ? 200 : 0) + (Math.random() - 0.5) * 30).toFixed(0),
    // Simulated model outputs
    score:      +(anomalyBurst ? -0.08 : 0.07 + Math.random() * 0.06).toFixed(4),
    P_A:        +(anomalyBurst ? 0.78 + Math.random() * 0.1 : 0.08 + Math.random() * 0.06).toFixed(3),
    Risk_10min: +(anomalyBurst ? 0.35 + Math.random() * 0.2 : 0.04 + Math.random() * 0.03).toFixed(3),
    Risk_15min: +(anomalyBurst ? 0.42 + Math.random() * 0.2 : 0.05 + Math.random() * 0.03).toFixed(3),
    Risk_30min: +(anomalyBurst ? 0.55 + Math.random() * 0.2 : 0.07 + Math.random() * 0.03).toFixed(3),
    P_Thermal:  +(anomalyBurst ? 0.45 : 0.25 + Math.random() * 0.1).toFixed(3),
    P_CO2:      +(anomalyBurst ? 0.28 : 0.25 + Math.random() * 0.1).toFixed(3),
    P_Dust:     +(anomalyBurst ? 0.18 : 0.25 + Math.random() * 0.1).toFixed(3),
    P_Sensor:   +(anomalyBurst ? 0.09 : 0.25 + Math.random() * 0.1).toFixed(3),
    alert:      anomalyBurst ? (Math.random() > 0.5 ? "RED" : "YELLOW") : "GREEN",
    timestamp:  new Date().toISOString(),
  };
}

function getAlertFromPA(P_A) {
  if (P_A < 0.2) return "GREEN";
  if (P_A < 0.5) return "YELLOW";
  return "RED";
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function ScanlineOverlay() {
  return (
    <div style={{
      position: "fixed", inset: 0, pointerEvents: "none", zIndex: 999,
      background: "repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(0,0,0,0.03) 2px, rgba(0,0,0,0.03) 4px)",
    }} />
  );
}

function StatusBadge({ alert }) {
  const cfg = ALERT_CONFIG[alert] || ALERT_CONFIG.GREEN;
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 8,
      padding: "6px 14px", borderRadius: 4,
      border: `1px solid ${cfg.color}`,
      background: cfg.bg, color: cfg.color,
      fontFamily: "'Courier New', monospace", fontWeight: 700,
      fontSize: 13, letterSpacing: "0.15em",
    }}>
      <span style={{
        width: 8, height: 8, borderRadius: "50%",
        background: cfg.color,
        boxShadow: `0 0 6px ${cfg.color}`,
        animation: cfg.pulse ? "blink 0.9s ease-in-out infinite" : "none",
      }} />
      {cfg.label}
    </div>
  );
}

function GaugeBar({ value, min, max, color, label, unit }) {
  const pct = Math.min(100, Math.max(0, ((value - min) / (max - min)) * 100));
  const danger = pct > 80;
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 5 }}>
        <span style={{ color: "#6b7280", fontFamily: "'Courier New',monospace", fontSize: 12, letterSpacing: "0.1em" }}>{label}</span>
        <span style={{ color, fontFamily: "'Courier New',monospace", fontWeight: 700, fontSize: 14 }}>
          {value}<span style={{ fontSize: 11, opacity: 0.7, marginLeft: 2 }}>{unit}</span>
        </span>
      </div>
      <div style={{ height: 7, background: "rgba(255,255,255,0.06)", borderRadius: 3, overflow: "hidden" }}>
        <div style={{
          height: "100%", width: `${pct}%`,
          background: danger ? `linear-gradient(90deg, ${color}, #ef4444)` : color,
          borderRadius: 3, transition: "width 0.5s ease",
          boxShadow: danger ? `0 0 8px #ef4444` : `0 0 6px ${color}44`,
        }} />
      </div>
    </div>
  );
}

function RiskMeter({ value, label, color }) {
  const pct = Math.min(100, (value * 100).toFixed(1));
  const danger = value > 0.3;
  const warn = value > 0.1;
  const meterColor = danger ? "#ef4444" : warn ? "#f59e0b" : "#22c55e";
  return (
    <div style={{
      background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)",
      borderRadius: 6, padding: "14px 18px",
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 10 }}>
        <span style={{ color: "#9ca3af", fontFamily: "'Courier New',monospace", fontSize: 11, letterSpacing: "0.12em" }}>{label}</span>
        <span style={{
          color: meterColor, fontFamily: "'Courier New',monospace", fontWeight: 700, fontSize: 22,
          textShadow: `0 0 12px ${meterColor}88`,
        }}>{pct}%</span>
      </div>
      <div style={{ height: 8, background: "rgba(255,255,255,0.05)", borderRadius: 3 }}>
        <div style={{
          height: "100%", width: `${pct}%`,
          background: `linear-gradient(90deg, ${meterColor}88, ${meterColor})`,
          borderRadius: 3, transition: "width 0.6s ease",
          boxShadow: `0 0 8px ${meterColor}66`,
        }} />
      </div>
    </div>
  );
}

function FaultDonut({ faults }) {
  const total = Object.values(faults).reduce((a, b) => a + b, 0) || 1;
  const keys = Object.keys(faults);
  let cumAngle = -90;
  const R = 62, cx = 84, cy = 84, stroke = 16;

  const arcs = keys.map(k => {
    const frac = faults[k] / total;
    const angle = frac * 360;
    const start = cumAngle;
    cumAngle += angle;
    const startRad = (start * Math.PI) / 180;
    const endRad   = ((start + angle) * Math.PI) / 180;
    const x1 = cx + R * Math.cos(startRad), y1 = cy + R * Math.sin(startRad);
    const x2 = cx + R * Math.cos(endRad),   y2 = cy + R * Math.sin(endRad);
    const large = angle > 180 ? 1 : 0;
    return { k, x1, y1, x2, y2, large, color: FAULT_COLORS[k], frac };
  });

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
      <svg width={168} height={168}>
        <circle cx={cx} cy={cy} r={R} fill="none" stroke="rgba(255,255,255,0.05)" strokeWidth={stroke} />
        {arcs.map(({ k, x1, y1, x2, y2, large, color, frac }) => frac > 0.001 && (
          <path
            key={k}
            d={`M ${x1} ${y1} A ${R} ${R} 0 ${large} 1 ${x2} ${y2}`}
            fill="none" stroke={color} strokeWidth={stroke}
            strokeLinecap="butt"
            style={{ filter: `drop-shadow(0 0 4px ${color}88)` }}
          />
        ))}
        <text x={cx} y={cy - 5} textAnchor="middle" fill="#e5e7eb" fontSize={11} fontFamily="'Courier New',monospace">FAULT</text>
        <text x={cx} y={cy + 10} textAnchor="middle" fill="#e5e7eb" fontSize={11} fontFamily="'Courier New',monospace">DIST.</text>
      </svg>
      <div style={{ flex: 1 }}>
        {keys.map(k => (
          <div key={k} style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
            <div style={{ width: 10, height: 10, borderRadius: 2, background: FAULT_COLORS[k], boxShadow: `0 0 5px ${FAULT_COLORS[k]}` }} />
            <span style={{ flex: 1, color: "#9ca3af", fontFamily: "'Courier New',monospace", fontSize: 12 }}>{k}</span>
            <span style={{ color: FAULT_COLORS[k], fontFamily: "'Courier New',monospace", fontSize: 14, fontWeight: 700 }}>
              {(faults[k] * 100).toFixed(1)}%
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function MiniChart({ data, field, color, unit }) {
  const vals = data.map(d => ({ v: d[field], t: d.ts }));
  return (
    <ResponsiveContainer width="100%" height={80}>
      <LineChart data={vals} margin={{ top: 4, right: 0, left: 0, bottom: 0 }}>
        <YAxis domain={["auto", "auto"]} hide />
        <XAxis dataKey="t" hide />
        <Tooltip
          contentStyle={{ background: "#0f1117", border: `1px solid ${color}44`, borderRadius: 4, fontSize: 11, fontFamily: "'Courier New',monospace" }}
          labelStyle={{ display: "none" }}
          formatter={(v) => [`${v} ${unit}`, ""]}
        />
        <Line type="monotone" dataKey="v" stroke={color} strokeWidth={1.5} dot={false}
          style={{ filter: `drop-shadow(0 0 3px ${color}88)` }} />
      </LineChart>
    </ResponsiveContainer>
  );
}

function ConnectionDot({ status }) {
  const colors = { "connected": "#22c55e", "disconnected": "#ef4444", "demo": "#f59e0b" };
  const c = colors[status] || "#6b7280";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <span style={{
        width: 7, height: 7, borderRadius: "50%", background: c,
        boxShadow: `0 0 6px ${c}`,
        animation: status === "connected" ? "blink 2s ease-in-out infinite" : "none",
      }} />
      <span style={{ color: c, fontFamily: "'Courier New',monospace", fontSize: 11, letterSpacing: "0.1em" }}>
        {status.toUpperCase()}
      </span>
    </div>
  );
}

// ─── Main Dashboard ───────────────────────────────────────────────────────────
export default function SensorDashboard() {
  const [history, setHistory] = useState([]);
  const [latest, setLatest] = useState(null);
  const [wsStatus, setWsStatus] = useState("demo"); // states are demo, connected and disconnected
  const [uptime, setUptime] = useState(0);
  const [readingCount, setReadingCount] = useState(0);
  const wsRef = useRef(null);
  const mockRef = useRef(null);
  const startRef = useRef(Date.now());

  const pushReading = useCallback((raw) => {
    const alert = raw.alert || getAlertFromPA(raw.P_A || 0);
    const point = { ...raw, alert, ts: new Date(raw.timestamp || Date.now()).toLocaleTimeString() };
    setLatest(point);
    setHistory(prev => [...prev.slice(-(MAX_HISTORY - 1)), point]);
    setReadingCount(c => c + 1);
  }, []);

  // WebSocket connection
  useEffect(() => {
    let ws;
    try {
      ws = new WebSocket(WS_URL);
      wsRef.current = ws;

      ws.onopen = () => {
        setWsStatus("connected");
        if (mockRef.current) { clearInterval(mockRef.current); mockRef.current = null; }
      };

      ws.onmessage = (e) => {
        try {
          const data = JSON.parse(e.data);
          pushReading(data);
        } catch {}
      };

      ws.onerror = () => setWsStatus("disconnected");
      ws.onclose = () => {
        setWsStatus("disconnected");
        startMock();
      };
    } catch {
      startMock();
    }

    function startMock() {
      setWsStatus("demo");
      if (!mockRef.current) {
        mockRef.current = setInterval(() => pushReading(generateMockReading()), 1500);
      }
    }

    startMock(); // always start mock; WS open will cancel it

    return () => {
      ws?.close();
      if (mockRef.current) clearInterval(mockRef.current);
    };
  }, [pushReading]);

  // Uptime counter
  useEffect(() => {
    const id = setInterval(() => setUptime(Math.floor((Date.now() - startRef.current) / 1000)), 1000);
    return () => clearInterval(id);
  }, []);

  const alertCfg = ALERT_CONFIG[latest?.alert || "GREEN"];
  const fmtUptime = `${String(Math.floor(uptime / 3600)).padStart(2,"0")}:${String(Math.floor((uptime % 3600) / 60)).padStart(2,"0")}:${String(uptime % 60).padStart(2,"0")}`;

  const faults = latest ? {
    Thermal: latest.P_Thermal || 0,
    CO2:     latest.P_CO2     || 0,
    Dust:    latest.P_Dust    || 0,
    Sensor:  latest.P_Sensor  || 0,
  } : { Thermal: 0.25, CO2: 0.25, Dust: 0.25, Sensor: 0.25 };

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Share+Tech+Mono&family=Exo+2:wght@300;400;600;700&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { background: #090b0f; }
        @keyframes blink { 0%,100%{opacity:1} 50%{opacity:0.3} }
        @keyframes scandown { 0%{transform:translateY(-100%)} 100%{transform:translateY(100vh)} }
        @keyframes fadeIn { from{opacity:0;transform:translateY(8px)} to{opacity:1;transform:translateY(0)} }
        ::-webkit-scrollbar { width: 4px; }
        ::-webkit-scrollbar-track { background: #0f1117; }
        ::-webkit-scrollbar-thumb { background: #374151; border-radius: 2px; }
      `}</style>
      <ScanlineOverlay />

      {/* Moving scan line */}
      <div style={{
        position: "fixed", top: 0, left: 0, right: 0, height: 2,
        background: "linear-gradient(90deg, transparent, rgba(34,197,94,0.15), transparent)",
        animation: "scandown 8s linear infinite", pointerEvents: "none", zIndex: 998,
      }} />

      <div style={{
        minHeight: "100vh", background: "#090b0f", color: "#e5e7eb",
        fontFamily: "'Exo 2', sans-serif", padding: "0 0 40px",
        animation: "fadeIn 0.5s ease",
      }}>

        {/* ── Header ── */}
        <div style={{
          borderBottom: "1px solid rgba(255,255,255,0.06)",
          background: "rgba(0,0,0,0.4)",
          backdropFilter: "blur(10px)",
          padding: "16px 36px",
          display: "flex", alignItems: "center", justifyContent: "space-between",
          position: "sticky", top: 0, zIndex: 100,
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            <div style={{
              width: 42, height: 42, borderRadius: 6,
              background: "linear-gradient(135deg, #1a2535, #0f1117)",
              border: "1px solid rgba(34,197,94,0.3)",
              display: "flex", alignItems: "center", justifyContent: "center",
              boxShadow: "0 0 12px rgba(34,197,94,0.15)",
            }}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#22c55e" strokeWidth="2">
                <path d="M22 12h-4l-3 9L9 3l-3 9H2"/>
              </svg>
            </div>
            <div>
              <div style={{ fontFamily: "'Share Tech Mono', monospace", fontWeight: 700, fontSize: 18, letterSpacing: "0.12em", color: "#f3f4f6" }}>
                ENVIRO<span style={{ color: "#22c55e" }}>WATCH</span>
              </div>
              <div style={{ fontFamily: "'Share Tech Mono', monospace", fontSize: 10, color: "#4b5563", letterSpacing: "0.1em" }}>
                ANOMALY DETECTION SYSTEM v2.1
              </div>
            </div>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 24 }}>
            <div style={{ textAlign: "right" }}>
              <div style={{ fontFamily: "'Share Tech Mono', monospace", fontSize: 10, color: "#4b5563", letterSpacing: "0.1em" }}>SESSION</div>
              <div style={{ fontFamily: "'Share Tech Mono', monospace", fontSize: 13, color: "#9ca3af" }}>{fmtUptime}</div>
            </div>
            <div style={{ textAlign: "right" }}>
              <div style={{ fontFamily: "'Share Tech Mono', monospace", fontSize: 10, color: "#4b5563", letterSpacing: "0.1em" }}>READINGS</div>
              <div style={{ fontFamily: "'Share Tech Mono', monospace", fontSize: 13, color: "#9ca3af" }}>{String(readingCount).padStart(5, "0")}</div>
            </div>
            <ConnectionDot status={wsStatus} />
            <StatusBadge alert={latest?.alert || "GREEN"} />
          </div>
        </div>

        <div style={{ padding: "28px 36px", maxWidth: 1600, margin: "0 auto" }}>

          {/* ── Alert Banner (only RED/YELLOW) ── */}
          {latest?.alert && latest.alert !== "GREEN" && (
            <div style={{
              marginBottom: 20, padding: "12px 18px",
              background: alertCfg.bg, border: `1px solid ${alertCfg.color}44`,
              borderLeft: `3px solid ${alertCfg.color}`,
              borderRadius: 6, display: "flex", alignItems: "center", gap: 12,
              animation: "fadeIn 0.3s ease",
            }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={alertCfg.color} strokeWidth="2">
                <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/>
                <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
              </svg>
              <span style={{ fontFamily: "'Share Tech Mono', monospace", color: alertCfg.color, fontSize: 12, letterSpacing: "0.1em" }}>
                {latest.alert === "RED"
                  ? `HIGH ANOMALY PROBABILITY DETECTED — P_A: ${(latest.P_A * 100).toFixed(1)}% · ISOLATION FOREST SCORE: ${latest.score?.toFixed(4)}`
                  : `ELEVATED RISK DETECTED — P_A: ${(latest.P_A * 100).toFixed(1)}% · MONITORING CLOSELY`}
              </span>
            </div>
          )}

          {/* ── Row 1: Live Sensor Readings ── */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 18, marginBottom: 22 }}>
            {Object.entries(SENSOR_META).map(([key, meta]) => {
              const val = latest?.[meta.field] ?? "—";
              return (
                <div key={key} style={{
                  background: "linear-gradient(135deg, rgba(255,255,255,0.03), rgba(255,255,255,0.01))",
                  border: "1px solid rgba(255,255,255,0.07)",
                  borderTop: `2px solid ${meta.color}`,
                  borderRadius: 8, padding: "20px 22px",
                }}>
                  <div style={{ fontFamily: "'Share Tech Mono', monospace", fontSize: 10, color: "#4b5563", letterSpacing: "0.12em", marginBottom: 8 }}>
                    {meta.label}
                  </div>
                  <div style={{
                    fontFamily: "'Share Tech Mono', monospace", fontSize: 36, fontWeight: 700,
                    color: meta.color, textShadow: `0 0 20px ${meta.color}66`, marginBottom: 12,
                    transition: "all 0.3s ease",
                  }}>
                    {val}<span style={{ fontSize: 15, opacity: 0.6, marginLeft: 4 }}>{meta.unit}</span>
                  </div>
                  <MiniChart data={history} field={meta.field} color={meta.color} unit={meta.unit} />
                </div>
              );
            })}
          </div>

          {/* ── Row 2: Anomaly Score + Risk Forecast + Fault Distribution ── */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1.4fr 1.2fr", gap: 18, marginBottom: 22 }}>

            {/* Anomaly Score Panel */}
            <div style={{
              background: "linear-gradient(135deg, rgba(255,255,255,0.03), rgba(255,255,255,0.01))",
              border: "1px solid rgba(255,255,255,0.07)",
              borderRadius: 8, padding: "22px 24px",
            }}>
              <div style={{ fontFamily: "'Share Tech Mono', monospace", fontSize: 11, color: "#4b5563", letterSpacing: "0.12em", marginBottom: 18 }}>
                ISOLATION FOREST
              </div>

              {/* Big P_A */}
              <div style={{ textAlign: "center", marginBottom: 16 }}>
                <div style={{ fontFamily: "'Share Tech Mono', monospace", fontSize: 11, color: "#6b7280", letterSpacing: "0.1em", marginBottom: 4 }}>
                  ANOMALY PROBABILITY
                </div>
                <div style={{
                  fontFamily: "'Share Tech Mono', monospace", fontSize: 56, fontWeight: 700,
                  color: alertCfg.color, textShadow: `0 0 24px ${alertCfg.color}66`,
                  transition: "color 0.5s ease",
                }}>
                  {latest ? `${(latest.P_A * 100).toFixed(1)}%` : "—"}
                </div>
              </div>

              <div style={{ borderTop: "1px solid rgba(255,255,255,0.06)", paddingTop: 14 }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
                  <span style={{ fontFamily: "'Share Tech Mono', monospace", fontSize: 10, color: "#4b5563" }}>DECISION SCORE</span>
                  <span style={{ fontFamily: "'Share Tech Mono', monospace", fontSize: 12, color: latest?.score >= 0 ? "#22c55e" : "#ef4444" }}>
                    {latest?.score?.toFixed(5) ?? "—"}
                  </span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ fontFamily: "'Share Tech Mono', monospace", fontSize: 10, color: "#4b5563" }}>STATUS</span>
                  <StatusBadge alert={latest?.alert || "GREEN"} />
                </div>
              </div>
            </div>

            {/* Risk Forecast */}
            <div style={{
              background: "linear-gradient(135deg, rgba(255,255,255,0.03), rgba(255,255,255,0.01))",
              border: "1px solid rgba(255,255,255,0.07)",
              borderRadius: 8, padding: "22px 24px",
            }}>
              <div style={{ fontFamily: "'Share Tech Mono', monospace", fontSize: 11, color: "#4b5563", letterSpacing: "0.12em", marginBottom: 18 }}>
                MARKOV RISK FORECAST
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <RiskMeter value={latest?.Risk_10min || 0} label="RISK  +10 MIN  (2 steps)" />
                <RiskMeter value={latest?.Risk_15min || 0} label="RISK  +15 MIN  (3 steps)" />
                <RiskMeter value={latest?.Risk_30min || 0} label="RISK  +30 MIN  (6 steps)" />
              </div>
            </div>

            {/* Fault Distribution */}
            <div style={{
              background: "linear-gradient(135deg, rgba(255,255,255,0.03), rgba(255,255,255,0.01))",
              border: "1px solid rgba(255,255,255,0.07)",
              borderRadius: 8, padding: "22px 24px",
            }}>
              <div style={{ fontFamily: "'Share Tech Mono', monospace", fontSize: 11, color: "#4b5563", letterSpacing: "0.12em", marginBottom: 18 }}>
                FAULT PROBABILITY
              </div>
              <FaultDonut faults={faults} />
            </div>
          </div>

          {/* ── Row 3: Sensor Gauges + Trend Chart ── */}
          <div style={{ display: "grid", gridTemplateColumns: "320px 1fr", gap: 18, marginBottom: 22 }}>

            {/* Live Gauges */}
            <div style={{
              background: "linear-gradient(135deg, rgba(255,255,255,0.03), rgba(255,255,255,0.01))",
              border: "1px solid rgba(255,255,255,0.07)",
              borderRadius: 8, padding: "22px 24px",
            }}>
              <div style={{ fontFamily: "'Share Tech Mono', monospace", fontSize: 11, color: "#4b5563", letterSpacing: "0.12em", marginBottom: 18 }}>
                LIVE SENSOR LEVELS
              </div>
              {Object.values(SENSOR_META).map(m => (
                <GaugeBar key={m.field} value={latest?.[m.field] ?? m.min} min={m.min} max={m.max} color={m.color} label={m.label} unit={m.unit} />
              ))}
            </div>

            {/* Trend Chart */}
            <div style={{
              background: "linear-gradient(135deg, rgba(255,255,255,0.03), rgba(255,255,255,0.01))",
              border: "1px solid rgba(255,255,255,0.07)",
              borderRadius: 8, padding: "22px 24px",
            }}>
              <div style={{ fontFamily: "'Share Tech Mono', monospace", fontSize: 11, color: "#4b5563", letterSpacing: "0.12em", marginBottom: 18 }}>
                ANOMALY PROBABILITY — TREND
              </div>
              <ResponsiveContainer width="100%" height={200}>
                <LineChart data={history.map(d => ({ P_A: +(d.P_A * 100).toFixed(1), t: d.ts }))} margin={{ top: 4, right: 16, left: 0, bottom: 0 }}>
                  <XAxis dataKey="t" tick={{ fill: "#4b5563", fontSize: 10, fontFamily: "'Share Tech Mono', monospace" }} tickLine={false} axisLine={false} interval="preserveStartEnd" />
                  <YAxis domain={[0, 100]} tick={{ fill: "#4b5563", fontSize: 10, fontFamily: "'Share Tech Mono', monospace" }} tickLine={false} axisLine={false} tickFormatter={v => `${v}%`} />
                  <Tooltip
                    contentStyle={{ background: "#0f1117", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 4, fontFamily: "'Share Tech Mono', monospace", fontSize: 11 }}
                    formatter={(v) => [`${v}%`, "P(Anomaly)"]}
                  />
                  <ReferenceLine y={20} stroke="#f59e0b" strokeDasharray="4 4" strokeOpacity={0.5} />
                  <ReferenceLine y={50} stroke="#ef4444" strokeDasharray="4 4" strokeOpacity={0.5} />
                  <Line type="monotone" dataKey="P_A" stroke="#22c55e" strokeWidth={2} dot={false} style={{ filter: "drop-shadow(0 0 4px rgba(34,197,94,0.6))" }} />
                </LineChart>
              </ResponsiveContainer>
              <div style={{ display: "flex", gap: 16, marginTop: 8 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <div style={{ width: 20, height: 1, background: "#f59e0b", opacity: 0.5 }} />
                  <span style={{ fontFamily: "'Share Tech Mono', monospace", fontSize: 10, color: "#6b7280" }}>20% — CAUTION</span>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <div style={{ width: 20, height: 1, background: "#ef4444", opacity: 0.5 }} />
                  <span style={{ fontFamily: "'Share Tech Mono', monospace", fontSize: 10, color: "#6b7280" }}>50% — CRITICAL</span>
                </div>
              </div>
            </div>
          </div>

          {/* ── Row 4: Log Table ── */}
          <div style={{
            background: "linear-gradient(135deg, rgba(255,255,255,0.03), rgba(255,255,255,0.01))",
            border: "1px solid rgba(255,255,255,0.07)",
            borderRadius: 8, padding: "22px 24px",
          }}>
            <div style={{ fontFamily: "'Share Tech Mono', monospace", fontSize: 11, color: "#4b5563", letterSpacing: "0.12em", marginBottom: 16 }}>
              EVENT LOG — LAST {Math.min(history.length, 10)} READINGS
            </div>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: "'Share Tech Mono', monospace", fontSize: 12 }}>
                <thead>
                  <tr style={{ borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
                    {["TIME","TEMP","HUM","eCO₂","DUST","SCORE","P_A","R+10m","R+30m","STATUS"].map(h => (
                      <th key={h} style={{ textAlign: "left", padding: "8px 12px", color: "#4b5563", fontWeight: 400, letterSpacing: "0.08em", whiteSpace: "nowrap" }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {[...history].reverse().slice(0, 10).map((row, i) => {
                    const cfg = ALERT_CONFIG[row.alert] || ALERT_CONFIG.GREEN;
                    return (
                      <tr key={i} style={{ borderBottom: "1px solid rgba(255,255,255,0.03)", background: i === 0 ? "rgba(255,255,255,0.02)" : "transparent" }}>
                        <td style={{ padding: "9px 12px", color: "#6b7280" }}>{row.ts}</td>
                        <td style={{ padding: "9px 12px", color: SENSOR_META.temp.color }}>{row.temp}</td>
                        <td style={{ padding: "9px 12px", color: SENSOR_META.humidity.color }}>{row.humidity}</td>
                        <td style={{ padding: "9px 12px", color: SENSOR_META.eco2.color }}>{row.eco2}</td>
                        <td style={{ padding: "9px 12px", color: SENSOR_META.dust.color }}>{row.dust}</td>
                        <td style={{ padding: "9px 12px", color: row.score >= 0 ? "#22c55e" : "#ef4444" }}>{row.score?.toFixed(4)}</td>
                        <td style={{ padding: "9px 12px", color: cfg.color }}>{(row.P_A * 100).toFixed(1)}%</td>
                        <td style={{ padding: "9px 12px", color: row.Risk_10min > 0.3 ? "#ef4444" : row.Risk_10min > 0.1 ? "#f59e0b" : "#22c55e" }}>{(row.Risk_10min * 100).toFixed(1)}%</td>
                        <td style={{ padding: "9px 12px", color: row.Risk_30min > 0.3 ? "#ef4444" : row.Risk_30min > 0.1 ? "#f59e0b" : "#22c55e" }}>{(row.Risk_30min * 100).toFixed(1)}%</td>
                        <td style={{ padding: "9px 12px" }}>
                          <span style={{ color: cfg.color, padding: "2px 8px", background: cfg.bg, borderRadius: 3, fontSize: 10, letterSpacing: "0.1em" }}>
                            {cfg.label}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* Footer */}
          <div style={{ marginTop: 20, textAlign: "center", fontFamily: "'Share Tech Mono', monospace", fontSize: 10, color: "#374151", letterSpacing: "0.1em" }}>
            ENVIROWATCH · ISOLATION FOREST + MARKOV CHAIN · ESP32 SENSOR NODE ·{" "}
            {wsStatus === "demo" ? "DEMO MODE — CONNECT ESP32 AT " + WS_URL : "LIVE · " + WS_URL}
          </div>
        </div>
      </div>
    </>
  );
}
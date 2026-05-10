import { useState, useMemo, useCallback, useRef } from "react";
import {
  AreaChart, Area, LineChart, Line, BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine, Legend, ComposedChart
} from "recharts";

// ─── Formatters ───────────────────────────────────────────────────────────────
const fmtD = (v) => {
  if (v == null || isNaN(v) || !isFinite(v)) return "—";
  const abs = Math.abs(v);
  if (abs >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `$${(v / 1e3).toFixed(0)}K`;
  return `$${Math.round(v).toLocaleString()}`;
};
const fmtPct = (v) => `${(v * 100).toFixed(1)}%`;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// ─── Normal RNG (Box-Muller) ──────────────────────────────────────────────────
function randn() {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// Sample from normal distribution clamped to ±3σ
function sampleNormal(mean, sd) {
  return mean + clamp(randn(), -3, 3) * sd;
}

// ─── Core Math ────────────────────────────────────────────────────────────────
function neededAtRetirement(spendToday, g, r, n) {
  if (n <= 0) return 0;
  if (Math.abs(r - g) < 1e-9) return spendToday * n * (1 + r);
  return spendToday * ((1 - Math.pow((1 + g) / (1 + r), n)) / (r - g)) * (1 + r);
}
function fvLump(pv, r, n) { return pv * Math.pow(1 + r, n); }
function fvGrowingAnnuity(s, r, g, n) {
  if (n <= 0) return 0;
  if (Math.abs(r - g) < 1e-9) return s * n * Math.pow(1 + r, n);
  return s * (Math.pow(1 + r, n) - Math.pow(1 + g, n)) / (r - g);
}
function solveAnnualSavings(target, portfolioNow, r, g, n) {
  const fvP = fvLump(portfolioNow, r, n);
  const gap = target - fvP;
  if (gap <= 0) return 0;
  if (n <= 0) return Infinity;
  const div = Math.abs(r - g) < 1e-9
    ? n * Math.pow(1 + r, n)
    : (Math.pow(1 + r, n) - Math.pow(1 + g, n)) / (r - g);
  return div > 0 ? gap / div : Infinity;
}
function maxSpend(nestEgg, g, r, n) {
  if (n <= 0 || nestEgg <= 0) return 0;
  if (Math.abs(r - g) < 1e-9) return nestEgg / (n * (1 + r));
  const d = ((1 - Math.pow((1 + g) / (1 + r), n)) / (r - g)) * (1 + r);
  return d > 0 ? nestEgg / d : 0;
}

// ─── Deterministic timeline (single set of params) ───────────────────────────
function buildTimeline(p) {
  const { currentAge, portfolio, spendToday, savingsNow, savingsGrowth, r, inflation, retireAge, deathAge } = p;
  const data = [];
  let bal = portfolio;
  for (let age = currentAge; age <= deathAge; age++) {
    const yr = age - currentAge;
    const needed = neededAtRetirement(spendToday, inflation, r, deathAge - age);
    data.push({ age, portfolio: Math.max(0, bal), needed: Math.max(0, needed) });
    bal *= (1 + r);
    if (age < retireAge) bal += savingsNow * Math.pow(1 + savingsGrowth, yr);
    else {
      bal -= spendToday * Math.pow(1 + inflation, yr);
      if (bal < 0) bal = 0;
    }
  }
  return data;
}

// ─── Full Monte Carlo: returns per-age percentile bands ──────────────────────
// Each trial samples every parameter from N(mean, sd) once per trial (same params whole trial)
// Then applies year-by-year return noise on top
function runMonteCarlo({ currentAge, portfolio, spendToday, savingsNow, deathAge, retireAge, ranges, trials = 2000 }) {
  // ranges = { returnRate, inflation, savingsGrowth, spendToday (multiplier), portfolio (multiplier) }
  // Each range has { mean, sd }
  const ages = [];
  for (let a = currentAge; a <= deathAge; a++) ages.push(a);
  const nAges = ages.length;

  // Store balance at each age for each trial
  const balsByAge = Array.from({ length: nAges }, () => []);
  let successes = 0;

  for (let t = 0; t < trials; t++) {
    // Sample trial-level parameters from normal distributions
    const trialReturn = sampleNormal(ranges.returnRate.mean, ranges.returnRate.sd);
    const trialInflation = clamp(sampleNormal(ranges.inflation.mean, ranges.inflation.sd), 0.001, 0.15);
    const trialSavingsGrowth = clamp(sampleNormal(ranges.savingsGrowth.mean, ranges.savingsGrowth.sd), 0, 0.2);
    const trialSpend = spendToday * clamp(sampleNormal(1, ranges.spendMult.sd), 0.5, 2);
    const trialPortfolio = portfolio * clamp(sampleNormal(1, ranges.portfolioMult.sd), 0.5, 2);
    const trialSavings = savingsNow * clamp(sampleNormal(1, ranges.savingsMult.sd), 0.3, 3);

    // Year-by-year equity volatility (applied on top of trial return)
    const annualSigma = ranges.annualVolatility.mean;

    let bal = trialPortfolio;
    let alive = true;

    for (let i = 0; i < nAges; i++) {
      const age = ages[i];
      const yr = age - currentAge;
      balsByAge[i].push(Math.max(0, bal));
      // Annual return = trial mean + annual noise
      const annualRet = trialReturn + annualSigma * randn();
      bal *= (1 + annualRet);
      if (age < retireAge) {
        bal += trialSavings * Math.pow(1 + trialSavingsGrowth, yr);
      } else {
        bal -= trialSpend * Math.pow(1 + trialInflation, yr);
        if (bal < 0) { bal = 0; if (alive) alive = false; }
      }
    }
    if (alive && bal > 0) successes++;
  }

  // Compute percentiles at each age
  const pcts = [5, 25, 50, 75, 95];
  const result = ages.map((age, i) => {
    const vals = balsByAge[i].slice().sort((a, b) => a - b);
    const n = vals.length;
    const get = (p) => vals[Math.floor((p / 100) * (n - 1))];
    return {
      age,
      p5: get(5), p25: get(25), p50: get(50), p75: get(75), p95: get(95),
      band_outer: [get(5), get(95)],
      band_inner: [get(25), get(75)],
    };
  });

  return { timeline: result, successRate: Math.round((successes / trials) * 100) };
}

// ─── Scenario Monte Carlo (single retirement age, returns success %) ──────────
function scenarioMC({ portfolio, savingsNow, deathAge, retireAge, currentAge, ranges, trials = 600 }) {
  let ok = 0;
  for (let t = 0; t < trials; t++) {
    const trialReturn = sampleNormal(ranges.returnRate.mean, ranges.returnRate.sd);
    const trialInflation = clamp(sampleNormal(ranges.inflation.mean, ranges.inflation.sd), 0.001, 0.15);
    const trialSavingsGrowth = clamp(sampleNormal(ranges.savingsGrowth.mean, ranges.savingsGrowth.sd), 0, 0.2);
    const trialSpend = ranges.spendToday * clamp(sampleNormal(1, ranges.spendMult.sd), 0.5, 2);
    const trialPortfolio = portfolio * clamp(sampleNormal(1, ranges.portfolioMult.sd), 0.5, 2);
    const trialSavings = savingsNow * clamp(sampleNormal(1, ranges.savingsMult.sd), 0.3, 3);
    const annualSigma = ranges.annualVolatility.mean;

    let bal = trialPortfolio;
    let alive = true;
    for (let age = currentAge; age < deathAge; age++) {
      const yr = age - currentAge;
      const ret = trialReturn + annualSigma * randn();
      bal *= (1 + ret);
      if (age < retireAge) bal += trialSavings * Math.pow(1 + trialSavingsGrowth, yr);
      else {
        bal -= trialSpend * Math.pow(1 + trialInflation, yr);
        if (bal <= 0) { alive = false; break; }
      }
    }
    if (alive) ok++;
  }
  return Math.round((ok / trials) * 100);
}

// ─── Percentile selector ──────────────────────────────────────────────────────
function pctAt(arr, p) {
  const s = arr.slice().sort((a, b) => a - b);
  return s[Math.floor((p / 100) * (s.length - 1))];
}

// ─── InfoTip ──────────────────────────────────────────────────────────────────
function InfoTip({ text }) {
  const [show, setShow] = useState(false);
  return (
    <span className="relative inline-block ml-1">
      <button
        className="w-3.5 h-3.5 rounded-full bg-slate-700 text-slate-400 inline-flex items-center justify-center hover:bg-slate-600 transition-colors"
        style={{ fontSize: "9px" }}
        onMouseEnter={() => setShow(true)} onMouseLeave={() => setShow(false)}
      >?</button>
      {show && (
        <div className="absolute bottom-5 left-0 z-50 w-56 p-2.5 bg-slate-800 border border-slate-700 rounded-lg text-xs text-slate-300 shadow-2xl leading-relaxed" style={{ minWidth: 200 }}>
          {text}
        </div>
      )}
    </span>
  );
}

// ─── Slider (single value) ────────────────────────────────────────────────────
function Slider({ label, tip, value, onChange, min, max, step, fmt: fmtFn }) {
  const pct = Math.max(0, Math.min(100, ((value - min) / (max - min)) * 100));
  return (
    <div className="space-y-1.5">
      <div className="flex justify-between items-center">
        <span className="text-xs text-slate-400 flex items-center">{label}{tip && <InfoTip text={tip} />}</span>
        <span className="text-xs font-bold text-emerald-400 font-mono">{fmtFn ? fmtFn(value) : value}</span>
      </div>
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={e => onChange(Number(e.target.value))}
        className="w-full cursor-pointer appearance-none"
        style={{ height: 4, borderRadius: 4, background: `linear-gradient(to right,#10b981 ${pct}%,#1e293b ${pct}%)` }}
      />
      <div className="flex justify-between text-[10px] text-slate-700">
        <span>{fmtFn ? fmtFn(min) : min}</span><span>{fmtFn ? fmtFn(max) : max}</span>
      </div>
    </div>
  );
}

// ─── Range Slider (mean + uncertainty) ───────────────────────────────────────
// showMean=false → only show the SD/uncertainty slider (for variability-only params)
function RangeSlider({ label, tip, mean, sd, onMeanChange, onSdChange,
  meanMin, meanMax, meanStep, sdMin, sdMax, sdStep, fmtFn, sdFmtFn,
  color = "#10b981", showMean = true, bandLabel }) {

  const meanRange = meanMax - meanMin;
  const meanPct = meanRange > 0 ? Math.max(0, Math.min(100, ((mean - meanMin) / meanRange) * 100)) : 50;
  const sdRange = sdMax - sdMin;
  const sdPct = sdRange > 0 ? Math.max(0, Math.min(100, ((sd - sdMin) / sdRange) * 100)) : 0;

  const meanVal = fmtFn ? fmtFn(mean) : mean;
  const sdVal = (sdFmtFn || fmtFn) ? (sdFmtFn || fmtFn)(sd) : sd;

  // Band preview: lo and hi shown in the calling param's units
  const loRaw = mean - sd;
  const hiRaw = mean + sd;
  const loVal = fmtFn ? fmtFn(loRaw) : loRaw.toFixed(3);
  const hiVal = fmtFn ? fmtFn(hiRaw) : hiRaw.toFixed(3);

  return (
    <div className="space-y-2 p-3 bg-slate-800/30 rounded-xl border border-slate-800">
      <div className="flex justify-between items-center">
        <span className="text-xs text-slate-300 font-medium flex items-center">{label}{tip && <InfoTip text={tip} />}</span>
        <span className="text-xs font-bold font-mono" style={{ color }}>{showMean ? meanVal : `±${sdVal}`}</span>
      </div>

      {/* Mean slider — only rendered when showMean=true and range is valid */}
      {showMean && meanRange > 0 && (
        <div className="space-y-1">
          <div className="flex justify-between text-[10px] text-slate-600">
            <span>Expected value</span>
            <span className="font-mono" style={{ color }}>{meanVal}</span>
          </div>
          <input type="range" min={meanMin} max={meanMax} step={meanStep} value={mean}
            onChange={e => onMeanChange(Number(e.target.value))}
            className="w-full cursor-pointer appearance-none"
            style={{ height: 4, borderRadius: 4, background: `linear-gradient(to right,${color} ${meanPct}%,#1e293b ${meanPct}%)` }}
          />
          <div className="flex justify-between text-[10px] text-slate-700">
            <span>{fmtFn ? fmtFn(meanMin) : meanMin}</span>
            <span>{fmtFn ? fmtFn(meanMax) : meanMax}</span>
          </div>
        </div>
      )}

      {/* SD / uncertainty slider */}
      {sdRange > 0 && (
        <div className="space-y-1">
          <div className="flex justify-between text-[10px] text-slate-600">
            <span>Uncertainty (±1σ)</span>
            <span className="font-mono text-violet-400">±{sdVal}</span>
          </div>
          <input type="range" min={sdMin} max={sdMax} step={sdStep} value={sd}
            onChange={e => onSdChange(Number(e.target.value))}
            className="w-full cursor-pointer appearance-none"
            style={{ height: 4, borderRadius: 4, background: `linear-gradient(to right,#6366f1 ${sdPct}%,#1e293b ${sdPct}%)` }}
          />
          <div className="flex justify-between text-[10px] text-slate-700">
            <span>{(sdFmtFn || fmtFn) ? (sdFmtFn || fmtFn)(sdMin) : sdMin}</span>
            <span>{(sdFmtFn || fmtFn) ? (sdFmtFn || fmtFn)(sdMax) : sdMax}</span>
          </div>
        </div>
      )}

      {/* Band preview */}
      {showMean && sd > 0 && (
        <div className="flex items-center gap-1.5 text-[10px] flex-wrap">
          <span className="text-slate-600">{bandLabel || "68% of trials:"}</span>
          <span className="font-mono text-violet-400">{loVal}</span>
          <span className="text-slate-700">to</span>
          <span className="font-mono text-violet-400">{hiVal}</span>
        </div>
      )}
      {!showMean && sd > 0 && (
        <div className="flex items-center gap-1.5 text-[10px] flex-wrap">
          <span className="text-slate-600">{bandLabel || "68% of trials within"}</span>
          <span className="font-mono text-violet-400">±{sdVal}</span>
          <span className="text-slate-600">of your input</span>
        </div>
      )}
    </div>
  );
}

// ─── Card ─────────────────────────────────────────────────────────────────────
function Card({ label, value, sub, color = "bg-emerald-500", tip }) {
  return (
    <div className="relative bg-slate-900 border border-slate-800 rounded-xl p-3.5 overflow-hidden hover:border-slate-700 transition-colors">
      <div className={`absolute top-0 left-0 right-0 h-0.5 ${color}`} />
      <p className="text-[10px] uppercase tracking-widest text-slate-500 mb-0.5 flex items-center">{label}{tip && <InfoTip text={tip} />}</p>
      <p className="text-lg font-bold text-white font-mono leading-tight">{value}</p>
      {sub && <p className="text-[10px] text-slate-600 mt-0.5">{sub}</p>}
    </div>
  );
}

// ─── Chart Tooltip ────────────────────────────────────────────────────────────
function ChartTip({ active, payload, label, xLabel = "Age", isMC = false }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-slate-900 border border-slate-700 rounded-xl p-3 shadow-2xl text-xs space-y-1 min-w-[170px]">
      <p className="text-slate-400 font-medium mb-1.5">{xLabel} {label}</p>
      {payload.filter(p => p.value != null && p.name && !p.name.startsWith("_")).map((p, i) => (
        <div key={i} className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-1.5">
            <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: p.color }} />
            <span className="text-slate-400 truncate" style={{ maxWidth: 90 }}>{p.name}</span>
          </div>
          <span className="font-mono font-bold flex-shrink-0" style={{ color: p.color }}>
            {typeof p.value === "number" ? fmtD(p.value) : p.value}
          </span>
        </div>
      ))}
    </div>
  );
}

// ─── MC Band Chart (portfolio over time with percentile bands) ────────────────
function MCBandChart({ mcData, detData, retireAge, deathAge, label }) {
  if (!mcData || !mcData.length) return null;

  // Merge deterministic "needed" into mc data for overlay
  const detByAge = {};
  detData.forEach(d => { detByAge[d.age] = d; });

  const merged = mcData.map(d => ({
    age: d.age,
    p50: d.p50,
    p5: d.p5,
    p95: d.p95,
    p25: d.p25,
    p75: d.p75,
    band_outer: d.band_outer,
    band_inner: d.band_inner,
    // For recharts composed area trick: need [lo, hi] as separate fields
    outer_lo: d.p5,
    outer_hi: d.p95,
    inner_lo: d.p25,
    inner_hi: d.p75,
    needed: detByAge[d.age]?.needed ?? 0,
  }));

  return (
    <div>
      <p className="text-xs text-slate-500 mb-1">{label}</p>
      <div className="flex gap-3 mb-3 text-[10px] flex-wrap">
        <span className="flex items-center gap-1"><span className="inline-block w-3 h-2 rounded" style={{ background: "rgba(99,102,241,0.15)", border: "1px solid rgba(99,102,241,0.3)" }} /> 5th–95th %ile</span>
        <span className="flex items-center gap-1"><span className="inline-block w-3 h-2 rounded" style={{ background: "rgba(99,102,241,0.3)", border: "1px solid rgba(99,102,241,0.5)" }} /> 25th–75th %ile</span>
        <span className="flex items-center gap-1"><span className="inline-block w-3 h-1.5 rounded" style={{ background: "#6366f1" }} /> Median</span>
        <span className="flex items-center gap-1"><span className="inline-block w-3 h-1.5 rounded" style={{ background: "#f59e0b" }} /> Nest Egg Needed</span>
      </div>
      <ResponsiveContainer width="100%" height={280}>
        <ComposedChart data={merged} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
          <defs>
            <linearGradient id="mcOuter" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#6366f1" stopOpacity={0.12} />
              <stop offset="100%" stopColor="#6366f1" stopOpacity={0.04} />
            </linearGradient>
            <linearGradient id="mcInner" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#6366f1" stopOpacity={0.28} />
              <stop offset="100%" stopColor="#6366f1" stopOpacity={0.1} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
          <XAxis dataKey="age" tick={{ fill: "#64748b", fontSize: 10 }} axisLine={{ stroke: "#1e293b" }} tickLine={false} />
          <YAxis tick={{ fill: "#64748b", fontSize: 10 }} axisLine={{ stroke: "#1e293b" }} tickLine={false} tickFormatter={fmtD} width={64} />
          <Tooltip content={<ChartTip isMC />} />
          {/* Outer band: p5 to p95 */}
          <Area type="monotone" dataKey="outer_hi" stroke="none" fill="url(#mcOuter)" name="_outer_hi" legendType="none" />
          <Area type="monotone" dataKey="outer_lo" stroke="none" fill="#0f172a" name="_outer_lo" legendType="none" />
          {/* Inner band: p25 to p75 */}
          <Area type="monotone" dataKey="inner_hi" stroke="rgba(99,102,241,0.35)" strokeWidth={0.5} fill="url(#mcInner)" name="_inner_hi" legendType="none" />
          <Area type="monotone" dataKey="inner_lo" stroke="rgba(99,102,241,0.35)" strokeWidth={0.5} fill="#0f172a" name="_inner_lo" legendType="none" />
          {/* Median */}
          <Line type="monotone" dataKey="p50" stroke="#6366f1" strokeWidth={2} dot={false} name="Median" />
          {/* Percentile lines subtle */}
          <Line type="monotone" dataKey="p5" stroke="#6366f1" strokeWidth={0.75} strokeDasharray="3 3" dot={false} name="5th %ile" />
          <Line type="monotone" dataKey="p95" stroke="#6366f1" strokeWidth={0.75} strokeDasharray="3 3" dot={false} name="95th %ile" />
          {/* Needed overlay */}
          <Line type="monotone" dataKey="needed" stroke="#f59e0b" strokeWidth={1.5} dot={false} name="Needed" />
          <ReferenceLine x={retireAge} stroke="#10b981" strokeDasharray="4 3"
            label={{ value: `↑ ${retireAge}`, position: "insideTopRight", fill: "#6ee7b7", fontSize: 9 }} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

// ─── Simple deterministic charts ──────────────────────────────────────────────
function C1_Det({ data, retireAge }) {
  return (
    <ResponsiveContainer width="100%" height={260}>
      <AreaChart data={data} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
        <defs>
          <linearGradient id="gP" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="#10b981" stopOpacity={0.2} /><stop offset="95%" stopColor="#10b981" stopOpacity={0} />
          </linearGradient>
          <linearGradient id="gN" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="#f59e0b" stopOpacity={0.15} /><stop offset="95%" stopColor="#f59e0b" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
        <XAxis dataKey="age" tick={{ fill: "#64748b", fontSize: 10 }} axisLine={{ stroke: "#1e293b" }} tickLine={false} />
        <YAxis tick={{ fill: "#64748b", fontSize: 10 }} axisLine={{ stroke: "#1e293b" }} tickLine={false} tickFormatter={fmtD} width={64} />
        <Tooltip content={<ChartTip />} />
        <Legend wrapperStyle={{ fontSize: "11px", color: "#94a3b8", paddingTop: 8 }} />
        <Area type="monotone" dataKey="needed" stroke="#f59e0b" strokeWidth={1.5} fill="url(#gN)" name="Needed" dot={false} />
        <Area type="monotone" dataKey="portfolio" stroke="#10b981" strokeWidth={2} fill="url(#gP)" name="Portfolio" dot={false} />
        <ReferenceLine x={retireAge} stroke="#6366f1" strokeDasharray="4 3"
          label={{ value: `↑ ${retireAge}`, position: "insideTopRight", fill: "#a5b4fc", fontSize: 9 }} />
      </AreaChart>
    </ResponsiveContainer>
  );
}

function C2_Det({ data }) {
  return (
    <ResponsiveContainer width="100%" height={260}>
      <BarChart data={data} margin={{ top: 8, right: 8, left: 8, bottom: 16 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" vertical={false} />
        <XAxis dataKey="retireAge" tick={{ fill: "#64748b", fontSize: 10 }} axisLine={{ stroke: "#1e293b" }} tickLine={false}
          label={{ value: "Retirement Age", position: "insideBottom", offset: -8, fill: "#475569", fontSize: 10 }} />
        <YAxis tick={{ fill: "#64748b", fontSize: 10 }} axisLine={{ stroke: "#1e293b" }} tickLine={false} tickFormatter={fmtD} width={64} />
        <Tooltip content={<ChartTip xLabel="Retire Age" />} />
        <Bar dataKey="reqSavings" name="Save/Yr Now" fill="#10b981" radius={[4, 4, 0, 0]}
          label={{ position: "top", formatter: v => v > 0 ? fmtD(v) : "✓", fill: "#6ee7b7", fontSize: 9 }} />
      </BarChart>
    </ResponsiveContainer>
  );
}

function C3_Det({ data }) {
  return (
    <ResponsiveContainer width="100%" height={260}>
      <LineChart data={data} margin={{ top: 8, right: 8, left: 8, bottom: 16 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
        <XAxis dataKey="retireAge" tick={{ fill: "#64748b", fontSize: 10 }} axisLine={{ stroke: "#1e293b" }} tickLine={false}
          label={{ value: "Retirement Age", position: "insideBottom", offset: -8, fill: "#475569", fontSize: 10 }} />
        <YAxis tick={{ fill: "#64748b", fontSize: 10 }} axisLine={{ stroke: "#1e293b" }} tickLine={false} tickFormatter={fmtD} width={64} />
        <Tooltip content={<ChartTip xLabel="Retire Age" />} />
        <Legend wrapperStyle={{ fontSize: "11px", color: "#94a3b8", paddingTop: 8 }} />
        <Line type="monotone" dataKey="affordableSpend" stroke="#38bdf8" strokeWidth={2.5} dot={{ fill: "#38bdf8", r: 3 }} name="What You Can Afford" />
        <Line type="monotone" dataKey="targetSpend" stroke="#f59e0b" strokeWidth={1.5} strokeDasharray="5 3" dot={false} name="Your Target" />
      </LineChart>
    </ResponsiveContainer>
  );
}

function C4_Det({ data }) {
  return (
    <ResponsiveContainer width="100%" height={260}>
      <AreaChart data={data} margin={{ top: 8, right: 8, left: 8, bottom: 16 }}>
        <defs>
          <linearGradient id="gNE" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#f59e0b" stopOpacity={0.2} /><stop offset="95%" stopColor="#f59e0b" stopOpacity={0} /></linearGradient>
          <linearGradient id="gPE" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#10b981" stopOpacity={0.15} /><stop offset="95%" stopColor="#10b981" stopOpacity={0} /></linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
        <XAxis dataKey="retireAge" tick={{ fill: "#64748b", fontSize: 10 }} axisLine={{ stroke: "#1e293b" }} tickLine={false}
          label={{ value: "Retirement Age", position: "insideBottom", offset: -8, fill: "#475569", fontSize: 10 }} />
        <YAxis tick={{ fill: "#64748b", fontSize: 10 }} axisLine={{ stroke: "#1e293b" }} tickLine={false} tickFormatter={fmtD} width={64} />
        <Tooltip content={<ChartTip xLabel="Retire Age" />} />
        <Legend wrapperStyle={{ fontSize: "11px", color: "#94a3b8", paddingTop: 8 }} />
        <Area type="monotone" dataKey="required" stroke="#f59e0b" strokeWidth={2} fill="url(#gNE)" name="Nest Egg Needed" dot={false} />
        <Area type="monotone" dataKey="projectedAtRetire" stroke="#10b981" strokeWidth={2} fill="url(#gPE)" name="Projected Portfolio" dot={false} />
      </AreaChart>
    </ResponsiveContainer>
  );
}

// ─── Main App ─────────────────────────────────────────────────────────────────
export default function App() {
  // ── Base params ──
  const [currentAge, setCurrentAge] = useState(30);
  const [portfolio, setPortfolio] = useState(100000);
  const [spendToday, setSpendToday] = useState(75000);
  const [savingsNow, setSavingsNow] = useState(15000);
  const [savingsGrowth, setSavingsGrowth] = useState(0.05);
  const [returnRate, setReturnRate] = useState(0.08);
  const [inflationRate, setInflationRate] = useState(0.027);
  const [retireAge, setRetireAge] = useState(60);
  const [deathAge, setDeathAge] = useState(90);

  // ── Advanced mode ──
  const [advancedMode, setAdvancedMode] = useState(false);

  // ── Range params (mean = base value, sd = uncertainty) ──
  const [rR_sd, setRR_sd] = useState(0.03);       // return rate uncertainty
  const [inf_sd, setInf_sd] = useState(0.01);     // inflation uncertainty
  const [sg_sd, setSg_sd] = useState(0.015);      // savings growth uncertainty
  const [spend_sd, setSpend_sd] = useState(0.1);  // spend multiplier sd
  const [port_sd, setPort_sd] = useState(0.05);   // portfolio multiplier sd
  const [sav_sd, setSav_sd] = useState(0.1);      // savings multiplier sd
  const [annualVol, setAnnualVol] = useState(0.14); // year-to-year equity vol

  // ── MC results ──
  const [mcResults, setMcResults] = useState(null); // { timeline, successRate, scenarioSuccessRates }
  const [mcRunning, setMcRunning] = useState(false);
  const [mcTrials, setMcTrials] = useState(2000);
  const [activeChart, setActiveChart] = useState(0);

  const safeRetire = clamp(retireAge, currentAge + 1, deathAge - 1);
  const safeDeath = clamp(deathAge, retireAge + 1, 105);

  // ── Deterministic calculations ──
  const summaryYrs = safeRetire - currentAge;
  const summaryYrsRetired = safeDeath - safeRetire;
  const neededNow = neededAtRetirement(spendToday, inflationRate, returnRate, summaryYrsRetired);
  const projAtRetire = fvLump(portfolio, returnRate, summaryYrs) + fvGrowingAnnuity(savingsNow, returnRate, savingsGrowth, summaryYrs);
  const reqSavingsNow = Math.max(0, solveAnnualSavings(neededNow, portfolio, returnRate, savingsGrowth, summaryYrs));
  const onTrack = projAtRetire >= neededNow;
  const spendAtRetire = spendToday * Math.pow(1 + inflationRate, summaryYrs);

  const coastFIREAge = useMemo(() => {
    for (let a = currentAge; a <= safeRetire; a++) {
      const fvC = fvLump(fvLump(portfolio, returnRate, a - currentAge), returnRate, safeRetire - a);
      if (fvC >= neededNow) return a;
    }
    return null;
  }, [currentAge, portfolio, returnRate, safeRetire, neededNow]);

  const timelineData = useMemo(() => buildTimeline({
    currentAge, portfolio, spendToday, savingsNow, savingsGrowth,
    r: returnRate, inflation: inflationRate, retireAge: safeRetire, deathAge: safeDeath
  }), [currentAge, portfolio, spendToday, savingsNow, savingsGrowth, returnRate, inflationRate, safeRetire, safeDeath]);

  const scenarioAges = useMemo(() => {
    const ages = [];
    const start = Math.ceil((currentAge + 5) / 5) * 5;
    for (let a = start; a <= Math.min(75, safeDeath - 5); a += 5) ages.push(a);
    return ages;
  }, [currentAge, safeDeath]);

  const scenarioData = useMemo(() => scenarioAges.map(rAge => {
    const yrs = rAge - currentAge;
    const yrsRet = safeDeath - rAge;
    const required = neededAtRetirement(spendToday, inflationRate, returnRate, yrsRet);
    const projectedAtRetire = fvLump(portfolio, returnRate, yrs) + fvGrowingAnnuity(savingsNow, returnRate, savingsGrowth, yrs);
    const reqSavings = Math.max(0, solveAnnualSavings(required, portfolio, returnRate, savingsGrowth, yrs));
    const affordableSpend = maxSpend(projectedAtRetire, inflationRate, returnRate, yrsRet);
    const gap = Math.max(0, required - projectedAtRetire);
    // MC success from last sim run
    const mcSucc = mcResults?.scenarioSuccessRates?.[rAge] ?? null;
    return { retireAge: rAge, required, projectedAtRetire, reqSavings, affordableSpend, gap, canRetire: gap <= 0, targetSpend: spendToday, successProb: mcSucc };
  }), [scenarioAges, currentAge, portfolio, spendToday, savingsNow, savingsGrowth, returnRate, inflationRate, safeDeath, mcResults]);

  // ── Build MC ranges object ──
  const buildRanges = useCallback(() => ({
    returnRate:       { mean: returnRate,    sd: rR_sd },
    inflation:        { mean: inflationRate, sd: inf_sd },
    savingsGrowth:    { mean: savingsGrowth, sd: sg_sd },
    spendMult:        { sd: spend_sd },      // multiplier applied to spendToday
    portfolioMult:    { sd: port_sd },       // multiplier applied to portfolio
    savingsMult:      { sd: sav_sd },        // multiplier applied to savingsNow
    annualVolatility: { mean: annualVol },
    spendToday,
  }), [returnRate, rR_sd, inflationRate, inf_sd, savingsGrowth, sg_sd, spend_sd, port_sd, sav_sd, annualVol, spendToday]);

  // ── Run simulation ──
  const runSimulation = useCallback(() => {
    setMcRunning(true);
    // Use setTimeout so UI updates before heavy computation
    setTimeout(() => {
      try {
        const ranges = buildRanges();
        const main = runMonteCarlo({
          currentAge, portfolio, spendToday, savingsNow, deathAge: safeDeath,
          retireAge: safeRetire, ranges, trials: mcTrials
        });
        // Run scenario success rates
        const scenarioSuccessRates = {};
        for (const rAge of scenarioAges) {
          scenarioSuccessRates[rAge] = scenarioMC({
            portfolio, savingsNow, deathAge: safeDeath, retireAge: rAge,
            currentAge, ranges: { ...ranges }, trials: 400
          });
        }
        setMcResults({ ...main, scenarioSuccessRates, ranAt: Date.now() });
      } finally {
        setMcRunning(false);
      }
    }, 30);
  }, [currentAge, portfolio, spendToday, savingsNow, safeDeath, safeRetire, mcTrials, scenarioAges, buildRanges]);

  const CHARTS = [
    { label: "📈 Portfolio Over Time", key: "portfolio" },
    { label: "💰 Savings Needed", key: "savings" },
    { label: "🛋️ Max Annual Spend", key: "spend" },
    { label: "🎯 Nest Egg Required", key: "nestegg" },
  ];

  const chartDescriptions = [
    `Portfolio balance from today to age ${safeDeath}. Green = your balance; amber = nest egg needed. After age ${safeRetire} the green line falls as you withdraw.`,
    "How much you need to save this year (today's dollars, growing with income) to retire at each age.",
    "What you can sustainably spend each year with your current savings rate, vs. your target.",
    "Total nest egg needed vs. projected portfolio at each retirement age."
  ];

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100" style={{ fontFamily: "'DM Sans', system-ui, sans-serif" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600;700&family=DM+Mono:wght@400;500&display=swap');
        input[type=range]{-webkit-appearance:none;appearance:none;outline:none;height:4px;border-radius:4px;}
        input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:13px;height:13px;border-radius:50%;background:#10b981;cursor:pointer;box-shadow:0 0 0 3px rgba(16,185,129,.15);transition:box-shadow .15s;}
        input[type=range]::-webkit-slider-thumb:hover{box-shadow:0 0 0 6px rgba(16,185,129,.2);}
        .fade{animation:fadeUp .25s ease forwards;}
        @keyframes fadeUp{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:translateY(0)}}
        ::-webkit-scrollbar{width:4px;height:4px}::-webkit-scrollbar-track{background:#1e293b}::-webkit-scrollbar-thumb{background:#334155;border-radius:2px}
        .mc-glow { box-shadow: 0 0 0 1px rgba(99,102,241,0.3), 0 4px 24px rgba(99,102,241,0.08); }
      `}</style>

      {/* Header */}
      <header className="sticky top-0 z-40 bg-slate-950/90 backdrop-blur-xl border-b border-slate-800/60">
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 rounded-lg bg-emerald-500 flex items-center justify-center flex-shrink-0">
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <path d="M1 10L5 6L8 9L13 3" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
            <span className="text-sm font-bold text-white tracking-tight">FireCalc</span>
            {advancedMode && <span className="text-[10px] px-2 py-0.5 rounded-full bg-violet-500/15 border border-violet-500/30 text-violet-400 font-medium">Monte Carlo Mode</span>}
          </div>
          <button
            onClick={() => { setAdvancedMode(a => !a); setMcResults(null); }}
            className={`text-xs px-3 py-1.5 rounded-lg border transition-all ${advancedMode ? "bg-violet-500/10 border-violet-500/30 text-violet-400" : "border-slate-700 text-slate-500 hover:text-slate-300"}`}
          >{advancedMode ? "⚡ Advanced On" : "Advanced Mode"}</button>
        </div>
      </header>

      <div className="max-w-7xl mx-auto px-4 py-5 space-y-5">

        {/* Summary Cards */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2.5">
          <Card label="Retire Age" value={`Age ${safeRetire}`} sub={`${safeRetire - currentAge} yrs away`} color="bg-indigo-500"
            tip="Your selected retirement age." />
          <Card label="Nest Egg Needed" value={fmtD(neededNow)} sub={`By age ${safeRetire}`} color="bg-amber-500"
            tip={`Total savings needed at ${safeRetire} to spend ${fmtD(spendToday)}/yr (today's $) until age ${safeDeath}.`} />
          <Card label={onTrack ? "Projected ✓" : "Projected (Gap)"} value={fmtD(projAtRetire)}
            sub={onTrack ? "Exceeds goal" : `Short ${fmtD(neededNow - projAtRetire)}`}
            color={onTrack ? "bg-emerald-500" : "bg-rose-500"}
            tip="Your projected portfolio at your retirement age." />
          <Card label="Save/Yr Now" value={reqSavingsNow === 0 ? "On Track" : fmtD(reqSavingsNow)} sub="Today's $, grows w/ income" color="bg-sky-500"
            tip={`Annual savings needed this year, growing ${fmtPct(savingsGrowth)}/yr.`} />
          <Card label="Coast FIRE Age" value={coastFIREAge ? `Age ${coastFIREAge}` : "—"} sub={`Stop saving, coast to ${safeRetire}`} color="bg-teal-500"
            tip="After this age, your portfolio grows on its own to what you need." />
          {advancedMode && mcResults ? (
            <Card label="MC Success Rate" value={`${mcResults.successRate}%`} sub={`${mcTrials.toLocaleString()} trials`}
              color={mcResults.successRate >= 80 ? "bg-emerald-500" : mcResults.successRate >= 60 ? "bg-amber-500" : "bg-rose-500"}
              tip="Probability your money lasts until your end age, across all simulated scenarios." />
          ) : (
            <Card label="Inflation-Adj Spend" value={fmtD(spendAtRetire)} sub={`Age ${safeRetire} in future $`} color="bg-violet-500"
              tip={`Your spending target in future dollars at age ${safeRetire}.`} />
          )}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">

          {/* ── Left: Sliders ── */}
          <div className="space-y-4">

            {/* Base Inputs */}
            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 space-y-5">
              <p className="text-[10px] uppercase tracking-widest text-slate-600 font-semibold">Your Situation</p>
              <Slider label="Current Age" value={currentAge} onChange={setCurrentAge} min={18} max={65} step={1} fmt={v => `${v} yrs`} tip="How old you are today." />
              <Slider label="Current Portfolio" value={portfolio} onChange={setPortfolio} min={0} max={2000000} step={5000} fmt={fmtD} tip="Total invested assets." />
              <Slider label="Annual Spend Target (Today's $)" value={spendToday} onChange={setSpendToday} min={20000} max={300000} step={2500} fmt={fmtD} tip="Desired annual spending in retirement, in today's dollars. Grows with inflation automatically." />
              <Slider label="You Save This Year" value={savingsNow} onChange={setSavingsNow} min={0} max={150000} step={500} fmt={fmtD} tip="Current annual savings. Grows with income each year." />
              <Slider label="Annual Income Growth" value={savingsGrowth} onChange={setSavingsGrowth} min={0} max={0.15} step={0.005} fmt={fmtPct} tip="How fast your savings contributions grow each year." />
            </div>

            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 space-y-5">
              <p className="text-[10px] uppercase tracking-widest text-slate-600 font-semibold">Plan</p>
              <Slider label="Target Retirement Age" value={safeRetire} onChange={v => { setRetireAge(v); if (v >= deathAge) setDeathAge(v + 5); }} min={currentAge + 1} max={80} step={1} fmt={v => `Age ${v}`} tip="When you want to stop working." />
              <Slider label="Age Money Must Last Until" value={safeDeath} onChange={v => { setDeathAge(v); if (v <= retireAge) setRetireAge(v - 5); }} min={70} max={105} step={1} fmt={v => `Age ${v}`} tip="How long your money must last." />
            </div>

            {/* Deterministic assumptions OR advanced ranges */}
            {!advancedMode ? (
              <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 space-y-5">
                <p className="text-[10px] uppercase tracking-widest text-slate-600 font-semibold">Assumptions</p>
                <Slider label="Expected Annual Return" value={returnRate} onChange={setReturnRate} min={0.02} max={0.15} step={0.005} fmt={fmtPct} tip="Average annual investment return. S&P 500 historically ~10%. Use 6–8% to be conservative." />
                <Slider label="Expected Annual Inflation" value={inflationRate} onChange={setInflationRate} min={0.01} max={0.08} step={0.005} fmt={fmtPct} tip="How much prices rise per year. Fed target 2%, long-run US avg ~2.7%." />
              </div>
            ) : (
              <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 space-y-4 mc-glow">
                <div className="flex items-center justify-between">
                  <p className="text-[10px] uppercase tracking-widest text-violet-400 font-semibold">Monte Carlo Ranges</p>
                  <InfoTip text="Each simulation trial randomly samples every factor from a normal distribution with your chosen mean and uncertainty (±1σ). Results show the spread of 5th–95th percentile outcomes." />
                </div>
                <p className="text-[10px] text-slate-500 leading-relaxed">
                  Set the <strong className="text-slate-400">mean</strong> (expected value) and <strong className="text-slate-400">uncertainty</strong> for each factor. Each trial draws random values from these distributions.
                </p>

                <RangeSlider label="Investment Return" mean={returnRate} sd={rR_sd}
                  onMeanChange={setReturnRate} onSdChange={setRR_sd}
                  meanMin={0.02} meanMax={0.15} meanStep={0.005}
                  sdMin={0.005} sdMax={0.06} sdStep={0.005}
                  fmtFn={fmtPct} color="#10b981"
                  tip="Mean return across your holding period. Uncertainty reflects uncertainty in future market conditions." />

                <RangeSlider label="Inflation Rate" mean={inflationRate} sd={inf_sd}
                  onMeanChange={setInflationRate} onSdChange={setInf_sd}
                  meanMin={0.01} meanMax={0.08} meanStep={0.005}
                  sdMin={0.002} sdMax={0.03} sdStep={0.002}
                  fmtFn={fmtPct} color="#f59e0b"
                  tip="Average long-term inflation. Uncertainty reflects surprise inflation scenarios." />

                <RangeSlider label="Annual Income Growth" mean={savingsGrowth} sd={sg_sd}
                  onMeanChange={setSavingsGrowth} onSdChange={setSg_sd}
                  meanMin={0} meanMax={0.15} meanStep={0.005}
                  sdMin={0.005} sdMax={0.04} sdStep={0.005}
                  fmtFn={fmtPct} color="#38bdf8"
                  tip="How fast savings contributions grow. Uncertainty reflects career variability." />

                <RangeSlider
                  label="Retirement Spending Variability"
                  showMean={false}
                  mean={spendToday} sd={spendToday * spend_sd}
                  onMeanChange={() => {}} onSdChange={v => setSpend_sd(v / spendToday)}
                  meanMin={spendToday} meanMax={spendToday} meanStep={1}
                  sdMin={spendToday * 0.02} sdMax={spendToday * 0.4} sdStep={spendToday * 0.01}
                  fmtFn={fmtD} color="#f472b6"
                  bandLabel="68% of trials spend within"
                  tip={`How much your actual spending might deviate from your ${fmtD(spendToday)}/yr target. A ±${fmtD(spendToday * spend_sd)} uncertainty means some trials spend more, some less.`}
                />

                <RangeSlider
                  label="Annual Savings Variability"
                  showMean={false}
                  mean={savingsNow} sd={savingsNow * sav_sd}
                  onMeanChange={() => {}} onSdChange={v => setSav_sd(Math.max(0, v / (savingsNow || 1)))}
                  meanMin={savingsNow} meanMax={savingsNow} meanStep={1}
                  sdMin={savingsNow * 0.02} sdMax={savingsNow * 0.5} sdStep={savingsNow * 0.01}
                  fmtFn={fmtD} color="#34d399"
                  bandLabel="68% of trials save within"
                  tip={`Uncertainty in how much you actually save each year around your ${fmtD(savingsNow)}/yr baseline. Captures job changes, bonuses, or lean years.`}
                />

                {/* Trials + Run button */}
                <div className="space-y-3 pt-1">
                  <Slider label="Simulation Trials" value={mcTrials} onChange={setMcTrials} min={500} max={5000} step={500} fmt={v => v.toLocaleString()}
                    tip="More trials = more accurate results but slower. 2,000 is a good balance." />
                  <button
                    onClick={runSimulation}
                    disabled={mcRunning}
                    className={`w-full py-2.5 rounded-xl text-sm font-bold transition-all ${mcRunning
                      ? "bg-violet-500/20 text-violet-400 cursor-not-allowed"
                      : "bg-violet-500 hover:bg-violet-400 text-white shadow-lg shadow-violet-500/20"}`}
                  >
                    {mcRunning ? (
                      <span className="flex items-center justify-center gap-2">
                        <svg className="animate-spin w-4 h-4" fill="none" viewBox="0 0 24 24">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
                        </svg>
                        Running {mcTrials.toLocaleString()} trials…
                      </span>
                    ) : `▶ Run ${mcTrials.toLocaleString()} Simulations`}
                  </button>
                  {mcResults && (
                    <p className="text-[10px] text-slate-600 text-center">
                      Last run: {new Date(mcResults.ranAt).toLocaleTimeString()} · {mcTrials.toLocaleString()} trials · Success: <span className={mcResults.successRate >= 80 ? "text-emerald-400" : mcResults.successRate >= 60 ? "text-amber-400" : "text-rose-400"}>{mcResults.successRate}%</span>
                    </p>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* ── Right: Charts + Table ── */}
          <div className="lg:col-span-2 space-y-4">

            {/* Charts */}
            <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden">
              <div className="flex border-b border-slate-800 overflow-x-auto">
                {CHARTS.map((c, i) => (
                  <button key={c.key} onClick={() => setActiveChart(i)}
                    className={`px-3.5 py-3 text-xs font-medium whitespace-nowrap transition-all border-b-2 flex-shrink-0 ${activeChart === i ? "border-emerald-500 text-emerald-400 bg-emerald-500/5" : "border-transparent text-slate-500 hover:text-slate-300"}`}>
                    {c.label}
                  </button>
                ))}
              </div>
              <div className="p-5 fade" key={`${activeChart}-${advancedMode}-${mcResults?.ranAt}`}>
                <p className="text-xs text-slate-500 mb-4">{chartDescriptions[activeChart]}</p>

                {/* In advanced mode with results: show MC bands on chart 0 */}
                {advancedMode && mcResults && activeChart === 0 ? (
                  <MCBandChart mcData={mcResults.timeline} detData={timelineData} retireAge={safeRetire} deathAge={safeDeath}
                    label="Shaded regions show the spread of outcomes across all simulated scenarios." />
                ) : activeChart === 0 ? (
                  <C1_Det data={timelineData} retireAge={safeRetire} />
                ) : activeChart === 1 ? (
                  <C2_Det data={scenarioData} />
                ) : activeChart === 2 ? (
                  <C3_Det data={scenarioData} />
                ) : (
                  <C4_Det data={scenarioData} />
                )}

                {/* Advanced mode nudge for non-portfolio charts */}
                {advancedMode && !mcResults && activeChart === 0 && (
                  <div className="mt-4 p-3 bg-violet-500/5 border border-violet-500/20 rounded-xl text-xs text-violet-400 text-center">
                    Run simulations to see Monte Carlo percentile bands on this chart →
                  </div>
                )}
                {advancedMode && mcResults && activeChart !== 0 && (
                  <div className="mt-4 p-3 bg-violet-500/5 border border-violet-500/20 rounded-xl text-xs text-violet-300">
                    <strong>MC context:</strong> Deterministic projections shown. For full scenario distributions, see the Portfolio chart. Success rates per age are in the table below.
                  </div>
                )}
              </div>
            </div>

            {/* Table */}
            <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden">
              <div className="px-5 py-3.5 border-b border-slate-800 flex items-center justify-between flex-wrap gap-2">
                <p className="text-xs font-semibold text-slate-300">Retirement Scenarios</p>
                <div className="flex items-center gap-2">
                  {advancedMode && mcResults && <span className="text-[10px] text-violet-400">✓ MC success rates loaded</span>}
                  <p className="text-[10px] text-slate-600">Save/Yr in today's $ · Portfolio in future $</p>
                </div>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-xs" style={{ minWidth: 520 }}>
                  <thead>
                    <tr className="border-b border-slate-800/60">
                      {["Retire At", "Nest Egg Needed", "Projected", "Gap", "Save/Yr Now", ...(advancedMode && mcResults ? ["MC Success %"] : [])].map(h => (
                        <th key={h} className="text-left py-2.5 px-3 text-[10px] uppercase tracking-widest text-slate-600 font-semibold">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {scenarioData.map(s => (
                      <tr key={s.retireAge}
                        className={`border-b border-slate-800/30 hover:bg-slate-800/30 transition-colors ${s.retireAge === safeRetire ? "bg-indigo-500/5" : ""}`}>
                        <td className="py-3 px-3">
                          <span className={`font-bold ${s.canRetire ? "text-emerald-400" : "text-slate-300"}`}>{s.retireAge}{s.canRetire ? " ✓" : ""}</span>
                          {s.retireAge === safeRetire && <span className="ml-1 text-[9px] text-indigo-400 uppercase">selected</span>}
                        </td>
                        <td className="py-3 px-3 font-mono text-amber-400">{fmtD(s.required)}</td>
                        <td className={`py-3 px-3 font-mono ${s.canRetire ? "text-emerald-400" : "text-slate-400"}`}>{fmtD(s.projectedAtRetire)}</td>
                        <td className={`py-3 px-3 font-mono font-bold ${s.gap > 0 ? "text-rose-400" : "text-emerald-400"}`}>
                          {s.gap > 0 ? `-${fmtD(s.gap)}` : "None ✓"}
                        </td>
                        <td className={`py-3 px-3 font-mono font-bold ${s.reqSavings > savingsNow * 3 ? "text-rose-400" : s.reqSavings === 0 ? "text-emerald-400" : "text-slate-200"}`}>
                          {s.reqSavings === 0 ? "On track" : `${fmtD(s.reqSavings)}/yr`}
                        </td>
                        {advancedMode && mcResults && (
                          <td className={`py-3 px-3 font-bold ${(s.successProb || 0) >= 80 ? "text-emerald-400" : (s.successProb || 0) >= 60 ? "text-amber-400" : "text-rose-400"}`}>
                            {s.successProb !== null ? `${s.successProb}%` : <span className="text-slate-600">Run sim</span>}
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="px-5 py-3 border-t border-slate-800/40">
                <p className="text-[10px] text-slate-600 leading-relaxed">
                  Return: <span className="font-mono text-slate-500">{fmtPct(returnRate)}</span> ·
                  Inflation: <span className="font-mono text-slate-500">{fmtPct(inflationRate)}</span> ·
                  Income growth: <span className="font-mono text-slate-500">{fmtPct(savingsGrowth)}</span> ·
                  End age: <span className="font-mono text-slate-500">{safeDeath}</span>
                  {advancedMode && mcResults && <span> · MC trials: <span className="font-mono text-violet-400">{mcTrials.toLocaleString()}</span></span>}
                </p>
              </div>
            </div>

            {/* Insight */}
            <div className="bg-slate-900/50 border border-slate-800/40 rounded-2xl p-4">
              <p className="text-[10px] uppercase tracking-widest text-slate-600 font-semibold mb-2">💡 Summary</p>
              <p className="text-sm text-slate-300 leading-relaxed">
                {onTrack
                  ? <>Your projected <span className="text-emerald-400 font-mono font-bold">{fmtD(projAtRetire)}</span> at age {safeRetire} exceeds the <span className="text-amber-400 font-mono">{fmtD(neededNow)}</span> needed. You're on track.</>
                  : <>To retire at <span className="text-indigo-400 font-bold">age {safeRetire}</span> and spend <span className="text-slate-200 font-mono">{fmtD(spendToday)}/yr</span>, you need <span className="text-amber-400 font-mono font-bold">{fmtD(neededNow)}</span>. You're projected to reach <span className="text-slate-300 font-mono">{fmtD(projAtRetire)}</span> — a gap of <span className="text-rose-400 font-mono font-bold">{fmtD(neededNow - projAtRetire)}</span>. Saving <span className="text-sky-400 font-mono font-bold">{fmtD(reqSavingsNow)}/yr</span> now (growing {fmtPct(savingsGrowth)}/yr) closes it.</>
                }
                {coastFIREAge != null && <> Coast FIRE at <span className="text-teal-400 font-bold">age {coastFIREAge}</span> — stop saving then and let it grow.</>}
                {advancedMode && mcResults && <> Across {mcTrials.toLocaleString()} simulations with your uncertainty ranges, your plan succeeds <span className={`font-bold ${mcResults.successRate >= 80 ? "text-emerald-400" : mcResults.successRate >= 60 ? "text-amber-400" : "text-rose-400"}`}>{mcResults.successRate}%</span> of the time.</>}
              </p>
            </div>
          </div>
        </div>

        <footer className="text-center text-[10px] text-slate-800 py-3 border-t border-slate-900">
          Educational only · Not financial advice · Returns not guaranteed
        </footer>
      </div>
    </div>
  );
}

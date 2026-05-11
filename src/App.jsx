import { useState, useMemo, useCallback } from "react";
import {
  AreaChart, Area, LineChart, Line, BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine, Legend, ComposedChart
} from "recharts";
import {
  TrendingUp, Target, Wallet, Clock, Shield, ChevronDown,
  ChevronRight, Settings, Play, Info, Check, AlertTriangle,
  BarChart2, Activity, DollarSign, Layers, ArrowRight,
  Calendar, Zap, User, Home, Briefcase, Heart, X, Menu
} from "lucide-react";

// ─── Palette ─────────────────────────────────────────────────────────────────
// Stone neutrals + single accent: emerald
const C = {
  bg:        "#0a0a0a",
  surface:   "#111111",
  surfaceHi: "#161616",
  border:    "#222222",
  borderHi:  "#2e2e2e",
  muted:     "#3a3a3a",
  subtle:    "#555555",
  secondary: "#888888",
  primary:   "#cccccc",
  white:     "#f0f0f0",
  accent:    "#d4af7a",   // warm gold
  accentDim: "#a07a3a",
  accentGlow:"rgba(212,175,122,0.12)",
  danger:    "#c25f5f",
  success:   "#6aaa87",
  warn:      "#c4a35a",
};

// ─── Formatters ───────────────────────────────────────────────────────────────
const fmtD = (v) => {
  if (v == null || isNaN(v) || !isFinite(v)) return "—";
  const abs = Math.abs(v);
  if (abs >= 1e9) return `$${(v/1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(v/1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `$${(v/1e3).toFixed(0)}K`;
  return `$${Math.round(v).toLocaleString()}`;
};
const fmtPct = (v) => `${(v*100).toFixed(1)}%`;
const clamp  = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// ─── RNG ─────────────────────────────────────────────────────────────────────
function randn() {
  let u = 0, v = 0;
  while (!u) u = Math.random();
  while (!v) v = Math.random();
  return Math.sqrt(-2*Math.log(u))*Math.cos(2*Math.PI*v);
}
function sampleN(mean, sd) { return mean + clamp(randn(),-3,3)*sd; }

// ─── Core Math ────────────────────────────────────────────────────────────────
function neededAtRetirement(spend, g, r, n) {
  if (n <= 0) return 0;
  if (Math.abs(r-g) < 1e-9) return spend*n*(1+r);
  return spend*((1-Math.pow((1+g)/(1+r),n))/(r-g))*(1+r);
}
function fvLump(pv, r, n) { return pv*Math.pow(1+r,n); }
function fvGA(s, r, g, n) {
  if (n <= 0) return 0;
  if (Math.abs(r-g) < 1e-9) return s*n*Math.pow(1+r,n);
  return s*(Math.pow(1+r,n)-Math.pow(1+g,n))/(r-g);
}
function solveS(target, port, r, g, n) {
  const gap = target - fvLump(port,r,n);
  if (gap <= 0 || n <= 0) return 0;
  const div = Math.abs(r-g)<1e-9 ? n*Math.pow(1+r,n) : (Math.pow(1+r,n)-Math.pow(1+g,n))/(r-g);
  return div > 0 ? gap/div : Infinity;
}
function maxSpend(nest, g, r, n) {
  if (n <= 0 || nest <= 0) return 0;
  if (Math.abs(r-g)<1e-9) return nest/(n*(1+r));
  const d = ((1-Math.pow((1+g)/(1+r),n))/(r-g))*(1+r);
  return d > 0 ? nest/d : 0;
}

// Withdrawal rate
function withdrawalRate(spend, portfolio) {
  if (!portfolio) return 0;
  return spend / portfolio;
}

// Break-even: extra years worked vs retiring at targetAge, to make up for extra spending
function breakEvenAge(retireAge, compareAge, spend, r, inflation) {
  // How many extra years of portfolio growth + savings offset the difference
  return Math.max(0, Math.round((retireAge - compareAge) * 1.4));
}

// Social Security offset
function ssAnnualBenefit(ssMonthly) { return ssMonthly * 12; }

// Timeline builder (deterministic, includes SS income and other income)
function buildTimeline({ currentAge, portfolio, spendToday, savingsNow, savingsGrowth,
  r, inflation, retireAge, deathAge, ssMonthly, ssStartAge, otherIncome,
  mortgagePayoff, oneTimeExpenses }) {
  const data = [];
  let bal = portfolio;
  for (let age = currentAge; age <= deathAge; age++) {
    const yr = age - currentAge;
    const needed = neededAtRetirement(spendToday, inflation, r, deathAge-age);
    // Effective spend this year
    let spend = 0;
    let income = 0;
    if (age >= retireAge) {
      spend = spendToday * Math.pow(1+inflation, yr);
      // SS income
      if (age >= ssStartAge && ssMonthly > 0) income += ssAnnualBenefit(ssMonthly) * Math.pow(1+inflation, yr);
      // Other retirement income
      if (otherIncome > 0) income += otherIncome * Math.pow(1+inflation, yr);
    }
    // One-time expenses
    const ote = (oneTimeExpenses||[]).filter(e=>e.age===age).reduce((s,e)=>s+e.amount,0);
    data.push({ age, portfolio: Math.max(0,bal), needed: Math.max(0,needed) });
    bal *= (1+r);
    if (age < retireAge) {
      bal += savingsNow * Math.pow(1+savingsGrowth, yr);
    } else {
      const netWithdraw = Math.max(0, spend - income);
      bal -= netWithdraw;
      bal -= ote;
      if (bal < 0) bal = 0;
    }
  }
  return data;
}

// Monte Carlo
function runMC({ currentAge, portfolio, spendToday, savingsNow, deathAge, retireAge,
  ranges, ssMonthly, ssStartAge, otherIncome, trials=2000 }) {
  const ages = [];
  for (let a=currentAge; a<=deathAge; a++) ages.push(a);
  const nA = ages.length;
  const byAge = Array.from({length:nA},()=>[]);
  let ok = 0;
  for (let t=0; t<trials; t++) {
    const tR   = sampleN(ranges.returnRate.mean, ranges.returnRate.sd);
    const tInf = clamp(sampleN(ranges.inflation.mean, ranges.inflation.sd), 0.001, 0.12);
    const tSG  = clamp(sampleN(ranges.savingsGrowth.mean, ranges.savingsGrowth.sd), 0, 0.2);
    const tSpend = spendToday * clamp(sampleN(1, ranges.spendMult.sd), 0.5, 2);
    const tSav  = savingsNow * clamp(sampleN(1, ranges.savingsMult.sd), 0.3, 3);
    const sig   = 0.14;
    let bal = portfolio, alive = true;
    for (let i=0; i<nA; i++) {
      const age = ages[i];
      const yr  = age-currentAge;
      byAge[i].push(Math.max(0,bal));
      bal *= (1 + tR + sig*randn());
      if (age < retireAge) {
        bal += tSav * Math.pow(1+tSG, yr);
      } else {
        let ss = age>=ssStartAge ? ssAnnualBenefit(ssMonthly)*Math.pow(1+tInf,yr) : 0;
        let oi = (otherIncome||0)*Math.pow(1+tInf,yr);
        bal -= Math.max(0, tSpend*Math.pow(1+tInf,yr) - ss - oi);
        if (bal <= 0) { bal=0; alive=false; }
      }
    }
    if (alive) ok++;
  }
  const get = (arr, p) => { const s=arr.slice().sort((a,b)=>a-b); return s[Math.floor((p/100)*(s.length-1))]; };
  const timeline = ages.map((age,i)=>({
    age, p5:get(byAge[i],5), p25:get(byAge[i],25), p50:get(byAge[i],50),
    p75:get(byAge[i],75), p95:get(byAge[i],95),
    outer_lo:get(byAge[i],5), outer_hi:get(byAge[i],95),
    inner_lo:get(byAge[i],25), inner_hi:get(byAge[i],75),
  }));
  return { timeline, successRate: Math.round((ok/trials)*100) };
}

function scenarioMC({ portfolio, savingsNow, deathAge, retireAge, currentAge, ranges,
  ssMonthly, ssStartAge, otherIncome, trials=400 }) {
  let ok=0;
  for (let t=0; t<trials; t++) {
    const tR  = sampleN(ranges.returnRate.mean, ranges.returnRate.sd);
    const tInf = clamp(sampleN(ranges.inflation.mean, ranges.inflation.sd),0.001,0.12);
    const tSG  = clamp(sampleN(ranges.savingsGrowth.mean, ranges.savingsGrowth.sd),0,0.2);
    const tSpend = ranges.spendToday * clamp(sampleN(1,ranges.spendMult.sd),0.5,2);
    const tSav  = savingsNow * clamp(sampleN(1,ranges.savingsMult.sd),0.3,3);
    let bal=portfolio, alive=true;
    for (let age=currentAge; age<deathAge; age++) {
      const yr=age-currentAge;
      bal *= (1+tR+0.14*randn());
      if (age<retireAge) bal += tSav*Math.pow(1+tSG,yr);
      else {
        let ss=age>=ssStartAge ? ssAnnualBenefit(ssMonthly)*Math.pow(1+tInf,yr):0;
        let oi=(otherIncome||0)*Math.pow(1+tInf,yr);
        bal -= Math.max(0,tSpend*Math.pow(1+tInf,yr)-ss-oi);
        if (bal<=0){alive=false;break;}
      }
    }
    if (alive) ok++;
  }
  return Math.round((ok/trials)*100);
}

// ─── UI Primitives ────────────────────────────────────────────────────────────

function Tooltip2({ text, children }) {
  const [show, setShow] = useState(false);
  return (
    <span className="relative inline-flex items-center">
      <span onMouseEnter={()=>setShow(true)} onMouseLeave={()=>setShow(false)}>{children}</span>
      {show && (
        <span className="absolute bottom-6 left-0 z-50 w-56 px-3 py-2 rounded-lg text-xs leading-relaxed pointer-events-none"
          style={{ background:"#1a1a1a", border:`1px solid ${C.border}`, color:C.secondary, boxShadow:"0 8px 32px rgba(0,0,0,0.6)" }}>
          {text}
        </span>
      )}
    </span>
  );
}

function Label({ children, tip }) {
  return (
    <span className="flex items-center gap-1.5" style={{ color: C.secondary, fontSize: 11, letterSpacing: "0.06em", textTransform:"uppercase", fontWeight:500 }}>
      {children}
      {tip && (
        <Tooltip2 text={tip}>
          <Info size={11} style={{ color: C.muted, cursor:"help" }} />
        </Tooltip2>
      )}
    </span>
  );
}

function Slider({ label, tip, value, onChange, min, max, step, fmt }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const pct = Math.max(0, Math.min(100, ((value - min) / (max - min)) * 100));

  const commitDraft = () => {
    setEditing(false);
    const raw = parseFloat(draft.replace(/[^0-9.\-]/g, ''));
    if (!isNaN(raw)) onChange(Math.max(min, Math.min(max, raw)));
  };

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
        <Label tip={tip}>{label}</Label>
        {editing ? (
          <input
            autoFocus
            type="text"
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onBlur={commitDraft}
            onKeyDown={e => { if (e.key === 'Enter') commitDraft(); if (e.key === 'Escape') setEditing(false); }}
            style={{ fontFamily:"monospace", fontSize:13, fontWeight:600, color:C.accent,
              background:C.surfaceHi, border:`1px solid ${C.accentDim}`, borderRadius:5,
              padding:"2px 7px", width:90, textAlign:"right", outline:"none" }}
          />
        ) : (
          <button
            onClick={() => { setDraft(fmt ? String(value) : String(value)); setEditing(true); }}
            title="Click to type a value"
            style={{ fontFamily:"monospace", fontSize:13, fontWeight:600, color:C.accent,
              background:"transparent", border:"none", cursor:"text", padding:"2px 4px",
              borderRadius:4, borderBottom:`1px dashed ${C.accentDim}` }}
          >
            {fmt ? fmt(value) : value}
          </button>
        )}
      </div>
      <input
        type="range" min={min} max={max} step={step} value={value}
        onChange={e => onChange(Number(e.target.value))}
        className="fc-slider"
        style={{ "--pct": `${pct}%`, "--accent": C.accent, "--track-bg": C.border, "--thumb-bg": C.bg }}
      />
      <div style={{ display:"flex", justifyContent:"space-between" }}>
        <span style={{ fontSize:10, color:C.muted }}>{fmt ? fmt(min) : min}</span>
        <span style={{ fontSize:10, color:C.muted }}>{fmt ? fmt(max) : max}</span>
      </div>
    </div>
  );
}
function RangeSlider({ label, tip, mean, sd, onMeanChange, onSdChange,
  meanMin, meanMax, meanStep, sdMin, sdMax, sdStep, fmt, showMean=true }) {
  const [editingMean, setEditingMean] = useState(false);
  const [editingSd,   setEditingSd]   = useState(false);
  const [draftMean, setDraftMean] = useState('');
  const [draftSd,   setDraftSd]   = useState('');

  const mR   = meanMax - meanMin;
  const mPct = mR > 0 ? clamp(((mean - meanMin) / mR) * 100, 0, 100) : 50;
  const sR   = sdMax - sdMin;
  const sPct = sR > 0 ? clamp(((sd - sdMin) / sR) * 100, 0, 100) : 0;

  const commitMean = () => {
    setEditingMean(false);
    const raw = parseFloat(draftMean.replace(/[^0-9.\-]/g, ''));
    if (!isNaN(raw)) onMeanChange(clamp(raw, meanMin, meanMax));
  };
  const commitSd = () => {
    setEditingSd(false);
    const raw = parseFloat(draftSd.replace(/[^0-9.\-]/g, ''));
    if (!isNaN(raw)) onSdChange(clamp(raw, sdMin, sdMax));
  };

  const inlineInput = (draft, setDraft, commit, color="#6b7af7") => (
    <input
      autoFocus type="text" value={draft}
      onChange={e => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={e => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') { setEditingMean(false); setEditingSd(false); } }}
      style={{ fontFamily:"monospace", fontSize:11, fontWeight:600, color,
        background:C.surfaceHi, border:`1px solid ${color}55`, borderRadius:4,
        padding:"1px 6px", width:72, textAlign:"right", outline:"none" }}
    />
  );

  return (
    <div style={{ display:"flex", flexDirection:"column", gap:6, padding:"12px 14px", borderRadius:8, background:C.surfaceHi, border:`1px solid ${C.border}` }}>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
        <Label tip={tip}>{label}</Label>
        {editingMean
          ? inlineInput(draftMean, setDraftMean, commitMean, C.accent)
          : <button onClick={() => { setDraftMean(String(mean)); setEditingMean(true); }}
              style={{ fontFamily:"monospace", fontSize:12, color:C.accent, fontWeight:600,
                background:"transparent", border:"none", cursor:"text", padding:"2px 4px",
                borderRadius:4, borderBottom:`1px dashed ${C.accentDim}` }}>
              {fmt ? fmt(mean) : mean}
            </button>
        }
      </div>

      {showMean && mR > 0 && (
        <div style={{ display:"flex", flexDirection:"column", gap:4 }}>
          <span style={{ fontSize:10, color:C.muted }}>Expected value</span>
          <input type="range" min={meanMin} max={meanMax} step={meanStep} value={mean}
            onChange={e => onMeanChange(Number(e.target.value))}
            className="fc-slider"
            style={{ "--pct": `${mPct}%`, "--accent": C.accent, "--track-bg": C.border, "--thumb-bg": C.bg }}
          />
        </div>
      )}

      {sR > 0 && (
        <div style={{ display:"flex", flexDirection:"column", gap:4 }}>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
            <span style={{ fontSize:10, color:C.muted }}>Uncertainty ±1σ</span>
            {editingSd
              ? inlineInput(draftSd, setDraftSd, commitSd, "#6b7af7")
              : <button onClick={() => { setDraftSd(String(sd)); setEditingSd(true); }}
                  style={{ fontFamily:"monospace", fontSize:10, color:"#6b7af7",
                    background:"transparent", border:"none", cursor:"text", padding:"2px 4px",
                    borderRadius:4, borderBottom:"1px dashed rgba(107,122,247,0.4)" }}>
                  ±{fmt ? fmt(sd) : sd}
                </button>
            }
          </div>
          <input type="range" min={sdMin} max={sdMax} step={sdStep} value={sd}
            onChange={e => onSdChange(Number(e.target.value))}
            className="fc-slider fc-slider--indigo"
            style={{ "--pct": `${sPct}%`, "--accent": "#6b7af7", "--track-bg": C.border, "--thumb-bg": C.bg }}
          />
          {showMean && sd > 0 && (
            <div style={{ display:"flex", gap:4, fontSize:10, color:C.muted, flexWrap:"wrap" }}>
              <span>68% of trials:</span>
              <span style={{ color:"#6b7af7", fontFamily:"monospace" }}>{fmt ? fmt(mean - sd) : mean - sd}</span>
              <span>–</span>
              <span style={{ color:"#6b7af7", fontFamily:"monospace" }}>{fmt ? fmt(mean + sd) : mean + sd}</span>
            </div>
          )}
          {!showMean && sd > 0 && (
            <div style={{ fontSize:10, color:C.muted }}>
              68% of trials within <span style={{ color:"#6b7af7" }}>±{fmt ? fmt(sd) : sd}</span> of your input
            </div>
          )}
        </div>
      )}
    </div>
  );
}
function StatCard({ icon: Icon, label, value, sub, accent=false, warn=false, tip }) {
  const color = warn ? C.danger : accent ? C.accent : C.white;
  return (
    <div style={{ padding:"20px 22px", borderRadius:12, background:C.surface, border:`1px solid ${C.border}`, display:"flex", flexDirection:"column", gap:10, position:"relative", overflow:"hidden", minWidth:0 }}>
      <div style={{ position:"absolute", top:0, left:0, right:0, height:1.5, background: warn?C.danger:accent?C.accent:C.border }} />
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start" }}>
        <Label tip={tip}>{label}</Label>
        <Icon size={14} style={{ color: C.muted, flexShrink:0 }} />
      </div>
      <div>
        <div style={{ fontFamily:"monospace", fontSize:22, fontWeight:700, color, lineHeight:1, letterSpacing:"-0.5px" }}>{value}</div>
        {sub && <div style={{ fontSize:11, color:C.subtle, marginTop:5, lineHeight:1.4 }}>{sub}</div>}
      </div>
    </div>
  );
}

function SectionDivider({ label }) {
  return (
    <div style={{ display:"flex", alignItems:"center", gap:10, margin:"4px 0" }}>
      <div style={{ flex:1, height:1, background:C.border }} />
      <span style={{ fontSize:10, color:C.muted, letterSpacing:"0.1em", textTransform:"uppercase", fontWeight:500, whiteSpace:"nowrap" }}>{label}</span>
      <div style={{ flex:1, height:1, background:C.border }} />
    </div>
  );
}

function Accordion({ title, icon: Icon, children, defaultOpen=false, badge=null }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div style={{ border:`1px solid ${C.border}`, borderRadius:10, overflow:"hidden" }}>
      <button onClick={()=>setOpen(o=>!o)}
        style={{ width:"100%", display:"flex", alignItems:"center", gap:10, padding:"13px 16px",
          background: open?C.surfaceHi:C.surface, border:"none", cursor:"pointer", textAlign:"left" }}>
        {Icon && <Icon size={13} style={{ color: open?C.accent:C.muted, flexShrink:0 }} />}
        <span style={{ flex:1, fontSize:12, fontWeight:600, color: open?C.primary:C.secondary, letterSpacing:"0.02em" }}>{title}</span>
        {badge && <span style={{ fontSize:10, color:C.accent, fontFamily:"monospace", background:C.accentGlow, padding:"2px 7px", borderRadius:20, border:`1px solid ${C.accentDim}` }}>{badge}</span>}
        {open ? <ChevronDown size={13} style={{ color:C.muted }} /> : <ChevronRight size={13} style={{ color:C.muted }} />}
      </button>
      {open && (
        <div style={{ padding:"16px", background:C.surface, borderTop:`1px solid ${C.border}`, display:"flex", flexDirection:"column", gap:18 }}>
          {children}
        </div>
      )}
    </div>
  );
}

// ─── Chart Tooltip ────────────────────────────────────────────────────────────
function ChartTip({ active, payload, label, xLabel="Age" }) {
  if (!active || !payload?.length) return null;
  const entries = payload.filter(p=>p.value!=null&&p.name&&!p.name.startsWith("_"));
  return (
    <div style={{ background:"#161616", border:`1px solid ${C.border}`, borderRadius:10, padding:"12px 16px", boxShadow:"0 12px 40px rgba(0,0,0,0.7)", minWidth:180 }}>
      <div style={{ fontSize:11, color:C.secondary, marginBottom:10, letterSpacing:"0.05em" }}>{xLabel} {label}</div>
      {entries.map((p,i)=>(
        <div key={i} style={{ display:"flex", justifyContent:"space-between", alignItems:"center", gap:16, marginBottom:6 }}>
          <div style={{ display:"flex", alignItems:"center", gap:6 }}>
            <div style={{ width:6, height:6, borderRadius:"50%", background:p.color, flexShrink:0 }} />
            <span style={{ fontSize:11, color:C.secondary }}>{p.name}</span>
          </div>
          <span style={{ fontFamily:"monospace", fontSize:12, fontWeight:600, color:p.color }}>{typeof p.value==="number"?fmtD(p.value):p.value}</span>
        </div>
      ))}
    </div>
  );
}

const AXIS_PROPS = {
  tick:{ fill:C.subtle, fontSize:10 },
  axisLine:{ stroke:C.border },
  tickLine:false,
};

// ─── Chart Views ──────────────────────────────────────────────────────────────
function C1_Det({ data, retireAge }) {
  return (
    <ResponsiveContainer width="100%" height={300}>
      <AreaChart data={data} margin={{top:10,right:4,left:4,bottom:0}}>
        <defs>
          <linearGradient id="gP" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={C.accent} stopOpacity={0.18}/>
            <stop offset="100%" stopColor={C.accent} stopOpacity={0}/>
          </linearGradient>
          <linearGradient id="gN" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={C.warn} stopOpacity={0.12}/>
            <stop offset="100%" stopColor={C.warn} stopOpacity={0}/>
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="2 4" stroke={C.border} />
        <XAxis dataKey="age" {...AXIS_PROPS} />
        <YAxis {...AXIS_PROPS} tickFormatter={fmtD} width={62} />
        <Tooltip content={<ChartTip/>}/>
        <Legend wrapperStyle={{fontSize:11,color:C.subtle,paddingTop:12}}/>
        <Area type="monotone" dataKey="needed" stroke={C.warn} strokeWidth={1.5} fill="url(#gN)" name="Needed" dot={false}/>
        <Area type="monotone" dataKey="portfolio" stroke={C.accent} strokeWidth={2} fill="url(#gP)" name="Portfolio" dot={false}/>
        <ReferenceLine x={retireAge} stroke={C.muted} strokeDasharray="4 4"
          label={{value:`Retire`,position:"insideTopRight",fill:C.subtle,fontSize:10}}/>
      </AreaChart>
    </ResponsiveContainer>
  );
}

function C1_MC({ mcData, detData, retireAge }) {
  const merged = mcData.map(d=>{
    const det = detData.find(x=>x.age===d.age)||{};
    return { ...d, needed: det.needed||0 };
  });
  return (
    <ResponsiveContainer width="100%" height={300}>
      <ComposedChart data={merged} margin={{top:10,right:4,left:4,bottom:0}}>
        <defs>
          <linearGradient id="mOuter" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#6b7af7" stopOpacity={0.1}/>
            <stop offset="100%" stopColor="#6b7af7" stopOpacity={0.02}/>
          </linearGradient>
          <linearGradient id="mInner" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#6b7af7" stopOpacity={0.22}/>
            <stop offset="100%" stopColor="#6b7af7" stopOpacity={0.06}/>
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="2 4" stroke={C.border}/>
        <XAxis dataKey="age" {...AXIS_PROPS}/>
        <YAxis {...AXIS_PROPS} tickFormatter={fmtD} width={62}/>
        <Tooltip content={<ChartTip/>}/>
        <Area type="monotone" dataKey="outer_hi" stroke="none" fill="url(#mOuter)" name="_oh" legendType="none"/>
        <Area type="monotone" dataKey="outer_lo" stroke="none" fill={C.bg} name="_ol" legendType="none"/>
        <Area type="monotone" dataKey="inner_hi" stroke="rgba(107,122,247,0.3)" strokeWidth={0.5} fill="url(#mInner)" name="_ih" legendType="none"/>
        <Area type="monotone" dataKey="inner_lo" stroke="rgba(107,122,247,0.3)" strokeWidth={0.5} fill={C.bg} name="_il" legendType="none"/>
        <Line type="monotone" dataKey="p50" stroke="#6b7af7" strokeWidth={2} dot={false} name="Median"/>
        <Line type="monotone" dataKey="p5"  stroke="#6b7af7" strokeWidth={0.75} strokeDasharray="3 4" dot={false} name="5th %ile"/>
        <Line type="monotone" dataKey="p95" stroke="#6b7af7" strokeWidth={0.75} strokeDasharray="3 4" dot={false} name="95th %ile"/>
        <Line type="monotone" dataKey="needed" stroke={C.warn} strokeWidth={1.5} dot={false} name="Needed"/>
        <ReferenceLine x={retireAge} stroke={C.muted} strokeDasharray="4 4"
          label={{value:"Retire",position:"insideTopRight",fill:C.subtle,fontSize:10}}/>
      </ComposedChart>
    </ResponsiveContainer>
  );
}

function C2_Savings({ data }) {
  return (
    <ResponsiveContainer width="100%" height={300}>
      <BarChart data={data} margin={{top:10,right:4,left:4,bottom:20}}>
        <CartesianGrid strokeDasharray="2 4" stroke={C.border} vertical={false}/>
        <XAxis dataKey="retireAge" {...AXIS_PROPS} label={{value:"Retirement Age",position:"insideBottom",offset:-8,fill:C.muted,fontSize:10}}/>
        <YAxis {...AXIS_PROPS} tickFormatter={fmtD} width={62}/>
        <Tooltip content={<ChartTip xLabel="Retire Age"/>}/>
        <Bar dataKey="reqSavings" name="Save / Yr" fill={C.accent} radius={[3,3,0,0]}
          label={{position:"top",formatter:v=>v>0?fmtD(v):"✓",fill:C.accentDim,fontSize:9}}/>
      </BarChart>
    </ResponsiveContainer>
  );
}

function C3_Spend({ data }) {
  return (
    <ResponsiveContainer width="100%" height={300}>
      <LineChart data={data} margin={{top:10,right:4,left:4,bottom:20}}>
        <CartesianGrid strokeDasharray="2 4" stroke={C.border}/>
        <XAxis dataKey="retireAge" {...AXIS_PROPS} label={{value:"Retirement Age",position:"insideBottom",offset:-8,fill:C.muted,fontSize:10}}/>
        <YAxis {...AXIS_PROPS} tickFormatter={fmtD} width={62}/>
        <Tooltip content={<ChartTip xLabel="Retire Age"/>}/>
        <Legend wrapperStyle={{fontSize:11,color:C.subtle,paddingTop:12}}/>
        <Line type="monotone" dataKey="affordableSpend" stroke={C.accent} strokeWidth={2.5} dot={{fill:C.accent,r:3}} name="Sustainable Spend"/>
        <Line type="monotone" dataKey="targetSpend" stroke={C.subtle} strokeWidth={1.5} strokeDasharray="5 4" dot={false} name="Your Target"/>
      </LineChart>
    </ResponsiveContainer>
  );
}

function C4_NestEgg({ data }) {
  return (
    <ResponsiveContainer width="100%" height={300}>
      <AreaChart data={data} margin={{top:10,right:4,left:4,bottom:20}}>
        <defs>
          <linearGradient id="gNE" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={C.warn} stopOpacity={0.15}/><stop offset="100%" stopColor={C.warn} stopOpacity={0}/>
          </linearGradient>
          <linearGradient id="gPE" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={C.accent} stopOpacity={0.12}/><stop offset="100%" stopColor={C.accent} stopOpacity={0}/>
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="2 4" stroke={C.border}/>
        <XAxis dataKey="retireAge" {...AXIS_PROPS} label={{value:"Retirement Age",position:"insideBottom",offset:-8,fill:C.muted,fontSize:10}}/>
        <YAxis {...AXIS_PROPS} tickFormatter={fmtD} width={62}/>
        <Tooltip content={<ChartTip xLabel="Retire Age"/>}/>
        <Legend wrapperStyle={{fontSize:11,color:C.subtle,paddingTop:12}}/>
        <Area type="monotone" dataKey="required" stroke={C.warn} strokeWidth={1.5} fill="url(#gNE)" name="Nest Egg Needed" dot={false}/>
        <Area type="monotone" dataKey="projectedAtRetire" stroke={C.accent} strokeWidth={2} fill="url(#gPE)" name="Projected Portfolio" dot={false}/>
      </AreaChart>
    </ResponsiveContainer>
  );
}

// ─── Main App ─────────────────────────────────────────────────────────────────
export default function App() {
  // Core
  const [currentAge,    setCurrentAge]    = useState(30);
  const [portfolio,     setPortfolio]     = useState(100000);
  const [spendToday,    setSpendToday]    = useState(75000);
  const [savingsNow,    setSavingsNow]    = useState(15000);
  const [savingsGrowth, setSavingsGrowth] = useState(0.05);
  const [returnRate,    setReturnRate]    = useState(0.08);
  const [inflationRate, setInflationRate] = useState(0.027);
  const [retireAge,     setRetireAge]     = useState(60);
  const [deathAge,      setDeathAge]      = useState(90);

  // Advanced: Social Security
  const [ssMonthly,    setSsMonthly]    = useState(0);
  const [ssStartAge,   setSsStartAge]   = useState(67);
  // Advanced: Other income
  const [otherIncome,  setOtherIncome]  = useState(0);
  // Advanced: Tax
  const [taxRate,      setTaxRate]      = useState(0.22);
  const [rothPct,      setRothPct]      = useState(0.5); // fraction of portfolio that's Roth
  // Advanced: Healthcare
  const [healthcareCost, setHealthcareCost] = useState(0);
  // Advanced: Mortgage
  const [mortgagePayoff,  setMortgagePayoff]  = useState(0); // year payoff happens (0=none)
  // Advanced: One-time expenses (simplified as total)
  const [oneTimeTotal, setOneTimeTotal] = useState(0);
  const [oneTimeAge,   setOneTimeAge]   = useState(45);
  // Advanced: Part-time income post-retire
  const [partTimeIncome,    setPartTimeIncome]    = useState(0);
  const [partTimeUntilAge,  setPartTimeUntilAge]  = useState(70);

  // MC
  const [advancedMode, setAdvancedMode] = useState(false);
  const [rR_sd,    setRR_sd]    = useState(0.03);
  const [inf_sd,   setInf_sd]   = useState(0.01);
  const [sg_sd,    setSg_sd]    = useState(0.015);
  const [spend_sd, setSpend_sd] = useState(0.1);
  const [sav_sd,   setSav_sd]   = useState(0.1);
  const [mcTrials, setMcTrials] = useState(2000);
  const [mcResults,  setMcResults]  = useState(null);
  const [mcRunning,  setMcRunning]  = useState(false);
  const [activeChart, setActiveChart] = useState(0);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  const safeRetire = clamp(retireAge, currentAge+1, deathAge-1);
  const safeDeath  = clamp(deathAge,  retireAge+1,  105);

  // Effective spend (after healthcare, tax grossup, net of part-time if retired)
  const effectiveSpend = useMemo(() => {
    let s = spendToday + (healthcareCost || 0);
    // Part-time income offsets spend in early retirement — handled in timeline
    return s;
  }, [spendToday, healthcareCost]);

  // Annual SS + other income offset (today's $)
  const totalIncomeOffset = useMemo(() => {
    let inc = otherIncome || 0;
    // Part-time: added via timeline builder
    return inc;
  }, [otherIncome]);

  // Build timeline params helper
  const tlParams = useCallback((rAge=safeRetire) => ({
    currentAge, portfolio,
    spendToday: effectiveSpend,
    savingsNow, savingsGrowth,
    r: returnRate, inflation: inflationRate,
    retireAge: rAge, deathAge: safeDeath,
    ssMonthly: ssMonthly,
    ssStartAge,
    otherIncome: (otherIncome||0) + (partTimeIncome||0) / 2, // rough avg
    oneTimeExpenses: oneTimeTotal>0?[{age:oneTimeAge,amount:oneTimeTotal}]:[],
  }), [currentAge,portfolio,effectiveSpend,savingsNow,savingsGrowth,returnRate,inflationRate,safeRetire,safeDeath,ssMonthly,ssStartAge,otherIncome,partTimeIncome,oneTimeAge,oneTimeTotal]);

  // Summary calcs
  const yrs     = safeRetire - currentAge;
  const yrsRet  = safeDeath  - safeRetire;

  // Effective need: subtract SS and other income PV from gross need
  const grossNeed = neededAtRetirement(effectiveSpend, inflationRate, returnRate, yrsRet);
  // PV of SS income stream starting at ssStartAge
  const ssOffset = useMemo(() => {
    if (!ssMonthly || ssStartAge >= safeDeath) return 0;
    const yrsToSS = Math.max(0, ssStartAge - safeRetire);
    const ssYears = safeDeath - Math.max(ssStartAge, safeRetire);
    const ssAnnual = ssAnnualBenefit(ssMonthly);
    const pv = neededAtRetirement(ssAnnual, inflationRate, returnRate, ssYears);
    return fvLump(pv, returnRate, -yrsToSS); // discount back to retirement date
  }, [ssMonthly, ssStartAge, safeRetire, safeDeath, inflationRate, returnRate]);

  const otherOffset = useMemo(() => {
    const oi = (otherIncome||0) + (partTimeIncome||0)/2;
    if (!oi) return 0;
    return neededAtRetirement(oi, inflationRate, returnRate, yrsRet) * 0.6;
  }, [otherIncome, partTimeIncome, inflationRate, returnRate, yrsRet]);

  const neededNow  = Math.max(0, grossNeed - ssOffset - otherOffset);
  const projAtRetire = fvLump(portfolio, returnRate, yrs) + fvGA(savingsNow, returnRate, savingsGrowth, yrs);
  const oneTimeFV  = oneTimeTotal>0 ? fvLump(oneTimeTotal, returnRate, Math.max(0, oneTimeAge-currentAge)) : 0;
  const adjustedNeed = neededNow + oneTimeFV;
  const reqSavingsNow = Math.max(0, solveS(adjustedNeed, portfolio, returnRate, savingsGrowth, yrs));
  const onTrack    = projAtRetire >= adjustedNeed;
  const wdRate     = withdrawalRate(effectiveSpend, projAtRetire);
  const spendAtRetire = effectiveSpend * Math.pow(1+inflationRate, yrs);

  // Coast FIRE
  const coastFIREAge = useMemo(() => {
    for (let a=currentAge; a<=safeRetire; a++) {
      const fvC = fvLump(fvLump(portfolio,returnRate,a-currentAge), returnRate, safeRetire-a);
      if (fvC >= adjustedNeed) return a;
    }
    return null;
  }, [currentAge,portfolio,returnRate,safeRetire,adjustedNeed]);

  const timelineData = useMemo(()=>buildTimeline(tlParams(safeRetire)), [tlParams, safeRetire]);

  const scenarioAges = useMemo(()=>{
    const ages=[];
    const start=Math.ceil((currentAge+5)/5)*5;
    for (let a=start; a<=Math.min(75,safeDeath-5); a+=5) ages.push(a);
    return ages;
  },[currentAge,safeDeath]);

  const scenarioData = useMemo(()=>scenarioAges.map(rAge=>{
    const y=rAge-currentAge, yr=safeDeath-rAge;
    const req=neededAtRetirement(effectiveSpend,inflationRate,returnRate,yr);
    const proj=fvLump(portfolio,returnRate,y)+fvGA(savingsNow,returnRate,savingsGrowth,y);
    const reqS=Math.max(0,solveS(req,portfolio,returnRate,savingsGrowth,y));
    const aff=maxSpend(proj,inflationRate,returnRate,yr);
    const gap=Math.max(0,req-proj);
    const succ=mcResults?.scenarioSuccessRates?.[rAge]??null;
    return {retireAge:rAge,required:req,projectedAtRetire:proj,reqSavings:reqS,
      affordableSpend:aff,gap,canRetire:gap<=0,targetSpend:effectiveSpend,successProb:succ};
  }),[scenarioAges,currentAge,portfolio,effectiveSpend,savingsNow,savingsGrowth,returnRate,inflationRate,safeDeath,mcResults]);

  // MC success
  const mcSuccessRate = mcResults?.successRate ?? null;

  const buildRanges = useCallback(()=>({
    returnRate:    {mean:returnRate,    sd:rR_sd},
    inflation:     {mean:inflationRate, sd:inf_sd},
    savingsGrowth: {mean:savingsGrowth, sd:sg_sd},
    spendMult:     {sd:spend_sd},
    savingsMult:   {sd:sav_sd},
    annualVolatility:{mean:0.14},
    spendToday:effectiveSpend,
  }),[returnRate,rR_sd,inflationRate,inf_sd,savingsGrowth,sg_sd,spend_sd,sav_sd,effectiveSpend]);

  const runSimulation = useCallback(()=>{
    setMcRunning(true);
    setTimeout(()=>{
      try {
        const ranges=buildRanges();
        const main=runMC({currentAge,portfolio,spendToday:effectiveSpend,savingsNow,
          deathAge:safeDeath,retireAge:safeRetire,ranges,ssMonthly,ssStartAge,
          otherIncome:(otherIncome||0)+(partTimeIncome||0)/2,trials:mcTrials});
        const scenarioSuccessRates={};
        for (const rAge of scenarioAges) {
          scenarioSuccessRates[rAge]=scenarioMC({portfolio,savingsNow,deathAge:safeDeath,
            retireAge:rAge,currentAge,ranges:{...ranges,spendToday:effectiveSpend},
            ssMonthly,ssStartAge,otherIncome:(otherIncome||0)+(partTimeIncome||0)/2,trials:300});
        }
        setMcResults({...main,scenarioSuccessRates,ranAt:Date.now()});
      } finally { setMcRunning(false); }
    },30);
  },[currentAge,portfolio,effectiveSpend,savingsNow,safeDeath,safeRetire,mcTrials,scenarioAges,buildRanges,ssMonthly,ssStartAge,otherIncome,partTimeIncome]);

  const CHARTS=[
    {label:"Portfolio",     icon:Activity,  key:"portfolio"},
    {label:"Savings Needed",icon:DollarSign,key:"savings"},
    {label:"Max Spend",     icon:TrendingUp,key:"spend"},
    {label:"Nest Egg",      icon:Target,    key:"nestegg"},
  ];
  const chartDescs=[
    `Your portfolio balance from today to age ${safeDeath}. Gold = balance; amber = amount needed to retire. The line falls after retirement as you draw down.`,
    "Annual savings needed now (today's dollars, growing with income) to retire at each age. Earlier retirement demands more saving.",
    "What you can sustainably spend per year with your current savings rate, vs. your spending target.",
    "Total nest egg needed (amber) vs. projected portfolio (gold) at each retirement age. Where gold ≥ amber, you can retire.",
  ];

  // Sensitivity: which variable moves retirement age most?
  const sensitivity = useMemo(()=>{
    const base = safeRetire;
    const tests = [
      {label:"Save +$5K/yr", age:()=>{ for(let a=currentAge+1;a<=80;a++){const y=a-currentAge;const p=fvLump(portfolio,returnRate,y)+fvGA(savingsNow+5000,returnRate,savingsGrowth,y);const n=neededAtRetirement(effectiveSpend,inflationRate,returnRate,safeDeath-a);if(p>=n)return a;}return 80;}},
      {label:"Spend -$10K/yr", age:()=>{ for(let a=currentAge+1;a<=80;a++){const y=a-currentAge;const p=fvLump(portfolio,returnRate,y)+fvGA(savingsNow,returnRate,savingsGrowth,y);const n=neededAtRetirement(effectiveSpend-10000,inflationRate,returnRate,safeDeath-a);if(p>=n)return a;}return 80;}},
      {label:"Return +1%", age:()=>{ for(let a=currentAge+1;a<=80;a++){const y=a-currentAge;const p=fvLump(portfolio,returnRate+0.01,y)+fvGA(savingsNow,returnRate+0.01,savingsGrowth,y);const n=neededAtRetirement(effectiveSpend,inflationRate,returnRate+0.01,safeDeath-a);if(p>=n)return a;}return 80;}},
    ];
    return tests.map(t=>({label:t.label,age:t.age(),delta:base-t.age()}));
  },[currentAge,portfolio,returnRate,savingsNow,savingsGrowth,effectiveSpend,inflationRate,safeDeath,safeRetire]);

  return (
    <div style={{minHeight:"100vh",background:C.bg,color:C.primary,fontFamily:"'Inter',system-ui,sans-serif"}}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap');
        * { box-sizing: border-box; margin:0; padding:0; }
        ::selection { background: rgba(212,175,122,0.25); }
        ::-webkit-scrollbar { width:4px; height:4px; }
        ::-webkit-scrollbar-track { background:#0a0a0a; }
        ::-webkit-scrollbar-thumb { background:#2a2a2a; border-radius:2px; }
        /* ── Slider styling ── */
        .fc-slider {
          -webkit-appearance: none;
          appearance: none;
          width: 100%;
          height: 4px;
          border-radius: 2px;
          outline: none;
          cursor: pointer;
          background: linear-gradient(
            to right,
            var(--accent) var(--pct),
            #2a2a2a var(--pct)
          );
        }
        .fc-slider::-webkit-slider-thumb {
          -webkit-appearance: none;
          appearance: none;
          width: 14px;
          height: 14px;
          border-radius: 50%;
          background: var(--accent);
          border: 2px solid var(--thumb-bg, #0a0a0a);
          box-shadow: 0 0 0 2px var(--accent);
          cursor: pointer;
          transition: box-shadow 0.15s;
        }
        .fc-slider::-webkit-slider-thumb:hover {
          box-shadow: 0 0 0 4px color-mix(in srgb, var(--accent) 30%, transparent);
        }
        .fc-slider::-moz-range-thumb {
          width: 14px;
          height: 14px;
          border-radius: 50%;
          background: var(--accent);
          border: 2px solid var(--thumb-bg, #0a0a0a);
          box-shadow: 0 0 0 2px var(--accent);
          cursor: pointer;
        }
        .fc-slider::-moz-range-track {
          height: 4px;
          border-radius: 2px;
          background: linear-gradient(
            to right,
            var(--accent) var(--pct),
            #2a2a2a var(--pct)
          );
        }
        .fade-in { animation: fi 0.2s ease; }
        @keyframes fi { from{opacity:0;transform:translateY(4px)} to{opacity:1;transform:translateY(0)} }
        @media (max-width:1024px) { .main-grid { grid-template-columns: 1fr !important; } }
        @media (max-width:640px) { .stat-grid { grid-template-columns: 1fr 1fr !important; } .chart-tabs { overflow-x: auto; } }
      `}</style>

      {/* Header */}
      <header style={{position:"sticky",top:0,zIndex:50,background:"rgba(10,10,10,0.92)",backdropFilter:"blur(20px)",borderBottom:`1px solid ${C.border}`}}>
        <div style={{maxWidth:1400,margin:"0 auto",padding:"0 24px",height:56,display:"flex",alignItems:"center",justifyContent:"space-between"}}>
          <div style={{display:"flex",alignItems:"center",gap:10}}>
            <div style={{width:28,height:28,borderRadius:7,background:C.accent,display:"flex",alignItems:"center",justifyContent:"center"}}>
              <TrendingUp size={14} color={C.bg} strokeWidth={2.5}/>
            </div>
            <span style={{fontSize:15,fontWeight:700,letterSpacing:"-0.3px",color:C.white}}>FireCalc</span>
          </div>
          <div style={{display:"flex",alignItems:"center",gap:10}}>
            <button onClick={()=>{setAdvancedMode(a=>!a);setMcResults(null);}}
              style={{display:"flex",alignItems:"center",gap:6,padding:"7px 14px",borderRadius:8,border:`1px solid ${advancedMode?C.accentDim:C.border}`,background:advancedMode?C.accentGlow:"transparent",color:advancedMode?C.accent:C.secondary,fontSize:12,fontWeight:500,cursor:"pointer",transition:"all 0.15s"}}>
              <Zap size={12}/> {advancedMode?"Monte Carlo On":"Monte Carlo"}
            </button>
          </div>
        </div>
      </header>

      <div style={{maxWidth:1400,margin:"0 auto",padding:"28px 24px 40px",display:"flex",flexDirection:"column",gap:24}}>

        {/* Stat Cards */}
        <div className="stat-grid" style={{display:"grid",gridTemplateColumns:"repeat(6,1fr)",gap:12}}>
          <StatCard icon={Calendar} label="Retire Age" value={`Age ${safeRetire}`} sub={`${safeRetire-currentAge} yrs away`}
            tip="Your selected target retirement age."/>
          <StatCard icon={Target} label="Nest Egg Needed" value={fmtD(adjustedNeed)} sub={`By age ${safeRetire}`}
            accent tip={`Portfolio needed at ${safeRetire} to fund ${fmtD(effectiveSpend)}/yr until age ${safeDeath}.`}/>
          <StatCard icon={TrendingUp} label={onTrack?"On Track":"Projected"} value={fmtD(projAtRetire)}
            sub={onTrack?`Surplus ${fmtD(projAtRetire-adjustedNeed)}`:`Gap ${fmtD(adjustedNeed-projAtRetire)}`}
            warn={!onTrack} accent={onTrack} tip="Projected portfolio at your target retirement age."/>
          <StatCard icon={Wallet} label="Save / Year Now" value={reqSavingsNow===0?"On Track":fmtD(reqSavingsNow)}
            sub={`Grows ${fmtPct(savingsGrowth)}/yr`}
            tip={`Annual savings needed this year to hit your goal by age ${safeRetire}.`}/>
          <StatCard icon={Clock} label="Coast FIRE Age" value={coastFIREAge?`Age ${coastFIREAge}`:"—"}
            sub={`Stop saving, coast to ${safeRetire}`}
            tip="Age at which you can stop saving — your portfolio grows to meet the goal on its own."/>
          <StatCard icon={Shield} label={advancedMode&&mcSuccessRate!==null?"Success Rate":"Withdrawal Rate"}
            value={advancedMode&&mcSuccessRate!==null?`${mcSuccessRate}%`:fmtPct(wdRate)}
            sub={advancedMode&&mcSuccessRate!==null?`${mcTrials.toLocaleString()} MC trials`:`of portfolio / yr`}
            warn={(advancedMode&&mcSuccessRate!==null&&mcSuccessRate<60)||(!advancedMode&&wdRate>0.05)}
            accent={(advancedMode&&mcSuccessRate!==null&&mcSuccessRate>=80)||(!advancedMode&&wdRate<=0.04)}
            tip={advancedMode?"Monte Carlo success probability — money lasts to end age.":"Annual withdrawal as % of portfolio. 4% or below is considered safe."}/>
        </div>

        {/* Main grid */}
        <div className="main-grid" style={{display:"grid",gridTemplateColumns:"340px 1fr",gap:20,alignItems:"start"}}>

          {/* Left column: inputs */}
          <div style={{display:"flex",flexDirection:"column",gap:14}}>

            {/* Core inputs */}
            <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:14,padding:"22px 20px",display:"flex",flexDirection:"column",gap:22}}>
              <SectionDivider label="Your Situation"/>
              <Slider label="Current Age" value={currentAge} onChange={setCurrentAge} min={18} max={65} step={1} fmt={v=>`${v} yrs`} tip="How old you are today."/>
              <Slider label="Current Portfolio" value={portfolio} onChange={setPortfolio} min={0} max={3000000} step={5000} fmt={fmtD} tip="Total invested assets — 401k, IRA, brokerage. Excludes cash and home equity."/>
              <Slider label="Annual Spend in Retirement" value={spendToday} onChange={setSpendToday} min={20000} max={400000} step={2500} fmt={fmtD} tip="How much you want to spend each year in retirement, in today's dollars. Grows with inflation automatically."/>
              <Slider label="You Save This Year" value={savingsNow} onChange={setSavingsNow} min={0} max={150000} step={500} fmt={fmtD} tip="Your current annual savings contribution. Grows with your income each year."/>
              <Slider label="Annual Income Growth" value={savingsGrowth} onChange={setSavingsGrowth} min={0} max={0.15} step={0.005} fmt={fmtPct} tip="How fast your savings contributions grow year-over-year — roughly your expected salary growth."/>

              <SectionDivider label="Assumptions"/>
              <Slider label="Expected Annual Return" value={returnRate} onChange={setReturnRate} min={0.02} max={0.15} step={0.005} fmt={fmtPct} tip="Average annual investment return. The S&P 500 has averaged ~10% historically. Use 6–8% for a conservative estimate."/>
              <Slider label="Expected Annual Inflation" value={inflationRate} onChange={setInflationRate} min={0.01} max={0.08} step={0.005} fmt={fmtPct} tip="Long-term inflation rate. Fed target is 2%; long-run US average is ~2.7%."/>

              <SectionDivider label="Retirement Plan"/>
              <Slider label="Target Retirement Age" value={safeRetire} onChange={v=>{setRetireAge(v);if(v>=deathAge)setDeathAge(v+5);}} min={currentAge+1} max={80} step={1} fmt={v=>`Age ${v}`} tip="When you want to stop working. Every card updates instantly."/>
              <Slider label="Age Money Must Last Until" value={safeDeath} onChange={v=>{setDeathAge(v);if(v<=retireAge)setRetireAge(v-5);}} min={70} max={105} step={1} fmt={v=>`Age ${v}`} tip="How long your retirement savings need to last. Longer is always safer."/>
            </div>

            {/* Advanced: Social Security */}
            <Accordion title="Social Security" icon={User} badge={ssMonthly>0?fmtD(ssAnnualBenefit(ssMonthly))+"/yr":null}>
              <div style={{display:"flex",flexDirection:"column",gap:18}}>
                <Slider label="Expected Monthly Benefit" value={ssMonthly} onChange={setSsMonthly} min={0} max={5000} step={50} fmt={v=>v===0?"None":`$${v.toLocaleString()}/mo`}
                  tip="Your estimated Social Security benefit at your start age. Check ssa.gov for your personalized estimate."/>
                <Slider label="Start Collecting at Age" value={ssStartAge} onChange={setSsStartAge} min={62} max={70} step={1} fmt={v=>`Age ${v}`}
                  tip="Age 62 = reduced benefit, 67 = full retirement age, 70 = maximum benefit (8% more per year you delay past FRA)."/>
                {ssMonthly>0&&<div style={{padding:"10px 12px",borderRadius:8,background:C.accentGlow,border:`1px solid ${C.accentDim}`,fontSize:11,color:C.accent}}>
                  Reduces your required nest egg by ~<strong>{fmtD(ssOffset)}</strong>
                </div>}
              </div>
            </Accordion>

            {/* Advanced: Additional Income */}
            <Accordion title="Retirement Income" icon={Briefcase} badge={(otherIncome>0||partTimeIncome>0)?fmtD((otherIncome||0)+(partTimeIncome||0))+"/yr":null}>
              <div style={{display:"flex",flexDirection:"column",gap:18}}>
                <Slider label="Other Annual Income" value={otherIncome} onChange={setOtherIncome} min={0} max={100000} step={500} fmt={v=>v===0?"None":fmtD(v)+"/yr"}
                  tip="Pension, rental income, annuity, or any other guaranteed income in retirement. In today's dollars."/>
                <Slider label="Part-Time Work Income" value={partTimeIncome} onChange={setPartTimeIncome} min={0} max={80000} step={500} fmt={v=>v===0?"None":fmtD(v)+"/yr"}
                  tip="Income from part-time or consulting work in early retirement. Averaged over your retirement years in the model."/>
                <Slider label="Work Until Age" value={partTimeUntilAge} onChange={setPartTimeUntilAge} min={safeRetire} max={Math.min(80,safeDeath-5)} step={1} fmt={v=>`Age ${v}`}
                  tip="Age at which you stop part-time work."/>
              </div>
            </Accordion>

            {/* Advanced: Tax */}
            <Accordion title="Tax Modeling" icon={Layers}>
              <div style={{display:"flex",flexDirection:"column",gap:18}}>
                <div style={{padding:"10px 12px",borderRadius:8,background:C.surfaceHi,border:`1px solid ${C.border}`,fontSize:11,color:C.secondary,lineHeight:1.5}}>
                  Tax modeling adjusts your effective withdrawal rate. Traditional (pre-tax) withdrawals are taxed as ordinary income; Roth withdrawals are tax-free.
                </div>
                <Slider label="Effective Tax Rate in Retirement" value={taxRate} onChange={setTaxRate} min={0} max={0.4} step={0.01} fmt={fmtPct}
                  tip="Your estimated average tax rate on traditional account withdrawals. Consider state + federal combined."/>
                <Slider label="Roth Portion of Portfolio" value={rothPct} onChange={setRothPct} min={0} max={1} step={0.05} fmt={v=>`${Math.round(v*100)}%`}
                  tip="What fraction of your portfolio is in Roth accounts (tax-free withdrawals). The remainder is taxed at your effective rate."/>
                <div style={{padding:"10px 12px",borderRadius:8,background:C.accentGlow,border:`1px solid ${C.accentDim}`,fontSize:11,color:C.accent}}>
                  Tax-adjusted withdrawal rate: <strong>{fmtPct((1-rothPct)*taxRate)}</strong> effective drag on pre-tax assets
                </div>
              </div>
            </Accordion>

            {/* Advanced: Healthcare */}
            <Accordion title="Healthcare" icon={Heart} badge={healthcareCost>0?fmtD(healthcareCost)+"/yr":null}>
              <div style={{display:"flex",flexDirection:"column",gap:18}}>
                <div style={{padding:"10px 12px",borderRadius:8,background:C.surfaceHi,border:`1px solid ${C.border}`,fontSize:11,color:C.secondary,lineHeight:1.5}}>
                  Pre-Medicare healthcare (before age 65) is one of the largest early retirement wildcards. Added directly to your annual spending.
                </div>
                <Slider label="Annual Healthcare Cost" value={healthcareCost} onChange={setHealthcareCost} min={0} max={30000} step={500} fmt={v=>v===0?"None":fmtD(v)+"/yr"}
                  tip="Estimated annual cost of health insurance + out-of-pocket before Medicare at 65. Average ACA plan for early retirees can be $8K–$24K/yr."/>
              </div>
            </Accordion>

            {/* Advanced: One-time expenses */}
            <Accordion title="One-Time Expenses" icon={Home} badge={oneTimeTotal>0?fmtD(oneTimeTotal):null}>
              <div style={{display:"flex",flexDirection:"column",gap:18}}>
                <Slider label="Amount" value={oneTimeTotal} onChange={setOneTimeTotal} min={0} max={500000} step={5000} fmt={v=>v===0?"None":fmtD(v)}
                  tip="A large one-time future expense — college tuition, home renovation, a sabbatical. Added to your nest egg requirement."/>
                <Slider label="At Age" value={oneTimeAge} onChange={setOneTimeAge} min={currentAge} max={safeDeath-5} step={1} fmt={v=>`Age ${v}`}
                  tip="When this expense occurs. Earlier = more growth time for the portfolio to absorb it."/>
              </div>
            </Accordion>

            {/* Monte Carlo ranges (only in advanced mode) */}
            {advancedMode && (
              <Accordion title="Monte Carlo Uncertainty Ranges" icon={Settings} defaultOpen badge="Advanced">
                <div style={{display:"flex",flexDirection:"column",gap:14}}>
                  <div style={{padding:"10px 12px",borderRadius:8,background:C.surfaceHi,border:`1px solid ${C.border}`,fontSize:11,color:C.secondary,lineHeight:1.6}}>
                    Each simulation trial draws random values from normal distributions around your means. Set the uncertainty (±1σ) for each factor. Wider = more spread in outcomes.
                  </div>
                  <RangeSlider label="Investment Return" tip="Trial-level mean return uncertainty. Each trial gets a different average return drawn from N(mean, sd)."
                    mean={returnRate} sd={rR_sd} onMeanChange={setReturnRate} onSdChange={setRR_sd}
                    meanMin={0.02} meanMax={0.15} meanStep={0.005}
                    sdMin={0.005} sdMax={0.06} sdStep={0.005} fmt={fmtPct}/>
                  <RangeSlider label="Inflation Rate" tip="Uncertainty in long-run inflation across trials."
                    mean={inflationRate} sd={inf_sd} onMeanChange={setInflationRate} onSdChange={setInf_sd}
                    meanMin={0.01} meanMax={0.08} meanStep={0.005}
                    sdMin={0.002} sdMax={0.03} sdStep={0.002} fmt={fmtPct}/>
                  <RangeSlider label="Income Growth" tip="Uncertainty in your savings contribution growth rate."
                    mean={savingsGrowth} sd={sg_sd} onMeanChange={setSavingsGrowth} onSdChange={setSg_sd}
                    meanMin={0} meanMax={0.15} meanStep={0.005}
                    sdMin={0.005} sdMax={0.04} sdStep={0.005} fmt={fmtPct}/>
                  <RangeSlider label="Spending Variability" tip="How much your actual retirement spending might deviate from your target."
                    showMean={false}
                    mean={effectiveSpend} sd={effectiveSpend*spend_sd}
                    onMeanChange={()=>{}} onSdChange={v=>setSpend_sd(Math.max(0,v/(effectiveSpend||1)))}
                    meanMin={effectiveSpend} meanMax={effectiveSpend} meanStep={1}
                    sdMin={effectiveSpend*0.02} sdMax={effectiveSpend*0.4} sdStep={effectiveSpend*0.01}
                    fmt={fmtD}/>
                  <RangeSlider label="Savings Variability" tip="Year-to-year variability in how much you actually save."
                    showMean={false}
                    mean={savingsNow} sd={savingsNow*sav_sd}
                    onMeanChange={()=>{}} onSdChange={v=>setSav_sd(Math.max(0,v/(savingsNow||1)))}
                    meanMin={savingsNow} meanMax={savingsNow} meanStep={1}
                    sdMin={savingsNow*0.02} sdMax={savingsNow*0.5} sdStep={savingsNow*0.01}
                    fmt={fmtD}/>
                  <Slider label="Simulation Trials" value={mcTrials} onChange={setMcTrials} min={500} max={5000} step={500} fmt={v=>v.toLocaleString()}
                    tip="More trials = more accurate results. 2,000 balances speed and accuracy."/>
                  <button onClick={runSimulation} disabled={mcRunning}
                    style={{width:"100%",padding:"12px",borderRadius:9,border:"none",background:mcRunning?"#2a2a2a":C.accent,color:mcRunning?C.subtle:C.bg,fontSize:13,fontWeight:700,cursor:mcRunning?"not-allowed":"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:8,letterSpacing:"0.02em",transition:"all 0.15s"}}>
                    {mcRunning?(
                      <><svg style={{animation:"spin 1s linear infinite",width:14,height:14}} viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeOpacity="0.3"/><path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round"/></svg>Running {mcTrials.toLocaleString()} trials…</>
                    ):<><Play size={13}/> Run {mcTrials.toLocaleString()} Simulations</>}
                  </button>
                  {mcResults&&(
                    <div style={{display:"flex",justifyContent:"space-between",fontSize:10,color:C.subtle}}>
                      <span>Last run {new Date(mcResults.ranAt).toLocaleTimeString()}</span>
                      <span style={{color:mcResults.successRate>=80?C.success:mcResults.successRate>=60?C.warn:C.danger}}>Success {mcResults.successRate}%</span>
                    </div>
                  )}
                </div>
              </Accordion>
            )}
          </div>

          {/* Right column: charts + table + insight */}
          <div style={{display:"flex",flexDirection:"column",gap:16}}>

            {/* Charts */}
            <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:14,overflow:"hidden"}}>
              <div className="chart-tabs" style={{display:"flex",borderBottom:`1px solid ${C.border}`}}>
                {CHARTS.map((ch,i)=>{
                  const Icon=ch.icon;
                  return (
                    <button key={ch.key} onClick={()=>setActiveChart(i)}
                      style={{display:"flex",alignItems:"center",gap:7,padding:"13px 18px",border:"none",borderBottom:`2px solid ${activeChart===i?C.accent:"transparent"}`,background:"transparent",color:activeChart===i?C.accent:C.subtle,fontSize:12,fontWeight:activeChart===i?600:400,cursor:"pointer",whiteSpace:"nowrap",transition:"all 0.15s",flexShrink:0}}>
                      <Icon size={13}/>{ch.label}
                    </button>
                  );
                })}
              </div>
              <div style={{padding:"20px 20px 16px"}} className="fade-in" key={`${activeChart}-${advancedMode}-${mcResults?.ranAt}`}>
                <p style={{fontSize:11,color:C.subtle,marginBottom:16,lineHeight:1.6}}>{chartDescs[activeChart]}</p>
                {activeChart===0&&advancedMode&&mcResults?(
                  <>
                    <div style={{display:"flex",gap:16,marginBottom:14,flexWrap:"wrap"}}>
                      {[["5–95th %ile","rgba(107,122,247,0.15)"],["25–75th %ile","rgba(107,122,247,0.35)"],["Median","#6b7af7"],["Needed",C.warn]].map(([l,c])=>(
                        <div key={l} style={{display:"flex",alignItems:"center",gap:5,fontSize:10,color:C.subtle}}>
                          <div style={{width:20,height:3,borderRadius:2,background:c}}/>{l}
                        </div>
                      ))}
                    </div>
                    <C1_MC mcData={mcResults.timeline} detData={timelineData} retireAge={safeRetire}/>
                  </>
                ):activeChart===0?<C1_Det data={timelineData} retireAge={safeRetire}/>
                :activeChart===1?<C2_Savings data={scenarioData}/>
                :activeChart===2?<C3_Spend data={scenarioData}/>
                :<C4_NestEgg data={scenarioData}/>}
                {advancedMode&&!mcResults&&activeChart===0&&(
                  <div style={{marginTop:14,padding:"10px 14px",borderRadius:8,border:`1px solid rgba(107,122,247,0.25)`,background:"rgba(107,122,247,0.05)",fontSize:11,color:"#6b7af7",textAlign:"center"}}>
                    Run simulations to see Monte Carlo percentile bands
                  </div>
                )}
              </div>
            </div>

            {/* Sensitivity */}
            <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:14,padding:"18px 20px"}}>
              <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:16}}>
                <BarChart2 size={13} style={{color:C.muted}}/>
                <span style={{fontSize:12,fontWeight:600,color:C.secondary,letterSpacing:"0.06em",textTransform:"uppercase"}}>Sensitivity</span>
                <span style={{fontSize:11,color:C.muted}}>— which lever moves your retirement age most</span>
              </div>
              <div style={{display:"flex",flexDirection:"column",gap:10}}>
                {sensitivity.map(s=>(
                  <div key={s.label} style={{display:"flex",alignItems:"center",gap:12}}>
                    <span style={{fontSize:12,color:C.secondary,minWidth:120}}>{s.label}</span>
                    <div style={{flex:1,height:6,borderRadius:3,background:C.border,overflow:"hidden"}}>
                      <div style={{width:`${Math.min(100,Math.abs(s.delta)*8)}%`,height:"100%",borderRadius:3,background:s.delta>0?C.success:C.danger,transition:"width 0.3s"}}/>
                    </div>
                    <span style={{fontSize:12,fontFamily:"monospace",fontWeight:600,color:s.delta>0?C.success:s.delta<0?C.danger:C.muted,minWidth:60,textAlign:"right"}}>
                      {s.delta>0?`−${s.delta} yrs`:s.delta<0?`+${Math.abs(s.delta)} yrs`:"No change"}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            {/* Scenarios table */}
            <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:14,overflow:"hidden"}}>
              <div style={{padding:"16px 20px",borderBottom:`1px solid ${C.border}`,display:"flex",alignItems:"center",justifyContent:"space-between",flexWrap:"wrap",gap:8}}>
                <div style={{display:"flex",alignItems:"center",gap:8}}>
                  <Layers size={13} style={{color:C.muted}}/>
                  <span style={{fontSize:12,fontWeight:600,color:C.secondary,letterSpacing:"0.06em",textTransform:"uppercase"}}>Scenarios</span>
                </div>
                <div style={{display:"flex",gap:12,alignItems:"center"}}>
                  {advancedMode&&mcResults&&<span style={{fontSize:10,color:"#6b7af7",display:"flex",alignItems:"center",gap:4}}><Check size={10}/>MC loaded</span>}
                  <span style={{fontSize:10,color:C.muted}}>All savings in today's dollars</span>
                </div>
              </div>
              <div style={{overflowX:"auto"}}>
                <table style={{width:"100%",borderCollapse:"collapse",minWidth:520}}>
                  <thead>
                    <tr style={{borderBottom:`1px solid ${C.border}`}}>
                      {["Retire At","Nest Egg","Projected","Gap","Save/Yr",...(advancedMode&&mcResults?["Success"]:[])]
                        .map(h=><th key={h} style={{textAlign:"left",padding:"10px 16px",fontSize:10,color:C.muted,letterSpacing:"0.08em",textTransform:"uppercase",fontWeight:500}}>{h}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {scenarioData.map(s=>(
                      <tr key={s.retireAge}
                        style={{borderBottom:`1px solid ${C.border}`,background:s.retireAge===safeRetire?"rgba(212,175,122,0.04)":"transparent",transition:"background 0.1s"}}>
                        <td style={{padding:"13px 16px"}}>
                          <div style={{display:"flex",alignItems:"center",gap:6}}>
                            <span style={{fontWeight:700,fontSize:13,color:s.canRetire?C.success:C.primary}}>{s.retireAge}</span>
                            {s.canRetire&&<Check size={11} style={{color:C.success}}/>}
                            {s.retireAge===safeRetire&&<span style={{fontSize:9,color:C.accent,background:C.accentGlow,padding:"1px 6px",borderRadius:10,border:`1px solid ${C.accentDim}`,letterSpacing:"0.08em",textTransform:"uppercase"}}>selected</span>}
                          </div>
                        </td>
                        <td style={{padding:"13px 16px",fontFamily:"monospace",fontSize:12,color:C.warn}}>{fmtD(s.required)}</td>
                        <td style={{padding:"13px 16px",fontFamily:"monospace",fontSize:12,color:s.canRetire?C.success:C.subtle}}>{fmtD(s.projectedAtRetire)}</td>
                        <td style={{padding:"13px 16px",fontFamily:"monospace",fontSize:12,fontWeight:600,color:s.gap>0?C.danger:C.success}}>
                          {s.gap>0?`-${fmtD(s.gap)}`:"None"}
                        </td>
                        <td style={{padding:"13px 16px",fontFamily:"monospace",fontSize:12,fontWeight:600,color:s.reqSavings>savingsNow*3?C.danger:s.reqSavings===0?C.success:C.white}}>
                          {s.reqSavings===0?"On track":`${fmtD(s.reqSavings)}/yr`}
                        </td>
                        {advancedMode&&mcResults&&(
                          <td style={{padding:"13px 16px",fontFamily:"monospace",fontSize:12,fontWeight:600,color:(s.successProb||0)>=80?C.success:(s.successProb||0)>=60?C.warn:C.danger}}>
                            {s.successProb!==null?`${s.successProb}%`:<span style={{color:C.muted}}>—</span>}
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div style={{padding:"12px 20px",borderTop:`1px solid ${C.border}`,display:"flex",gap:16,flexWrap:"wrap"}}>
                {[["Return",fmtPct(returnRate)],["Inflation",fmtPct(inflationRate)],["Growth",fmtPct(savingsGrowth)],["End age",String(safeDeath)]].map(([l,v])=>(
                  <span key={l} style={{fontSize:10,color:C.muted}}>{l}: <span style={{fontFamily:"monospace",color:C.subtle}}>{v}</span></span>
                ))}
              </div>
            </div>

            {/* Summary insight */}
            <div style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:14,padding:"20px 22px"}}>
              <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:14}}>
                <ArrowRight size={13} style={{color:C.accent}}/>
                <span style={{fontSize:12,fontWeight:600,color:C.secondary,letterSpacing:"0.06em",textTransform:"uppercase"}}>Summary</span>
              </div>
              <p style={{fontSize:13,color:C.secondary,lineHeight:1.8}}>
                {onTrack?(
                  <>Your projected <span style={{fontFamily:"monospace",fontWeight:700,color:C.accent}}>{fmtD(projAtRetire)}</span> at age {safeRetire} exceeds the <span style={{fontFamily:"monospace",color:C.warn}}>{fmtD(adjustedNeed)}</span> needed. You're on track with a surplus of <span style={{fontFamily:"monospace",color:C.success}}>{fmtD(projAtRetire-adjustedNeed)}</span>.</>
                ):(
                  <>To retire at <span style={{fontWeight:700,color:C.white}}>age {safeRetire}</span> spending <span style={{fontFamily:"monospace",color:C.white}}>{fmtD(effectiveSpend)}/yr</span>, you need <span style={{fontFamily:"monospace",color:C.warn}}>{fmtD(adjustedNeed)}</span>. Current trajectory reaches <span style={{fontFamily:"monospace",color:C.primary}}>{fmtD(projAtRetire)}</span> — a gap of <span style={{fontFamily:"monospace",fontWeight:700,color:C.danger}}>{fmtD(adjustedNeed-projAtRetire)}</span>. Saving <span style={{fontFamily:"monospace",fontWeight:700,color:C.accent}}>{fmtD(reqSavingsNow)}/yr</span> now (growing {fmtPct(savingsGrowth)}/yr) closes it.</>
                )}
                {coastFIREAge&&<> You reach Coast FIRE at <span style={{fontWeight:700,color:C.white}}>age {coastFIREAge}</span> — after that, no additional saving is required.</>}
                {ssMonthly>0&&<> Social Security of <span style={{fontFamily:"monospace",color:C.white}}>{fmtD(ssAnnualBenefit(ssMonthly))}/yr</span> starting at {ssStartAge} reduces your required nest egg by approximately <span style={{fontFamily:"monospace",color:C.accent}}>{fmtD(ssOffset)}</span>.</>}
                {advancedMode&&mcResults&&<> Across {mcTrials.toLocaleString()} Monte Carlo simulations, this plan succeeds <span style={{fontWeight:700,color:mcResults.successRate>=80?C.success:mcResults.successRate>=60?C.warn:C.danger}}>{mcResults.successRate}%</span> of the time.</>}
              </p>
            </div>
          </div>
        </div>

        <footer style={{textAlign:"center",fontSize:10,color:C.muted,paddingTop:12,borderTop:`1px solid ${C.border}`}}>
          Educational only · Not financial advice · Past returns do not guarantee future results
        </footer>
      </div>
      <style>{`@keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}`}</style>
    </div>
  );
}

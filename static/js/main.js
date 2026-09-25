import { createScene } from "./scene.js";

const { gsap, ScrollTrigger, DrawSVGPlugin, SplitText } = window;
gsap.registerPlugin(ScrollTrigger, DrawSVGPlugin, SplitText);

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const NS = "http://www.w3.org/2000/svg";
const usd = (v, d = 0) => "$" + Number(v).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const pct = (v, d = 2) => Number(v).toFixed(d) + "%";
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

// Always start at the top: the intro plays over the hero, and scroll animations are
// registered while the loader is showing (a restored mid-page scroll would skip them).
if ("scrollRestoration" in history) history.scrollRestoration = "manual";
window.scrollTo(0, 0);

const scene = createScene($("#webgl"));

// Smooth (inertial) scrolling with Lenis, driven by the same GSAP ticker that renders the
// 3D scene, so scroll position, ScrollTrigger scrubs and WebGL frames update in lockstep.
const lenis = new window.Lenis({ lerp: 0.09, wheelMultiplier: 1, smoothWheel: true });
lenis.stop(); // locked while the loader is showing
lenis.on("scroll", ScrollTrigger.update);
gsap.ticker.add((time, deltaMs) => {
  lenis.raf(time * 1000);
  scene.render(deltaMs);
});
gsap.ticker.lagSmoothing(500, 33); // a rare long frame won't make animations jump ahead
ScrollTrigger.config({ ignoreMobileResize: true });
let META = null;

// ------------------------------------------------------------------ SVG helpers
function el(tag, attrs = {}, parent) {
  const n = document.createElementNS(NS, tag);
  for (const k in attrs) n.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(n);
  return n;
}
const toMs = (d) => Date.parse(d + "T00:00:00Z");

function niceTicks(lo, hi, n = 5) {
  const step0 = (hi - lo) / n, mag = Math.pow(10, Math.floor(Math.log10(step0)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= step0);
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(v);
  return out;
}

// Build an empty chart frame with axes; returns scale functions and layers
function frame(svg, xDomain, yDomain, opts = {}) {
  const r = svg.getBoundingClientRect();
  const w = Math.max(r.width, 200), h = Math.max(r.height, 150);
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  svg.innerHTML = "";
  const m = { l: 70, r: 18, t: 12, b: 30, ...opts.margin };
  if (w < 500) m.l = 56;
  const [x0, x1] = xDomain, pad = (yDomain[1] - yDomain[0]) * 0.08;
  const y0 = yDomain[0] - pad, y1 = yDomain[1] + pad;
  const x = (v) => m.l + ((v - x0) / (x1 - x0)) * (w - m.l - m.r);
  const y = (v) => h - m.b - ((v - y0) / (y1 - y0)) * (h - m.t - m.b);
  const axis = el("g", { class: "axis" }, svg);
  for (const t of niceTicks(y0, y1, 5)) {
    el("line", { class: "gridline", x1: m.l, x2: w - m.r, y1: y(t), y2: y(t) }, axis);
    const tx = el("text", { x: m.l - 10, y: y(t) + 4, "text-anchor": "end" }, axis);
    tx.textContent = t >= 1000 ? "$" + (t / 1000).toFixed(t % 1000 ? 1 : 0) + "k" : "$" + t;
  }
  const nx = w < 600 ? 3 : 6;
  for (let i = 0; i <= nx; i++) {
    const v = x0 + ((x1 - x0) * i) / nx;
    const tx = el("text", { x: x(v), y: h - 8, "text-anchor": i === 0 ? "start" : i === nx ? "end" : "middle" }, axis);
    tx.textContent = new Date(v).toISOString().slice(0, opts.monthOnly ? 7 : 10);
  }
  const defs = el("defs", {}, svg);
  const layer = el("g", {}, svg);
  return { w, h, m, x, y, defs, layer };
}
const linePath = (xs, ys) => xs.map((xv, i) => (i ? "L" : "M") + xv.toFixed(1) + " " + ys[i].toFixed(1)).join("");
const areaPath = (xs, top, bot) => linePath(xs, top) + xs.slice().reverse().map((xv, i) => "L" + xv.toFixed(1) + " " + bot[bot.length - 1 - i].toFixed(1)).join("") + "Z";

function gradient(defs, id, color, a0, a1) {
  const g = el("linearGradient", { id, x1: 0, y1: 0, x2: 0, y2: 1 }, defs);
  el("stop", { offset: "0%", "stop-color": color, "stop-opacity": a0 }, g);
  el("stop", { offset: "100%", "stop-color": color, "stop-opacity": a1 }, g);
  return `url(#${id})`;
}

// Hover crosshair + tooltip for a chart
function attachTooltip(svg, tip, f, dates, rows) {
  const ms = dates.map(toMs);
  const cross = el("line", { class: "crosshair", y1: f.m.t, y2: f.h - f.m.b }, svg);
  const dots = rows.map((r) => el("circle", { r: 4, fill: r.color, stroke: "#05060a", "stroke-width": 2, opacity: 0 }, svg));
  cross.style.opacity = 0;
  const tipX = gsap.quickTo(tip, "x", { duration: 0.25, ease: "power3.out" });
  const tipY = gsap.quickTo(tip, "y", { duration: 0.25, ease: "power3.out" });
  let pending = null, lastI = -1;
  svg.onpointermove = (e) => {
    if (!pending) requestAnimationFrame(() => { update(pending); pending = null; });
    pending = e;
  };
  const update = (e) => {
    const b = svg.getBoundingClientRect();
    const px = ((e.clientX - b.left) / b.width) * f.w;
    let lo = 0, hi = ms.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (f.x(ms[mid]) < px) lo = mid; else hi = mid; }
    const i = Math.abs(f.x(ms[lo]) - px) <= Math.abs(f.x(ms[hi]) - px) ? lo : hi;
    const card = tip.parentElement.getBoundingClientRect();
    const left = e.clientX - card.left + 16, flip = left + 200 > card.width;
    tipX(flip ? left - 232 : left); tipY(e.clientY - card.top - 20);
    gsap.to(tip, { opacity: 1, duration: 0.2, overwrite: "auto" });
    if (i === lastI) return;
    lastI = i;
    const X = f.x(ms[i]);
    cross.setAttribute("x1", X); cross.setAttribute("x2", X); cross.style.opacity = 1;
    let html = `<div>${dates[i]}</div>`;
    rows.forEach((r, k) => {
      const v = r.values[i];
      if (v == null) { dots[k].setAttribute("opacity", 0); return; }
      dots[k].setAttribute("cx", X); dots[k].setAttribute("cy", f.y(v)); dots[k].setAttribute("opacity", 1);
      html += `<div>${r.label}: <b style="color:${r.color}">${usd(v)}</b></div>`;
    });
    tip.innerHTML = html;
  };
  svg.onpointerleave = () => {
    lastI = -1;
    gsap.to(tip, { opacity: 0, duration: 0.2, overwrite: "auto" });
    cross.style.opacity = 0; dots.forEach((d) => d.setAttribute("opacity", 0));
  };
}

// ------------------------------------------------------------------ Loader & intro
function runLoader(ready, onReveal) {
  const prog = { v: 0 };
  gsap.set("#loaderBar", { drawSVG: "0%" });
  gsap.set("#loaderB", { drawSVG: "0%" });
  gsap.to("#loaderB", { drawSVG: "100%", duration: 1.6, ease: "power2.inOut" });
  const fill = gsap.to(prog, {
    v: 90, duration: 1.6, ease: "power1.out",
    onUpdate: () => { $("#loaderNum").textContent = Math.round(prog.v); gsap.set("#loaderBar", { drawSVG: prog.v + "%" }); },
  });
  return Promise.all([ready, new Promise((r) => setTimeout(r, 1200))]).then(() =>
    new Promise((resolve) => {
      fill.kill();
      gsap.timeline({ onComplete: resolve })
        .to(prog, { v: 100, duration: 0.5, ease: "power2.out",
          onUpdate: () => { $("#loaderNum").textContent = Math.round(prog.v); gsap.set("#loaderBar", { drawSVG: prog.v + "%" }); } })
        .to(".loader-ring, .loader-count", { scale: 0.8, opacity: 0, duration: 0.5, ease: "power3.in" })
        .add(onReveal, "-=0.15") // intro starts as the curtain lifts, so the hero is never shown static
        .to("#loader", { clipPath: "inset(0 0 100% 0)", duration: 0.9, ease: "expo.inOut" }, "<")
        .set("#loader", { display: "none" });
    })
  );
}

function buildIntro() {
  const title = SplitText.create("#heroTitle", { type: "lines,chars", mask: "lines" });
  const tl = gsap.timeline({
    paused: true, defaults: { ease: "expo.out" },
    onComplete: () => {
      // un-split so the line masks no longer clip the orange glow, then fade the glow in
      title.revert();
      gsap.fromTo("#heroTitle .accent", { textShadow: "0 0 40px rgba(247,147,26,0)" },
        { textShadow: "0 0 40px rgba(247,147,26,.45)", duration: 1.2, ease: "power2.out" });
    },
  });
  tl.from(scene.state, { zoom: 9, duration: 2.4, ease: "expo.inOut" }, 0)
    .from(scene.coin.scale, { x: 0, y: 0, z: 0, duration: 2, ease: "elastic.out(1, 0.6)" }, 0.3)
    .from(scene.state, { spin: -Math.PI * 6, duration: 2.6, ease: "expo.out" }, 0.3)
    .from(title.chars, { yPercent: 120, rotate: 10, duration: 1.3, stagger: 0.025 }, 0.5)
    .from("#hero .reveal-up", { y: 40, opacity: 0, duration: 1.2, stagger: 0.12 }, 0.9)
    .from(".nav", { yPercent: -100, opacity: 0, duration: 1 }, 1);
  return tl;
}

function ambientLoops() {
  gsap.fromTo("#scrollLine", { drawSVG: "0% 0%" }, { drawSVG: "0% 100%", duration: 1.2, repeat: -1, ease: "power2.inOut", yoyo: true, repeatDelay: 0.2 });
  gsap.fromTo("#emptyPath", { drawSVG: "0%" }, { drawSVG: "100%", duration: 2.2, repeat: -1, yoyo: true, ease: "sine.inOut" });
}

// ------------------------------------------------------------------ Cursor & magnetic buttons
function cursor() {
  if (matchMedia("(hover: none)").matches) return;
  const cx = gsap.quickTo("#cursor", "x", { duration: 0.5, ease: "power3" });
  const cy = gsap.quickTo("#cursor", "y", { duration: 0.5, ease: "power3" });
  const dx = gsap.quickTo("#cursorDot", "x", { duration: 0.1 });
  const dy = gsap.quickTo("#cursorDot", "y", { duration: 0.1 });
  addEventListener("pointermove", (e) => { cx(e.clientX); cy(e.clientY); dx(e.clientX); dy(e.clientY); });
  $$("a, button, input").forEach((n) => {
    n.addEventListener("pointerenter", () => gsap.to("#cursor", { scale: 1.8, borderColor: "rgba(255,193,94,.9)", duration: 0.3 }));
    n.addEventListener("pointerleave", () => gsap.to("#cursor", { scale: 1, borderColor: "rgba(247,147,26,.6)", duration: 0.3 }));
  });
  $$(".magnetic").forEach((b) => {
    const xTo = gsap.quickTo(b, "x", { duration: 0.6, ease: "elastic.out(1, 0.4)" });
    const yTo = gsap.quickTo(b, "y", { duration: 0.6, ease: "elastic.out(1, 0.4)" });
    b.addEventListener("pointermove", (e) => {
      const r = b.getBoundingClientRect();
      xTo((e.clientX - r.left - r.width / 2) * 0.3); yTo((e.clientY - r.top - r.height / 2) * 0.4);
    });
    b.addEventListener("pointerleave", () => { xTo(0); yTo(0); });
  });
}

// ------------------------------------------------------------------ Generic scroll reveals
function scrollReveals() {
  gsap.to("#navProgress", { scaleX: 1, ease: "none", scrollTrigger: { start: 0, end: "max", scrub: 0.3 } });

  $$("section[id]").forEach((sec) => {
    const link = $(`.nav a[href="#${sec.id}"]`);
    if (!link) return;
    ScrollTrigger.create({ trigger: sec, start: "top center", end: "bottom center",
      onToggle: (st) => link.classList.toggle("active", st.isActive) });
  });
  $$(".nav a[href^='#'], .hero-cta a").forEach((a) => a.addEventListener("click", (e) => {
    const target = $(a.getAttribute("href"));
    if (!target) return;
    e.preventDefault();
    const y = ScrollTrigger.getAll().find((s) => s.pin === target)?.start ?? target.getBoundingClientRect().top + scrollY;
    lenis.scrollTo(y, { duration: 1.4, easing: (t) => 1 - Math.pow(1 - t, 4) });
  }));

  $$("h2.split").forEach((h) => {
    SplitText.create(h, {
      type: "lines,words", mask: "lines", autoSplit: true,
      onSplit: (self) => gsap.from(self.words, {
        yPercent: 110, opacity: 0, duration: 1.1, stagger: 0.04, ease: "expo.out",
        scrollTrigger: { trigger: h, start: "top 85%", toggleActions: "play none none reverse" },
      }),
    });
  });
  $$(".section .lead, .section .eyebrow, main > section:not(#hero) .reveal-up").forEach((n) =>
    gsap.from(n, { y: 30, opacity: 0, duration: 1, ease: "power3.out",
      scrollTrigger: { trigger: n, start: "top 88%", toggleActions: "play none none reverse" } })
  );
  gsap.set(".glass:not(.step)", { opacity: 0 });
  ScrollTrigger.batch(".glass:not(.step)", {
    start: "top 88%",
    onEnter: (b) => gsap.fromTo(b, { y: 60, opacity: 0, rotateX: -8, transformPerspective: 900 },
      { y: 0, opacity: 1, rotateX: 0, duration: 1.2, stagger: 0.1, ease: "expo.out", overwrite: true }),
  });
  gsap.from(".footer .fine", { opacity: 0, y: 20, scrollTrigger: { trigger: ".footer", start: "top 70%" } });
}

// ------------------------------------------------------------------ Marquee driven by scroll velocity
// ------------------------------------------------------------------ Model selection
// Three models are offered: Random Forest (default), Ridge Regression and Linear Regression.
let MODEL = null; // key of the selected model
const modelListeners = [];
const MODEL_COLORS = { random_forest: "#f7931a", ridge: "#7b5cff", linear: "#3ecf8e" };
const MODEL_SHORT = { random_forest: "Random Forest", ridge: "Ridge", linear: "Linear" };
const modelKeys = () => META.model_order;
const M = (key = MODEL) => META.models[key];
const onModelChange = (fn) => modelListeners.push(fn);

function setModel(key) {
  if (key === MODEL || !META.models[key]) return;
  MODEL = key;
  modelListeners.forEach((fn) => fn(key));
}

// Backtest error statistics for one model
function modelErrors(key = MODEL) {
  const act = META.backtest_actual, pred = M(key).backtest;
  const errs = pred.map((p, i) => ((p - act[i]) / act[i]) * 100);
  const within = [1, 2, 5].map((t) => (errs.filter((e) => Math.abs(e) <= t).length / errs.length) * 100);
  return { errs, within };
}

// Segmented control rendered into every .model-switch placeholder; all copies stay in sync
function modelSwitches() {
  const switches = $$(".model-switch");
  switches.forEach((sw) => {
    sw.setAttribute("role", "radiogroup");
    sw.setAttribute("aria-label", "Prediction model");
    sw.innerHTML = `<span class="ms-pill"></span>` + modelKeys()
      .map((k) => `<button type="button" role="radio" data-model="${k}">${M(k).name}</button>`).join("");
    $$("button", sw).forEach((b) => b.addEventListener("click", () => setModel(b.dataset.model)));
  });
  const place = (animate) => switches.forEach((sw) => {
    const btn = $(`button[data-model="${MODEL}"]`, sw);
    $$("button", sw).forEach((b) => { b.classList.toggle("active", b === btn); b.setAttribute("aria-checked", b === btn); });
    const vars = { x: btn.offsetLeft, width: btn.offsetWidth, backgroundColor: MODEL_COLORS[MODEL] };
    if (animate) gsap.to($(".ms-pill", sw), { ...vars, duration: 0.6, ease: "expo.out" });
    else gsap.set($(".ms-pill", sw), vars);
  });
  place(false);
  onModelChange(() => place(true));
  addEventListener("resize", () => place(false));
}

function marquee() {
  const items = modelKeys().map((k) => [`${M(k).name} · price accuracy`, pct(M(k).metrics["Accuracy_%"])]);
  items.push(["Daily candles", META.n_days.toLocaleString()], ["Minute rows", "7,616,181"], ["Test days", META.split.n_test]);
  const html = items.map(([k, v]) => `<span>${k}<b>${v}</b></span><span>✦</span>`).join("");
  $("#marquee").innerHTML = html + html;
  const loop = gsap.to("#marquee", { xPercent: -50, ease: "none", duration: 40, repeat: -1 });
  let speed = 1;
  gsap.ticker.add((_, dt) => {
    const target = gsap.utils.clamp(-6, 6, 1 + lenis.velocity / 8);
    speed += (target - speed) * (1 - Math.exp(-dt / 120));
    loop.timeScale(speed);
  });
}

// ------------------------------------------------------------------ Accuracy gauges
function gauges() {
  const R = 70;
  const defs = [
    { label: "Price accuracy", get: (m) => m["Accuracy_%"], dec: 2, max: 100, unit: "PERCENT", color: "var(--accent)",
      desc: (m) => `100% minus the average % error (MAPE ${pct(m["MAPE_%"])})` },
    { label: "R² score", get: (m) => m.R2, dec: 3, max: 1, unit: "SCORE", color: "var(--accent-2)",
      desc: () => "Share of the variation in price explained" },
    { label: "Within ±5%", get: (m, e) => e.within[2], dec: 1, max: 100, unit: "PERCENT", color: "var(--good)",
      desc: () => "Test days where the prediction landed within 5%" },
    { label: "Direction hit-rate", get: (m) => m["Direction_%"], dec: 1, max: 100, unit: "PERCENT", color: "var(--violet)",
      desc: () => "Up/down calls that were right (50% = coin flip)" },
  ];
  $("#gauges").innerHTML = defs.map((g, i) => `
    <div class="gauge glass">
      <svg viewBox="0 0 170 170">
        <circle class="g-track" cx="85" cy="85" r="${R}"/>
        <circle class="g-bar" id="gbar${i}" cx="85" cy="85" r="${R}" stroke="${g.color}" transform="rotate(-90 85 85)"/>
        <text class="g-val" x="85" y="90" text-anchor="middle" id="gval${i}">0</text>
        <text class="g-unit" x="85" y="112" text-anchor="middle">${g.unit}</text>
      </svg>
      <h3>${g.label}</h3><p id="gdesc${i}"></p>
    </div>`).join("");
  gsap.set(defs.map((_, i) => `#gbar${i}`), { drawSVG: "0%" });
  const cur = defs.map(() => ({ v: 0 }));
  let shown = false;
  const texts = (key) => {
    const m = M(key).metrics;
    $("#dirInline").textContent = pct(m["Direction_%"], 1);
    defs.forEach((g, i) => ($(`#gdesc${i}`).textContent = g.desc(m)));
  };
  const apply = (key, duration, step) => {
    const m = M(key).metrics, e = modelErrors(key);
    texts(key);
    defs.forEach((g, i) => {
      const v = g.get(m, e);
      gsap.to(`#gbar${i}`, { drawSVG: `${(v / g.max) * 100}%`, duration, delay: i * step, ease: "expo.out", overwrite: true });
      gsap.to(cur[i], { v, duration, delay: i * step, ease: "expo.out", overwrite: true,
        onUpdate: () => ($(`#gval${i}`).textContent = cur[i].v.toFixed(g.dec)) });
    });
  };
  texts(MODEL);
  ScrollTrigger.create({ trigger: "#gauges", start: "top 80%", once: true, onEnter: () => { shown = true; apply(MODEL, 2, 0.12); } });
  onModelChange((key) => (shown ? apply(key, 1.2, 0.06) : texts(key)));
}

// ------------------------------------------------------------------ Backtest section
function backtestSection() {
  const dates = META.backtest_dates, act = META.backtest_actual, pv = M().backtest, color = MODEL_COLORS[MODEL];
  const svg = $("#backtestChart");
  const ms = dates.map(toMs);
  const all = act.concat(pv);
  const f = frame(svg, [ms[0], ms[ms.length - 1]], [Math.min(...all), Math.max(...all)]);
  const xs = ms.map(f.x);
  el("path", { d: areaPath(xs, act.map(f.y), xs.map(() => f.h - f.m.b)), fill: gradient(f.defs, "btArea", "#8d93a8", 0.18, 0), class: "bt-area" }, f.layer);
  const actual = el("path", { class: "line", d: linePath(xs, act.map(f.y)), stroke: "#8d93a8" }, f.layer);
  const pred = el("path", { class: "line", d: linePath(xs, pv.map(f.y)), stroke: color, "stroke-width": 1.5 }, f.layer);
  $("#btPredLegend").innerHTML = `<i style="background:${color}"></i>Predicted · ${M().name}`;
  attachTooltip(svg, $("#bTip"), f, dates, [
    { label: "Actual", color: "#8d93a8", values: act },
    { label: MODEL_SHORT[MODEL], color, values: pv },
  ]);
  return { actual, pred, area: $(".bt-area", svg) };
}

let panelTriggers = [];
function errorPanels(initial) {
  panelTriggers.forEach((t) => t.kill());
  panelTriggers = [];
  const { errs, within } = modelErrors();
  const color = MODEL_COLORS[MODEL];
  const lo = -8, hi = 8, bw = 0.5, nb = (hi - lo) / bw;
  const counts = new Array(nb).fill(0);
  errs.forEach((e) => { const k = Math.floor((gsap.utils.clamp(lo, hi - 1e-6, e) - lo) / bw); counts[k]++; });
  const svg = $("#errHist");
  const r = svg.getBoundingClientRect(), w = r.width, h = r.height;
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  svg.innerHTML = "";
  const max = Math.max(...counts), bwPx = (w - 20) / nb;
  const bars = counts.map((c, k) => {
    const x0 = lo + k * bw, bh = (c / max) * (h - 36);
    const center = Math.abs(x0 + bw / 2) <= 1;
    return el("rect", { x: 10 + k * bwPx + 1, y: h - 22 - bh, width: bwPx - 2, height: bh, rx: 2,
      fill: center ? color : "#8d93a8", opacity: center ? 1 : 0.55 }, svg);
  });
  [-8, -4, 0, 4, 8].forEach((v) => {
    const t = el("text", { x: 10 + ((v - lo) / (hi - lo)) * (w - 20), y: h - 6, "text-anchor": "middle", fill: "#8d93a8", "font-size": 11, "font-family": "JetBrains Mono" }, svg);
    t.textContent = (v > 0 ? "+" : "") + v + "%";
  });
  const barAnim = { scaleY: 0, transformOrigin: "50% 100%", duration: 1, stagger: { each: 0.02, from: "center" }, ease: "back.out(1.6)" };

  $("#within").innerHTML = within.map((v, i) => `
    <div class="within-row"><span>±${[1, 2, 5][i]}%</span><div class="within-bar"><span data-v="${v}" style="background:linear-gradient(90deg, var(--violet), ${color})"></span></div><span class="wv" data-v="${v}">0%</span></div>`).join("");
  const tl = gsap.timeline({ paused: initial });
  $$("#within .within-bar span").forEach((s, i) => tl.to(s, { scaleX: +s.dataset.v / 100, duration: 1.4, ease: "expo.out" }, i * 0.12));
  $$("#within .wv").forEach((s, i) => {
    const o = { v: 0 };
    tl.to(o, { v: +s.dataset.v, duration: 1.4, ease: "expo.out", onUpdate: () => (s.textContent = o.v.toFixed(1) + "%") }, i * 0.12);
  });

  if (initial) {
    const hist = gsap.from(bars, { ...barAnim, paused: true });
    panelTriggers.push(
      ScrollTrigger.create({ trigger: svg, start: "top 85%", animation: hist, toggleActions: "play none none reverse" }),
      ScrollTrigger.create({ trigger: "#within", start: "top 85%", animation: tl, toggleActions: "play none none reverse" }));
  } else {
    gsap.from(bars, barAnim);
  }
}

let btScrub = null;
function backtestAnimations() {
  const { actual, pred, area } = backtestSection();
  btScrub = gsap.timeline({ scrollTrigger: { trigger: "#backtestChart", start: "top 85%", end: "bottom 45%", scrub: 0.6 } })
    .fromTo(actual, { drawSVG: "0%" }, { drawSVG: "100%", ease: "none" }, 0)
    .fromTo(pred, { drawSVG: "0%" }, { drawSVG: "100%", ease: "none" }, 0.08)
    .fromTo(area, { opacity: 0 }, { opacity: 1, ease: "none" }, 0.5);
  errorPanels(true);
  onModelChange(() => {
    if (btScrub) { btScrub.scrollTrigger.kill(); btScrub.kill(); btScrub = null; }
    const { pred: p } = backtestSection();
    gsap.fromTo(p, { drawSVG: "0%" }, { drawSVG: "100%", duration: 1.4, ease: "power2.inOut" });
    errorPanels(false);
  });
}

// ------------------------------------------------------------------ Models table
function modelsTable() {
  const keys = modelKeys();
  const maxMae = Math.max(...keys.map((k) => M(k).metrics.MAE));
  const rows = keys.map((k) => {
    const r = M(k).metrics;
    return `
    <tr data-model="${k}" tabindex="0" title="Use ${M(k).name} for predictions">
      <td><i class="mdot" style="background:${MODEL_COLORS[k]}"></i>${M(k).name}<span class="tag">SELECTED</span></td>
      <td><span class="bar" style="width:${(r.MAE / maxMae) * 90}px"></span>${usd(r.MAE)}</td>
      <td>${usd(r.RMSE)}</td><td>${r.R2.toFixed(4)}</td><td>${pct(r["Accuracy_%"])}</td>
      <td>${pct(r["Direction_%"], 1)}</td><td>${r.Fit_Status}</td>
    </tr>`;
  }).join("");
  $("#modelTable").innerHTML = `<thead><tr><th>Model</th><th>MAE</th><th>RMSE</th><th>R²</th><th>Price acc.</th><th>Direction</th><th>Diagnosis</th></tr></thead><tbody>${rows}</tbody>`;
  $$("#modelTable tbody tr").forEach((tr) => {
    tr.addEventListener("click", () => setModel(tr.dataset.model));
    tr.addEventListener("keydown", (e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), setModel(tr.dataset.model)));
  });
  const mark = () => $$("#modelTable tbody tr").forEach((tr) => tr.classList.toggle("best", tr.dataset.model === MODEL));
  mark();
  onModelChange(() => {
    mark();
    gsap.fromTo("#modelTable tr.best td", { backgroundColor: "rgba(247,147,26,.18)" }, { backgroundColor: "rgba(247,147,26,0)", duration: 1.2 });
  });
  const tl = gsap.timeline({ scrollTrigger: { trigger: "#modelTable", start: "top 80%", toggleActions: "play none none reverse" } });
  tl.from("#modelTable th", { opacity: 0, y: -10, stagger: 0.05, duration: 0.6 })
    .from("#modelTable tbody tr", { opacity: 0, x: -50, stagger: 0.12, duration: 0.9, ease: "expo.out" }, 0.1)
    .from("#modelTable .bar", { scaleX: 0, stagger: 0.12, duration: 1.2, ease: "expo.out" }, 0.3);
}

// ------------------------------------------------------------------ Evaluation dashboard
function evaluationDashboard() {
  const keys = modelKeys();
  const st = (trigger) => ({ trigger, start: "top 82%", toggleActions: "play none none reverse" });
  const box = (svg, W, H) => { svg.setAttribute("viewBox", `0 0 ${W} ${H}`); svg.innerHTML = ""; return svg; };
  const txt = (parent, x, y, s, attrs = {}) => { const t = el("text", { x, y, ...attrs }, parent); t.textContent = s; return t; };
  const tip = (node, s) => { el("title", {}, node).textContent = s; };
  const hl = (node, key) => { node.classList.add("ev-hl"); node.dataset.model = key; return node; };

  // 1. Direction accuracy bars
  {
    const W = 480, Hh = 260, m = { l: 40, r: 8, t: 18, b: 30 };
    const svg = box($("#evAcc"), W, Hh), lo = 40, hi = 60, H = Hh - m.t - m.b, bw = (W - m.l - m.r) / keys.length;
    const y = (v) => m.t + H - ((Math.max(v, lo) - lo) / (hi - lo)) * H;
    [40, 45, 50, 55, 60].forEach((v) => {
      el("line", { class: "gridline", x1: m.l, x2: W - m.r, y1: y(v), y2: y(v) }, svg);
      txt(svg, m.l - 6, y(v) + 4, v + "%", { "text-anchor": "end" });
    });
    const bars = keys.map((k, i) => {
      const v = M(k).metrics["Direction_%"], x = m.l + i * bw + bw * 0.25, w = bw * 0.5;
      const g = hl(el("g", {}, svg), k);
      const r = el("rect", { x, y: y(v), width: w, height: y(lo) - y(v), rx: 6, fill: MODEL_COLORS[k] }, g);
      tip(r, `${M(k).name}: ${v.toFixed(2)}%`);
      txt(g, x + w / 2, y(v) - 6, v.toFixed(1) + "%", { "text-anchor": "middle", class: "val" });
      txt(svg, x + w / 2, Hh - 10, MODEL_SHORT[k], { "text-anchor": "middle" });
      return r;
    });
    const coin = el("line", { x1: m.l, x2: W - m.r, y1: y(50), y2: y(50), stroke: "#ff6b6b", "stroke-dasharray": "4 4" }, svg);
    txt(svg, W - m.r, y(50) - 5, "coin flip 50%", { "text-anchor": "end", fill: "#ff6b6b" });
    gsap.timeline({ scrollTrigger: st(svg) })
      .from(bars, { scaleY: 0, transformOrigin: "50% 100%", duration: 1, stagger: 0.1, ease: "expo.out" })
      .fromTo(coin, { drawSVG: "0%" }, { drawSVG: "100%", duration: 0.8 }, 0.3);
  }

  // 2. Precision / Recall / F1 grouped bars
  {
    const W = 480, Hh = 240, m = { l: 36, r: 8, t: 10, b: 30 };
    const svg = box($("#evPrf"), W, Hh), H = Hh - m.t - m.b, gw = (W - m.l - m.r) / keys.length;
    const y = (v) => m.t + H - v * H;
    const metrics = [["Precision", "#f7931a"], ["Recall", "#7b5cff"], ["F1", "#3ecf8e"]];
    $("#evPrfLegend").innerHTML = metrics.map(([k, c]) => `<span><i style="background:${c}"></i>${k}</span>`).join("");
    [0, 0.25, 0.5, 0.75, 1].forEach((v) => {
      el("line", { class: "gridline", x1: m.l, x2: W - m.r, y1: y(v), y2: y(v) }, svg);
      txt(svg, m.l - 6, y(v) + 4, v.toFixed(2), { "text-anchor": "end" });
    });
    const bars = [];
    keys.forEach((k, i) => {
      const bw = gw * 0.22, g = hl(el("g", {}, svg), k);
      metrics.forEach(([name, c], j) => {
        const v = M(k).metrics[name], x = m.l + i * gw + gw * 0.17 + j * bw;
        const r = el("rect", { x, y: y(v), width: bw - 3, height: y(0) - y(v), rx: 3, fill: c }, g);
        tip(r, `${M(k).name} · ${name}: ${v.toFixed(3)}`);
        bars.push(r);
      });
      txt(svg, m.l + i * gw + gw / 2, Hh - 10, MODEL_SHORT[k], { "text-anchor": "middle" });
    });
    gsap.from(bars, { scaleY: 0, transformOrigin: "50% 100%", duration: 0.9, stagger: 0.04, ease: "expo.out", scrollTrigger: st(svg) });
  }

  // 3. Confusion matrix (selected model)
  let cmShown = false;
  const drawCM = (animate) => {
    const cmx = M().confusion_matrix, max = Math.max(...cmx.flat());
    $("#evCmModel").textContent = M().name;
    const cell = (v, tag, good) => {
      const a = 0.12 + 0.5 * (v / max);
      return `<div class="cell" style="background:rgba(${good ? "62,207,142" : "255,107,107"},${a.toFixed(2)})"><b data-v="${v}">${animate ? 0 : v}</b><span>${tag}</span></div>`;
    };
    const [[tn, fp], [fn, tp]] = cmx, total = tn + fp + fn + tp;
    $("#evCm").innerHTML = `
      <div></div><div class="h">Predicted DOWN</div><div class="h">Predicted UP</div>
      <div class="h">Actual DOWN</div>${cell(tn, "TRUE NEG", true)}${cell(fp, "FALSE POS", false)}
      <div class="h">Actual UP</div>${cell(fn, "FALSE NEG", false)}${cell(tp, "TRUE POS", true)}
      <p class="cm-note">Accuracy ${(((tn + tp) / total) * 100).toFixed(1)}% · Precision ${((tp / Math.max(tp + fp, 1)) * 100).toFixed(1)}%
        · Recall ${((tp / Math.max(tp + fn, 1)) * 100).toFixed(1)}% on ${total} test days</p>`;
    if (!animate) return;
    const tl = gsap.timeline();
    tl.from("#evCm .cell", { scale: 0.6, opacity: 0, duration: 0.8, stagger: 0.1, ease: "back.out(1.7)" });
    $$("#evCm .cell b").forEach((b) => {
      const o = { v: 0 };
      tl.to(o, { v: +b.dataset.v, duration: 1.2, ease: "expo.out", onUpdate: () => (b.textContent = Math.round(o.v)) }, 0.1);
    });
  };
  drawCM(false);
  ScrollTrigger.create({ trigger: "#evCm", start: "top 82%", once: true, onEnter: () => { cmShown = true; drawCM(true); } });

  // 4. ROC curves
  const rocLines = {};
  {
    const S = 300, m = { l: 36, r: 10, t: 10, b: 34 }, W = S - m.l - m.r, H = S - m.t - m.b;
    const svg = box($("#evRoc"), S, S);
    const x = (v) => m.l + v * W, y = (v) => m.t + H - v * H;
    [0, 0.5, 1].forEach((v) => {
      el("line", { class: "gridline", x1: m.l, x2: m.l + W, y1: y(v), y2: y(v) }, svg);
      txt(svg, m.l - 6, y(v) + 4, v, { "text-anchor": "end" });
      txt(svg, x(v), S - 18, v, { "text-anchor": "middle" });
    });
    txt(svg, m.l + W / 2, S - 2, "false positive rate →", { "text-anchor": "middle" });
    const diag = el("line", { x1: x(0), y1: y(0), x2: x(1), y2: y(1), stroke: "rgba(255,255,255,.35)", "stroke-dasharray": "4 4" }, svg);
    const lines = keys.map((k) => (rocLines[k] = hl(el("path", {
      d: linePath(M(k).roc.fpr.map(x), M(k).roc.tpr.map(y)), fill: "none", stroke: MODEL_COLORS[k], "stroke-width": 2 }, svg), k)));
    $("#evRocLegend").innerHTML = keys.map((k) => `<span><i style="background:${MODEL_COLORS[k]}"></i>${MODEL_SHORT[k]} AUC ${M(k).metrics.AUC.toFixed(3)}</span>`).join("")
      + `<span><i style="background:rgba(255,255,255,.35)"></i>random 0.500</span>`;
    gsap.timeline({ scrollTrigger: st(svg) })
      .fromTo(diag, { drawSVG: "0%" }, { drawSVG: "100%", duration: 0.6 })
      .fromTo(lines, { drawSVG: "0%" }, { drawSVG: "100%", duration: 1.4, stagger: 0.15, ease: "power2.inOut" }, 0.2);
  }

  // 5. CV spread box plot
  {
    const Wd = 480, Hh = 260, m = { l: 40, r: 8, t: 12, b: 30 };
    const svg = box($("#evCv"), Wd, Hh);
    const all = keys.flatMap((k) => M(k).cv_folds.dir_acc.map((v) => v * 100));
    const lo = Math.floor(Math.min(...all, 46) / 2) * 2, hi = Math.ceil(Math.max(...all, 54) / 2) * 2;
    const H = Hh - m.t - m.b, gw = (Wd - m.l - m.r) / keys.length;
    const y = (v) => m.t + H - ((v - lo) / (hi - lo)) * H;
    niceTicks(lo, hi, 4).forEach((v) => {
      el("line", { class: "gridline", x1: m.l, x2: Wd - m.r, y1: y(v), y2: y(v) }, svg);
      txt(svg, m.l - 6, y(v) + 4, v + "%", { "text-anchor": "end" });
    });
    el("line", { x1: m.l, x2: Wd - m.r, y1: y(50), y2: y(50), stroke: "#ff6b6b", "stroke-dasharray": "4 4" }, svg);
    const q = (arr, p) => { const a = [...arr].sort((u, v) => u - v), i = (a.length - 1) * p, f = Math.floor(i); return a[f] + (a[Math.ceil(i)] - a[f]) * (i - f); };
    const groups = keys.map((k, i) => {
      const v = M(k).cv_folds.dir_acc.map((d) => d * 100), cx = m.l + i * gw + gw / 2, bw = gw * 0.34, c = MODEL_COLORS[k];
      const g = hl(el("g", {}, svg), k);
      el("line", { x1: cx, x2: cx, y1: y(Math.min(...v)), y2: y(Math.max(...v)), stroke: c, "stroke-width": 1.5 }, g);
      el("rect", { x: cx - bw / 2, y: y(q(v, 0.75)), width: bw, height: Math.max(y(q(v, 0.25)) - y(q(v, 0.75)), 2), rx: 4,
        fill: c, "fill-opacity": 0.35, stroke: c }, g);
      el("line", { x1: cx - bw / 2, x2: cx + bw / 2, y1: y(q(v, 0.5)), y2: y(q(v, 0.5)), stroke: "#fff", "stroke-width": 2 }, g);
      v.forEach((d, j) => el("circle", { cx: cx + (j - 2) * 6, cy: y(d), r: 3, fill: c }, g));
      txt(svg, cx, Hh - 10, MODEL_SHORT[k], { "text-anchor": "middle" });
      const mean = v.reduce((a, b) => a + b, 0) / v.length;
      const sd = Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / v.length);
      tip(g, `${M(k).name}: mean ${mean.toFixed(1)}% ± ${sd.toFixed(1)}% over 5 folds`);
      return g;
    });
    gsap.from(groups, { opacity: 0, y: 30, duration: 0.9, stagger: 0.12, ease: "expo.out", scrollTrigger: st(svg) });
  }

  // Highlight the selected model in every chart
  const highlight = (animate) => {
    $$("#evaluation .ev-hl").forEach((n) => {
      const on = n.dataset.model === MODEL;
      gsap.to(n, { opacity: on ? 1 : 0.35, duration: animate ? 0.5 : 0 });
      n.classList.toggle("selected", on);
    });
    Object.entries(rocLines).forEach(([k, p]) => p.setAttribute("stroke-width", k === MODEL ? 3.2 : 1.6));
  };
  highlight(false);
  onModelChange(() => {
    highlight(true);
    drawCM(cmShown);
  });
}

// ------------------------------------------------------------------ Pinned horizontal pipeline
function pipeline() {
  const track = $("#pipeTrack");
  const svg = $("#pipeSvg"), path = $("#pipePath");
  const steps = $$(".step", track);
  const build = () => {
    const tr = track.getBoundingClientRect();
    const W = track.scrollWidth, H = 80;
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.style.width = W + "px";
    let d = `M0 ${H / 2}`;
    steps.forEach((s, i) => {
      const r = s.getBoundingClientRect(), cx = r.left - tr.left + r.width / 2;
      d += ` C ${cx - 120} ${i % 2 ? 0 : H}, ${cx - 60} ${i % 2 ? 0 : H}, ${cx} ${H / 2}`;
    });
    path.setAttribute("d", d + ` L ${W} ${H / 2}`);
  };
  build();
  const distance = () => track.scrollWidth - innerWidth + 40;
  const tl = gsap.timeline({
    scrollTrigger: { trigger: "#pipeline", start: "top top", end: () => "+=" + distance() * 1.2, pin: true, scrub: 0.6, invalidateOnRefresh: true, onRefreshInit: build },
  });
  tl.to(track, { x: () => -Math.max(distance(), 0), ease: "none", duration: 1 }, 0)
    .fromTo(path, { drawSVG: "0%" }, { drawSVG: "100%", ease: "none", duration: 1 }, 0);
  steps.forEach((s, i) =>
    tl.from(s, { opacity: 0.15, scale: 0.88, y: i % 2 ? -30 : 30, duration: 0.15, ease: "power2.out" }, Math.max(0, i / (steps.length - 1) - 0.2))
  );
}

// ------------------------------------------------------------------ 3D scene choreography (scrubbed by scroll)
function sceneTimeline() {
  const mob = innerWidth < 768; // re-evaluated on every rebuild (resize)
  const keys = [
    { sel: "#hero", coin: [mob ? 0 : 2.6, mob ? 2.1 : 0.1, 0], rot: [0.15, 0, -0.1], s: mob ? 0.55 : 1, cam: [0, 0, 9], look: [0, 0, 0], ribbon: 0 },
    { sel: "#accuracy", coin: [mob ? 0 : 4.2, mob ? 2.6 : 1.7, -1], rot: [0.6, 0, 0.3], s: 0.6, cam: [0, 0, 10], look: [0, 0, 0], ribbon: 0 },
    { sel: "#predict", coin: [mob ? 0 : 4, 2.6, -2], rot: [-0.3, 0, -0.4], s: 0.45, cam: [0, 0.3, 10], look: [0, 0, 0], ribbon: 0.05 },
    { sel: "#backtest", coin: [0, 4.5, -3], rot: [1.2, 0, 0], s: 0.35, cam: [0, -1.2, 7.5], look: [0, -1.4, -6], ribbon: 1 },
    { sel: "#models", coin: [mob ? 0 : -3.4, 0.4, 0], rot: [0.2, 0, 0.5], s: 0.8, cam: [0, 0, 9.5], look: [0, 0, 0], ribbon: 1 },
    { sel: "#evaluation", coin: [mob ? 0 : 4.6, 2.7, -3], rot: [0.5, 0, -0.3], s: 0.4, cam: [0, 0, 10], look: [0, 0, 0], ribbon: 1 },
    { sel: "#pipeline", coin: [mob ? 0 : 4.4, 2.4, -3], rot: [0.3, 0, 0], s: 0.55, cam: [0, 0.4, 10], look: [0, 0, 0], ribbon: 1 },
    { sel: ".footer", coin: [mob ? 0 : 2.8, 0.2, 1], rot: [-0.2, 0, -0.2], s: 1, cam: [0, 0, 8], look: [0, 0, 0], ribbon: 1 },
  ];
  const max = ScrollTrigger.maxScroll(window) || 1;
  const posOf = (sel) => {
    const st = ScrollTrigger.getAll().find((s) => s.pin === $(sel));
    const top = st ? st.start : $(sel).getBoundingClientRect().top + scrollY;
    return gsap.utils.clamp(0, 1, (top - innerHeight * 0.35) / max);
  };
  const { coinRig, camBase, lookTarget, state } = scene;
  const apply = (k) => {
    coinRig.position.set(...k.coin); coinRig.rotation.set(...k.rot); coinRig.scale.setScalar(k.s);
    camBase.set(...k.cam); lookTarget.set(...k.look); state.ribbonProgress = k.ribbon;
  };
  apply(keys[0]);
  const tl = gsap.timeline({ paused: true, defaults: { ease: "power2.inOut" } });
  tl.set({}, {}, 1); // fixed total duration of 1 = whole page
  const xyz = (a) => ({ x: a[0], y: a[1], z: a[2] });
  let prev = keys[0], prevT = 0;
  keys.slice(1).forEach((k) => {
    const t = Math.max(posOf(k.sel), prevT + 0.01), d = t - prevT;
    const step = (target, from, to, ease) =>
      tl.fromTo(target, { ...from, immediateRender: false }, { ...to, duration: d, ...(ease ? { ease } : {}) }, prevT);
    step(coinRig.position, xyz(prev.coin), xyz(k.coin));
    step(coinRig.rotation, xyz(prev.rot), xyz(k.rot));
    step(coinRig.scale, xyz([prev.s, prev.s, prev.s]), xyz([k.s, k.s, k.s]));
    step(camBase, xyz(prev.cam), xyz(k.cam));
    step(lookTarget, xyz(prev.look), xyz(k.look));
    step(state, { ribbonProgress: prev.ribbon }, { ribbonProgress: k.ribbon }, "none");
    prev = k; prevT = t;
  });
  return ScrollTrigger.create({
    start: 0, end: "max", scrub: 0.8, animation: tl,
    onUpdate: (st) => (state.scroll = st.progress),
  });
}

// ------------------------------------------------------------------ Prediction
function setupPredict() {
  const input = $("#dt");
  const last = META.last_date;
  const shift = (days) => {
    const d = new Date(toMs(last) + days * 864e5);
    return d.toISOString().slice(0, 10) + "T12:00";
  };
  input.value = shift(90);
  $$(".chip").forEach((c) => c.addEventListener("click", () => {
    input.value = shift(+c.dataset.days);
    gsap.fromTo(input, { backgroundColor: "rgba(247,147,26,.25)" }, { backgroundColor: "rgba(0,0,0,.35)", duration: 0.8 });
    gsap.fromTo(c, { scale: 0.9 }, { scale: 1, duration: 0.6, ease: "elastic.out(1,0.4)" });
  }));

  let lastData = null, busy = false;
  $("#predictForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (busy) return;
    busy = true;
    const btn = $("#predictBtn");
    btn.disabled = true;
    $("span", btn).textContent = "Simulating…";
    const spin = gsap.to(scene.state, { idleSpeed: 6, duration: 0.8, ease: "power2.in" });
    const arrow = gsap.to($("svg", btn), { x: 6, repeat: -1, yoyo: true, duration: 0.3, ease: "sine.inOut" });
    try {
      const r = await fetch(`/predict?model=${MODEL}&datetime=` + encodeURIComponent(input.value));
      const d = await r.json();
      if (d.error) return showError(d.error);
      lastData = d;
      showResult(d);
      drawForecast(d, true);
      scene.celebrate(d.mode === "historical" ? true : d.predicted >= d.last_actual);
    } catch (err) {
      showError("Could not reach the server.");
    } finally {
      spin.kill(); arrow.kill();
      gsap.to(scene.state, { idleSpeed: 0.35, duration: 1.5, ease: "power2.out" });
      gsap.set($("svg", btn), { x: 0 });
      btn.disabled = false;
      $("span", btn).textContent = "Run prediction";
      busy = false;
    }
  });
  onModelChange(() => lastData && $("#predictForm").requestSubmit());
  let rt;
  addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(() => lastData && drawForecast(lastData, false), 200); });
}

function showError(msg) {
  $("#resultEmpty").classList.remove("hidden");
  $("#resultBody").classList.add("hidden");
  $("#resultEmpty p").innerHTML = `<span class="error-msg">${msg}</span>`;
  gsap.fromTo("#resultCard", { x: -10 }, { x: 0, duration: 0.6, ease: "elastic.out(1, 0.3)" });
}

function showResult(d) {
  $("#resultEmpty").classList.add("hidden");
  $("#resultBody").classList.remove("hidden");
  const stat = (k, v, cls = "") => `<div class="rstat"><div class="k">${k}</div><div class="v ${cls}">${v}</div></div>`;
  let s = "";
  if (d.mode === "historical") {
    $("#rLabel").textContent = `${d.model_name} · prediction for ${d.date} · historical check`;
    s += stat("Actual close", usd(d.actual, 2));
    s += stat("Error", pct(d.error_pct), d.error_pct < 3 ? "up" : "down");
    s += stat("90% range", `${usd(d.low)} – ${usd(d.high)}`);
  } else {
    const chg = (d.predicted / d.last_actual - 1) * 100;
    $("#rLabel").textContent = `${d.model_name} · median forecast for ${d.date} · ${d.horizon} days ahead`;
    s += stat("vs last close", (chg >= 0 ? "+" : "") + pct(chg), chg >= 0 ? "up" : "down");
    s += stat("Chance it's higher", pct(d.prob_up, 0), d.prob_up >= 50 ? "up" : "down");
    s += stat("90% range", `${usd(d.low)} – ${usd(d.high)}`);
  }
  $("#rStats").innerHTML = s;
  const o = { v: 0 };
  gsap.timeline()
    .from("#rLabel", { opacity: 0, y: 12, duration: 0.6, ease: "power3.out" })
    .to(o, { v: d.predicted, duration: 1.8, ease: "expo.out",
      onUpdate: () => ($("#rPrice").textContent = Number(o.v).toLocaleString("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 })) }, 0)
    .from(".rstat", { opacity: 0, y: 30, scale: 0.95, stagger: 0.08, duration: 0.9, ease: "expo.out" }, 0.2);
}

function drawForecast(d, animate) {
  const svg = $("#forecastChart");
  const H = d.history;
  const legend = $("#fLegend");
  if (d.mode === "historical") {
    const ms = H.dates.map(toMs);
    const target = toMs(d.date);
    const f = frame(svg, [ms[0], ms[ms.length - 1]], [Math.min(...H.prices, d.low), Math.max(...H.prices, d.high)]);
    const xs = ms.map(f.x);
    legend.innerHTML = `<span><i style="background:#8d93a8"></i>Actual</span><span><i style="background:#f7931a"></i>Model prediction</span><span><i class="band" style="background:#f7931a"></i>90% range</span>`;
    el("path", { d: areaPath(xs, H.prices.map(f.y), xs.map(() => f.h - f.m.b)), fill: gradient(f.defs, "fhArea", "#8d93a8", 0.15, 0) }, f.layer);
    const line = el("path", { class: "line", d: linePath(xs, H.prices.map(f.y)), stroke: "#8d93a8" }, f.layer);
    const X = f.x(target);
    const vline = el("line", { x1: X, x2: X, y1: f.m.t, y2: f.h - f.m.b, stroke: "rgba(247,147,26,.4)", "stroke-dasharray": "4 5" }, f.layer);
    const bar = el("line", { x1: X, x2: X, y1: f.y(d.low), y2: f.y(d.high), stroke: "#f7931a", "stroke-width": 10, "stroke-linecap": "round", opacity: 0.35 }, f.layer);
    const act = el("circle", { cx: X, cy: f.y(d.actual), r: 6, fill: "#eef0f6" }, f.layer);
    const dot = el("circle", { cx: X, cy: f.y(d.predicted), r: 8, fill: "#f7931a", stroke: "#05060a", "stroke-width": 3 }, f.layer);
    attachTooltip(svg, $("#fTip"), f, H.dates, [{ label: "Actual", color: "#8d93a8", values: H.prices }]);
    if (animate) {
      gsap.timeline()
        .fromTo(line, { drawSVG: "0%" }, { drawSVG: "100%", duration: 1.6, ease: "power2.inOut" })
        .fromTo(vline, { drawSVG: "0%" }, { drawSVG: "100%", duration: 0.6 }, 0.8)
        .fromTo(bar, { drawSVG: "50% 50%" }, { drawSVG: "0% 100%", duration: 0.8, ease: "expo.out" }, 1.1)
        .from([act, dot], { attr: { r: 0 }, duration: 0.9, stagger: 0.15, ease: "elastic.out(1, 0.5)" }, 1.2);
    }
    return;
  }

  // Future: history + Monte Carlo fan
  const F = d.forecast;
  const dates = H.dates.concat(F.dates);
  const ms = dates.map(toMs);
  const hN = H.dates.length;
  const lo = Math.min(...H.prices, ...F.p5), hi = Math.max(...H.prices, ...F.p95);
  const f = frame(svg, [ms[0], ms[ms.length - 1]], [lo, hi]);
  legend.innerHTML = `<span><i style="background:#8d93a8"></i>Actual</span><span><i style="background:#f7931a"></i>Median forecast</span>
    <span><i class="band" style="background:#f7931a"></i>50% range</span><span><i class="band" style="background:#7b5cff"></i>90% range</span>
    <span><i style="background:#7b5cff;opacity:.6"></i>Sample paths</span>`;
  const hx = ms.slice(0, hN).map(f.x);
  // forecast series start from the last actual point so the fan is attached to history
  const fx = [hx[hN - 1], ...ms.slice(hN).map(f.x)];
  const lastP = H.prices[hN - 1];
  const withStart = (arr) => [lastP, ...arr];
  const clip = el("clipPath", { id: "fanClip" }, f.defs);
  const clipRect = el("rect", { x: hx[hN - 1], y: 0, width: animate ? 0 : f.w, height: f.h }, clip);

  el("path", { d: areaPath(hx, H.prices.map(f.y), hx.map(() => f.h - f.m.b)), fill: gradient(f.defs, "fhArea2", "#8d93a8", 0.15, 0) }, f.layer);
  const fan = el("g", { "clip-path": "url(#fanClip)" }, f.layer);
  el("path", { d: areaPath(fx, withStart(F.p95).map(f.y), withStart(F.p5).map(f.y)), fill: "#7b5cff", opacity: 0.16 }, fan);
  el("path", { d: areaPath(fx, withStart(F.p75).map(f.y), withStart(F.p25).map(f.y)), fill: "#f7931a", opacity: 0.2 }, fan);
  const samples = F.samples.map((sp) => el("path", { class: "line", d: linePath(fx, withStart(sp).map(f.y)), stroke: "#9c86ff", "stroke-width": 1, opacity: 0.45 }, f.layer));
  const hist = el("path", { class: "line", d: linePath(hx, H.prices.map(f.y)), stroke: "#8d93a8" }, f.layer);
  const med = el("path", { class: "line", d: linePath(fx, withStart(F.p50).map(f.y)), stroke: "#f7931a", "stroke-width": 2.5 }, f.layer);
  const nowX = hx[hN - 1];
  const nowLine = el("line", { x1: nowX, x2: nowX, y1: f.m.t, y2: f.h - f.m.b, stroke: "rgba(255,255,255,.25)", "stroke-dasharray": "3 5" }, f.layer);
  const nowTxt = el("text", { x: nowX + 8, y: f.m.t + 14, fill: "#8d93a8", "font-size": 11, "font-family": "JetBrains Mono" }, f.layer);
  nowTxt.textContent = "LAST DATA →";
  const endX = fx[fx.length - 1], endY = f.y(F.p50[F.p50.length - 1]);
  const ring = el("circle", { cx: endX, cy: endY, r: 14, fill: "none", stroke: "#f7931a", "stroke-width": 1.5 }, f.layer);
  const endDot = el("circle", { cx: endX, cy: endY, r: 6, fill: "#f7931a", stroke: "#05060a", "stroke-width": 2 }, f.layer);

  const pad = new Array(hN - 1).fill(null);
  attachTooltip(svg, $("#fTip"), f, dates, [
    { label: "Actual", color: "#8d93a8", values: H.prices.concat(new Array(F.dates.length).fill(null)) },
    { label: "Median", color: "#f7931a", values: pad.concat(withStart(F.p50)) },
    { label: "90% low", color: "#9c86ff", values: pad.concat(withStart(F.p5)) },
    { label: "90% high", color: "#9c86ff", values: pad.concat(withStart(F.p95)) },
  ]);

  gsap.killTweensOf(ring);
  gsap.to(ring, { attr: { r: 26 }, opacity: 0, duration: 1.6, repeat: -1, ease: "power2.out", delay: animate ? 3 : 0 });
  if (!animate) return;
  gsap.timeline()
    .fromTo(hist, { drawSVG: "0%" }, { drawSVG: "100%", duration: 1.3, ease: "power2.inOut" })
    .fromTo(nowLine, { drawSVG: "0%" }, { drawSVG: "100%", duration: 0.5 }, 1)
    .from(nowTxt, { opacity: 0, x: -10, duration: 0.5 }, 1.1)
    .to(clipRect, { attr: { width: f.w }, duration: 1.8, ease: "power2.inOut" }, 1.2)
    .fromTo(samples, { drawSVG: "0%" }, { drawSVG: "100%", duration: 1.6, stagger: 0.08, ease: "power2.inOut" }, 1.2)
    .fromTo(med, { drawSVG: "0%" }, { drawSVG: "100%", duration: 1.8, ease: "power2.inOut" }, 1.3)
    .from(endDot, { attr: { r: 0 }, duration: 0.8, ease: "elastic.out(1, 0.4)" }, 2.9);
}

// ------------------------------------------------------------------ Boot
const dataPromise = fetch("/api/meta").then((r) => r.json());
let intro = null;

// Build the whole page while the loader still covers it, then compile every shader once,
// so nothing heavy happens after the reveal.
const ready = Promise.all([dataPromise, document.fonts.ready]).then(async ([meta]) => {
  META = meta;
  MODEL = META.default_model; // Random Forest
  $("#tLast").textContent = usd(META.last_close);
  $("#tModel").textContent = M().name;
  onModelChange(() => {
    $("#tModel").textContent = M().name;
    gsap.fromTo("#tModel", { yPercent: 60, opacity: 0 }, { yPercent: 0, opacity: 1, duration: 0.6, ease: "expo.out" });
    gsap.to(scene.state, { spin: scene.state.spin + Math.PI * 2, duration: 1.4, ease: "expo.out" });
  });
  scene.setPriceHistory(META.weekly.prices);

  cursor();
  modelSwitches();
  marquee();
  backtestAnimations();
  gauges();
  modelsTable();
  evaluationDashboard();
  setupPredict();
  pipeline();
  scrollReveals();

  ScrollTrigger.refresh();
  let sceneST = sceneTimeline();
  intro = buildIntro();
  let rt;
  addEventListener("resize", () => {
    clearTimeout(rt);
    rt = setTimeout(() => {
      backtestSection();
      // rebuild the scene choreography once ScrollTrigger has re-measured the layout
      sceneST.animation.kill(); sceneST.kill();
      sceneST = sceneTimeline();
    }, 500);
  });
  if (reduceMotion) gsap.globalTimeline.timeScale(3);
  await scene.warmup();
});

runLoader(ready, () => {
  intro.play();
  ambientLoops();
}).then(() => {
  lenis.start();
  ScrollTrigger.update();
});

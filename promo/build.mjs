// Builds the figure and the video page into scratch/media/promo/build/.
//   node promo/build.mjs            figure.html, figure-light.html (standalone, looping) and promo.html (the video page)
// The Anatomy skill must be installed; set ANATOMY_SKILL if it lives somewhere else.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as M from "./model.mjs";
import { makeBench } from "./bench.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const SKILL = process.env.ANATOMY_SKILL ?? join(homedir(), ".agents/skills/anatomy");
const OUT = join(ROOT, "scratch/media/promo/build");
if (!existsSync(join(SKILL, "kit/iso-kit.mjs"))) throw new Error(`The Anatomy skill is not installed at ${SKILL}.`);

const k = await import(pathToFileURL(join(SKILL, "kit/iso-kit.mjs")).href);
const G = await import(pathToFileURL(join(SKILL, "kit/lathe.mjs")).href);
const bench = makeBench(k, G, M);

// A module as an expression: its exports become the fields of one object, so several modules share a page script.
function moduleOf(file, needs = "") {
  const source = readFileSync(file, "utf8");
  const names = [...source.matchAll(/^export (?:function|const|let|class) (\w+)/gm)].map((match) => match[1]);
  const body = source.replace(/^import .*$/gm, "").replace(/^export /gm, "");
  return `(() => {${needs}\n${body}\nreturn { ${names.join(", ")} };\n})()`;
}
const RUNTIME = `
const k = ${moduleOf(join(SKILL, "kit/iso-kit.mjs"))};
const G = ${moduleOf(join(SKILL, "kit/lathe.mjs"), "const { cameraOf, iso, pathOf } = k;")};
const M = ${moduleOf(join(HERE, "model.mjs"))};
const { makeBench } = ${moduleOf(join(HERE, "bench.mjs"))};
const bench = makeBench(k, G, M);
const live = Object.fromEntries([...document.querySelectorAll("[data-live]")].map((node) => [node.dataset.live, node]));
// Draws the bench exactly as it stands at cycle time t and returns that state.
function figSeek(t) {
  const state = M.stateAt(t);
  const art = bench.frame(state);
  for (const name in art) live[name].innerHTML = art[name];
  return state;
}
`;

// The standalone figure: an idle tour that loops, stops offscreen and stands still under reduced motion.
const TOUR = `
const stage = document.querySelector(".iso-stage");
const readout = document.querySelector("[data-readout]");
const still = matchMedia("(prefers-reduced-motion: reduce)");
let frame = 0, last = 0, clock = 0, visible = false, held = false;
const draw = (t) => {
  const state = figSeek(t);
  const text = M.readoutOf(state);
  if (readout.textContent !== text) readout.textContent = text;
  return state;
};
function tick(now) {
  const dt = last ? Math.min((now - last) / 1000, 1 / 30) : 1 / 60;
  last = now;
  clock += dt;
  draw(clock);
  frame = visible && !held ? requestAnimationFrame(tick) : 0;
}
const run = () => { if (!frame && visible && !held && !still.matches) { last = 0; frame = requestAnimationFrame(tick); } };
new IntersectionObserver((entries) => { visible = entries[entries.length - 1].isIntersecting; if (visible) run(); }, { rootMargin: "120px 0px" }).observe(stage);
const describe = (state) => stage.setAttribute("aria-valuetext", state.pieces + " of " + M.REAL.pieces + " pieces joined");
// Arrow keys step through the run by hand; Space hands it back to the tour.
stage.addEventListener("keydown", (event) => {
  const step = event.shiftKey ? 1 : 0.25;
  if (event.key === "ArrowRight" || event.key === "ArrowUp") clock = Math.min(M.RESET - 0.01, clock % M.CYCLE + step);
  else if (event.key === "ArrowLeft" || event.key === "ArrowDown") clock = Math.max(0, clock % M.CYCLE - step);
  else if (event.key === "Home") clock = 0;
  else if (event.key === "End") clock = M.DONE;
  else if (event.key === " " || event.key === "Enter") { held = false; event.preventDefault(); run(); return; }
  else return;
  event.preventDefault();
  held = true;
  describe(draw(clock));
});
// A seekable clock for tools: promoSeek(t) stops the tour and shows the bench at t.
window.promoSeek = (t) => { held = true; clock = t; return draw(t); };
describe(draw(still.matches ? M.DONE : 0));
`;

const FIGURE_CSS = readFileSync(join(HERE, "figure.css"), "utf8");
const inline = (script) => script.replace(/<\/(script)/gi, "<\\/$1");

function figureSvg() {
  const first = bench.frame(M.stateAt(0));
  const body = bench.layers.map((layer) => (typeof layer === "string" ? layer : `<g data-live="${layer.live}">${first[layer.live]}</g>`));
  return k.figureSvg({ width: bench.W, height: bench.H, label: bench.label, body: `<g id="sg-bench">${body.join("")}</g>` });
}

function plate({ hint, legend }) {
  return k.plateHtml({
    fig: "Fig 1",
    title: "Splicing bench",
    hint,
    readout: M.readoutOf(M.stateAt(0)),
    keys: legend
      ? [
          { mark: "lit", label: "The viewer: the frame under the gate, lit once picture film reaches it" },
          { mark: "raised", label: "Strips of picture film, 53 pieces each, and the sound tape beside them" },
        ]
      : [],
    caption: legend
      ? `One real download replayed on a splicing bench: ${M.REAL.pieces} two-second pieces, ${M.REAL.pictureMB} MB of picture and ${M.REAL.soundMB} MB of sound, joined without re-encoding into one ${M.REAL.totalMB} MB file, ${M.clock(M.REAL.seconds)} long at ${M.REAL.height}p. One turn of the dial is the whole download.`
      : undefined,
    body: `<div class="iso-stage" tabindex="0" role="slider" aria-label="Splicing bench: arrow keys step through one download, Space resumes the tour" aria-valuemin="0" aria-valuemax="${M.REAL.pieces}" aria-valuenow="0">${figureSvg()}</div>`,
  });
}

mkdirSync(OUT, { recursive: true });

for (const theme of ["dark", "light"]) {
  const page = k
    .pageHtml({ title: "streamgrab: splicing bench", theme, width: 760, body: plate({ hint: "Runs one download, then loops", legend: true }), script: RUNTIME + TOUR })
    .replace("</style>", `${FIGURE_CSS}</style>`);
  const name = theme === "light" ? "figure-light.html" : "figure.html";
  writeFileSync(join(OUT, name), page);
  console.log("wrote", join(OUT, name));
}

// The video page. The font and the screenshot are embedded so the page is one file.
const font = readFileSync(join(ROOT, "node_modules/@fontsource-variable/bricolage-grotesque/files/bricolage-grotesque-latin-wght-normal.woff2")).toString("base64");
const fresh = join(ROOT, "scratch/media/promo/popup-many-dark@2x.png");
const shot = readFileSync(existsSync(fresh) ? fresh : join(ROOT, "scratch/media/e2e/popup-many-dark.png")).toString("base64");
const video = `<!doctype html><html><head><meta charset="utf-8"><title>streamgrab promo</title><style>
@font-face { font-family: "Bricolage Grotesque"; font-weight: 200 800; font-display: block; src: url(data:font/woff2;base64,${font}) format("woff2"); }
${k.ISO_CSS}${FIGURE_CSS}${readFileSync(join(HERE, "page.css"), "utf8")}</style></head><body><div class="stage">
<section class="scene title"><h1 class="wordmark">streamgrab</h1><div class="bar"></div><p class="line" data-text="tagline"></p></section>
<section class="scene bench"><div class="brand wordmark">streamgrab</div><div class="card iso" data-theme="dark">${plate({ hint: "-", legend: false })}</div><div class="inset iso" data-theme="dark"><svg class="iso-svg" viewBox="0 0 250 100" aria-hidden="true"><use href="#sg-bench"/></svg></div><div class="caps"><p class="cap"><i></i></p><p class="cap"><i></i></p><p class="cap"><i></i></p></div></section>
<section class="scene product"><div class="shot"><img alt="" src="data:image/png;base64,${shot}"></div><p class="line" data-text="product"></p></section>
<section class="scene end"><h1 class="wordmark">streamgrab</h1><div class="bar"></div><p class="line" data-text="end"></p><p class="url">github.com/xingfanxia/streamgrab</p></section>
</div><script type="module">${inline(RUNTIME + readFileSync(join(HERE, "page.js"), "utf8"))}</script></body></html>`;
writeFileSync(join(OUT, "promo.html"), video);
console.log("wrote", join(OUT, "promo.html"));

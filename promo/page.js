// The promo video's timeline. Everything on the page is a pure function of t, set by window.promoSeek(t):
// no wall clock, no requestAnimationFrame on the recorded path. `figSeek`, `M` and the figure come from the build.
const STRINGS = {
  en: {
    tagline: "Save the video playing on any page",
    caps: ["Finds the stream the page is playing", "Picture and sound served apart? Joined into one file, never re-encoded", "One MP4, in your Downloads"],
    product: "Direct files, HLS, DASH —\nYouTube and Bilibili\nthrough yt-dlp",
    end: "Open source, MIT. No account, no limits, no telemetry.",
    fig: "Fig 1",
    title: "Splicing bench",
    hint: "One real download, replayed",
    words: { pieces: "pieces", threading: "threading", clearing: "clearing the bench" },
  },
  zh: {
    tagline: "把网页上正在播放的视频存下来",
    caps: ["找到页面正在播放的那条流", "画面和声音分开？\n自动接成一个文件，不重新编码", "一个 MP4，存进下载目录"],
    product: "直链、HLS、DASH，\nYouTube 和 B 站走 yt-dlp",
    end: "开源 · MIT\n没有账号、没有限制、不联网上报",
    fig: "图 1",
    title: "接片台",
    hint: "一次真实下载的回放",
    words: { pieces: "片", threading: "穿片中", clearing: "清台" },
  },
};
const DURATION = 20;
// Scene windows: [start, end, fade in, fade out]
const SCENES = { title: [0, 3, 0.5, 0.4], bench: [3, 14, 0.5, 0.4], product: [14, 18, 0.5, 0.4], end: [18, 20.5, 0.45, 0] };
// The bench starts its run a little after it appears, so strips are seen leaving the magazine.
const BENCH_STARTS = 3.6;
const CAPS = [[3.5, 6.45], [6.75, 10.2], [10.5, 13.75]];

const query = new URLSearchParams(location.search);
const lang = query.get("lang") === "zh" ? "zh" : "en";
const format = query.get("format") === "3x4" ? "3x4" : "16x9";
const T = STRINGS[lang];
document.documentElement.lang = lang === "zh" ? "zh-Hans" : "en";
document.documentElement.dataset.lang = lang;
document.documentElement.dataset.format = format;

const $ = (selector) => document.querySelector(selector);
for (const node of document.querySelectorAll("[data-text]")) node.textContent = T[node.dataset.text];
document.querySelectorAll(".cap").forEach((node, index) => node.append(T.caps[index]));
$('[data-corner="fig"]').textContent = T.fig;
$('[data-corner="title"]').textContent = T.title;
$('[data-corner="hint"]').textContent = T.hint;

const ease = M.ease;
const windowOf = (t, [from, to, rise, fall]) => ease((t - from) / rise) * (fall ? 1 - ease((t - (to - fall)) / fall) : 1);
const show = (node, opacity, lift = 0) => {
  node.style.opacity = opacity.toFixed(4);
  node.style.transform = lift ? `translateY(${lift.toFixed(2)}px)` : "";
};

const scenes = Object.fromEntries(Object.keys(SCENES).map((name) => [name, $(`.scene.${name}`)]));
const caps = [...document.querySelectorAll(".cap")];
const readout = $("[data-readout]");
const zoom = $(".inset svg");

window.promoDuration = DURATION;
window.promoSeek = (time) => {
  const t = Math.min(DURATION, Math.max(0, time));
  for (const name in SCENES) scenes[name].style.opacity = windowOf(t, SCENES[name]).toFixed(4);

  // 1 · title: wordmark, then the bar, then the line.
  show($(".title .wordmark"), ease(t / 0.6), 18 * (1 - ease(t / 0.7)));
  $(".title .bar").style.transform = `scaleX(${ease((t - 0.35) / 0.6).toFixed(4)})`;
  show($(".title .line"), ease((t - 0.6) / 0.6), 14 * (1 - ease((t - 0.6) / 0.7)));

  // 2 · the bench runs one download and then rests on the finished reel.
  const state = figSeek(Math.min(M.RESET - 0.01, Math.max(0, t - BENCH_STARTS)));
  readout.textContent = M.readoutOf(state, T.words);
  caps.forEach((node, index) => {
    const [from, to] = CAPS[index];
    const on = windowOf(t, [from, to, 0.4, 0.35]);
    show(node, on, 12 * (1 - ease((t - from) / 0.5)));
  });

  // The close-up window (tall format) moves from the magazine to the splice to the take-up reel with the captions.
  const mix = (a, b, share) => a + (b - a) * share;
  const toSplice = ease((t - 6.35) / 0.9);
  const toReel = ease((t - 10.1) / 0.9);
  const [feed, splice, reel] = [bench.views.feed, bench.views.splice, bench.views.reel];
  const cx = mix(mix(feed[0][0], splice[0][0], toSplice), reel[0][0], toReel);
  const cy = mix(mix(feed[0][1], splice[0][1], toSplice), reel[0][1], toReel);
  const w = mix(mix(feed[1], splice[1], toSplice), reel[1], toReel);
  const h = (w * 372) / 950;
  zoom.setAttribute("viewBox", `${(cx - w / 2).toFixed(2)} ${(cy - h / 2).toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)}`);

  // 3 · the product: the screenshot settles, the line follows.
  const p = t - SCENES.product[0];
  $(".shot").style.transform = `translateY(${(22 * (1 - ease(p / 0.8))).toFixed(2)}px)`;
  show($(".product .line"), ease((p - 0.35) / 0.6), 14 * (1 - ease((p - 0.35) / 0.7)));

  // 4 · end card.
  const e = t - SCENES.end[0];
  show($(".end .wordmark"), ease(e / 0.5), 14 * (1 - ease(e / 0.6)));
  $(".end .bar").style.transform = `scaleX(${ease((e - 0.2) / 0.5).toFixed(4)})`;
  show($(".end .line"), ease((e - 0.3) / 0.5));
  show($(".end .url"), ease((e - 0.5) / 0.5));
  return state;
};

// Preview helpers: ?t=12 shows one moment, ?play=1 plays in real time. The renderer uses neither.
window.promoSeek(Number(query.get("t") ?? 0));
if (query.get("play")) {
  const began = performance.now();
  const loop = (now) => {
    window.promoSeek(((now - began) / 1000) % DURATION);
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

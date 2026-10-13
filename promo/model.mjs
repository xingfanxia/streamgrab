// The truth behind the figure: one real download made with streamgrab, and the clock that replays it on the bench.
// Pure functions only. The build, the standalone figure and the video page all read their numbers from here.

// A DASH video saved with the extension and checked with ffprobe afterwards.
export const REAL = {
  seconds: 424.57, // running time, 7:05
  pieces: 212, // two-second segments
  pictureMB: 71.2,
  soundMB: 10.3,
  totalMB: 81.5,
  height: 1080,
};

export const CYCLE = 9; // seconds for one run of the bench
export const STROKES = 4; // strips spliced on the bench; each one stands for 53 pieces
export const PER_STROKE = REAL.pieces / STROKES;
export const INTRO = 0.7; // strips slide out of the magazine
export const STROKE = 1.7; // seconds per splice
export const DONE = INTRO + STROKES * STROKE; // 7.5
export const RESET = 8.3; // the bench is cleared for the next run

// Where each part of a stroke happens, as shares of the stroke.
export const BEAT = { close: [0, 0.22], down: [0.22, 0.36], up: [0.52, 0.64], advance: [0.64, 1] };

export const clamp01 = (value) => Math.min(1, Math.max(0, value));
export const ease = (value) => {
  const x = clamp01(value);
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
};
const span = (value, [from, to]) => ease((value - from) / (to - from));

// The state of the bench at cycle time t (seconds). Everything the figure draws follows from this.
//   feed     strips fed so far, as a real number: -1 (all in the magazine) … 4 (all joined and wound on)
//   butt     0…1, the leading strip closing the gap to the film's tail
//   press    0…1, the clamp coming down
//   pieces   whole pieces joined so far, 0…212
//   ghost    0…1 opacity of the film on the bench (it fades while the bench is cleared)
//   wound    strips' worth of film on the take-up reel, 0…4 (it rewinds smoothly while the bench is cleared)
export function stateAt(time) {
  const t = ((time % CYCLE) + CYCLE) % CYCLE;
  if (t < INTRO) {
    return { t, phase: "threading", stroke: 0, feed: -1 + ease((t - 0.08) / (INTRO - 0.12)), butt: 0, press: 0, pieces: 0, ghost: 1, wound: 0, stack: 1, lamp: 0 };
  }
  if (t < DONE) {
    const stroke = Math.min(STROKES - 1, Math.floor((t - INTRO) / STROKE));
    const u = (t - INTRO) / STROKE - stroke;
    const moved = span(u, BEAT.advance);
    const press = span(u, BEAT.down) * (1 - span(u, BEAT.up));
    const joined = clamp01((u - BEAT.down[0]) / (BEAT.up[1] - BEAT.down[0]));
    const feed = stroke + moved;
    return {
      t,
      phase: "joining",
      stroke,
      feed,
      butt: span(u, BEAT.close),
      press,
      pieces: Math.round((stroke + joined) * PER_STROKE),
      ghost: 1,
      wound: feed,
      stack: 1 - (stroke + joined) / STROKES,
      lamp: lampAt(feed),
    };
  }
  if (t < RESET) {
    return { t, phase: "done", stroke: STROKES, feed: STROKES, butt: 0, press: 0, pieces: REAL.pieces, ghost: 1, wound: STROKES, stack: 0, lamp: 1 };
  }
  const r = (t - RESET) / (CYCLE - RESET);
  const back = ease(r);
  const first = r < 0.5;
  return {
    t,
    phase: "clearing",
    stroke: first ? STROKES : 0,
    feed: first ? STROKES : -1,
    butt: 0,
    press: 0,
    pieces: Math.round(REAL.pieces * (1 - back)),
    ghost: first ? 1 - ease(r / 0.45) : ease((r - 0.55) / 0.45),
    wound: STROKES * (1 - back),
    stack: back,
    lamp: 1 - ease(r / 0.3),
  };
}

// The viewer lights once picture film, not leader, lies under its gate (just over one strip downstream of the splice).
const lampAt = (feed) => ease((feed - 1.02) / 0.25);

export const megabytes = (pieces) => (REAL.totalMB * pieces) / REAL.pieces;
export const clock = (seconds) => {
  const whole = Math.round(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
};

// The live readout in the corner of the card. Words and numbers come from the same state.
export const WORDS = { pieces: "pieces", threading: "threading", clearing: "clearing the bench" };
export function readoutOf(state, words = WORDS) {
  const count = `${state.pieces} / ${REAL.pieces} ${words.pieces}`;
  const size = `${megabytes(state.pieces).toFixed(1)} MB`;
  if (state.phase === "done") return `${count} · ${size} · ${clock(REAL.seconds)} · ${REAL.height}p`;
  if (state.phase === "threading") return `${count} · ${words.threading}`;
  if (state.phase === "clearing") return `${count} · ${words.clearing}`;
  return `${count} · ${size}`;
}

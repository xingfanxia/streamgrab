// The figure: a film splicing bench. Short strips of picture film leave a magazine, a reel of magnetic sound tape runs
// beside them, a clamp joins both into one print that passes a lit viewer and winds onto a take-up reel.
// One factory, used twice: by the Node build (static markup and the first frame) and inside the page (every frame).
// `k` is the Anatomy kit (iso-kit), `G` its lathe module, `M` the model.

export function makeBench(k, G, M) {
  const W = 720;
  const H = 372;

  // World units, about 1 px of the real thing: x along the bench, y toward the viewer, z up.
  const PLATE = { x: -128, y: -36, w: 260, d: 88, r: 6 };
  const PLATE_H = 8;
  const FOOT_H = 5;
  const TRACK = { x: -74, y: 1.5, w: 132, d: 17.5, r: 0.8 };
  const DECK = 2; // top of the track
  const FILM = 0.4; // film thickness
  const TAPE = [2.5, 6]; // sound lane, y
  const PICTURE = [6, 18]; // picture lane, y
  const STRIP = 36; // one strip of film
  const GAP = 5; // between waiting strips
  const FRAME = 12; // one frame of picture
  const SPLICE = -10; // x of the splice line
  const SLOT = -74; // x where strips leave the magazine
  const FLAT_END = 56; // x where the print leaves the track for the take-up reel
  const SOUND = { x: -96, z: 46, flange: 18, full: 15, empty: 8, hub: 4.5 };
  const TAKE = { x: 94, z: 40, flange: 30, empty: 9, full: 25, hub: 7 };
  const IDLER = { r: 2, z: DECK + FILM + 2, sound: -64, take: FLAT_END };
  const BLOCK = { x: -26, y: -4, w: 32, d: 28, r: 1.5 };
  const PRESS = { x: -17, y: -2.5, w: 14, d: 25, r: 1.5 };
  const PRESS_OPEN = 11;
  const PRESS_SHUT = DECK + FILM + 0.1;
  const PRESS_H = 3;
  const POSTS = [[-10, -0.9], [-10, 20.7]];
  const POST_TOP = 18;
  const VIEWER = { x: 14, y: -28, w: 30, d: 28, r: 2 };
  const VIEWER_H = 30;
  const SCREEN = { x: 17, top: 25, w: 24, h: 13.5 };
  const GATE = { x: 22, y: 0, w: 12, d: 19.4, r: 1 };
  const DIAL = [-48, 38];
  const DIAL_R = 11;
  const DIAL_H = 8;
  const CAN = [100, 35];

  const P = k.fitProjection(
    [...k.boxCorners(PLATE, -PLATE_H - FOOT_H, 0), [SOUND.x, 4, SOUND.z + SOUND.flange + 2], [TAKE.x, 10, TAKE.z + TAKE.flange + 2], [TAKE.x + TAKE.flange, 19, TAKE.z]],
    W,
    H,
    { pad: 12, azimuth: 58 },
  );

  const at = (point) => k.iso(point, P);
  const S = (paths, style) => k.solidSvg(paths, style);
  const L = (d, style) => k.lineSvg(d, style);
  const D = (points, style) => k.dotsSvg(points, style);
  const path = (points, closed = true) => points.map(([x, y], index) => `${index ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join("") + (closed ? "Z" : "");
  const byDepth = (points) => [...points].sort((a, b) => k.depthOf([a[0], a[1], 0], P) - k.depthOf([b[0], b[1], 0], P));
  // A frame whose axis runs toward the viewer along y; angles turn clockwise on screen from straight up.
  const axle = (x, z) => G.frameOf([x, 0, z], [0, 1, 0], [0, 0, 1], [1, 0, 0]);
  const SOUND_F = axle(SOUND.x, SOUND.z);
  const TAKE_F = axle(TAKE.x, TAKE.z);

  // The straight run of film or tape between two round things, in the x–z plane. `side` is +1 when the round thing lies
  // to the left of the direction of travel, −1 when it lies to the right.
  function tangent(c1, r1, side1, c2, r2, side2) {
    const dx = c2[0] - c1[0];
    const dz = c2[1] - c1[1];
    const distance = Math.hypot(dx, dz);
    const turn = Math.acos((side2 * r2 - side1 * r1) / distance);
    const base = Math.atan2(dz, dx);
    for (const sign of [1, -1]) {
      const n = [Math.cos(base + sign * turn), Math.sin(base + sign * turn)];
      const d = [n[1], -n[0]];
      if (d[0] * dx + d[1] * dz > 0) {
        return { from: [c1[0] - side1 * r1 * n[0], c1[1] - side1 * r1 * n[1]], to: [c2[0] - side2 * r2 * n[0], c2[1] - side2 * r2 * n[1]] };
      }
    }
    return null;
  }

  // A flat band between two points of the x–z plane, as wide as a lane.
  function band(from, to, [y0, y1], marks = []) {
    const corners = [[from[0], y0, from[1]], [from[0], y1, from[1]], [to[0], y1, to[1]], [to[0], y0, to[1]]].map(at);
    const length = Math.hypot(to[0] - from[0], to[1] - from[1]);
    const across = marks
      .filter(([s]) => s > 0.4 && s < length - 0.4)
      .map(([s, tone, lane = [y0, y1]]) => {
        const x = from[0] + ((to[0] - from[0]) * s) / length;
        const z = from[1] + ((to[1] - from[1]) * s) / length;
        return L(k.segment([x, lane[0], z], [x, lane[1], z], P), { tone });
      })
      .join("");
    return `<g class="iso-solid sg-band"><path class="iso-fill" d="${path(corners)}"/><path class="iso-shade" data-shade="3" d="${path(corners)}"/>${across}<path class="iso-line iso-edge" data-tone="hi" d="${path(corners)}"/></g>`;
  }

  // ---------------------------------------------------------------------------------------------- static parts

  function plate() {
    const out = [`<path class="iso-halo" d="${k.haloOf(PLATE, -PLATE_H - FOOT_H, PLATE_H, P)}"/>`];
    for (const [x, y] of byDepth(k.corners(PLATE, 18))) {
      out.push(S(k.cylinder(x, y, 7, -PLATE_H - FOOT_H, 1.6, P, 28), { tone: "lo" }));
      out.push(S(k.cylinder(x, y, 5.4, -PLATE_H - FOOT_H + 1.6, FOOT_H - 1.6, P, 28), { tone: "mid" }));
    }
    out.push(S(k.slabOf(PLATE, -PLATE_H, PLATE_H, P, 8, 1.4), { tone: "mid", inner: L(k.sideSeam(PLATE, -PLATE_H + 2.2, P, 8), { tone: "faint" }) }));
    out.push(L(k.planOutline(k.insetPlan(PLATE, 4), 0, P), { tone: "lo" }));
    const screws = k.corners(PLATE, 9);
    out.push(L(screws.map(([x, y]) => k.ring(x, y, 2, 0, P, 16)).join(""), { tone: "lo" }));
    out.push(D(screws.map(([x, y]) => at([x, y, 0])), { size: 0.5 }));
    return out.join("");
  }

  // Everything behind the film path: the splicing-tape dispenser, the two rewind posts and the viewer's lamp house.
  function dispenser() {
    const out = [];
    const base = { x: -19, y: -29.5, w: 18, d: 15.5, r: 2 };
    out.push(S(k.slabOf(base, 0, 2, P, 4, 0.5), { tone: "mid" }));
    out.push(D([at([base.x + 2.4, base.y + 2.4, 2]), at([base.x + base.w - 2.4, base.y + 2.4, 2])], { size: 0.4 }));
    out.push(S(k.cylinder(-10, -22.5, 5.6, 2, 3.6, P, 32, 0.4), { tone: "hi", crease: "lo" }));
    out.push(L(k.ring(-10, -22.5, 2.4, 5.6, P, 20), { tone: "lo" }));
    out.push(S(k.cylinder(-10, -22.5, 1.5, 5.6, 1.6, P, 16), { tone: "mid" }));
    out.push(S(k.slabOf({ x: -19, y: -15.4, w: 18, d: 1.4, r: 0.4 }, 2, 3, P, 2), { tone: "mid", crease: "none" }));
    return out.join("");
  }

  // A shallow tray for trims at the back, and two spare cores on pegs.
  function spares() {
    const out = [];
    const tray = { x: -74, y: -30, w: 40, d: 17, r: 2 };
    out.push(S(k.slabOf(tray, 0, 3.2, P, 4, 0.5), { tone: "mid", inner: L(k.sideSeam(tray, 1.2, P, 4), { tone: "faint" }) }));
    out.push(L(k.planOutline(k.insetPlan(tray, 2.2), 3.2, P, 3), { tone: "lo" }));
    out.push(D(k.corners(tray, 1.2).map(([x, y]) => at([x, y, 3.2])), { size: 0.35 }));
    const rack = { x: 54, y: -30, w: 28, d: 15, r: 2 };
    out.push(S(k.slabOf(rack, 0, 1.4, P, 4, 0.4), { tone: "lo" }));
    for (const x of [61.5, 74.5]) {
      out.push(S(k.cylinder(x, -22.5, 5, 1.4, 4.6, P, 32, 0.4), { tone: "mid" }));
      out.push(L(k.ring(x, -22.5, 3.4, 6, P, 24), { tone: "faint" }) + L(k.ring(x, -22.5, 1.6, 6, P, 16), { tone: "lo" }));
      out.push(S(k.cylinder(x, -22.5, 1.1, 6, 1.6, P, 14), { tone: "mid", crease: "none" }));
    }
    return out.join("");
  }

  function post(x, top, spindle) {
    const out = [];
    const plan = { x: x - 6, y: -14, w: 12, d: 9, r: 1.5 };
    out.push(S(k.slabOf(k.insetPlan(plan, -1.5), 0, 2.4, P, 4, 0.5), { tone: "mid" }));
    out.push(D(k.corners(k.insetPlan(plan, -1.5), 1.6).map(([px, py]) => at([px, py, 2.4])), { size: 0.4 }));
    out.push(S(k.slabOf(plan, 2.4, top - 2.4, P, 4, 0.6), { tone: "mid", inner: L(k.sideSeam(plan, spindle - 9, P, 4) + k.sideSeam(plan, 8, P, 4), { tone: "faint" }) }));
    out.push(L(k.planOutline(k.insetPlan(plan, 2), top, P, 3), { tone: "faint" }));
    out.push(D([at([x, -9.5, top])], { size: 0.5 }));
    return out.join("");
  }

  function viewerBody() {
    const out = [];
    out.push(S(k.slabOf(VIEWER, 0, VIEWER_H, P, 5, 0.8), { tone: "mid", inner: L(k.sideSeam(VIEWER, 4, P, 5), { tone: "faint" }) }));
    out.push(L(k.planOutline(k.insetPlan(VIEWER, 3), VIEWER_H, P, 4), { tone: "faint" }));
    for (const y of [-21, -17.5, -14]) out.push(L(k.planOutline({ x: VIEWER.x + 7, y, w: 9, d: 1.2, r: 0.6 }, VIEWER_H, P, 3), { tone: "lo" }));
    out.push(S(k.cylinder(35, -9, 4.6, VIEWER_H, 3.4, P, 28, 0.4), { tone: "mid" }));
    out.push(L(k.knurl(35, -9, 4.6, VIEWER_H, VIEWER_H + 3.4, 30, P), { tone: "lo" }));
    out.push(L(k.lineOnTop([35, -9], [35, -4.8], VIEWER_H + 3.4, P), { tone: "hi" }));
    out.push(D(k.corners(VIEWER, 3.4).map(([x, y]) => at([x, y, VIEWER_H])), { size: 0.4 }));
    // Two small bores under the screen, on the face toward the viewer.
    out.push(L(k.sideRing([21, 0, 6.2], 1.5, "y", P) + k.sideRing([27, 0, 6.2], 1.5, "y", P), { tone: "lo" }));
    out.push(D([at([21, 0, 6.2]), at([27, 0, 6.2])], { size: 0.45 }));
    return out.join("");
  }

  // The screen sits in a shallow recess on the viewer's front face. Its picture is the frame under the gate.
  const SCREEN_M = k.sideMatrix([SCREEN.x, 0], SCREEN.top, P, "left");
  function screenFrame() {
    return `<g transform="${SCREEN_M}"><clipPath id="sg-screen"><rect x="0.9" y="0.9" width="${SCREEN.w - 1.8}" height="${SCREEN.h - 1.8}" rx="0.6"/></clipPath><rect class="sg-recess" x="0" y="0" width="${SCREEN.w}" height="${SCREEN.h}" rx="1.2"/><rect class="sg-glass" x="0.9" y="0.9" width="${SCREEN.w - 1.8}" height="${SCREEN.h - 1.8}" rx="0.6"/></g>`;
  }
  const BARS = 7;
  function screenPicture(state) {
    const w = SCREEN.w - 1.8;
    const bar = w / BARS;
    // The picture travels with the film: one frame of film is one screen width.
    const slide = (((state.feed * STRIP) / FRAME) % 1 + 1) % 1;
    let bars = "";
    for (let index = -BARS; index < BARS; index++) {
      const x = 0.9 + index * bar + slide * w;
      if (x > SCREEN.w || x + bar < 0) continue;
      bars += `<rect class="sg-bar" data-bar="${((index % BARS) + BARS) % BARS}" x="${x.toFixed(2)}" y="0.9" width="${(bar + 0.05).toFixed(2)}" height="${SCREEN.h - 1.8}"/>`;
    }
    const lamp = state.lamp * state.ghost;
    return `<g transform="${SCREEN_M}"><g clip-path="url(#sg-screen)" opacity="${(0.07 + 0.93 * lamp).toFixed(3)}">${bars}</g><rect class="sg-bezel" x="0" y="0" width="${SCREEN.w}" height="${SCREEN.h}" rx="1.2" opacity="${(0.35 + 0.65 * lamp).toFixed(3)}"/></g>`;
  }

  function track() {
    const out = [];
    out.push(S(k.slabOf(TRACK, 0, DECK, P, 3, 0.4), { tone: "mid" }));
    out.push(S(k.slabOf(BLOCK, 0, DECK, P, 4, 0.5), { tone: "mid" }));
    out.push(L(k.planOutline(k.insetPlan(BLOCK, 1.6), DECK, P, 3), { tone: "faint" }));
    // The splice line, cut right across the block.
    out.push(L(k.lineOnTop([SPLICE, BLOCK.y], [SPLICE, BLOCK.y + BLOCK.d], DECK, P), { tone: "lo" }));
    out.push(D(k.corners(BLOCK, 2.6).map(([x, y]) => at([x, y, DECK])), { size: 0.45 }));
    return out.join("");
  }

  function magazineBack() {
    const out = [];
    out.push(S(k.slabOf({ x: -116, y: 4.5, w: 42, d: 15, r: 1 }, 0, DECK, P, 3), { tone: "mid" }));
    out.push(S(k.slabOf({ x: -116, y: 4.5, w: 42, d: 1.5, r: 0.5 }, DECK, 10, P, 2, 0.3), { tone: "mid" }));
    out.push(S(k.slabOf({ x: -116, y: 6, w: 1.5, d: 12, r: 0.5 }, DECK, 10, P, 2, 0.3), { tone: "mid" }));
    return out.join("");
  }
  function magazineFront() {
    const out = [];
    const right = { x: -75.5, y: 6, w: 1.5, d: 12, r: 0.5 };
    out.push(S(k.slabOf(right, DECK + 1.3, 8.7, P, 2, 0.3), { tone: "mid" }));
    const front = { x: -116, y: 18, w: 42, d: 1.5, r: 0.5 };
    out.push(S(k.slabOf(front, DECK, 5, P, 2, 0.3), { tone: "mid" }));
    out.push(D([-112, -99, -91, -78].map((x) => at([x, 18.75, DECK + 5])), { size: 0.4 }));
    return out.join("");
  }

  // The sound tape lies on the track from its idler to the splice line; the print lies on it from there on.
  function lanes() {
    const out = [];
    out.push(S(k.slabOf({ x: IDLER.sound, y: TAPE[0], w: SPLICE - IDLER.sound, d: TAPE[1] - TAPE[0], r: 0 }, DECK, FILM, P, 1), { tone: "hi", crease: "none" }));
    out.push(S(k.slabOf({ x: SPLICE, y: TAPE[0], w: FLAT_END - SPLICE, d: PICTURE[1] - TAPE[0], r: 0 }, DECK, FILM, P, 1), { tone: "hi", crease: "none" }));
    return out.join("");
  }

  function idler(x, part) {
    const far = { x: x - 1.6, y: 0, w: 3.2, d: 1.5, r: 0.4 };
    const near = { x: x - 1.6, y: 19, w: 3.2, d: 1.5, r: 0.4 };
    if (part === "far") return S(k.slabOf(far, 0, IDLER.z + 2.4, P, 2), { tone: "mid" });
    const F = axle(x, IDLER.z);
    return S(G.disc(1.5, 19, IDLER.r, F, P), { tone: "mid" }) + S(k.slabOf(near, 0, IDLER.z + 2.4, P, 2), { tone: "mid" }) + D([at([x, 20.5, IDLER.z])], { size: 0.45 });
  }

  function posts() {
    return POSTS.map(([x, y]) => S(k.cylinder(x, y, 1.1, DECK, POST_TOP - DECK, P, 14), { tone: "mid", crease: "none" })).join("");
  }
  // The clamp, built open; it comes down as one piece.
  const PRESS_ART = (() => {
    const out = [];
    out.push(S(k.slabOf(PRESS, PRESS_OPEN, PRESS_H, P, 4, 0.5), { tone: "hi", crease: "lo" }));
    const top = PRESS_OPEN + PRESS_H;
    out.push(L(k.planOutline(k.insetPlan(PRESS, 1.8), top, P, 3), { tone: "faint" }));
    out.push(L(POSTS.map(([x, y]) => k.ring(x, y, 1.9, top, P, 14)).join(""), { tone: "lo" }));
    out.push(S(k.cylinder(-10, 10, 3.3, top, 3, P, 24, 0.3), { tone: "mid" }));
    out.push(L(k.knurl(-10, 10, 3.3, top, top + 3, 24, P), { tone: "lo" }));
    out.push(L(k.lineOnTop([-10, 10], [-10, 13.3], top + 3, P), { tone: "hi" }));
    return out.join("");
  })();
  function press(state) {
    const drop = (PRESS_OPEN - PRESS_SHUT) * state.press;
    const top = PRESS_OPEN + PRESS_H - drop;
    const tops = POSTS.map(([x, y]) => S(k.cylinder(x, y, 1.1, top, POST_TOP - top, P, 14), { tone: "mid", crease: "none" }) + S(k.cylinder(x, y, 1.7, POST_TOP, 1, P, 14), { tone: "mid" })).join("");
    return `<g transform="${k.translateAlong(P, [0, 0, -drop])}">${PRESS_ART}</g>${tops}`;
  }
  // A guarded blade beside the block, for trimming a strip square.
  function blade() {
    const plan = { x: -25, y: 20.2, w: 6, d: 3.4, r: 0.8 };
    return S(k.slabOf(plan, DECK, 3.2, P, 2, 0.3), { tone: "mid" }) + L(k.planOutline({ x: -24, y: 21.5, w: 4, d: 0.8, r: 0.4 }, DECK + 3.2, P, 2), { tone: "lo" });
  }

  function gate() {
    const out = [];
    out.push(S(k.slabOf({ x: GATE.x, y: 19.2, w: GATE.w, d: 1.6, r: 0.4 }, 0, 4.6, P, 2), { tone: "mid" }));
    out.push(S(k.slabOf(GATE, 4.6, 2, P, 3, 0.4), { tone: "mid" }));
    out.push(L(k.ring(28, 10.5, 3.2, 6.6, P, 24), { tone: "mid" }) + L(k.ring(28, 10.5, 1.7, 6.6, P, 16), { tone: "lo" }));
    out.push(D([at([28, 10.5, 6.6])], { size: 0.5, tone: "hi" }));
    out.push(D([at([24, 2, 6.6]), at([32, 2, 6.6]), at([24, 17.4, 6.6]), at([32, 17.4, 6.6])], { size: 0.4 }));
    return out.join("");
  }

  // A reel on a horizontal spindle: a solid back flange, the roll, then an open front flange of three spokes and a rim.
  function reelBack(F, reel, y0) {
    return S(G.disc(-5, y0, 1.6, F, P), { tone: "mid", crease: "none" }) + S(G.disc(y0, y0 + 1.2, reel.flange, F, P), { tone: "mid", inner: L(G.circleOf(F, y0 + 1.2, reel.flange - 2.2, P, 120), { tone: "faint" }) });
  }
  function spokes(F, reel, y1, angle) {
    const out = [];
    const half = reel.flange > 20 ? 2.6 : 1.7;
    for (let index = 0; index < 3; index++) {
      const a = angle + (index * Math.PI * 2) / 3;
      const d = [Math.cos(a), Math.sin(a)];
      const n = [-d[1], d[0]];
      const r0 = reel.hub - 0.6;
      const r1 = reel.flange - 2.4;
      const polygon = [[d[0] * r0 - n[0] * half, d[1] * r0 - n[1] * half], [d[0] * r1 - n[0] * half, d[1] * r1 - n[1] * half], [d[0] * r1 + n[0] * half, d[1] * r1 + n[1] * half], [d[0] * r0 + n[0] * half, d[1] * r0 + n[1] * half]];
      out.push(S(G.prismOf(F, polygon, y1, y1 + 1.2, P), { tone: "mid", crease: "none" }));
    }
    return out.join("");
  }
  function reelFront(F, reel, y1) {
    // The rim is an open ring: only its visible facets are filled, so the roll and the spokes show through the middle.
    const inner = reel.flange - 3.2;
    const rim = G.ringBand(y1, y1 + 1.2, inner, reel.flange, F, P, { fill: "facets" });
    const edge = G.circleOf(F, y1 + 1.2, reel.flange, P, 120) + G.circleOf(F, y1 + 1.2, inner, P, 120) + G.arcOf(F, y1, reel.flange, P) + G.arcOf(F, y1, inner, P, { inward: true });
    const out = [S(rim, { tone: "mid", crease: "none" }) + `<path class="iso-line iso-edge" data-tone="mid" d="${edge}"/>`];
    out.push(S(G.disc(y1, y1 + 2.2, reel.hub, F, P), { tone: "mid" }));
    out.push(D(G.dotsOf(F, y1 + 2.2, reel.hub * 0.62, 3, P, { all: true, phase: 0.5 }), { size: 0.45 }));
    out.push(S(G.disc(y1 + 2.2, y1 + 3.6, reel.hub * 0.36, F, P), { tone: "mid" }));
    return out.join("");
  }

  function front() {
    const out = [];
    const strip = { x: -70, y: 22, w: 124, d: 5, r: 0.8 };
    out.push(S(k.slabOf(strip, 0, 0.6, P, 3), { tone: "lo", crease: "none" }));
    // One major tick per frame of film.
    const ticks = k.topTicks(strip.x + 4, strip.x + strip.w - 4, 4, 3, strip.y + 0.5, 0.6, [1.6, 3.2], P);
    out.push(L(ticks.minor, { tone: "lo" }), L(ticks.major, { tone: "mid" }));
    out.push(D([at([strip.x + 2, strip.y + 2.5, 0.6]), at([strip.x + strip.w - 2, strip.y + 2.5, 0.6])], { size: 0.45 }));
    const label = { x: -119, y: 29, w: 32, d: 16, r: 1.5 };
    out.push(S(k.slabOf(label, 0, 0.8, P, 4), { tone: "lo", crease: "none" }));
    out.push(L(k.planOutline(k.insetPlan(label, 1.6), 0.8, P, 3), { tone: "faint" }));
    out.push(L([[20, 33.5], [26, 37], [14, 40.5]].map(([w, y]) => k.lineOnTop([label.x + 4, y], [label.x + 4 + w, y], 0.8, P)).join(""), { tone: "lo", free: true }));
    out.push(D([at([label.x + 2.4, label.y + 2.4, 0.8]), at([label.x + label.w - 2.4, label.y + label.d - 2.4, 0.8])], { size: 0.4 }));
    // The counter: one turn of the needle is the whole download, 53 ticks of four pieces each.
    const [x, y] = DIAL;
    out.push(S(k.cylinder(x, y, DIAL_R + 2, 0, 1.4, P, 56), { tone: "lo" }));
    out.push(S(k.cylinder(x, y, DIAL_R, 1.4, DIAL_H - 1.4, P, 64, 0.7), { tone: "hi", crease: "lo" }));
    out.push(L(k.knurl(x, y, DIAL_R, DIAL_H - 2.6, DIAL_H, 60, P, 0.3), { tone: "lo" }));
    out.push(L(k.sideArc(x, y, DIAL_R, DIAL_H - 2.6, P, 36), { tone: "faint" }));
    out.push(L(k.ring(x, y, DIAL_R - 1.8, DIAL_H, P, 56), { tone: "lo" }));
    const marks = k.radialTicks(x, y, DIAL_R - 2.4, 53, 53, DIAL_H, [1.1, 2.6], P);
    out.push(L(marks.minor, { tone: "lo" }), L(marks.major, { tone: "hi" }));
    out.push(L(k.ring(x, y, 1.4, DIAL_H, P, 14), { tone: "mid" }));
    // A knurled knob for the feed.
    out.push(S(k.cylinder(8, 38, 6.4, 0, 1.2, P, 32), { tone: "lo" }));
    out.push(S(k.cylinder(8, 38, 5, 1.2, 4.2, P, 32, 0.4), { tone: "mid" }));
    out.push(L(k.knurl(8, 38, 5, 1.2, 5.4, 32, P), { tone: "lo" }));
    out.push(L(k.lineOnTop([8, 38], [8, 42.4], 5.4, P), { tone: "hi" }));
    out.push(D([at([8, 38, 5.4])], { size: 0.5, tone: "hi" }));
    // The can the finished reel goes home in.
    const [cx, cy] = CAN;
    out.push(S(k.cylinder(cx, cy, 14, 0, 4.4, P, 64), { tone: "mid" }));
    out.push(S(k.cylinder(cx, cy, 14.6, 4.4, 1.8, P, 64, 0.6), { tone: "mid" }));
    out.push(L(k.ring(cx, cy, 11.4, 6.2, P, 56) + k.ring(cx, cy, 5, 6.2, P, 28), { tone: "faint" }));
    out.push(k.faceTextSvg(k.topMatrix([cx, cy + 9.4], 6.2, P, "x"), "MP4", { size: 2.6, tone: "lo", anchor: "middle" }));
    return out.join("");
  }

  // --------------------------------------------------------------------------------------- parts that change

  const soundRadius = (wound) => Math.sqrt(SOUND.full ** 2 - ((SOUND.full ** 2 - SOUND.empty ** 2) * wound) / M.STROKES);
  const takeRadius = (wound) => Math.sqrt(TAKE.empty ** 2 + ((TAKE.full ** 2 - TAKE.empty ** 2) * wound) / M.STROKES);
  // How far a reel has turned once its roll has gone from r0 to r: length = ∫ r dθ with r² linear in length.
  const turned = (r0, r, growth) => (2 * (r - r0)) / growth;
  const TAKE_GROWTH = (TAKE.full ** 2 - TAKE.empty ** 2) / (M.STROKES * STRIP);
  const SOUND_GROWTH = (SOUND.full ** 2 - SOUND.empty ** 2) / (M.STROKES * STRIP);

  function stack(state) {
    const height = 0.5 + 7.5 * state.stack;
    const plan = { x: -114.5, y: 6, w: 39, d: 12, r: 0.4 };
    const top = DECK + height;
    const out = [S(k.slabOf(plan, DECK, height, P, 1), { tone: "hi", crease: "lo" })];
    out.push(L([-102.5, -90.5, -78.5].map((x) => k.lineOnTop([x, 6], [x, 18], top, P)).join(""), { tone: "lo" }));
    out.push(S(k.slabOf({ x: -102, y: 9, w: 15, d: 6, r: 1 }, top, 1.4, P, 2, 0.3), { tone: "mid" }));
    out.push(D([at([-94.5, 12, top + 1.4])], { size: 0.5 }));
    return out.join("");
  }

  // Where every strip's leading edge is. Strip i is the one joined in stroke i.
  function fronts(state) {
    const list = [];
    for (let index = 0; index < M.STROKES; index++) {
      const ahead = state.feed - index;
      let front;
      let joined = false;
      if (ahead >= 1 || (state.stroke > index && state.phase !== "threading")) {
        front = SPLICE + STRIP * ahead;
        joined = true;
      } else if (state.stroke === index && state.phase === "joining") {
        front = SPLICE - GAP * (1 - state.butt) + STRIP * ahead;
        joined = state.butt >= 1;
      } else {
        front = SPLICE - GAP + (STRIP + GAP) * ahead;
      }
      list.push({ front, joined });
    }
    return list;
  }

  const perforations = (from, to, z) => {
    const points = [];
    for (let x = Math.ceil((from + 1) / 3) * 3; x <= to - 1; x += 3) points.push(at([x, PICTURE[0] + 1.1, z]), at([x, PICTURE[1] - 1.1, z]));
    return points;
  };

  // Strips still upstream of the splice line are separate pieces of film lying on the track.
  function strips(state) {
    const out = [];
    for (const { front } of fronts(state)) {
      const from = Math.max(SLOT, front - STRIP);
      const to = Math.min(SPLICE, front);
      if (to - from < 0.3) continue;
      const top = DECK + FILM;
      out.push(S(k.slabOf({ x: from, y: PICTURE[0], w: to - from, d: PICTURE[1] - PICTURE[0], r: 0 }, DECK, FILM, P, 1), { tone: "hi", crease: "none" }));
      const lines = [1, 2].map((n) => front - n * FRAME).filter((x) => x > from + 0.4 && x < to - 0.4);
      if (lines.length) out.push(L(lines.map((x) => k.lineOnTop([x, PICTURE[0]], [x, PICTURE[1]], top, P)).join(""), { tone: "mid" }));
      out.push(D(perforations(from, to, top), { size: 0.32, tone: "lo" }));
    }
    return `<g opacity="${state.ghost.toFixed(3)}">${out.join("")}</g>`;
  }

  // Past the splice line the strips are one print: frame lines, a splice mark at every join, the sound stripe beside it.
  function printMarks(state) {
    const marks = [];
    let reach = SPLICE;
    for (const { front, joined } of fronts(state)) {
      if (front <= SPLICE) continue;
      reach = Math.max(reach, front);
      for (const n of [1, 2]) marks.push([front - n * FRAME, "mid"]);
      if (joined) marks.push([front - 0.7, "hi"], [front + 0.7, "hi"]);
    }
    return { marks: marks.filter(([x]) => x > SPLICE + 0.4), reach };
  }
  function print(state) {
    const { marks, reach } = printMarks(state);
    const top = DECK + FILM;
    const end = Math.min(reach, FLAT_END);
    const out = [];
    if (end > SPLICE + 0.5) {
      out.push(L(k.lineOnTop([SPLICE, PICTURE[0]], [end, PICTURE[0]], top, P), { tone: "mid" }));
      out.push(L(marks.filter(([x]) => x < FLAT_END - 0.4).map(([x]) => k.lineOnTop([x, PICTURE[0]], [x, PICTURE[1]], top, P)).join(""), { tone: "mid" }));
      if (reach < FLAT_END) out.push(L(k.lineOnTop([reach, TAPE[0]], [reach, PICTURE[1]], top, P), { tone: "hi" }));
      out.push(D(perforations(SPLICE, end, top), { size: 0.32, tone: "lo" }));
    }
    return `<g opacity="${state.ghost.toFixed(3)}">${out.join("")}</g>`;
  }

  function soundReel(state) {
    const r = soundRadius(state.wound);
    const run = tangent([SOUND.x, SOUND.z], r, 1, [IDLER.sound, IDLER.z], IDLER.r, 1);
    const angle = -turned(SOUND.full, r, -SOUND_GROWTH);
    const roll = G.disc(2.5, 6, r, SOUND_F, P);
    return band(run.from, run.to, TAPE) + S(roll, { tone: "hi", crease: "lo", inner: L(G.circleOf(SOUND_F, 6, SOUND.hub + 1.6, P, 120), { tone: "faint" }) }) + spokes(SOUND_F, SOUND, 6, angle);
  }

  function takeReel(state) {
    const r = takeRadius(state.wound);
    const run = tangent([IDLER.take, IDLER.z], IDLER.r, 1, [TAKE.x, TAKE.z], r, -1);
    const angle = turned(TAKE.empty, r, TAKE_GROWTH);
    const length = Math.hypot(run.to[0] - run.from[0], run.to[1] - run.from[1]);
    const { marks } = printMarks(state);
    const lane = [TAPE[0], PICTURE[1]];
    const across = state.ghost > 0.5 ? marks.map(([x, tone]) => [x - FLAT_END, tone, PICTURE]) : [];
    const rise = band(run.from, run.to, lane, across);
    const rings = [0.35, 0.7].map((share) => TAKE.hub + 1.6 + (r - TAKE.hub - 2.4) * share).filter((ring) => ring > TAKE.hub + 2);
    const roll = G.disc(TAPE[0], PICTURE[1], r, TAKE_F, P);
    return rise + S(roll, { tone: "hi", crease: "lo", inner: L(rings.map((ring) => G.circleOf(TAKE_F, PICTURE[1], ring, P, 120)).join(""), { tone: "faint" }) }) + spokes(TAKE_F, TAKE, PICTURE[1], angle);
  }

  function needle(state) {
    const angle = (state.pieces / M.REAL.pieces) * Math.PI * 2;
    const [x, y] = DIAL;
    const d = k.lineOnTop([x - Math.sin(angle) * 2.6, y + Math.cos(angle) * 2.6], [x + Math.sin(angle) * (DIAL_R - 3.4), y - Math.cos(angle) * (DIAL_R - 3.4)], DIAL_H + 0.2, P);
    return `<path class="iso-line" data-tone="hi" data-free="start" d="${d}" style="stroke-width:1.1"/>`;
  }

  // -------------------------------------------------------------------------------------- painter's order
  // Far to near. A string is static art; { live } is rebuilt for every frame by `frame(state)`.
  const layers = [
    plate(),
    spares(),
    dispenser(),
    post(SOUND.x, SOUND.z + 8, SOUND.z),
    post(TAKE.x, TAKE.z + 8, TAKE.z),
    viewerBody(),
    screenFrame(),
    { live: "screen" },
    track(),
    reelBack(SOUND_F, SOUND, 1.3),
    { live: "sound" },
    reelFront(SOUND_F, SOUND, 6),
    magazineBack(),
    { live: "stack" },
    idler(IDLER.sound, "far"),
    idler(IDLER.take, "far"),
    lanes(),
    { live: "print" },
    { live: "strips" },
    magazineFront(),
    idler(IDLER.sound, "near"),
    posts(),
    { live: "press" },
    blade(),
    gate(),
    reelBack(TAKE_F, TAKE, 1.3),
    { live: "take" },
    reelFront(TAKE_F, TAKE, PICTURE[1]),
    idler(IDLER.take, "near"),
    front(),
    { live: "needle" },
  ];

  const frame = (state) => ({
    screen: screenPicture(state),
    sound: soundReel(state),
    stack: stack(state),
    print: print(state),
    strips: strips(state),
    press: press(state),
    take: takeReel(state),
    needle: needle(state),
  });

  const label =
    "A film splicing bench. Short strips of picture film leave a magazine on the left while a small reel of magnetic sound tape runs beside them. A clamp joins each strip and the tape into one print, which passes a lit viewer and winds onto a take-up reel on the right. A dial counts the pieces joined.";

  // Close-ups for a page that wants them: [centre in the viewBox, width in viewBox units].
  const views = {
    feed: [at([-50, 10, 6]), 250],
    splice: [at([2, 8, 9]), 230],
    reel: [at([88, 16, 27]), 380],
  };

  return { W, H, P, layers, frame, label, views };
}

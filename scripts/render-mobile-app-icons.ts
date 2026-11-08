#!/usr/bin/env node

// Android icon presets (launcher layers, notification small icons, splash, AppIconPresets.kt) on
// the 108dp adaptive canvas; marks stay inside the 66dp disc circle masks keep. Glyphs are baked-in
// DM Sans / Noto Sans Mono Bold outlines (SIL OFL 1.1), so output never depends on installed fonts.
// Usage: node scripts/render-mobile-app-icons.ts [--sheet <contact-sheet.png>]

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import sharp, { type OverlayOptions } from "sharp";

const GLYPHS = {
  dmBold: {
    "2": "M50 0L50 99Q114 150 174.5 201Q235 252 283 302.5Q331 353 359 401Q387 449 387 494Q387 522 377 545.5Q367 569 345.5 583.5Q324 598 289 598Q254 598 230 582Q206 566 194 539.5Q182 513 182 480L51 480Q54 557 86 609Q118 661 172 686.5Q226 712 293 712Q367 712 418 684.5Q469 657 495.5 610Q522 563 522 502Q522 456 505.5 412Q489 368 459.5 326.5Q430 285 393 247Q356 209 316 174.5Q276 140 238 110L539 110L539 0Z",
    "3": "M300 -12Q232 -12 175 13Q118 38 84 89Q50 140 48 218L180 218Q181 185 195 158.5Q209 132 236 116.5Q263 101 300 101Q335 101 360 115Q385 129 398 152Q411 175 411 205Q411 240 393.5 263.5Q376 287 345.5 299Q315 311 276 311L224 311L224 422L276 422Q325 422 358.5 445Q392 468 392 514Q392 552 367.5 575Q343 598 299 598Q251 598 224 570Q197 542 194 501L62 501Q65 567 95.5 614.5Q126 662 178 687Q230 712 299 712Q372 712 422.5 686.5Q473 661 499 618Q525 575 525 525Q525 484 509.5 452Q494 420 468 399Q442 378 411 369Q450 361 479.5 338.5Q509 316 525.5 281Q542 246 542 200Q542 143 514.5 94.5Q487 46 432.5 17Q378 -12 300 -12Z",
    T: "M232 0L232 591L27 591L27 700L570 700L570 591L366 591L366 0Z",
  },
  dmBlack: {
    "2": "M47 0L47 111Q108 161 167.5 210Q227 259 274.5 307.5Q322 356 350 402.5Q378 449 378 492Q378 517 368.5 538.5Q359 560 339.5 572.5Q320 585 288 585Q257 585 235 571Q213 557 202 532.5Q191 508 191 476L46 476Q49 556 82 609Q115 662 170.5 687Q226 712 293 712Q371 712 423 683.5Q475 655 501.5 607.5Q528 560 528 502Q528 456 512 413.5Q496 371 468 331.5Q440 292 404.5 255.5Q369 219 330 185.5Q291 152 253 122L542 122L542 0Z",
    "3": "M302 -12Q233 -12 175.5 13Q118 38 83.5 89.5Q49 141 47 221L193 221Q194 190 207 165.5Q220 141 244 127Q268 113 302 113Q333 113 355.5 125.5Q378 138 389.5 158.5Q401 179 401 206Q401 237 386 258.5Q371 280 343 291.5Q315 303 278 303L226 303L226 425L278 425Q321 425 353 445.5Q385 466 385 509Q385 545 362 565.5Q339 586 301 586Q255 586 231 559.5Q207 533 204 496L59 496Q62 564 93 612.5Q124 661 177.5 686.5Q231 712 301 712Q375 712 427 686Q479 660 505.5 616.5Q532 573 532 522Q532 479 516 447.5Q500 416 474 395.5Q448 375 419 366Q458 358 486.5 335.5Q515 313 531 278.5Q547 244 547 200Q547 142 518.5 93.5Q490 45 435.5 16.5Q381 -12 302 -12Z",
    T: "M229 0L229 579L26 579L26 700L582 700L582 579L379 579L379 0Z",
  },
  dmMed: {
    "2": "M59 0L59 72Q129 126 192 181Q255 236 304.5 290.5Q354 345 382 397.5Q410 450 410 498Q410 532 398 561Q386 590 360 608.5Q334 627 289 627Q246 627 217.5 608Q189 589 174.5 557.5Q160 526 160 488L63 488Q64 560 94 610Q124 660 175.5 686Q227 712 291 712Q358 712 407 687.5Q456 663 483 616.5Q510 570 510 503Q510 455 491 407.5Q472 360 439.5 315Q407 270 367 228.5Q327 187 284.5 150Q242 113 203 83L532 83L532 0Z",
    "3": "M295 -12Q228 -12 172.5 12.5Q117 37 84.5 86.5Q52 136 50 211L150 211Q151 173 168 142Q185 111 217.5 92.5Q250 74 295 74Q340 74 370.5 91Q401 108 416.5 137Q432 166 432 202Q432 247 410.5 275Q389 303 352.5 317Q316 331 271 331L219 331L219 415L271 415Q334 415 371.5 444Q409 473 409 526Q409 570 380 598Q351 626 295 626Q239 626 206.5 594Q174 562 170 513L71 513Q74 572 102.5 617.5Q131 663 180.5 687.5Q230 712 295 712Q365 712 412.5 687.5Q460 663 484.5 622Q509 581 509 532Q509 495 495 463.5Q481 432 455 409Q429 386 392 376Q432 368 464 345Q496 322 514 285.5Q532 249 532 201Q532 144 505 95.5Q478 47 425.5 17.5Q373 -12 295 -12Z",
    T: "M236 0L236 618L29 618L29 700L544 700L544 618L336 618L336 0Z",
  },
  mono: {
    "2": "M57 0L57 105L231 279Q273 321 308 358Q343 395 364 431.5Q385 468 385 508Q385 551 360 574.5Q335 598 294 598Q254 598 217 580Q180 562 137 525L55 622Q94 656 129.5 678.5Q165 701 206.5 712.5Q248 724 305 724Q378 724 429.5 698Q481 672 508.5 627.5Q536 583 536 526Q536 462 508 409.5Q480 357 434.5 310Q389 263 335 215L243 134L243 124L555 124L555 0Z",
    "3": "M273 -10Q224 -10 171.5 0Q119 10 71 29L71 157Q115 136 167 124Q219 112 262 112Q387 112 387 215Q387 267 351 288Q315 309 229 309L175 309L175 425L230 425Q307 425 341.5 450Q376 475 376 521Q376 554 357 577Q338 600 289 600Q258 600 220 588Q182 576 134 550L69 654Q173 724 297 724Q354 724 403.5 706.5Q453 689 483.5 651.5Q514 614 514 553Q514 491 478.5 442Q443 393 375 376L375 373Q459 361 497 319Q535 277 535 208Q535 132 499.5 83.5Q464 35 405 12.5Q346 -10 273 -10Z",
    T: "M227 0L227 589L30 589L30 714L570 714L570 589L372 589L372 0Z",
  },
} as const;

type FontKey = keyof typeof GLYPHS;

const MODULE_DIR = "apps/mobile/modules/t3-app-icon";
const RES_DIR = `${MODULE_DIR}/android/src/main/res`;
const PREVIEW_DIR = "apps/mobile/assets/app-icons";
const CLASSIC_DIR = "apps/mobile/assets/t3-squared";

const DENSITIES = [
  ["mdpi", 1],
  ["hdpi", 1.5],
  ["xhdpi", 2],
  ["xxhdpi", 3],
  ["xxxhdpi", 4],
] as const;
const PREVIEW_SIZE = 256;
const KOTLIN_FILE = `${MODULE_DIR}/android/src/main/java/expo/modules/t3appicon/AppIconPresets.kt`;
/** Status bar icons are 24dp with about 2dp of padding. */
const SMALL_ICON_DP = 24;
const SMALL_ICON_LIVE_DP = 20;
/** Same canvas as expo-splash-screen's 288dp logo: the 108dp art, of which a 192dp circle shows. */
const SPLASH_PX = 288 * 4;
const SVG_DENSITY = 384;

function transformPath(d: string, scale: number, dx: number, dy: number) {
  const tokens = d.match(/[MLQCZ]|-?\d*\.?\d+(?:e-?\d+)?/gi) ?? [];
  let out = "";
  let isX = true;
  for (const token of tokens) {
    if (/^[MLQCZ]$/i.test(token)) {
      out += token;
      isX = true;
      continue;
    }
    const value = Number(token);
    const mapped = isX ? value * scale + dx : -value * scale + dy;
    out += `${/[MLQCZ]$/i.test(out) ? "" : " "}${mapped.toFixed(2)}`;
    isX = !isX;
  }
  return out;
}

interface Mark {
  readonly t: string;
  readonly three: string;
  readonly two: string;
  readonly box: { readonly x: number; readonly y: number; readonly w: number; readonly h: number };
  /** Baseline and cap line in canvas units. */
  readonly baseline: number;
  readonly capTop: number;
  readonly twoBox: {
    readonly x: number;
    readonly y: number;
    readonly w: number;
    readonly h: number;
  };
}

const GLYPH_METRICS: Record<FontKey, Record<"T" | "3" | "2", readonly [number, number]>> = {
  dmBold: { T: [27, 570], "3": [48, 542], "2": [50, 539] },
  dmBlack: { T: [26, 582], "3": [47, 547], "2": [46, 542] },
  dmMed: { T: [29, 544], "3": [50, 532], "2": [59, 532] },
  mono: { T: [30, 570], "3": [69, 535], "2": [57, 555] },
};
const CAP: Record<FontKey, number> = { dmBold: 700, dmBlack: 700, dmMed: 700, mono: 714 };

/** Lays out "T3²" with cap height `h`, centred on (cx, cy) by its visual bounds. */
function layoutMark(
  font: FontKey,
  h: number,
  cx: number,
  cy: number,
  options: { readonly gap?: number; readonly twoGap?: number; readonly twoScale?: number } = {},
): Mark {
  const s = h / CAP[font];
  const m = GLYPH_METRICS[font];
  const gap = (options.gap ?? -0.02) * h;
  const twoGap = (options.twoGap ?? 0.07) * h;
  const twoScale = options.twoScale ?? 0.52;
  const s2 = s * twoScale;
  const tX = -m.T[0] * s;
  const threeX = tX + m.T[1] * s + gap - m["3"][0] * s;
  const twoX = threeX + m["3"][1] * s + twoGap - m["2"][0] * s2;
  const right = twoX + m["2"][1] * s2;
  const twoRise = 0.14 * h;
  const top = -h - twoRise;
  const bottom = 12 * s;
  const ox = cx - right / 2;
  const oy = cy - (top + bottom) / 2;
  const twoBaseline = oy - h + 712 * s2 - twoRise;
  return {
    t: transformPath(GLYPHS[font].T, s, ox + tX, oy),
    three: transformPath(GLYPHS[font]["3"], s, ox + threeX, oy),
    two: transformPath(GLYPHS[font]["2"], s2, ox + twoX, twoBaseline),
    box: { x: ox, y: oy + top, w: right, h: bottom - top },
    baseline: oy,
    capTop: oy - h,
    twoBox: {
      x: ox + twoX + m["2"][0] * s2,
      y: twoBaseline - 712 * s2,
      w: (m["2"][1] - m["2"][0]) * s2,
      h: 712 * s2,
    },
  };
}

const markPaths = (mark: Mark) => `${mark.t}${mark.three}${mark.two}`;

const FULL = `x="0" y="0" width="108" height="108"`;
const filterBox = `filterUnits="userSpaceOnUse" ${FULL}`;

function squirclePath(cx: number, cy: number, r: number, n = 5, steps = 160) {
  let d = "";
  for (let i = 0; i < steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    const c = Math.cos(a);
    const sn = Math.sin(a);
    const x = cx + r * Math.sign(c) * Math.abs(c) ** (2 / n);
    const y = cy + r * Math.sign(sn) * Math.abs(sn) ** (2 / n);
    d += `${i === 0 ? "M" : "L"}${x.toFixed(2)} ${y.toFixed(2)}`;
  }
  return `${d}Z`;
}

function grid(step: number, stroke: string, width: number, from = 0, to = 108) {
  let d = "";
  for (let v = from; v <= to + 0.001; v += step) {
    d += `M${v.toFixed(2)} ${from}V${to}M${from} ${v.toFixed(2)}H${to}`;
  }
  return `<path d="${d}" stroke="${stroke}" stroke-width="${width}" fill="none"/>`;
}

interface PresetArt {
  readonly background: string;
  readonly foreground: string;
  readonly monochrome: string;
}

const mono = (mark: Mark) => `<path d="${markPaths(mark)}" fill="#fff"/>`;

function glass(): PresetArt {
  const mark = layoutMark("dmBold", 18.5, 54, 55);
  const tile = squirclePath(54, 54, 27, 4.2);
  const inner = squirclePath(54, 54, 23.5, 4.2);
  const blobs = `
    <circle cx="34" cy="36" r="22" fill="#5b7cff"/>
    <circle cx="78" cy="40" r="18" fill="#ff4fd8"/>
    <circle cx="70" cy="80" r="24" fill="#22e3ff"/>
    <circle cx="30" cy="82" r="14" fill="#8b5cff"/>`;
  return {
    background: `
      <defs>
        <radialGradient id="bg" cx="0.5" cy="0.45" r="0.75">
          <stop offset="0" stop-color="#1b1f3a"/><stop offset="1" stop-color="#05060d"/>
        </radialGradient>
        <filter id="soft" ${filterBox}><feGaussianBlur stdDeviation="7"/></filter>
      </defs>
      <rect ${FULL} fill="url(#bg)"/>
      <g filter="url(#soft)" opacity="0.95">${blobs}</g>`,
    foreground: `
      <defs>
        <clipPath id="tile"><path d="${tile}"/></clipPath>
        <clipPath id="edge"><path d="${tile}${inner}" clip-rule="evenodd"/></clipPath>
        <filter id="bend" ${filterBox}><feGaussianBlur stdDeviation="1.6"/></filter>
        <filter id="frost" ${filterBox}>
          <feGaussianBlur stdDeviation="5.5" result="b"/>
          <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="7" result="n"/>
          <feDisplacementMap in="b" in2="n" scale="2.2" xChannelSelector="R" yChannelSelector="G"/>
        </filter>
        <linearGradient id="sheen" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#fff" stop-opacity="0.38"/>
          <stop offset="0.45" stop-color="#fff" stop-opacity="0.06"/>
          <stop offset="1" stop-color="#fff" stop-opacity="0.16"/>
        </linearGradient>
        <linearGradient id="rim" x1="0.1" y1="0" x2="0.9" y2="1">
          <stop offset="0" stop-color="#fff" stop-opacity="0.95"/>
          <stop offset="0.35" stop-color="#fff" stop-opacity="0.15"/>
          <stop offset="0.7" stop-color="#fff" stop-opacity="0.08"/>
          <stop offset="1" stop-color="#fff" stop-opacity="0.75"/>
        </linearGradient>
        <filter id="shadow" ${filterBox}>
          <feGaussianBlur in="SourceAlpha" stdDeviation="1.6"/>
          <feOffset dy="1.2"/>
          <feComponentTransfer><feFuncA type="linear" slope="0.45"/></feComponentTransfer>
          <feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge>
        </filter>
        <filter id="lift" ${filterBox}>
          <feGaussianBlur in="SourceAlpha" stdDeviation="3"/><feOffset dy="2.5"/>
          <feComponentTransfer><feFuncA type="linear" slope="0.5"/></feComponentTransfer>
        </filter>
      </defs>
      <path d="${tile}" fill="#000" filter="url(#lift)"/>
      <g clip-path="url(#tile)">
        <g transform="translate(54 54) scale(1.18) translate(-54 -54)" filter="url(#frost)">
          <rect ${FULL} fill="#14182e"/>${blobs}
        </g>
        <rect ${FULL} fill="url(#sheen)"/>
        <ellipse cx="44" cy="32" rx="22" ry="7" fill="#fff" opacity="0.10" transform="rotate(-18 44 32)"/>
      </g>
      <g clip-path="url(#edge)">
        <g transform="translate(54 54) scale(0.72) translate(-54 -54)" filter="url(#bend)">
          <rect ${FULL} fill="#14182e"/>${blobs}
        </g>
        <rect ${FULL} fill="#fff" opacity="0.12"/>
      </g>
      <path d="${tile}" fill="none" stroke="#ff5a7a" stroke-opacity="0.55" stroke-width="0.7" transform="translate(-0.45 0)"/>
      <path d="${tile}" fill="none" stroke="#3ad7ff" stroke-opacity="0.55" stroke-width="0.7" transform="translate(0.45 0)"/>
      <path d="${tile}" fill="none" stroke="url(#rim)" stroke-width="1.1"/>
      <g filter="url(#shadow)">
        <path d="${mark.t}${mark.three}" fill="#fff"/>
        <path d="${mark.two}" fill="#bff4ff"/>
      </g>`,
    monochrome: mono(mark),
  };
}

function void_(): PresetArt {
  const mark = layoutMark("dmMed", 19, 54, 54.5);
  return {
    background: `
      <defs>
        <radialGradient id="v" cx="0.5" cy="0.42" r="0.7">
          <stop offset="0" stop-color="#1c1c1c"/><stop offset="0.6" stop-color="#070707"/><stop offset="1" stop-color="#000"/>
        </radialGradient>
      </defs>
      <rect ${FULL} fill="url(#v)"/>`,
    foreground: `
      <circle cx="54" cy="54" r="30.5" fill="none" stroke="#3a3a3a" stroke-width="0.45"/>
      <path d="M54 22.5V25.5M54 82.5V85.5M22.5 54H25.5M82.5 54H85.5" stroke="#5a5a5a" stroke-width="0.45"/>
      <path d="${mark.t}${mark.three}" fill="#fff"/>
      <path d="${mark.two}" fill="#8a8a8a"/>`,
    monochrome: mono(mark),
  };
}

function frost(): PresetArt {
  const mark = layoutMark("dmBold", 17, 54, 55);
  const disc = squirclePath(54, 54, 24, 4.2);
  const aura = `
    <circle cx="34" cy="32" r="18" fill="#ffffff"/>
    <circle cx="82" cy="80" r="24" fill="#1e1e1e"/>
    <circle cx="22" cy="86" r="14" fill="#5a5a5a"/>
    <circle cx="78" cy="28" r="12" fill="#e6e6e6"/>`;
  return {
    background: `
      <defs><filter id="a" ${filterBox}><feGaussianBlur stdDeviation="9"/></filter></defs>
      <rect ${FULL} fill="#a4a4a4"/>
      <g filter="url(#a)">${aura}</g>`,
    foreground: `
      <defs>
        <clipPath id="d"><path d="${disc}"/></clipPath>
        <filter id="f" ${filterBox}><feGaussianBlur stdDeviation="4"/></filter>
        <filter id="sh" ${filterBox}>
          <feGaussianBlur in="SourceAlpha" stdDeviation="3.2"/><feOffset dy="2.6"/>
          <feComponentTransfer><feFuncA type="linear" slope="0.28"/></feComponentTransfer>
        </filter>
        <linearGradient id="hl" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#fff" stop-opacity="0.9"/><stop offset="0.5" stop-color="#fff" stop-opacity="0.2"/><stop offset="1" stop-color="#fff" stop-opacity="0.55"/>
        </linearGradient>
      </defs>
      <path d="${disc}" fill="#000" filter="url(#sh)"/>
      <g clip-path="url(#d)">
        <g filter="url(#f)" transform="translate(54 54) scale(1.12) translate(-54 -54)"><rect ${FULL} fill="#a4a4a4"/>${aura}</g>
        <rect ${FULL} fill="#f4f4f4" opacity="0.62"/>
      </g>
      <path d="${disc}" fill="none" stroke="url(#hl)" stroke-width="1"/>
      <path d="${mark.t}${mark.three}" fill="#0a0a0a"/>
      <path d="${mark.two}" fill="#6a6a6a"/>`,
    monochrome: mono(mark),
  };
}

function terminal(): PresetArt {
  const mark = layoutMark("mono", 17, 57, 55, { gap: 0.02, twoGap: 0.04 });
  const promptX = mark.box.x - 12.5;
  const prompt = `M${promptX} ${mark.capTop + 3}L${promptX + 7} ${mark.capTop + 8.5}L${promptX} ${mark.capTop + 14}`;
  const cursor = `<rect x="${(mark.twoBox.x + mark.twoBox.w - 4.5).toFixed(2)}" y="${(mark.baseline + 2.5).toFixed(2)}" width="6.5" height="2.6" />`;
  let scan = "";
  for (let y = 0.5; y < 108; y += 1.6) scan += `M0 ${y.toFixed(2)}H108`;
  const glyphs = `<path d="${markPaths(mark)}"/><path d="${prompt}" fill="none" stroke-width="2.6" stroke-linecap="square"/>${cursor}`;
  return {
    background: `
      <defs>
        <radialGradient id="c" cx="0.5" cy="0.5" r="0.7">
          <stop offset="0" stop-color="#0c2a14"/><stop offset="0.7" stop-color="#03110a"/><stop offset="1" stop-color="#000"/>
        </radialGradient>
      </defs>
      <rect ${FULL} fill="url(#c)"/>
      <path d="${scan}" stroke="#000" stroke-opacity="0.35" stroke-width="0.6"/>`,
    foreground: `
      <defs>
        <filter id="g" ${filterBox}>
          <feGaussianBlur stdDeviation="2.2" result="b"/>
          <feMerge><feMergeNode in="b"/><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
        </filter>
      </defs>
      <g fill="#3dff8a" stroke="#3dff8a" filter="url(#g)">${glyphs}</g>
      <g fill="#d9ffe6" stroke="#d9ffe6" opacity="0.55">${glyphs}</g>`,
    monochrome: `<g fill="#fff" stroke="#fff">${glyphs}</g>`,
  };
}

function neon(): PresetArt {
  const mark = layoutMark("dmBold", 20, 54, 50);
  let floor = "";
  const horizon = 70;
  for (let i = -8; i <= 8; i++) floor += `M${54 + i * 4} ${horizon}L${54 + i * 22} 108`;
  for (const t of [0.04, 0.12, 0.24, 0.4, 0.62, 0.9]) {
    const y = horizon + (108 - horizon) * t;
    floor += `M0 ${y.toFixed(2)}H108`;
  }
  let sunCut = "";
  for (const [y, h] of [
    [58, 1.2],
    [62, 1.8],
    [66, 2.4],
  ] as const)
    sunCut += `<rect x="20" y="${y}" width="68" height="${h}" fill="#000"/>`;
  return {
    background: `
      <defs>
        <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#0b0221"/><stop offset="0.5" stop-color="#3a0b5c"/><stop offset="0.66" stop-color="#ff2f8e"/><stop offset="0.66" stop-color="#12002b"/><stop offset="1" stop-color="#05000f"/>
        </linearGradient>
        <linearGradient id="sun" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#ffe45c"/><stop offset="1" stop-color="#ff2f8e"/>
        </linearGradient>
        <mask id="cut"><rect ${FULL} fill="#fff"/>${sunCut}</mask>
        <filter id="glow" ${filterBox}><feGaussianBlur stdDeviation="1.2" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
      </defs>
      <rect ${FULL} fill="url(#sky)"/>
      <circle cx="54" cy="58" r="22" fill="url(#sun)" mask="url(#cut)" opacity="0.95" transform="translate(0 0)"/>
      <rect x="0" y="${horizon}" width="108" height="${108 - horizon}" fill="#12002b"/>
      <path d="${floor}" stroke="#ff3dc8" stroke-width="0.55" fill="none" filter="url(#glow)"/>
      <path d="M0 ${horizon}H108" stroke="#ffb3f0" stroke-width="0.6"/>`,
    foreground: `
      <defs>
        <filter id="n" ${filterBox}>
          <feGaussianBlur stdDeviation="1.8" result="b"/>
          <feMerge><feMergeNode in="b"/><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
        </filter>
      </defs>
      <g filter="url(#n)" fill="none" stroke-linejoin="round">
        <path d="${mark.t}${mark.three}" fill="#14002e" fill-opacity="0.82" stroke="#22f2ff" stroke-width="1.7"/>
        <path d="${mark.two}" fill="#14002e" fill-opacity="0.82" stroke="#ff4fd8" stroke-width="1.4"/>
      </g>
      <g fill="none" stroke="#fff" stroke-linejoin="round">
        <path d="${mark.t}${mark.three}" stroke-width="0.6"/>
        <path d="${mark.two}" stroke-width="0.5"/>
      </g>`,
    monochrome: mono(mark),
  };
}

function blueprint(): PresetArt {
  const mark = layoutMark("dmBold", 21, 54, 55);
  const b = mark.box;
  const dash = `stroke="#cfe3ff" stroke-width="0.35" stroke-dasharray="1.4 1"`;
  return {
    background: `
      <defs>
        <radialGradient id="p" cx="0.5" cy="0.45" r="0.75">
          <stop offset="0" stop-color="#1f5fc4"/><stop offset="1" stop-color="#0b3584"/>
        </radialGradient>
      </defs>
      <rect ${FULL} fill="url(#p)"/>
      <g opacity="0.55">${grid(4.5, "#ffffff", 0.1)}</g>
      ${grid(18, "#ffffff", 0.22)}`,
    foreground: `
      <path d="M${b.x - 6} ${mark.baseline}H${b.x + b.w + 6}M${b.x - 6} ${mark.capTop}H${b.x + b.w + 6}" ${dash} fill="none"/>
      <circle cx="54" cy="54" r="31" fill="none" stroke="#cfe3ff" stroke-width="0.35" stroke-dasharray="0.8 1.2"/>
      <path d="M${b.x} ${mark.baseline + 6}H${b.x + b.w}M${b.x} ${mark.baseline + 4.5}V${mark.baseline + 7.5}M${b.x + b.w} ${mark.baseline + 4.5}V${mark.baseline + 7.5}" stroke="#ffffff" stroke-width="0.4" fill="none"/>
      <path d="M${b.x - 3} ${mark.capTop}V${mark.baseline}M${b.x - 4.5} ${mark.capTop}H${b.x - 1.5}M${b.x - 4.5} ${mark.baseline}H${b.x - 1.5}" stroke="#ffffff" stroke-width="0.4" fill="none"/>
      <path d="${markPaths(mark)}" fill="#ffffff" fill-opacity="0.16" stroke="#ffffff" stroke-width="1.25" stroke-linejoin="round"/>`,
    monochrome: mono(mark),
  };
}

const PIXEL_FONT: Record<"T" | "3" | "2", readonly string[]> = {
  T: ["#####", "#####", "..#..", "..#..", "..#..", "..#..", "..#.."],
  "3": ["####.", "....#", "....#", ".###.", "....#", "....#", "####."],
  "2": ["###.", "...#", ".##.", "#...", "####"],
};

function pixel(): PresetArt {
  const px = 3.4;
  const cols = 5 + 1 + 5 + 1 + 4;
  const width = cols * px;
  const x0 = 54 - width / 2;
  const y0 = 54 - (7 * px) / 2 + 1;
  const cells: Array<{ x: number; y: number; part: "main" | "two" }> = [];
  const put = (glyph: readonly string[], gx: number, gy: number, part: "main" | "two") =>
    glyph.forEach((row, ry) =>
      [...row].forEach((c, rx) => {
        if (c === "#") cells.push({ x: x0 + (gx + rx) * px, y: y0 + (gy + ry) * px, part });
      }),
    );
  put(PIXEL_FONT.T, 0, 0, "main");
  put(PIXEL_FONT["3"], 6, 0, "main");
  put(PIXEL_FONT["2"], 12, -1.5, "two");
  const rects = (filter: (cell: (typeof cells)[number]) => boolean, dx = 0, dy = 0) =>
    cells
      .filter(filter)
      .map(
        (c) =>
          `<rect x="${(c.x + dx).toFixed(2)}" y="${(c.y + dy).toFixed(2)}" width="${px + 0.02}" height="${px + 0.02}"/>`,
      )
      .join("");
  let stars = "";
  const rand = mulberry32(42);
  for (let i = 0; i < 34; i++) {
    const x = Math.floor(rand() * 36) * 3;
    const y = Math.floor(rand() * 36) * 3;
    stars += `<rect x="${x}" y="${y}" width="${rand() > 0.8 ? 1.6 : 1}" height="${rand() > 0.8 ? 1.6 : 1}" fill="#ffffff" opacity="${(0.35 + rand() * 0.6).toFixed(2)}"/>`;
  }
  return {
    background: `
      <defs>
        <linearGradient id="s" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#140c3a"/><stop offset="1" stop-color="#2b1263"/>
        </linearGradient>
      </defs>
      <rect ${FULL} fill="url(#s)"/>${stars}
      <path d="M0 88H108V108H0Z" fill="#0e0828"/>
      ${[0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => `<rect x="${i * 12 + (i % 2) * 3}" y="85" width="9" height="3" fill="#3c2a8f"/>`).join("")}`,
    foreground: `
      <defs>
        <linearGradient id="gold" gradientUnits="userSpaceOnUse" x1="0" y1="${y0}" x2="0" y2="${y0 + 7 * px}">
          <stop offset="0" stop-color="#fff38a"/><stop offset="0.42" stop-color="#fff38a"/>
          <stop offset="0.42" stop-color="#ffb627"/><stop offset="0.72" stop-color="#ffb627"/>
          <stop offset="0.72" stop-color="#ff6b2b"/><stop offset="1" stop-color="#ff6b2b"/>
        </linearGradient>
      </defs>
      <g fill="#05030f">${rects(() => true, px * 0.5, px * 0.5)}</g>
      <g fill="url(#gold)">${rects((c) => c.part === "main")}</g>
      <g fill="#4ff0ff">${rects((c) => c.part === "two")}</g>`,
    monochrome: `<g fill="#fff">${rects(() => true)}</g>`,
  };
}

function brutal(): PresetArt {
  const mark = layoutMark("dmBlack", 25, 52, 58, { gap: -0.06, twoGap: 0.02, twoScale: 0.5 });
  const two = mark.twoBox;
  const pad = 2.2;
  return {
    background: `<rect ${FULL} fill="#f1eee4"/>
      <path d="M0 26H108M0 84H108" stroke="#0a0a0a" stroke-width="0.6"/>`,
    foreground: `
      <rect x="${(two.x - pad).toFixed(2)}" y="${(two.y - pad).toFixed(2)}" width="${(two.w + pad * 2).toFixed(2)}" height="${(two.h + pad * 2).toFixed(2)}" fill="#ff3b1f"/>
      <path d="${mark.t}${mark.three}" fill="#0a0a0a"/>
      <path d="${mark.two}" fill="#f1eee4"/>`,
    // The ² is knocked out of its block, as in the colour layers.
    monochrome: `<path d="${mark.t}${mark.three}" fill="#fff"/>
      <path d="M${(two.x - pad).toFixed(2)} ${(two.y - pad).toFixed(2)}h${(two.w + pad * 2).toFixed(2)}v${(two.h + pad * 2).toFixed(2)}h${(-two.w - pad * 2).toFixed(2)}Z${mark.two}" fill="#fff" fill-rule="evenodd"/>`,
  };
}

/** The original black T3 Code icon with chrome letters, plus the ². */
function original(): PresetArt {
  const mark = layoutMark("dmBold", 25, 54, 55, { gap: 0.03, twoGap: 0.04, twoScale: 0.46 });
  return {
    background: `
      <defs>
        <radialGradient id="o" cx="0.5" cy="0.4" r="0.75">
          <stop offset="0" stop-color="#121212"/><stop offset="1" stop-color="#000"/>
        </radialGradient>
      </defs>
      <rect ${FULL} fill="url(#o)"/>`,
    foreground: `
      <defs>
        <linearGradient id="chrome" x1="0" y1="${mark.capTop.toFixed(2)}" x2="0" y2="${mark.baseline.toFixed(2)}" gradientUnits="userSpaceOnUse">
          <stop offset="0" stop-color="#ffffff"/><stop offset="0.45" stop-color="#ececec"/><stop offset="1" stop-color="#9c9c9c"/>
        </linearGradient>
        <filter id="lift" ${filterBox}><feDropShadow dx="0" dy="0.5" stdDeviation="0.6" flood-color="#000" flood-opacity="0.8"/></filter>
      </defs>
      <path d="${markPaths(mark)}" fill="url(#chrome)" stroke="#d6d6d6" stroke-width="0.45" stroke-linejoin="round" filter="url(#lift)"/>
      <path d="${markPaths(mark)}" fill="none" stroke="#5c5c5c" stroke-width="0.15" stroke-linejoin="round"/>`,
    monochrome: mono(mark),
  };
}

function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ART: Record<string, () => PresetArt> = {
  original,
  glass,
  void: void_,
  frost,
  terminal,
  neon,
  blueprint,
  pixel,
  brutal,
};

const svgDoc = (inner: string, size: number) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 108 108">${inner}</svg>`;

const rasterize = (inner: string, size: number) =>
  sharp(Buffer.from(svgDoc(inner, size)), { density: SVG_DENSITY })
    .resize(size, size)
    .png()
    .toBuffer();

async function flatten(layers: { background: Buffer; foreground: Buffer }) {
  return sharp(layers.background)
    .composite([{ input: layers.foreground }])
    .png()
    .toBuffer();
}

/** The centre 72dp viewport of a 108dp composite, at `size` px. */
async function viewport(composite: Buffer, size: number) {
  const meta = await sharp(composite).metadata();
  const full = meta.width!;
  const inset = Math.round((full * 18) / 108);
  return sharp(composite)
    .extract({ left: inset, top: inset, width: full - inset * 2, height: full - inset * 2 })
    .resize(size, size)
    .png()
    .toBuffer();
}

async function masked(image: Buffer, size: number, shape: "circle" | "squircle" | "rounded") {
  const path =
    shape === "circle"
      ? `<circle cx="54" cy="54" r="54"/>`
      : shape === "squircle"
        ? `<path d="${squirclePath(54, 54, 54, 4.2)}"/>`
        : `<rect width="108" height="108" rx="20"/>`;
  const mask = await rasterize(`<g fill="#fff">${path}</g>`, size);
  return sharp(await sharp(image).resize(size, size).png().toBuffer())
    .composite([{ input: mask, blend: "dest-in" }])
    .png()
    .toBuffer();
}

async function renderPresetFull(art: PresetArt, size: number) {
  const background = await rasterize(art.background, size);
  const foreground = await rasterize(art.foreground, size);
  return { background, foreground, composite: await flatten({ background, foreground }) };
}

async function classicFull(root: string, size: number) {
  const background = await sharp(`${root}/${CLASSIC_DIR}/adaptive-background.png`)
    .resize(size, size)
    .png()
    .toBuffer();
  const foreground = await sharp(`${root}/${CLASSIC_DIR}/adaptive-foreground.png`)
    .resize(size, size)
    .png()
    .toBuffer();
  return { background, foreground, composite: await flatten({ background, foreground }) };
}

const webp = (input: Buffer) => sharp(input).webp({ lossless: true, effort: 6 }).toBuffer();

type Outputs = Map<string, Buffer | string>;

async function androidResources(outputs: Outputs, id: string, art: PresetArt) {
  const name = `t3_icon_${id}`;
  for (const [density, scale] of DENSITIES) {
    const layer = Math.round(108 * scale);
    const legacy = Math.round(48 * scale);
    const { background, foreground, composite } = await renderPresetFull(art, layer);
    const monochrome = await rasterize(art.monochrome, layer);
    const dir = `${RES_DIR}/mipmap-${density}`;
    outputs.set(`${dir}/${name}_background.webp`, await webp(background));
    outputs.set(`${dir}/${name}_foreground.webp`, await webp(foreground));
    outputs.set(`${dir}/${name}_monochrome.webp`, await webp(monochrome));
    // Pre-Oreo launchers draw the legacy bitmap as is: the 72dp viewport inside a 2dp margin.
    const inner = Math.round(44 * scale);
    const pad = (legacy - inner) / 2;
    const extend = {
      top: Math.floor(pad),
      bottom: Math.ceil(pad),
      left: Math.floor(pad),
      right: Math.ceil(pad),
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    };
    const view = await viewport(composite, inner);
    outputs.set(
      `${dir}/${name}.webp`,
      await webp(
        await sharp(await masked(view, inner, "rounded"))
          .extend(extend)
          .png()
          .toBuffer(),
      ),
    );
    outputs.set(
      `${dir}/${name}_round.webp`,
      await webp(
        await sharp(await masked(view, inner, "circle"))
          .extend(extend)
          .png()
          .toBuffer(),
      ),
    );
  }
  const adaptive = `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@mipmap/${name}_background"/>
    <foreground android:drawable="@mipmap/${name}_foreground"/>
    <monochrome android:drawable="@mipmap/${name}_monochrome"/>
</adaptive-icon>
`;
  outputs.set(`${RES_DIR}/mipmap-anydpi-v26/${name}.xml`, adaptive);
  outputs.set(`${RES_DIR}/mipmap-anydpi-v26/${name}_round.xml`, adaptive);
}

async function contactSheet(
  entries: ReadonlyArray<{ id: string; label: string; composite: Buffer }>,
) {
  const big = 168;
  const small = 48;
  const cellW = big * 2 + small + 70;
  const cellH = big + 56;
  const columns = 2;
  const rows = Math.ceil(entries.length / columns);
  const width = cellW * columns + 40;
  const height = cellH * rows + 40;
  const wallpaper = await sharp(
    Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><defs><linearGradient id="w" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#2d3a4a"/><stop offset="1" stop-color="#11161d"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#w)"/></svg>`,
    ),
  )
    .png()
    .toBuffer();
  const overlays: OverlayOptions[] = [];
  let labels = "";
  for (const [index, entry] of entries.entries()) {
    const x = 20 + (index % columns) * cellW;
    const y = 20 + Math.floor(index / columns) * cellH;
    const view = await viewport(entry.composite, big * 2);
    overlays.push({ input: await masked(view, big, "circle"), left: x, top: y });
    overlays.push({ input: await masked(view, big, "squircle"), left: x + big + 16, top: y });
    overlays.push({
      input: await masked(view, small, "squircle"),
      left: x + big * 2 + 32,
      top: y + 20,
    });
    overlays.push({ input: await masked(view, 36, "circle"), left: x + big * 2 + 38, top: y + 84 });
    labels += `<text x="${x + 4}" y="${y + big + 30}" font-family="DejaVu Sans" font-size="20" fill="#fff">${entry.label} <tspan fill="#9aa4b0" font-size="15">${entry.id}</tspan></text>`;
  }
  const text = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${labels}</svg>`,
  );
  overlays.push({ input: text, left: 0, top: 0 });
  return sharp(wallpaper).composite(overlays).png().toBuffer();
}

/** White pixels' bounding box in a monochrome raster, as a square centred on the mark. */
async function markSquare(monochrome: Buffer) {
  const { data, info } = await sharp(monochrome)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let [left, top, right, bottom] = [info.width, info.height, -1, -1];
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      if (data[(y * info.width + x) * info.channels + 3]! < 16) continue;
      left = Math.min(left, x);
      right = Math.max(right, x);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
    }
  }
  if (right < 0) throw new Error("Monochrome layer is empty");
  const side = Math.ceil(
    (Math.max(right - left, bottom - top) * SMALL_ICON_DP) / SMALL_ICON_LIVE_DP,
  );
  const cx = (left + right) / 2;
  const cy = (top + bottom) / 2;
  return { left: Math.round(cx - side / 2), top: Math.round(cy - side / 2), side };
}

async function smallIcons(outputs: Outputs, id: string, monochrome: Buffer) {
  const box = await markSquare(monochrome);
  const meta = await sharp(monochrome).metadata();
  const pad = {
    top: Math.max(0, -box.top),
    left: Math.max(0, -box.left),
    bottom: Math.max(0, box.top + box.side - meta.height!),
    right: Math.max(0, box.left + box.side - meta.width!),
    background: { r: 0, g: 0, b: 0, alpha: 0 },
  };
  const padded = await sharp(monochrome).extend(pad).png().toBuffer();
  const square = await sharp(padded)
    .extract({
      left: box.left + pad.left,
      top: box.top + pad.top,
      width: box.side,
      height: box.side,
    })
    .png()
    .toBuffer();
  for (const [density, scale] of DENSITIES) {
    const size = Math.round(SMALL_ICON_DP * scale);
    // Small icons are alpha masks; force white so only coverage matters.
    const icon = await sharp(square)
      .resize(size, size)
      .ensureAlpha()
      .extractChannel("alpha")
      .toBuffer();
    const white = await sharp({
      create: { width: size, height: size, channels: 3, background: "#ffffff" },
    })
      .joinChannel(icon)
      .png({ compressionLevel: 9 })
      .toBuffer();
    outputs.set(`${RES_DIR}/drawable-${density}/t3_notify_${id}.png`, white);
  }
}

/** One xxxhdpi bitmap; other densities scale it down when it loads. */
async function splash(outputs: Outputs, id: string, composite: Buffer) {
  const art = await sharp(composite).resize(SPLASH_PX, SPLASH_PX).png().toBuffer();
  const mask = await rasterize(`<circle cx="54" cy="54" r="37.5" fill="#fff"/>`, SPLASH_PX);
  const circle = await sharp(art)
    .composite([{ input: mask, blend: "dest-in" }])
    .png()
    .toBuffer();
  outputs.set(`${RES_DIR}/drawable-xxxhdpi/t3_splash_${id}.webp`, await webp(circle));
}

function kotlinTable(presets: ReadonlyArray<PresetEntry>) {
  const rows = presets.map(
    ({ id, accent }) =>
      `    "${id}" to AppIconPreset(R.drawable.t3_notify_${id}, 0xFF${accent.slice(1).toUpperCase()}.toInt()),`,
  );
  return `// Generated by scripts/render-mobile-app-icons.ts from presets.json. Do not edit.
package expo.modules.t3appicon

data class AppIconPreset(val smallIcon: Int, val accent: Int)

internal val APP_ICON_PRESETS: Map<String, AppIconPreset> = mapOf(
${rows.join("\n")}
)
`;
}

const PresetEntries = Schema.Array(
  Schema.Struct({ id: Schema.String, label: Schema.String, accent: Schema.String }),
);
type PresetEntry = (typeof PresetEntries.Type)[number];
const decodePresets = Schema.decodeEffect(Schema.fromJsonString(PresetEntries));

async function renderAll(root: string, presets: ReadonlyArray<PresetEntry>, withSheet: boolean) {
  const outputs: Outputs = new Map();
  const sheetEntries: Array<{ id: string; label: string; composite: Buffer }> = [];
  for (const preset of presets) {
    if (preset.id === "classic") {
      const { composite } = await classicFull(root, 432);
      outputs.set(`${PREVIEW_DIR}/classic.png`, await viewport(composite, PREVIEW_SIZE));
      await smallIcons(
        outputs,
        preset.id,
        await sharp(`${root}/${CLASSIC_DIR}/monochrome.png`).resize(1080, 1080).png().toBuffer(),
      );
      sheetEntries.push({ ...preset, composite });
      continue;
    }
    const make = ART[preset.id];
    if (!make) throw new Error(`No artwork for preset "${preset.id}"`);
    const art = make();
    await androidResources(outputs, preset.id, art);
    const { composite } = await renderPresetFull(art, 432);
    outputs.set(`${PREVIEW_DIR}/${preset.id}.png`, await viewport(composite, PREVIEW_SIZE));
    await smallIcons(outputs, preset.id, await rasterize(art.monochrome, 1080));
    await splash(outputs, preset.id, (await renderPresetFull(art, SPLASH_PX)).composite);
    sheetEntries.push({ ...preset, composite });
  }
  outputs.set(KOTLIN_FILE, kotlinTable(presets));
  return { outputs, sheet: withSheet ? await contactSheet(sheetEntries) : null };
}

const renderMobileAppIcons = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = path.resolve(import.meta.dirname, "..");
  const sheetIndex = process.argv.indexOf("--sheet");
  const sheetFile = sheetIndex === -1 ? null : path.resolve(process.argv[sheetIndex + 1] ?? "");
  const presets = yield* decodePresets(
    yield* fs.readFileString(path.join(root, MODULE_DIR, "presets.json")),
  );
  const { outputs, sheet } = yield* Effect.promise(() =>
    renderAll(root, presets, sheetFile !== null),
  );
  for (const [relative, contents] of outputs) {
    const file = path.join(root, relative);
    yield* fs.makeDirectory(path.dirname(file), { recursive: true });
    yield* typeof contents === "string"
      ? fs.writeFileString(file, contents)
      : fs.writeFile(file, contents);
  }
  yield* Console.log(`wrote ${outputs.size} files`);
  if (sheetFile && sheet) {
    yield* fs.writeFile(sheetFile, sheet);
    yield* Console.log(`wrote ${sheetFile}`);
  }
});

if (import.meta.main) {
  renderMobileAppIcons.pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain);
}

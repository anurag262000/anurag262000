#!/usr/bin/env node
// Draws the animated bento card at the top of the profile README:
// assets/bento-dark.svg and assets/bento-light.svg.
//
// Runs every day in .github/workflows/profile.yml with live GitHub data.
// Local preview with made-up data: node scripts/bento.mjs --sample --out preview

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";

// ── What the card says. Edit these lines to change the text. ──
const PROFILE = {
  login: process.env.USERNAME || "anurag262000",
  name: "Anurag",
  role: "Full stack web developer",
  builds: ["fast web apps", "clean interfaces", "reliable APIs", "tools teams use"],
  learning: ["Docker", "CI/CD", "System design"],
  project: {
    title: "Project & time tracker",
    blurb: "Self-hosted, for small agency teams",
    tech: "Next.js · PostgreSQL · Drizzle · Docker",
  },
  stack: [
    "typescript", "nextdotjs", "react", "nodedotjs", "express", "postgresql",
    "mongodb", "supabase", "firebase", "tailwindcss", "docker", "githubactions",
  ],
};

const THEMES = {
  dark: {
    tile: "#161b22", stroke: "#30363d", text: "#e6edf3", muted: "#8d96a0", accent: "#3fb950",
    live: "#3fb950", private: "#006d32", chip: "#0d1117", track: "#21262d", glow: "#238636", ground: "#0d1117", shine: "#ffffff",
    flame: ["#ff6a3d", "#ffb02e", "#ffe08a"],
    // city colours per contribution level: [front, side, top]
    city: [
      ["#1c2129", "#161a20", "#262c35"],
      ["#0e4429", "#0a321e", "#135c37"],
      ["#006d32", "#005226", "#0a8a43"],
      ["#26a641", "#1d8033", "#3cc456"],
      ["#39d353", "#2bab42", "#7ee891"],
    ],
  },
  light: {
    tile: "#f6f8fa", stroke: "#d0d7de", text: "#1f2328", muted: "#59636e", accent: "#1a7f37",
    live: "#1a7f37", private: "#4ac26b", chip: "#ffffff", track: "#e6eaef", glow: "#4ac26b", ground: "#eaeef2", shine: "#ffffff",
    flame: ["#e5482d", "#f59f0b", "#ffd166"],
    city: [
      ["#dfe4ea", "#d0d7de", "#eaeef2"],
      ["#9be9a8", "#7fd38d", "#b8f0c1"],
      ["#40c463", "#33a852", "#5fd47d"],
      ["#30a14e", "#26833f", "#45b862"],
      ["#216e39", "#18552b", "#2d8a4a"],
    ],
  },
};

const SANS = `-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans', Helvetica, Arial, sans-serif, 'Apple Color Emoji', 'Segoe UI Emoji', 'Noto Color Emoji'`;
const MONO = `ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace`;

// ── Grid: 4 columns, 840 wide ──
const W = 840;
const GAP = 12;
const COL = (W - 3 * GAP) / 4;
const colX = (c) => c * (COL + GAP);
const span = (n) => n * COL + (n - 1) * GAP;
const ROW_Y = [0, 192, 384, 606];

const LEVEL = { NONE: 0, FIRST_QUARTILE: 1, SECOND_QUARTILE: 2, THIRD_QUARTILE: 3, FOURTH_QUARTILE: 4 };

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const n2 = (v) => Math.round(v * 100) / 100;
const pts = (list) => list.map(([x, y]) => `${n2(x)},${n2(y)}`).join(" ");

// ── Data ──

async function graphql(token, query, variables) {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { Authorization: `bearer ${token}`, "Content-Type": "application/json", "User-Agent": "profile-bento" },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json();
  if (!res.ok || body.errors) throw new Error(`GitHub API: ${res.status} ${JSON.stringify(body.errors ?? body)}`);
  return body.data;
}

async function fetchData(login, token) {
  const query = `query($login: String!) {
    user(login: $login) {
      followers { totalCount }
      pullRequests { totalCount }
      repositories(ownerAffiliations: OWNER, isFork: false, privacy: PUBLIC, first: 100) {
        totalCount
        nodes {
          stargazerCount
          languages(first: 10, orderBy: { field: SIZE, direction: DESC }) { edges { size node { name color } } }
        }
      }
      contributionsCollection {
        contributionYears
        contributionCalendar {
          totalContributions
          weeks { contributionDays { date weekday contributionCount contributionLevel } }
        }
      }
    }
  }`;
  const { user: u } = await graphql(token, query, { login });

  const langs = new Map();
  for (const repo of u.repositories.nodes) {
    for (const { size, node } of repo.languages.edges) {
      const prev = langs.get(node.name) ?? { name: node.name, color: node.color, size: 0 };
      prev.size += size;
      langs.set(node.name, prev);
    }
  }

  const cal = u.contributionsCollection.contributionCalendar;
  return {
    total: cal.totalContributions,
    weeks: cal.weeks.map((w) =>
      w.contributionDays.map((d) => ({ date: d.date, weekday: d.weekday, count: d.contributionCount, level: LEVEL[d.contributionLevel] ?? 0 })),
    ),
    repos: u.repositories.totalCount,
    stars: u.repositories.nodes.reduce((sum, r) => sum + r.stargazerCount, 0),
    prs: u.pullRequests.totalCount,
    followers: u.followers.totalCount,
    languages: [...langs.values()].sort((a, b) => b.size - a.size),
    years: await fetchYears(login, token, u.contributionsCollection.contributionYears),
  };
}

// One total per calendar year you've contributed in. A single GitHub query
// window can't be longer than a year, so each year is its own aliased field.
async function fetchYears(login, token, contributionYears) {
  const now = new Date();
  const fields = contributionYears.map((y) => {
    const to = y === now.getUTCFullYear() ? now.toISOString() : `${y}-12-31T23:59:59Z`;
    return `y${y}: contributionsCollection(from: "${y}-01-01T00:00:00Z", to: "${to}") {
      restrictedContributionsCount
      contributionCalendar { totalContributions }
    }`;
  });
  const { user } = await graphql(token, `query($login: String!) { user(login: $login) { ${fields.join("\n")} } }`, { login });
  return contributionYears
    .map((y) => {
      const c = user[`y${y}`];
      const total = c.contributionCalendar.totalContributions;
      return { year: y, total, private: Math.min(total, c.restrictedContributionsCount) };
    })
    .sort((a, b) => a.year - b.year);
}

function sampleData() {
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const weeks = [];
  const start = new Date(Date.UTC(2025, 9, 26));
  let total = 0;
  for (let w = 0; w < 53; w++) {
    const days = [];
    for (let d = 0; d < 7; d++) {
      const date = new Date(start.getTime() + (w * 7 + d) * 864e5);
      const r = rand();
      const count = r < 0.45 ? 0 : Math.round(r * r * 14);
      total += count;
      days.push({ date: date.toISOString().slice(0, 10), weekday: d, count, level: count === 0 ? 0 : Math.min(4, Math.ceil(count / 3.5)) });
    }
    weeks.push(days);
  }
  return {
    total, weeks, repos: 24, stars: 1, prs: 3, followers: 4,
    years: [
      { year: 2023, total: 212, private: 150 },
      { year: 2024, total: 486, private: 391 },
      { year: 2025, total: 903, private: 810 },
      { year: 2026, total: 1725, private: 1540 },
    ],
    languages: [
      { name: "JavaScript", color: "#f1e05a", size: 52 },
      { name: "TypeScript", color: "#3178c6", size: 26 },
      { name: "CSS", color: "#663399", size: 14 },
      { name: "HTML", color: "#e34c26", size: 8 },
    ],
  };
}

function streaks(weeks) {
  const days = weeks.flat();
  let longest = 0;
  let run = 0;
  for (const d of days) {
    run = d.count > 0 ? run + 1 : 0;
    longest = Math.max(longest, run);
  }
  // Today may not have activity yet; the streak is still alive if yesterday did.
  let i = days.length - 1;
  if (i >= 0 && days[i].count === 0) i--;
  let current = 0;
  while (i >= 0 && days[i].count > 0) { current++; i--; }
  return { current, longest };
}

// ── Drawing helpers ──

let uid = 0;

function text(x, y, str, cls, extra = "") {
  return `<text x="${n2(x)}" y="${n2(y)}" class="${cls}"${extra}>${esc(str)}</text>`;
}

function tile(x, y, w, h, delay, body, t, clipId) {
  const clip = clipId ? `<clipPath id="${clipId}"><rect width="${w}" height="${h}" rx="16"/></clipPath>` : "";
  return `<g transform="translate(${n2(x)} ${n2(y)})">${clip}<g class="tile" style="animation-delay:${delay}s">` +
    `<rect width="${n2(w)}" height="${h}" rx="16" fill="${t.tile}" stroke="${t.stroke}"/>${body}</g></g>`;
}

// Slot-machine number: each digit column spins once through 0–9 and stops on its value.
function odometer(x, y, value, size, cls, delay) {
  const digits = String(value).split("");
  const dw = size * 0.6;
  const lh = size * 1.2;
  const id = `odo${uid++}`;
  let out = `<clipPath id="${id}"><rect x="${n2(x - 2)}" y="${n2(y - size * 0.92)}" width="${n2(digits.length * dw + 6)}" height="${n2(lh)}"/></clipPath>`;
  out += `<g clip-path="url(#${id})" class="${cls}">`;
  digits.forEach((d, i) => {
    const stop = 10 + Number(d);
    let col = "";
    for (let k = 0; k < 20; k++) col += `<text x="${n2(x + i * dw)}" y="${n2(y + k * lh)}">${k % 10}</text>`;
    out += `<g class="roll" style="transform:translateY(${n2(-stop * lh)}px);animation-delay:${n2(delay + i * 0.12)}s">${col}</g>`;
  });
  return out + "</g>";
}

// ── Tiles ──

function helloTile(t) {
  const w = span(2);
  const h = ROW_Y[1] + 180;
  let b = `<g clip-path="url(#clip-hello)"><circle class="glow" cx="${w - 70}" cy="40" r="190" fill="url(#glow)"/></g>`;
  b += `<text x="24" y="76" class="wave" font-size="34">👋</text>`;
  b += text(24, 132, `Hi, I'm ${PROFILE.name}.`, "hero");
  b += text(24, 162, PROFILE.role, "body muted");
  b += text(24, 210, "I BUILD", "label");
  PROFILE.builds.forEach((word, i) => {
    b += text(24, 244, word, "word", ` style="animation-delay:${i * 3}s;${i ? "opacity:0" : ""}"`);
  });
  b += `<line x1="24" x2="${w - 24}" y1="282" y2="282" stroke="${t.stroke}"/>`;
  b += text(24, 312, "NOW LEARNING", "label");
  let cx = 24;
  PROFILE.learning.forEach((item, i) => {
    const cw = item.length * 7.3 + 24;
    b += `<g transform="translate(${n2(cx)} 326)"><g class="pop" style="animation-delay:${n2(1.1 + i * 0.12)}s">` +
      `<rect width="${n2(cw)}" height="26" rx="13" fill="${t.chip}" stroke="${t.stroke}"/>` +
      text(cw / 2, 17.5, item, "chip", ` text-anchor="middle"`) + `</g></g>`;
    cx += cw + 8;
  });
  return tile(colX(0), ROW_Y[0], w, h, 0, b, t, "clip-hello");
}

function contributionsTile(t, data) {
  let b = text(20, 34, "CONTRIBUTIONS", "label");
  b += odometer(20, 96, data.total, 44, "big", 0.4);
  b += text(20, 124, "in the last year", "small muted");
  const sums = data.weeks.slice(-26).map((w) => w.reduce((s, d) => s + d.count, 0));
  const max = Math.max(1, ...sums);
  sums.forEach((s, i) => {
    const bh = s === 0 ? 2 : 4 + (s / max) * 24;
    b += `<rect class="growy" style="animation-delay:${n2(0.6 + i * 0.03)}s" x="${n2(20 + i * 6.2)}" y="${n2(164 - bh)}" width="4" height="${n2(bh)}" rx="1" fill="${t.accent}" fill-opacity="${n2(0.3 + 0.7 * (s / max))}"/>`;
  });
  return tile(colX(2), ROW_Y[0], COL, 180, 0.12, b, t);
}

function streakTile(t, data) {
  const { current, longest } = streaks(data.weeks);
  const [f1, f2, f3] = t.flame;
  let b = text(20, 34, "STREAK", "label");
  b += `<g transform="translate(146 18) scale(1.6)"><g class="flame">` +
    `<path d="M12 1.5c.6 3.2-1 5-2.6 6.8C7.7 10.2 6 12.2 6 15a6 6 0 0 0 12 0c0-2.4-1.1-4.2-2.4-5.7-.1 1.5-.8 2.7-2 3.3.4-3.6-.4-7.8-1.6-11.1z" fill="url(#flame)"/>` +
    `<path d="M12 11.2c.2 1.6-.6 2.5-1.4 3.4-.6.7-1.1 1.4-1.1 2.4a2.5 2.5 0 0 0 5 0c0-1.5-.9-2.6-1.6-3.3 0 .8-.4 1.3-.9 1.6.1-1.5-.1-2.9 0-4.1z" fill="${f3}"/>` +
    `</g></g>`;
  b += `<linearGradient id="flame" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="${f1}"/><stop offset="1" stop-color="${f2}"/></linearGradient>`;
  b += odometer(20, 96, current, 44, "big", 0.5);
  b += text(20, 124, current === 1 ? "day in a row" : "days in a row", "small muted");
  b += text(20, 160, `Best run: ${longest} day${longest === 1 ? "" : "s"}`, "tiny muted");
  return tile(colX(3), ROW_Y[0], COL, 180, 0.2, b, t);
}

function buildingTile(t) {
  const w = span(2);
  const p = PROFILE.project;
  let b = `<circle class="pulse" cx="27" cy="30" r="4" fill="${t.live}"/><circle cx="27" cy="30" r="4" fill="${t.live}"/>`;
  b += text(40, 34, "NOW BUILDING", "label");
  b += text(24, 74, p.title, "title");
  b += text(24, 100, p.blurb, "body muted");
  b += text(24, 126, p.tech, "tech");
  const bw = w - 48;
  b += `<clipPath id="clip-bar"><rect x="24" y="146" width="${n2(bw)}" height="10" rx="5"/></clipPath>`;
  b += `<rect x="24" y="146" width="${n2(bw)}" height="10" rx="5" fill="${t.track}"/>`;
  let stripes = "";
  for (let i = -2; i < bw / 16 + 2; i++) {
    const x = 24 + i * 16;
    stripes += `<polygon points="${pts([[x, 156], [x + 8, 146], [x + 16, 146], [x + 8, 156]])}"/>`;
  }
  b += `<g clip-path="url(#clip-bar)"><g class="slide" fill="${t.accent}" fill-opacity="0.55">${stripes}</g></g>`;
  return tile(colX(2), ROW_Y[1], w, 180, 0.28, b, t);
}

function skylineTile(t, data) {
  const weeks = data.weeks;
  const cw = 13;
  const dx = 6;
  const dy = 5;
  const fw = cw - 3;
  const [px, py] = [dx - 2, -(dy - 1.5)];
  const baseY = 194;
  const drawW = weeks.length * cw + 6 * dx + px;
  const ox = (W - drawW) / 2;
  const max = Math.max(1, ...weeks.flat().map((d) => d.count));

  let b = text(20, 34, "A YEAR OF CODE, IN 3D", "label");
  b += text(W - 20, 34, `${data.total} contributions`, "tiny muted mono", ` text-anchor="end"`);

  const gx = ox - 8;
  const gw = weeks.length * cw + 16;
  b += `<polygon fill="${t.ground}" points="${pts([[gx, baseY + 3], [gx + gw, baseY + 3], [gx + gw + 6 * dx + px, baseY + 3 - 6 * dy + py], [gx + 6 * dx + px, baseY + 3 - 6 * dy + py]])}"/>`;

  let bars = "";
  let twinkles = "";
  let lit = 0;
  for (let depth = 6; depth >= 0; depth--) {
    weeks.forEach((week, wi) => {
      const day = week.find((d) => d.weekday === depth);
      if (!day) return;
      const z = day.count === 0 ? 1.5 : 5 + Math.pow(day.count / max, 0.6) * 74;
      const x0 = ox + wi * cw + depth * dx;
      const y0 = baseY - depth * dy;
      const [front, side, top] = t.city[day.level];
      const topFace = [[x0, y0 - z], [x0 + fw, y0 - z], [x0 + fw + px, y0 - z + py], [x0 + px, y0 - z + py]];
      bars += `<g class="bar" style="animation-delay:${n2(0.5 + wi * 0.028 + (6 - depth) * 0.02)}s">` +
        `<rect x="${n2(x0)}" y="${n2(y0 - z)}" width="${fw}" height="${n2(z)}" fill="${front}"/>` +
        `<polygon points="${pts([[x0 + fw, y0], [x0 + fw, y0 - z], [x0 + fw + px, y0 - z + py], [x0 + fw + px, y0 + py]])}" fill="${side}"/>` +
        `<polygon points="${pts(topFace)}" fill="${top}"/></g>`;
      if (day.level >= 3 && (wi + depth) % 2 === 0 && lit < 30) {
        twinkles += `<polygon class="tw" style="animation-delay:${n2(2.5 + ((wi * 7 + depth * 13) % 60) / 10)}s" points="${pts(topFace)}" fill="${t.shine}"/>`;
        lit++;
      }
    });
  }
  b += bars + twinkles;
  b += `<g clip-path="url(#clip-sky)"><rect class="sweep" width="140" height="210" fill="url(#sweep)"/></g>`;
  return tile(0, ROW_Y[2], W, 210, 0.36, b, t, "clip-sky");
}

function stackTile(t, icons, y) {
  let b = text(20, 32, "STACK", "label");
  const size = 40;
  const perRow = 6;
  const gapX = (span(2) - 40 - perRow * size) / (perRow - 1);
  PROFILE.stack.forEach((slug, i) => {
    const icon = icons[slug];
    if (!icon) return;
    const x = 20 + (i % perRow) * (size + gapX);
    const y = 46 + Math.floor(i / perRow) * 50;
    const dark = luminance(icon.hex) < 0.25;
    const fill = dark ? t.text : `#${icon.hex}`;
    b += `<g transform="translate(${n2(x)} ${y})"><g class="pop" style="animation-delay:${n2(0.9 + i * 0.07)}s">` +
      `<g class="float" style="animation-delay:${n2(-i * 0.45)}s"><title>${esc(icon.title)}</title>` +
      `<rect width="${size}" height="${size}" rx="10" fill="${t.chip}" stroke="${t.stroke}"/>` +
      `<g transform="translate(10 10) scale(0.8333)"><path d="${icon.path}" fill="${fill}"/></g></g></g></g>`;
  });
  return tile(colX(0), y, span(2), 150, 0.44, b, t);
}

function languagesTile(t, data, y) {
  let b = text(20, 32, "TOP LANGUAGES", "label");
  const total = data.languages.reduce((s, l) => s + l.size, 0);
  const top = data.languages.slice(0, 4);
  if (!top.length) b += text(20, 70, "No public code yet", "small muted");
  top.forEach((l, i) => {
    const ly = 56 + i * 24;
    const share = total ? l.size / total : 0;
    b += text(20, ly, l.name, "tiny");
    b += text(COL - 20, ly, `${Math.round(share * 100)}%`, "tiny muted mono", ` text-anchor="end"`);
    b += `<rect x="20" y="${ly + 6}" width="${COL - 40}" height="5" rx="2.5" fill="${t.track}"/>`;
    b += `<rect class="growx" style="animation-delay:${n2(1 + i * 0.12)}s" x="20" y="${ly + 6}" width="${n2(Math.max(3, share * (COL - 40)))}" height="5" rx="2.5" fill="${l.color ?? t.muted}"/>`;
  });
  return tile(colX(2), y, COL, 150, 0.52, b, t);
}

function statsTile(t, data, y) {
  let b = text(20, 32, "PROFILE", "label");
  const cells = [
    [20, 68, data.repos, "Public repos"],
    [108, 68, data.stars, "Stars"],
    [20, 116, data.prs, "Pull requests"],
    [108, 116, data.followers, "Followers"],
  ];
  cells.forEach(([x, y, v, label], i) => {
    b += odometer(x, y, v, 24, "mid", 0.8 + i * 0.1);
    b += text(x, y + 18, label, "tiny muted");
  });
  return tile(colX(3), y, COL, 150, 0.6, b, t);
}

// ── Journey: contributions per year since you joined ──

const JOURNEY_H = 210;

function journeyTile(t, data, y) {
  const years = data.years;
  const sum = years.reduce((s, yr) => s + yr.total, 0);
  const best = years.reduce((a, yr) => (yr.total > a.total ? yr : a), years[0]);
  const thisYear = new Date().getUTCFullYear();

  let b = text(20, 34, "THE JOURNEY", "label");
  b += odometer(20, 100, sum, 44, "big", 0.5);
  b += text(20, 128, `contributions since ${years[0].year}`, "small muted");
  b += text(20, 154, `Best year: ${best.year} · ${best.total}`, "tiny muted");
  b += `<rect x="20" y="177" width="10" height="10" rx="2" fill="${t.accent}"/>` + text(36, 186, "Public", "tiny muted");
  b += `<rect x="96" y="177" width="10" height="10" rx="2" fill="${t.private}"/>` + text(112, 186, "Private", "tiny muted");

  const x0 = 300;
  const x1 = W - 24;
  const base = 168;
  const maxH = 96;
  const slot = (x1 - x0) / years.length;
  const bw = Math.min(56, slot * 0.5);
  const max = Math.max(1, ...years.map((yr) => yr.total));
  const tops = [];
  let bars = "";
  let labels = "";
  years.forEach((yr, i) => {
    const cx = x0 + slot * (i + 0.5);
    const hTotal = Math.max(3, (yr.total / max) * maxH);
    const hPrivate = yr.total ? hTotal * (yr.private / yr.total) : 0;
    const top = base - hTotal;
    const delay = 0.7 + i * 0.25;
    const id = `yr${uid++}`;
    tops.push([cx, top]);
    // Private work sits at the bottom of each bar, public work on top.
    bars += `<g class="growy" style="animation-delay:${n2(delay)}s">` +
      `<clipPath id="${id}"><rect x="${n2(cx - bw / 2)}" y="${n2(top)}" width="${n2(bw)}" height="${n2(hTotal)}" rx="6"/></clipPath>` +
      `<g clip-path="url(#${id})"><rect x="${n2(cx - bw / 2)}" y="${n2(top)}" width="${n2(bw)}" height="${n2(hTotal)}" fill="${t.accent}"/>` +
      `<rect x="${n2(cx - bw / 2)}" y="${n2(base - hPrivate)}" width="${n2(bw)}" height="${n2(hPrivate)}" fill="${t.private}"/></g></g>`;
    labels += text(cx, top - 14, yr.total, "tiny mono fade", ` text-anchor="middle" style="animation-delay:${n2(delay + 0.5)}s"`);
    labels += text(cx, base + 18, yr.year, "tiny mono muted", ` text-anchor="middle"`);
    if (yr.year === thisYear) labels += text(cx, base + 32, "so far", "micro muted", ` text-anchor="middle"`);
  });
  b += `<line x1="${x0}" x2="${x1}" y1="${base}" y2="${base}" stroke="${t.stroke}"/>`;
  b += bars + labels;

  // A trend line across the tops, drawn in once the bars are up.
  if (tops.length > 1) {
    const lineDelay = 0.9 + years.length * 0.25;
    const d = tops.map(([x, ty], i) => `${i ? "L" : "M"}${n2(x)} ${n2(ty - 4)}`).join(" ");
    b += `<path d="${d}" pathLength="1" class="draw" style="animation-delay:${n2(lineDelay)}s" fill="none" stroke="${t.text}" stroke-opacity="0.45" stroke-width="1.5"/>`;
    tops.forEach(([x, ty], i) => {
      const last = i === tops.length - 1;
      b += `<g transform="translate(${n2(x)} ${n2(ty - 4)})">` +
        (last ? `<circle class="halo" r="4" fill="none" stroke="${t.accent}" stroke-width="2"/>` : "") +
        `<g class="pop" style="animation-delay:${n2(lineDelay + 0.15 * i)}s"><circle r="3.5" fill="${t.tile}" stroke="${t.text}" stroke-width="1.5"/></g></g>`;
    });
  }
  return tile(0, y, W, JOURNEY_H, 0.42, b, t);
}

function luminance(hex) {
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// ── Page ──

function style(t) {
  const n = PROFILE.builds.length;
  const p = 100 / n;
  return `<style>
  text { font-family: ${SANS}; fill: ${t.text}; }
  .mono, .label, .chip, .tech, .big, .mid { font-family: ${MONO}; }
  .label { font-size: 11px; font-weight: 600; letter-spacing: 1.4px; fill: ${t.muted}; }
  .hero { font-size: 40px; font-weight: 800; letter-spacing: -0.5px; }
  .title { font-size: 22px; font-weight: 700; }
  .body { font-size: 16px; }
  .small { font-size: 13px; }
  .tiny { font-size: 12px; }
  .micro { font-size: 10px; }
  .muted { fill: ${t.muted}; }
  .chip { font-size: 12px; fill: ${t.text}; }
  .tech { font-size: 12.5px; fill: ${t.accent}; }
  .word { font-size: 28px; font-weight: 700; fill: ${t.accent}; animation: cycle ${n * 3}s infinite both; }
  .big text { font-size: 44px; font-weight: 700; fill: ${t.accent}; }
  .mid text { font-size: 24px; font-weight: 700; fill: ${t.text}; }

  .tile { animation: rise 0.8s cubic-bezier(.2,.8,.2,1) both; }
  .roll { animation: roll 1.8s cubic-bezier(.15,.75,.1,1) both; }
  .bar, .growy { transform-box: fill-box; transform-origin: 50% 100%; animation: grow 0.9s cubic-bezier(.2,.8,.2,1) both; }
  .growx { transform-box: fill-box; transform-origin: 0 50%; animation: growx 1s cubic-bezier(.2,.8,.2,1) both; }
  .pop { transform-box: fill-box; transform-origin: center; animation: pop 0.6s cubic-bezier(.3,1.5,.5,1) both; }
  .float { animation: float 3.2s ease-in-out infinite; }
  .pulse { transform-box: fill-box; transform-origin: center; opacity: 0; animation: pulse 2s ease-out infinite; }
  .slide { animation: slide 0.9s linear infinite; }
  .flame { transform-box: fill-box; transform-origin: 50% 100%; animation: flick 1.4s ease-in-out infinite; }
  .glow { animation: drift 14s ease-in-out infinite; }
  .wave { transform-box: fill-box; transform-origin: 70% 80%; animation: wave 2.8s ease-in-out infinite; }
  .tw { opacity: 0; animation: twinkle 6s ease-in-out infinite; }
  .sweep { transform: translateX(-200px); animation: sweep 9s linear 2s infinite; }
  .draw { stroke-dasharray: 1; animation: draw 1.2s ease-out both; }
  .fade { animation: fadein 0.6s ease-out both; }
  .halo { transform-box: fill-box; transform-origin: center; opacity: 0; animation: halo 2.6s ease-out infinite; }

  @keyframes rise { from { opacity: 0; transform: translateY(14px); } }
  @keyframes roll { from { transform: translateY(0); } }
  @keyframes grow { from { transform: scaleY(0); } }
  @keyframes growx { from { transform: scaleX(0); } }
  @keyframes pop { from { opacity: 0; transform: scale(0.4); } }
  @keyframes float { 50% { transform: translateY(-3px); } }
  @keyframes pulse { 0% { opacity: 0.6; transform: scale(1); } 100% { opacity: 0; transform: scale(3.2); } }
  @keyframes slide { from { transform: translateX(-16px); } }
  @keyframes flick { 0%, 100% { transform: scale(1, 1); } 25% { transform: scale(0.94, 1.07); } 50% { transform: scale(1.04, 0.96); } 75% { transform: scale(0.97, 1.04); } }
  @keyframes drift { 50% { transform: translate(-80px, 60px); } }
  @keyframes wave { 0%, 60%, 100% { transform: rotate(0); } 10%, 30% { transform: rotate(16deg); } 20%, 40% { transform: rotate(-8deg); } }
  @keyframes twinkle { 0%, 100% { opacity: 0; } 8% { opacity: 0.6; } 18% { opacity: 0; } }
  @keyframes sweep { from { transform: translateX(-200px); } to { transform: translateX(1000px); } }
  @keyframes draw { from { stroke-dashoffset: 1; } }
  @keyframes fadein { from { opacity: 0; } }
  @keyframes halo { 0% { opacity: 0.6; transform: scale(1); } 100% { opacity: 0; transform: scale(2.6); } }
  @keyframes cycle {
    0% { opacity: 0; transform: translateY(12px); }
    ${n2(p * 0.12)}% { opacity: 1; transform: none; }
    ${n2(p * 0.88)}% { opacity: 1; transform: none; }
    ${n2(p)}% { opacity: 0; transform: translateY(-12px); }
    100% { opacity: 0; transform: translateY(-12px); }
  }
  @media (prefers-reduced-motion: reduce) { * { animation: none !important; } }
</style>`;
}

function render(data, t, icons) {
  uid = 0;
  const journey = data.years?.length > 0;
  const bottomY = ROW_Y[3] + (journey ? JOURNEY_H + GAP : 0);
  const H = bottomY + 150;
  const defs = `<defs>
  <radialGradient id="glow"><stop offset="0" stop-color="${t.glow}" stop-opacity="0.35"/><stop offset="1" stop-color="${t.glow}" stop-opacity="0"/></radialGradient>
  <linearGradient id="sweep"><stop offset="0" stop-color="${t.shine}" stop-opacity="0"/><stop offset="0.5" stop-color="${t.shine}" stop-opacity="0.06"/><stop offset="1" stop-color="${t.shine}" stop-opacity="0"/></linearGradient>
</defs>`;
  const desc = `Hi, I'm ${PROFILE.name}, ${PROFILE.role.toLowerCase()}. ${data.total} contributions in the last year.`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="t">
<title id="t">${esc(desc)}</title>
${style(t)}
${defs}
${helloTile(t)}
${contributionsTile(t, data)}
${streakTile(t, data)}
${buildingTile(t)}
${skylineTile(t, data)}
${journey ? journeyTile(t, data, ROW_Y[3]) : ""}
${stackTile(t, icons, bottomY)}
${languagesTile(t, data, bottomY)}
${statsTile(t, data, bottomY)}
</svg>
`;
}

// GitHub lets browsers keep images for 5 minutes. A new ?v= on every redraw
// gives each version its own address, so a fresh card shows up straight away.
async function bustCache(version) {
  const readme = new URL("../README.md", import.meta.url);
  const before = await readFile(readme, "utf8");
  const after = before.replace(/(bento-(?:dark|light)\.svg)(\?v=\w+)?/g, `$1?v=${version}`);
  if (after !== before) await writeFile(readme, after);
}

async function main() {
  const sample = process.argv.includes("--sample");
  const token = process.env.GITHUB_TOKEN;
  if (!sample && !token) throw new Error("Set GITHUB_TOKEN, or run with --sample for made-up data.");
  const data = sample ? sampleData() : await fetchData(PROFILE.login, token);
  const icons = JSON.parse(await readFile(new URL("./icons.json", import.meta.url), "utf8"));
  // --out <folder> writes a preview somewhere else and leaves the README alone.
  const outArg = process.argv.indexOf("--out");
  const out = outArg > -1 ? process.argv[outArg + 1] : "assets";
  const outDir = new URL(`../${out}/`, import.meta.url);
  await mkdir(outDir, { recursive: true });
  const hash = createHash("sha1");
  for (const [name, theme] of Object.entries(THEMES)) {
    const svg = render(data, theme, icons);
    hash.update(svg);
    await writeFile(new URL(`bento-${name}.svg`, outDir), svg);
  }
  if (!sample && out === "assets") await bustCache(hash.digest("hex").slice(0, 10));
  console.log(`bento: ${data.total} contributions, ${data.repos} repos${sample ? " (sample data)" : ""}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});

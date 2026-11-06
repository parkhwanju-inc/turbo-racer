"use strict";
/* ================================================================
   터보 레이서 - 클라이언트
   - 한 브라우저가 여러 대의 차를 맡을 수 있음:
       · 사람 (키보드를 나눠 씀, 화면 분할)  · 컴퓨터(AI)
   - 다른 기기(와이파이)의 차는 서버에서 받아서 보간해 그림
   - 등수/기록은 서버가 도착 순서와 서버 시각으로 결정 → SQLite 저장
   ================================================================ */

const COLORS = ["#ff4d4d", "#3d8bff", "#ffd23d", "#3ddc84", "#b26bff", "#ff8c2e", "#2ee6e6", "#ff6fcf"];
const MAX_PLAYERS = 8, MAX_LOCAL_HUMANS = 4;
const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------- 트랙
const CTRL = [
  [400, 1350], [400, 700], [520, 380], [800, 280], [1150, 330], [1350, 620],
  [1650, 850], [1950, 700], [2150, 420], [2550, 380], [2820, 620], [2800, 1100],
  [2550, 1450], [2150, 1560], [1800, 1400], [1450, 1520], [1100, 1760], [700, 1780], [460, 1620],
];
const SP = 12;           // 샘플 간격(px)
const ROAD = 95;         // 도로 반폭
const GRASS = 75;        // 도로 밖 잔디 폭 (그 너머는 벽)
const LIMIT = ROAD + GRASS;

const T = buildTrack();
const N = T.length;
const PADS = [0.17, 0.43, 0.7].map((f) => Math.round(N * f));
const TREES = makeTrees();
const BOUNDS = T.reduce((b, p) => ({
  x0: Math.min(b.x0, p.x), y0: Math.min(b.y0, p.y), x1: Math.max(b.x1, p.x), y1: Math.max(b.y1, p.y),
}), { x0: 1e9, y0: 1e9, x1: -1e9, y1: -1e9 });
const ROAD_PATH = (() => {
  const p = new Path2D();
  T.forEach((q, i) => (i ? p.lineTo(q.x, q.y) : p.moveTo(q.x, q.y)));
  p.closePath();
  return p;
})();

function buildTrack() {
  const raw = [], n = CTRL.length;
  for (let i = 0; i < n; i++) {
    const p0 = CTRL[(i - 1 + n) % n], p1 = CTRL[i], p2 = CTRL[(i + 1) % n], p3 = CTRL[(i + 2) % n];
    for (let s = 0; s < 24; s++) {
      const t = s / 24, t2 = t * t, t3 = t2 * t;
      const f = (a, b, c, d) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      raw.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])]);
    }
  }
  const out = [[raw[0][0], raw[0][1]]];
  let need = SP;
  for (let i = 0; i < raw.length; i++) {
    const a = raw[i], b = raw[(i + 1) % raw.length];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    let pos = 0;
    while (len - pos >= need) {
      pos += need;
      const t = pos / len;
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      need = SP;
    }
    need -= len - pos;
  }
  const last = out[out.length - 1];
  if (Math.hypot(last[0] - out[0][0], last[1] - out[0][1]) < SP / 2) out.pop();
  const m = out.length;
  return out.map((p, i) => {
    const a = out[(i - 1 + m) % m], b = out[(i + 1) % m];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const tx = (b[0] - a[0]) / l, ty = (b[1] - a[1]) / l;
    return { x: p[0], y: p[1], tx, ty, nx: -ty, ny: tx };
  });
}

function makeTrees() {
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const trees = [];
  for (let k = 0; k < 900 && trees.length < 170; k++) {
    const x = -300 + rnd() * 3500, y = -200 + rnd() * 2300;
    let best = 1e9;
    for (const q of T) best = Math.min(best, (q.x - x) ** 2 + (q.y - y) ** 2);
    if (Math.sqrt(best) > LIMIT + 50) trees.push({ x, y, r: 22 + rnd() * 22 });
  }
  return trees;
}

function nearest(x, y, guess, range = 30) {
  let bi = guess, bd = 1e18;
  for (let k = -range; k <= range; k++) {
    const i = (((guess + k) % N) + N) % N;
    const d = (T[i].x - x) ** 2 + (T[i].y - y) ** 2;
    if (d < bd) { bd = d; bi = i; }
  }
  const q = T[bi];
  return { i: bi, lat: (x - q.x) * q.nx + (y - q.y) * q.ny };
}

function gridPos(slot) {
  const row = Math.floor(slot / 2), col = slot % 2;
  const back = Math.round((60 + row * 75) / SP);
  const i = N - back;
  const q = T[i], lat = col ? 40 : -40;
  return { x: q.x + q.nx * lat, y: q.y + q.ny * lat, a: Math.atan2(q.ty, q.tx), i, back };
}

// ---------------------------------------------------------------- 조작키
const SCHEMES = {
  all:    { label: "방향키 / WASD", nlabel: "Space", up: ["ArrowUp", "KeyW"], down: ["ArrowDown", "KeyS"], left: ["ArrowLeft", "KeyA"], right: ["ArrowRight", "KeyD"], nitro: ["Space", "ShiftLeft", "ShiftRight"] },
  wasd:   { label: "W A S D",       nlabel: "Shift", up: ["KeyW"], down: ["KeyS"], left: ["KeyA"], right: ["KeyD"], nitro: ["ShiftLeft", "KeyQ", "Space"] },
  arrows: { label: "방향키",         nlabel: "Enter", up: ["ArrowUp"], down: ["ArrowDown"], left: ["ArrowLeft"], right: ["ArrowRight"], nitro: ["Enter", "ShiftRight", "Slash"] },
  ijkl:   { label: "I J K L",       nlabel: "U",     up: ["KeyI"], down: ["KeyK"], left: ["KeyJ"], right: ["KeyL"], nitro: ["KeyU", "KeyO"] },
  numpad: { label: "숫자패드 8 4 5 6", nlabel: "0",  up: ["Numpad8"], down: ["Numpad5", "Numpad2"], left: ["Numpad4"], right: ["Numpad6"], nitro: ["Numpad0", "NumpadEnter"] },
};
const SPLIT_ORDER = ["wasd", "arrows", "ijkl", "numpad"];
const GAME_CODES = new Set(Object.values(SCHEMES).flatMap((s) => [...s.up, ...s.down, ...s.left, ...s.right, ...s.nitro]));
const pressed = new Set();
const touchKeys = { up: false, down: false, left: false, right: false, nitro: false };

// ---------------------------------------------------------------- 난이도 / 옵션
const DIFF = {
  //        grip: 미끄러짐(클수록 착 붙음)  turn: 핸들  grass: 잔디 속도  wall: 벽에 닿아도 유지되는 속도
  //        assist: 자동 핸들 보조  charge: 부스터 1칸 차는 시간(초)  ai: 컴퓨터 실력
  easy:   { grip: 14, turn: 2.5, grass: 0.8, wall: 0.97, assist: 2.4, charge: 6,  start: 2, ai: [0.58, 0.68], aiNitro: 0.15 },
  normal: { grip: 10, turn: 2.7, grass: 0.6, wall: 0.9,  assist: 0.9, charge: 9,  start: 1, ai: [0.75, 0.87], aiNitro: 0.5 },
  hard:   { grip: 7,  turn: 2.9, grass: 0.4, wall: 0.8,  assist: 0,   charge: 12, start: 0, ai: [0.92, 1.00], aiNitro: 1 },
};
const diff = () => DIFF[(S && S.settings && S.settings.difficulty) || "easy"] || DIFF.easy;
const opts = (() => {
  let o = {};
  try { o = JSON.parse(localStorage.getItem("tr_opts")) || {}; } catch (e) { /* ignore */ }
  return { rotate: o.rotate !== false, autoGas: !!o.autoGas };
})();
function saveOpts() { try { localStorage.setItem("tr_opts", JSON.stringify(opts)); } catch (e) { /* ignore */ } }

// ? 상자 (먹으면 부스터 +1). 줄마다 3개, 먹으면 3초 뒤 다시 생김
const BOX_ROWS = [0.09, 0.32, 0.56, 0.84].map((f) => Math.round(N * f));
const BOXES = BOX_ROWS.flatMap((i) => [-55, 0, 55].map((lat) => ({
  x: T[i].x + T[i].nx * lat, y: T[i].y + T[i].ny * lat, back: 0,
})));
const MAX_CHARGES = 3;

// ---------------------------------------------------------------- 상태
// locals: 이 브라우저가 맡은 플레이어들 {id, token, ai, skill, lane, car, cam, ...}
// id -> 비밀 토큰. 로컬 목록에서 먼저 빠진 플레이어(나가기 버튼)도 leave 를 보낼 수 있게 따로 기억
const tokenOf = {};
let locals = loadLocals();
let myColor = localStorage.getItem("tr_color") || COLORS[Math.floor(Math.random() * COLORS.length)];
let S = null;
let offset = 0, bestRtt = 1e9;
let screen = "join";
let remotes = {};
let busy = false, lastPoll = 0;
let netGen = 0; // 나가기 때마다 올림. 나가기 전에 보낸 폴링 응답을 구분하는 데 씀

const serverNow = () => Date.now() / 1000 + offset;
const humans = () => locals.filter((l) => !l.ai);
const localOf = (id) => locals.find((l) => l.id === id);
const pinfo = (id) => (S ? S.players.find((p) => p.id === id) : null) || {};
function schemeOf(l) {
  const hs = humans();
  if (hs.length <= 1) return "all";
  return SPLIT_ORDER[hs.indexOf(l)] || "wasd";
}

function loadLocals() {
  try { return (JSON.parse(sessionStorage.getItem("tr_locals")) || []).map(newLocal); }
  catch (e) { return []; }
}
function saveLocals() {
  try { sessionStorage.setItem("tr_locals", JSON.stringify(locals.map((l) => ({ id: l.id, token: l.token, ai: l.ai })))); }
  catch (e) { /* ignore */ }
}
function newLocal(o) {
  if (o.token) tokenOf[o.id] = o.token;
  return { id: o.id, token: o.token, ai: !!o.ai, skill: 0.8 + Math.random() * 0.13, lane: (Math.random() - 0.5) * 70,
           car: null, cam: { x: 0, y: 0, z: 1 }, stuck: 0, rev: 0 };
}

// ---------------------------------------------------------------- 네트워크
// 응답 없이 멈춘 요청은 이 시간 뒤 끊는다. 안 끊으면 busy 가 안 풀려 폴링이 영원히 멈춤 (#11)
const API_TIMEOUT_MS = 4000;
function timeoutSignal() {
  if (AbortSignal.timeout) return AbortSignal.timeout(API_TIMEOUT_MS);
  const c = new AbortController();
  setTimeout(() => c.abort(), API_TIMEOUT_MS);
  return c.signal;
}

async function api(path, body) {
  const t0 = Date.now();
  if (body !== undefined) {
    // 이 브라우저가 맡은 플레이어들의 비밀 토큰 (서버가 쓰기 요청을 확인함)
    const tokens = {};
    for (const l of locals) if (l.token) tokens[l.id] = l.token;
    if (typeof body.id === "string" && tokenOf[body.id]) tokens[body.id] = tokenOf[body.id];
    body = Object.assign({}, body, { tokens });
  }
  const res = await fetch(path, body === undefined ? { signal: timeoutSignal() } : { signal: timeoutSignal(),
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  }).catch((e) => netError(e));
  const data = await res.json().catch((e) => netError(e, res)); // HTML 오류 페이지(502 등)도 한국어 안내로
  const t1 = Date.now();
  if (data && typeof data.now === "number") {
    const rtt = t1 - t0;
    if (rtt <= bestRtt * 1.3 + 5) {
      bestRtt = Math.min(bestRtt, rtt);
      offset = data.now - (t0 + t1) / 2000;
    }
  }
  if (!res.ok) throw Object.assign(new Error(data.error || "오류"), { status: res.status });
  return data;
}

// 네트워크 오류·JSON 이 아닌 응답을 "Failed to fetch" 같은 원문 대신 한국어 문구로 바꿔 던진다 (#24)
function netError(e, res) {
  let msg;
  if (e && (e.name === "TimeoutError" || e.name === "AbortError")) msg = "서버 응답이 너무 늦어요. 잠시 후 다시 해 주세요";
  else if (!res) msg = "서버에 연결할 수 없어요. 인터넷 연결을 확인해 주세요";
  else if (res.status >= 500) msg = "서버에 잠시 문제가 있어요 (오류 " + res.status + "). 잠시 후 다시 해 주세요";
  else msg = "서버 응답을 읽지 못했어요 (오류 " + res.status + ")";
  console.warn(e);
  throw Object.assign(new Error(msg), { status: res && !res.ok ? res.status : undefined });
}

async function netTick() {
  if (busy || screen === "join" || !locals.length) return;
  const now = Date.now();
  const racing = screen === "game" && S && S.phase === "racing";
  if (now - lastPoll < (racing ? 90 : 500)) return; // 레이스 중 약 100ms(30ms 틱이라 실제 ~93ms). 다른 차는 updateRemotes 가 보간 (#8)
  lastPoll = now;
  busy = true;
  try {
    const cars = racing ? locals.filter((l) => l.car && !l.car.finished).map((l) => ({
      id: l.id, x: +l.car.x.toFixed(1), y: +l.car.y.toFixed(1), a: +l.car.a.toFixed(3),
      v: +l.car.fwd.toFixed(1), progress: +(l.car.dist / N).toFixed(4), lap: l.car.lap,
    })) : [];
    const gen = netGen;
    const s = await api("/api/update", { ids: locals.map((l) => l.id), cars });
    if (gen === netGen) onState(s); // 그사이 나갔으면 옛 응답은 버림 (#18)
  } catch (e) {
    console.warn(e);
  } finally {
    busy = false;
  }
}
setInterval(netTick, 30);

// 서버 응답이 한동안 없으면 화면 위에 "다시 연결하는 중…" 표시 (#11)
let lastNetOk = Date.now();
const netMsg = document.body.appendChild(el("div", {
  textContent: "서버와 연결이 끊겼어요 · 다시 연결하는 중…",
  style: { display: "none", position: "fixed", top: "8px", left: "50%", transform: "translateX(-50%)", zIndex: 20,
           padding: "6px 14px", borderRadius: "8px", background: "rgba(0,0,0,.8)", color: "#ffd23d",
           font: "bold 14px sans-serif", pointerEvents: "none" },
}));
setInterval(() => {
  const down = screen !== "join" && locals.length > 0 && Date.now() - lastNetOk > 2500;
  netMsg.style.display = down ? "block" : "none";
}, 250);

function onState(s) {
  S = s;
  lastNetOk = Date.now();
  if (screen === "join") return;
  const ids = new Set(s.players.map((p) => p.id));
  const before = locals.length;
  locals = locals.filter((l) => ids.has(l.id));
  if (locals.length !== before) saveLocals();
  if (!humans().length) {
    for (const l of locals) api("/api/leave", { id: l.id }).catch(() => {});
    locals = [];
    saveLocals();
    show("join");
    $("joinErr").textContent = "연결이 끊겨 대기실에서 나왔어요. 다시 참가해 주세요.";
    return;
  }
  for (const p of s.players) {
    if (localOf(p.id)) continue;
    let r = remotes[p.id];
    const g = gridPos(p.slot);
    const started = p.progress > -1 || p.x !== 0;
    const tx = started ? p.x : g.x, ty = started ? p.y : g.y, ta = started ? p.a : g.a;
    if (!r) r = remotes[p.id] = { x: tx, y: ty, a: ta };
    Object.assign(r, { tx, ty, ta, tv: p.v, t: performance.now() });
  }
  for (const id in remotes) if (!ids.has(id) || localOf(id)) delete remotes[id];

  if (s.phase === "lobby") {
    // 다른 사람이 "다시 하기"를 눌러도 결과 화면은 내가 확인을 누를 때까지 둔다 (#21)
    if (screen === "results") showRoomBackNote();
    else {
      if (screen !== "lobby") show("lobby");
      renderLobby();
    }
  } else if (s.phase === "racing") {
    if (screen !== "game") startRace();
  } else if (s.phase === "finished") {
    if (screen !== "results") { show("results"); renderResults(); }
  }
}

// ---------------------------------------------------------------- 화면/공통
function show(name) {
  screen = name;
  document.querySelectorAll(".screen").forEach((e) => e.classList.toggle("active", e.id === name));
  if (name === "game") resize();
  if (name === "lobby") $("lobbyErr").textContent = "";
}

function el(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const k in props) {
    if (k === "style") Object.assign(e.style, props[k]);
    else e[k] = props[k];
  }
  for (const c of kids) if (c != null) e.append(c);
  return e;
}

function fmt(ms) {
  if (ms == null) return "-";
  const m = Math.floor(ms / 60000), s = (ms % 60000) / 1000;
  return m + ":" + s.toFixed(3).padStart(6, "0");
}

// ---------------------------------------------------------------- 참가
$("nameInput").value = localStorage.getItem("tr_name") || "";
function renderColors() {
  const box = $("colorPick");
  box.innerHTML = "";
  COLORS.forEach((c) => {
    const b = el("button", { className: c === myColor ? "sel" : "", style: { background: c }, title: c });
    b.onclick = () => { myColor = c; localStorage.setItem("tr_color", c); renderColors(); };
    box.append(b);
  });
}
renderColors();

async function addLocal(body) {
  const s = await api("/api/join", body);
  if (!localOf(s.me)) locals.push(newLocal({ id: s.me, token: s.token, ai: body.ai }));
  saveLocals();
  if (screen === "join") show("lobby");
  onState(s);
}

$("joinBtn").onclick = async () => {
  const name = $("nameInput").value.trim();
  if (!name) { $("joinErr").textContent = "닉네임을 입력해 주세요"; return; }
  localStorage.setItem("tr_name", name);
  $("joinErr").textContent = "";
  $("joinBtn").disabled = true;
  const wait = ++joinWait;
  try { await addLocal({ name, color: myColor }); }
  catch (e) {
    $("joinErr").textContent = e.message;
    if (e.status === 409) waitForLobby(wait, name);
  }
  $("joinBtn").disabled = false;
};

// 레이스 중이라 참가가 막히면(409) 방 상태를 보다가 대기실로 돌아오면 자동으로 참가한다 (#24).
// 참가하기를 다시 누르면 이전 대기는 멈춘다. 대기실인데도 409 면(방이 가득 참 등) 기다리지 않는다.
let joinWait = 0;
async function waitForLobby(wait, name) {
  let racing = false;
  for (;;) {
    let st = null;
    try { st = await api("/api/state"); } catch (e) { /* 잠깐 끊겨도 계속 기다림 */ }
    if (wait !== joinWait || screen !== "join") return;
    if (st && st.phase === "lobby") {
      if (!racing) return;
      $("joinBtn").disabled = true;
      try { await addLocal({ name, color: myColor }); $("joinErr").textContent = ""; return; }
      catch (e) {
        if (wait !== joinWait) return;
        $("joinErr").textContent = e.message;
        if (e.status !== 409) return;
        racing = false;
        continue;
      } finally { $("joinBtn").disabled = false; }
    }
    if (st) {
      racing = true;
      $("joinErr").textContent = "레이스가 진행 중이에요. 레이스가 끝나면 자동으로 참가해요";
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
}
$("nameInput").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.isComposing) $("joinBtn").click(); });

// ---------------------------------------------------------------- 대기실
function renderLobby() {
  const ul = $("lobbyList");
  const ps = [...S.players].sort((a, b) => a.slot - b.slot);
  const hs = humans();
  // 0.5초 폴링마다 목록을 새로 만들면 누르는 도중 ✕ 버튼이 바뀌어 클릭이 사라진다 (#19).
  // 목록에 보이는 값이 바뀌었을 때만 다시 그린다.
  const sig = JSON.stringify([ps.map((p) => [p.id, p.name, p.color, p.slot, p.ai]),
    locals.map((l) => [l.id, l.ai])]);
  if (ul.dataset.sig !== sig) {
    ul.dataset.sig = sig;
    ul.innerHTML = "";
    for (const p of ps) {
      const l = localOf(p.id);
      let tag;
      if (p.ai) tag = "🤖 컴퓨터";
      else if (l) tag = hs.length > 1 ? "⌨ " + SCHEMES[schemeOf(l)].label : "";
      else tag = "📶 다른 기기";
      const canRemove = l && (l.ai || hs.indexOf(l) > 0);
      ul.append(el("li", {},
        el("span", { className: "dot", style: { background: p.color } }),
        el("span", { textContent: p.name }),
        el("span", { className: "tag", textContent: tag }),
        l && !l.ai && hs.indexOf(l) === 0 ? el("span", { className: "me", textContent: "나" }) : null,
        canRemove ? el("button", { className: "x", textContent: "✕", title: "빼기",
          onclick: () => { const cur = localOf(p.id); if (cur) removeLocal(cur); } }) : null));
    }
  }
  $("lobbyCount").textContent = ps.length;
  $("addLocalBtn").disabled = hs.length >= MAX_LOCAL_HUMANS || ps.length >= MAX_PLAYERS;
  $("addBotBtn").disabled = ps.length >= MAX_PLAYERS;
  $("lobbyHint").textContent = hs.length > 1
    ? "한 PC 화면 분할 · 키보드를 나눠 써요 (키 배정은 목록 오른쪽)"
    : "혼자서도 OK! 방향키/WASD · 휴대폰은 화면 버튼 · 컴퓨터를 추가해 보세요";
  renderOptions();
}

function renderOptions() {
  const st = (S && S.settings) || { laps: 3, difficulty: "easy" };
  const mark = (id, v) => document.querySelectorAll("#" + id + " button")
    .forEach((b) => b.classList.toggle("sel", b.dataset.v === String(v)));
  mark("optDiff", st.difficulty);
  mark("optLaps", st.laps);
  mark("optCam", opts.rotate ? "rotate" : "fixed");
  mark("optAuto", opts.autoGas ? "on" : "off");
  $("lobbyLaps").textContent = st.laps;
}
// 시작/설정 요청은 한 번에 하나만 보내고, 오류는 alert 대신 대기실 안 문구로 보여 준다 (#20).
// alert 은 페이지를 멈춰서 카운트다운을 놓치고, 오래 두면 리타이어된다.
// 다른 사람이 먼저 시작해서 생긴 오류는 무시한다. 다음 폴링이 레이스 화면으로 데려간다.
const RACE_STARTED_ERRORS = new Set(["이미 시작했어요", "대기실에서만 바꿀 수 있어요"]);
let roomBusy = false;
async function roomAction(path, extra) {
  if (roomBusy || !humans().length) return;
  roomBusy = true;
  $("startBtn").disabled = true;
  $("lobbyErr").textContent = "";
  try { onState(await api(path, Object.assign({ id: humans()[0].id }, extra))); }
  catch (e) { if (!RACE_STARTED_ERRORS.has(e.message)) $("lobbyErr").textContent = e.message; }
  finally {
    roomBusy = false;
    $("startBtn").disabled = false;
  }
}
const setRoom = (change) => roomAction("/api/settings", change);
document.querySelectorAll("#optDiff button").forEach((b) => (b.onclick = () => setRoom({ difficulty: b.dataset.v })));
document.querySelectorAll("#optLaps button").forEach((b) => (b.onclick = () => setRoom({ laps: +b.dataset.v })));
document.querySelectorAll("#optCam button").forEach((b) => (b.onclick = () => { opts.rotate = b.dataset.v === "rotate"; saveOpts(); renderOptions(); }));
document.querySelectorAll("#optAuto button").forEach((b) => (b.onclick = () => { opts.autoGas = b.dataset.v === "on"; saveOpts(); renderOptions(); }));

async function removeLocal(l) {
  try { await api("/api/leave", { id: l.id }); } catch (e) { /* ignore */ }
  locals = locals.filter((x) => x !== l);
  saveLocals();
  if (S) { S.players = S.players.filter((p) => p.id !== l.id); renderLobby(); }
}

$("addLocalBtn").onclick = () => {
  $("addLocalForm").classList.toggle("open");
  $("localName").value = "";
  $("localName").focus();
};
$("localOk").onclick = async () => {
  const name = $("localName").value.trim() || "플레이어" + (humans().length + 1);
  $("addLocalForm").classList.remove("open");
  try { await addLocal({ name }); } catch (e) { alert(e.message); }
};
$("localName").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.isComposing) $("localOk").click(); });

$("addBotBtn").onclick = async () => {
  const names = new Set(S.players.map((p) => p.name));
  let k = 1;
  while (names.has("컴퓨터" + k)) k++;
  try { await addLocal({ name: "컴퓨터" + k, ai: true }); } catch (e) { alert(e.message); }
};

$("startBtn").onclick = () => roomAction("/api/start", {});
// 대기실·레이스·결과 화면의 나가기가 모두 이걸 쓴다.
function leaveRoom() {
  // 화면과 로컬 상태를 먼저 정리한다. leave 응답을 기다리는 동안 폴링 응답이 먼저 오면
  // onState 가 "우리 플레이어가 사라졌다"고 보고 연결 끊김 오류를 띄우기 때문 (#18).
  // join 화면에서는 netTick 이 멈추고 onState 도 화면을 바꾸지 않는다.
  const leaving = locals;
  netGen++;
  locals = [];
  saveLocals();
  pressed.clear();
  show("join");
  $("joinErr").textContent = "";
  for (const l of leaving) api("/api/leave", { id: l.id }).catch(() => {});
}
$("leaveBtn").onclick = leaveRoom;
$("resultLeaveBtn").onclick = leaveRoom;

// 레이스 중에는 실수로 눌러 리타이어되지 않게 한 번 더 눌러야 나간다 (#23).
// confirm() 은 페이지를 멈춰서(#20 과 같은 문제) 쓰지 않는다.
const GAME_LEAVE_TEXT = "✕ 나가기";
let gameLeaveArmedAt = -1e9;
$("gameLeaveBtn").onclick = (e) => {
  const b = e.currentTarget;
  b.blur(); // 포커스가 남으면 Space/Enter(부스터 키)가 버튼을 다시 누른다
  const racing = S && S.phase === "racing" && locals.some((l) => l.car && !l.car.finished);
  if (racing && performance.now() - gameLeaveArmedAt > 3000) {
    gameLeaveArmedAt = performance.now();
    b.textContent = "한 번 더 누르면 리타이어";
    setTimeout(() => { if (performance.now() - gameLeaveArmedAt >= 3000) b.textContent = GAME_LEAVE_TEXT; }, 3000);
    return;
  }
  gameLeaveArmedAt = -1e9;
  b.textContent = GAME_LEAVE_TEXT;
  leaveRoom();
};

// ---------------------------------------------------------------- 결과
function renderResults() {
  $("resultNote").textContent = "";
  $("againBtn").textContent = "다시 하기";
  const rs = S.results || [];
  const nm = (r) => (r.ai ? "🤖 " : "") + r.name;
  const pod = $("podium");
  pod.innerHTML = "";
  [2, 1, 3].forEach((rank) => {
    const r = rs.find((x) => x.rank === rank);
    if (!r) { pod.append(el("div", { className: "pod" })); return; }
    pod.append(el("div", { className: "pod p" + rank },
      el("div", { className: "name", textContent: nm(r) }),
      el("div", { className: "car", style: { background: r.color } }),
      el("div", { className: "block" }, String(rank), el("div", { className: "t", textContent: fmt(r.time_ms) }))));
  });
  const tb = $("resultRows");
  tb.innerHTML = "";
  rs.forEach((r) => {
    tb.append(el("tr", {},
      el("td", { textContent: r.finished ? r.rank + "등" : "리타이어" }),
      el("td", {}, el("span", { className: "sw", style: { background: r.color } }), nm(r)),
      el("td", { textContent: fmt(r.time_ms) })));
  });
}
function showRoomBackNote() {
  $("resultNote").textContent = "다른 사람이 '다시 하기'를 눌러 방이 대기실로 돌아갔어요. 그사이 누가 레이스를 시작하면 함께 출발해요.";
  $("againBtn").textContent = "확인";
}
$("againBtn").onclick = async () => {
  if (S && S.phase === "finished") {
    let s;
    try { s = await api("/api/reset", { id: humans()[0].id }); } catch (e) { alert(e.message); return; }
    if (screen !== "results") return; // 기다리는 사이 다른 화면으로 넘어갔으면 그대로 둔다
    show("lobby");
    onState(s);
  } else if (S && S.phase === "lobby") {
    show("lobby"); // 이미 대기실로 돌아간 방: 내 화면만 넘긴다
    renderLobby();
  }
};

// 명예의 전당
document.querySelectorAll("[data-show-board]").forEach((b) => (b.onclick = openBoard));
$("boardClose").onclick = () => $("board").classList.remove("active");
async function openBoard() {
  $("board").classList.add("active");
  $("boardTotal").textContent = "불러오는 중…";
  $("bestRows").innerHTML = "";
  $("winRows").innerHTML = "";
  let d;
  try { d = await api("/api/leaderboard?laps=" + ((S && S.laps) || 3)); }
  catch (e) { $("boardTotal").textContent = "명예의 전당을 불러오지 못했어요. " + e.message; return; }
  $("boardTotal").textContent = "지금까지 " + d.total_races + "번의 레이스 (컴퓨터 기록은 제외)";
  $("bestRows").closest("div").querySelector("h3").textContent = "최고 기록 TOP 10 (" + d.laps + "바퀴 기준)";
  const b = $("bestRows"); b.innerHTML = "";
  d.best.forEach((r, i) => b.append(el("tr", {},
    el("td", { textContent: i + 1 }),
    el("td", {}, el("span", { className: "sw", style: { background: r.color } }), r.player_name),
    el("td", { textContent: fmt(r.time_ms) }))));
  if (!d.best.length) b.append(el("tr", {}, el("td", { colSpan: 3, textContent: "아직 기록이 없어요" })));
  const w = $("winRows"); w.innerHTML = "";
  d.wins.forEach((r) => w.append(el("tr", {},
    el("td", { textContent: r.player_name }), el("td", { textContent: r.gold }),
    el("td", { textContent: r.silver }), el("td", { textContent: r.bronze }), el("td", { textContent: r.races }))));
}

// ---------------------------------------------------------------- 레이스
function startRace() {
  const D = diff();
  for (const l of locals) {
    const p = pinfo(l.id);
    const g = gridPos(p.slot || 0);
    l.car = { x: g.x, y: g.y, a: g.a, vx: 0, vy: 0, fwd: 0, idx: g.i, dist: -g.back, lap: 0, lat: 0,
              steer: 0, boost: 0, boostMax: 1, grass: false, finished: false, rank: null, err: null,
              charges: D.start, gauge: 0, nitroHeld: false, pops: [] };
    // 레이스 도중 새로고침: 서버에 남은 내 위치·진행도로 이어서 달림 (완주했으면 완주 상태로)
    if (serverNow() > S.start_at && p.progress > -1 && (p.x || p.y)) {
      const c = l.car;
      let dist = Math.round(p.progress * N);
      const guess = ((dist % N) + N) % N;
      const n = nearest(p.x, p.y, guess);
      let d = n.i - guess;
      if (d > N / 2) d -= N;
      if (d < -N / 2) d += N;
      dist += d;
      Object.assign(c, { x: p.x, y: p.y, a: p.a, idx: n.i, lat: n.lat, dist,
                         lap: Math.max(0, Math.floor(dist / N)), grass: Math.abs(n.lat) > ROAD });
      if (p.rank) { c.finished = true; c.rank = p.rank; }
    }
    l.cam = { x: l.car.x, y: l.car.y, z: 1, a: l.car.a };
    l.stuck = 0; l.rev = 0;
    l.skill = D.ai[0] + Math.random() * (D.ai[1] - D.ai[0]);
  }
  for (const b of BOXES) b.back = 0;
  show("game");
}

function humanInput(l) {
  const sc = SCHEMES[schemeOf(l)];
  const first = humans()[0] === l;
  const f = (k) => sc[k].some((c) => pressed.has(c)) || (first && touchKeys[k]);
  const down = f("down");
  return { up: f("up") || (opts.autoGas && !down), down, left: f("left"), right: f("right"), nitro: f("nitro") };
}

function pop(car, text) { car.pops.push({ text, t: performance.now() }); }

function useNitro(car) {
  if (car.charges <= 0 || car.finished) return;
  car.charges--;
  car.boost = car.boostMax = 1.6;
  pop(car, "부스터!");
}

function aiInput(l, dt) {
  const c = l.car;
  const look = 8 + Math.round(Math.max(0, c.fwd) / 55);
  const q = T[(c.idx + look) % N];
  const tx = q.x + q.nx * l.lane, ty = q.y + q.ny * l.lane;
  let d = Math.atan2(ty - c.y, tx - c.x) - c.a;
  d = Math.atan2(Math.sin(d), Math.cos(d));
  if (serverNow() >= S.start_at + 1 && !c.finished) {
    l.stuck = Math.abs(c.fwd) < 25 ? l.stuck + dt : 0;
    if (l.stuck > 1.2) { l.rev = 0.7; l.stuck = 0; }
  }
  if (l.rev > 0) { l.rev -= dt; return { up: false, down: true, left: d > 0, right: d < 0 }; }
  const sharp = Math.abs(d) > 0.7;
  return { up: c.fwd < MAXV * l.skill && !(sharp && c.fwd > 300), down: sharp && c.fwd > 380,
           left: d < -0.05, right: d > 0.05,
           nitro: c.charges > 0 && Math.abs(d) < 0.12 && c.fwd > 300 && Math.random() < dt * diff().aiNitro };
}

const ACC = 430, BRAKE = 800, REV = 160, MAXV = 540;

// 매 프레임 1번: 부스터 키(누른 순간만), 게이지 충전
function control(l, inp, dt) {
  const car = l.car, D = diff();
  const racing = serverNow() >= S.start_at && !car.finished;
  if (inp.nitro && !car.nitroHeld && racing) useNitro(car);
  car.nitroHeld = !!inp.nitro;
  if (racing && car.charges < MAX_CHARGES) {
    car.gauge += dt / D.charge;
    if (car.gauge >= 1) { car.gauge = 0; car.charges++; pop(car, "⚡ +1"); }
  }
}

function physics(l, inp, dt) {
  const car = l.car, D = diff();
  const started = serverNow() >= S.start_at;
  const ctl = started && !car.finished;
  const ca = Math.cos(car.a), sa = Math.sin(car.a);
  let fwd = car.vx * ca + car.vy * sa;
  let side = -car.vx * sa + car.vy * ca;

  const boosting = car.boost > 0;
  car.boost = Math.max(0, car.boost - dt);
  const maxv = boosting ? MAXV * 1.45 : car.grass ? MAXV * D.grass : MAXV;

  if (ctl && inp.up) fwd += (boosting ? ACC * 2 : ACC) * dt;
  else if (ctl && inp.down) fwd -= (fwd > 0 ? BRAKE : ACC * 0.6) * dt;
  else fwd -= fwd * Math.min(1, 0.9 * dt);
  if (boosting && ctl) fwd = Math.max(fwd, MAXV * 1.2);
  if (fwd > maxv) fwd -= (fwd - maxv) * Math.min(1, 3 * dt);
  if (fwd < -REV) fwd = -REV;
  side -= side * Math.min(1, D.grip * dt);

  // 핸들: 부드럽게 꺾이고, 빠를수록 살짝 덜 꺾임
  const want = ctl ? (inp.right ? 1 : 0) - (inp.left ? 1 : 0) : 0;
  car.steer += (want - car.steer) * Math.min(1, dt * 9);
  const k = Math.max(-1, Math.min(1, fwd / 160)) * (1 - 0.25 * Math.min(1, Math.abs(fwd) / MAXV));
  car.a += car.steer * D.turn * dt * k;

  // 자동 핸들 보조: 길 가장자리로 가면 도로 쪽으로 살짝 돌려줌 (핸들 안 꺾을 때만)
  if (ctl && D.assist && want === 0 && fwd > 60) {
    const q0 = T[car.idx];
    const along = Math.atan2(q0.ty, q0.tx);
    const edge = Math.max(0, Math.min(1, (Math.abs(car.lat) - ROAD * 0.45) / ROAD));
    const target = along - Math.sign(car.lat) * 0.5 * edge;
    let da = target - car.a;
    da = Math.atan2(Math.sin(da), Math.cos(da));
    if (Math.abs(da) < 1.3) car.a += da * Math.min(1, D.assist * dt) * (0.35 + edge);
  }

  const c2 = Math.cos(car.a), s2 = Math.sin(car.a);
  car.vx = fwd * c2 - side * s2;
  car.vy = fwd * s2 + side * c2;
  car.x += car.vx * dt;
  car.y += car.vy * dt;

  // 벽: 쉬움일수록 미끄러지듯 따라가고 속도를 덜 잃음
  const n = nearest(car.x, car.y, car.idx);
  const q = T[n.i];
  if (Math.abs(n.lat) > LIMIT) {
    const over = Math.abs(n.lat) - LIMIT, sg = Math.sign(n.lat);
    car.x -= q.nx * over * sg;
    car.y -= q.ny * over * sg;
    const vn = car.vx * q.nx + car.vy * q.ny;
    if (vn * sg > 0) { car.vx -= q.nx * vn * 1.15; car.vy -= q.ny * vn * 1.15; }
    const keep = Math.pow(D.wall, dt * 60);
    car.vx *= keep; car.vy *= keep;
    if (D.assist) {   // 벽에 박으면 길 방향으로 차를 돌려줌
      let da = Math.atan2(q.ty, q.tx) - car.a;
      da = Math.atan2(Math.sin(da), Math.cos(da));
      if (Math.abs(da) < 1.4) car.a += da * Math.min(1, dt * 4);
    }
  }
  car.lat = n.lat;
  car.grass = Math.abs(n.lat) > ROAD;

  // ? 상자
  if (ctl) {
    const now = performance.now();
    for (const b of BOXES) {
      if (b.back > now) continue;
      if ((car.x - b.x) ** 2 + (car.y - b.y) ** 2 < 36 * 36) {
        b.back = now + 3000;
        if (car.charges < MAX_CHARGES) { car.charges++; pop(car, "⚡ 부스터 +1"); }
        else { car.boost = car.boostMax = 0.8; pop(car, "가득! 바로 부스터"); }
      }
    }
  }

  // 진행도 (역주행하면 줄어듦)
  let d = n.i - car.idx;
  if (d > N / 2) d -= N;
  if (d < -N / 2) d += N;
  car.dist += d;
  car.idx = n.i;
  car.lap = Math.max(0, Math.floor(car.dist / N));

  // 부스터
  if (ctl) for (const pi of PADS) {
    let dd = Math.abs(n.i - pi); dd = Math.min(dd, N - dd);
    if (dd <= 3 && Math.abs(n.lat) < 45) {
      if (car.boost < 0.5) pop(car, "부스트 패드!");
      car.boost = Math.max(car.boost, 1.1); car.boostMax = Math.max(car.boost, 1.1);
    }
  }

  // 다른 차와 부딪힘 (리타이어·완주한 차는 멈춰 있으므로 통과)
  const others = Object.keys(remotes).filter((id) => { const p = pinfo(id); return !p.dnf && !p.rank; })
    .map((id) => remotes[id])
    .concat(locals.filter((o) => o !== l && o.car && !o.car.finished).map((o) => o.car));
  for (const r of others) {
    const dx = car.x - r.x, dy = car.y - r.y, dl = Math.hypot(dx, dy);
    if (dl > 0.01 && dl < 36) {
      const push = (36 - dl) * (r.vx !== undefined ? 0.5 : 1);
      car.x += (dx / dl) * push; car.y += (dy / dl) * push;
      const vn = car.vx * dx / dl + car.vy * dy / dl;
      if (vn < 0) { car.vx -= (dx / dl) * vn * 1.3; car.vy -= (dy / dl) * vn * 1.3; }
    }
  }
  car.fwd = car.vx * Math.cos(car.a) + car.vy * Math.sin(car.a);

  // 완주 → 서버가 등수 결정
  if (!car.finished && car.dist >= S.laps * N) {
    car.finished = true;
    sendFinish(l, car, { id: l.id, lap: S.laps, progress: car.dist / N });
  }
}

// 완주 전송. 네트워크 오류·타임아웃·5xx 면 될 때까지 다시 보낸다 (#5).
// 서버는 이미 등수가 있으면 200 을 주므로 여러 번 보내도 안전. 4xx(거절)는 다시 보내지 않음.
function sendFinish(l, car, body, tries = 0) {
  api("/api/finish", body)
    .then((s) => { car.err = null; const me = s.players.find((p) => p.id === l.id); if (me) car.rank = me.rank; onState(s); })
    .catch((e) => {
      const me = pinfo(l.id);
      if (car.rank || me.rank) { car.err = null; car.rank = car.rank || me.rank; return; } // 그사이 폴링으로 등수를 받음
      const rejected = e.status >= 400 && e.status < 500;
      if (rejected || l.car !== car || !localOf(l.id) || !S || S.phase !== "racing") { car.err = e.message; return; }
      car.err = "기록 전송 중… (연결을 다시 시도하고 있어요)";
      setTimeout(() => sendFinish(l, car, body, tries + 1), Math.min(3000, 300 * 2 ** tries));
    });
}

function updateRemotes(dt) {
  const now = performance.now();
  for (const id in remotes) {
    const r = remotes[id];
    if (r.tx === undefined) continue;
    const age = Math.min(0.25, (now - r.t) / 1000);
    const ex = r.tx + Math.cos(r.ta) * (r.tv || 0) * age;
    const ey = r.ty + Math.sin(r.ta) * (r.tv || 0) * age;
    const k = Math.min(1, dt * 12);
    if (Math.hypot(ex - r.x, ey - r.y) > 300) { r.x = ex; r.y = ey; r.a = r.ta; }
    r.x += (ex - r.x) * k;
    r.y += (ey - r.y) * k;
    let da = r.ta - r.a;
    da = Math.atan2(Math.sin(da), Math.cos(da));
    r.a += da * k;
  }
}

function standings() {
  return S.players.map((p) => {
    const l = localOf(p.id);
    return { id: p.id, name: p.name, color: p.color, rank: p.rank, dnf: p.dnf, ai: p.ai,
             prog: l && l.car ? l.car.dist / N : p.progress };
  }).sort((a, b) => {
    if (a.rank && b.rank) return a.rank - b.rank;
    if (a.rank) return -1;
    if (b.rank) return 1;
    return b.prog - a.prog;
  });
}

// ---------------------------------------------------------------- 그리기
const cv = $("cv"), ctx = cv.getContext("2d");
let W = 0, H = 0, DPR = 1;
let VIEW_ROT = 0, FRAME_DT = 1 / 60;
function resize() {
  DPR = Math.min(2, window.devicePixelRatio || 1);
  W = cv.clientWidth; H = cv.clientHeight;
  cv.width = W * DPR; cv.height = H * DPR;
}
window.addEventListener("resize", resize);

function layout() {
  const hs = humans(), n = hs.length;
  if (n <= 1) return [{ x: 0, y: 0, w: W, h: H, l: hs[0] }];
  if (n === 2) {
    return W >= H
      ? [{ x: 0, y: 0, w: W / 2, h: H, l: hs[0] }, { x: W / 2, y: 0, w: W / 2, h: H, l: hs[1] }]
      : [{ x: 0, y: 0, w: W, h: H / 2, l: hs[0] }, { x: 0, y: H / 2, w: W, h: H / 2, l: hs[1] }];
  }
  const w = W / 2, h = H / 2;
  return hs.map((l, i) => ({ x: (i % 2) * w, y: Math.floor(i / 2) * h, w, h, l }));
}

function drawAll() {
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  const vps = layout();
  for (const vp of vps) drawView(vp);
  const n = vps.length;
  // 화면 분할선
  ctx.fillStyle = "#111";
  if (n === 2) { if (W >= H) ctx.fillRect(W / 2 - 2, 0, 4, H); else ctx.fillRect(0, H / 2 - 2, W, 4); }
  if (n >= 3) { ctx.fillRect(W / 2 - 2, 0, 4, H); ctx.fillRect(0, H / 2 - 2, W, 4); }
  // 미니맵
  if (n === 3) {
    ctx.fillStyle = "#16233f"; ctx.fillRect(W / 2 + 2, H / 2 + 2, W / 2 - 2, H / 2 - 2);
    drawMap(W / 2 + 20, H / 2 + 20, W / 2 - 40, H / 2 - 40);
  } else {
    const size = n === 1 ? Math.min(170, W * 0.32) : Math.min(150, W * 0.22);
    const bh = size * (BOUNDS.y1 - BOUNDS.y0) / (BOUNDS.x1 - BOUNDS.x0);
    // 터치(혼자)에선 HUD 가 화면 위쪽(12~58px)에 있으므로 그 아래에 그림 (순위표도 CSS 로 같이 내림)
    const top = n === 1 && document.body.classList.contains("touch") ? 74 : 16;
    if (n === 1) drawMap(W - size - 16, top, size, bh);
    else if (n === 2 && W >= H) drawMap(W / 2 - size / 2, 16, size, bh);
    else drawMap(W / 2 - size / 2, H / 2 - bh / 2, size, bh);
  }
}

function drawView(vp) {
  const l = vp.l, car = l.car, cam = l.cam;
  ctx.save();
  ctx.beginPath(); ctx.rect(vp.x, vp.y, vp.w, vp.h); ctx.clip();
  ctx.fillStyle = "#2c7a3f";
  ctx.fillRect(vp.x, vp.y, vp.w, vp.h);

  // 카메라 (프레임 속도와 상관없이 부드럽게 따라감)
  const dt = FRAME_DT;
  const ease = (rate) => 1 - Math.exp(-rate * dt);
  const base = Math.max(0.36, Math.min(1.2, Math.min(vp.w, vp.h) / 720));
  const spd = Math.hypot(car.vx, car.vy);
  const tz = base * (1 - Math.min(0.22, spd / 3000)) * (car.boost > 0 ? 0.92 : 1);
  cam.z += (tz - cam.z) * ease(3);
  if (opts.rotate) {
    let da = car.a - cam.a;
    da = Math.atan2(Math.sin(da), Math.cos(da));
    cam.a += da * ease(5);
    cam.x += (car.x + car.vx * 0.12 - cam.x) * ease(14);
    cam.y += (car.y + car.vy * 0.12 - cam.y) * ease(14);
    VIEW_ROT = -cam.a - Math.PI / 2;
    ctx.translate(vp.x + vp.w / 2, vp.y + vp.h * 0.64);
  } else {
    cam.x += (car.x + car.vx * 0.35 - cam.x) * ease(8);
    cam.y += (car.y + car.vy * 0.35 - cam.y) * ease(8);
    VIEW_ROT = 0;
    ctx.translate(vp.x + vp.w / 2, vp.y + vp.h / 2);
  }
  ctx.scale(cam.z, cam.z);
  ctx.rotate(VIEW_ROT);
  ctx.translate(-cam.x, -cam.y);

  const vr = Math.hypot(vp.w, vp.h) / cam.z + 60;
  for (const t of TREES) {
    if (Math.abs(t.x - cam.x) > vr || Math.abs(t.y - cam.y) > vr) continue;
    ctx.fillStyle = "#1d5c2c";
    ctx.beginPath(); ctx.arc(t.x + 6, t.y + 8, t.r, 0, 7); ctx.fill();
    ctx.fillStyle = "#3a9a4a";
    ctx.beginPath(); ctx.arc(t.x, t.y, t.r, 0, 7); ctx.fill();
    ctx.fillStyle = "#58b862";
    ctx.beginPath(); ctx.arc(t.x - t.r * 0.3, t.y - t.r * 0.3, t.r * 0.45, 0, 7); ctx.fill();
  }

  ctx.lineJoin = "round"; ctx.lineCap = "round";
  ctx.lineWidth = LIMIT * 2 + 24; ctx.strokeStyle = "#d8dde6"; ctx.stroke(ROAD_PATH);
  ctx.strokeStyle = "#ff5a5a"; ctx.setLineDash([40, 40]); ctx.stroke(ROAD_PATH);
  ctx.setLineDash([]);
  ctx.lineWidth = LIMIT * 2; ctx.strokeStyle = "#5cbf5f"; ctx.stroke(ROAD_PATH);
  ctx.lineWidth = ROAD * 2 + 16; ctx.strokeStyle = "#ffffff"; ctx.stroke(ROAD_PATH);
  ctx.strokeStyle = "#e33"; ctx.setLineDash([24, 24]); ctx.stroke(ROAD_PATH);
  ctx.setLineDash([]);
  ctx.lineWidth = ROAD * 2; ctx.strokeStyle = "#4a4f5c"; ctx.stroke(ROAD_PATH);
  ctx.lineWidth = 4; ctx.strokeStyle = "rgba(255,255,255,.35)"; ctx.setLineDash([30, 40]); ctx.stroke(ROAD_PATH);
  ctx.setLineDash([]);

  for (let s = 0; s < MAX_PLAYERS; s++) {
    const g = gridPos(s);
    ctx.save(); ctx.translate(g.x, g.y); ctx.rotate(g.a);
    ctx.strokeStyle = "rgba(255,255,255,.6)"; ctx.lineWidth = 3;
    ctx.strokeRect(-26, -18, 52, 36);
    ctx.restore();
  }

  const f = T[0];
  ctx.save(); ctx.translate(f.x, f.y); ctx.rotate(Math.atan2(f.ty, f.tx));
  const cell = ROAD * 2 / 10;
  for (let r = 0; r < 2; r++) for (let c = 0; c < 10; c++) {
    ctx.fillStyle = (r + c) % 2 ? "#111" : "#fff";
    ctx.fillRect(-cell + r * cell, -ROAD + c * cell, cell, cell);
  }
  ctx.restore();

  const blink = (performance.now() / 300) % 1;
  for (const pi of PADS) {
    const q = T[pi];
    ctx.save(); ctx.translate(q.x, q.y); ctx.rotate(Math.atan2(q.ty, q.tx));
    ctx.fillStyle = "#1f2a8a"; ctx.fillRect(-36, -42, 72, 84);
    for (let k = 0; k < 3; k++) {
      ctx.fillStyle = (k / 3 + blink) % 1 < 0.5 ? "#ffd23d" : "#ff9f1a";
      ctx.beginPath();
      const ox = -24 + k * 18;
      ctx.moveTo(ox, -28); ctx.lineTo(ox + 18, 0); ctx.lineTo(ox, 28); ctx.lineTo(ox + 8, 0);
      ctx.fill();
    }
    ctx.restore();
  }

  // ? 상자
  const tnow = performance.now();
  for (const b of BOXES) {
    if (b.back > tnow) continue;
    ctx.save(); ctx.translate(b.x, b.y + Math.sin(tnow / 250 + b.x) * 3); ctx.rotate(tnow / 600);
    ctx.fillStyle = "rgba(0,0,0,.25)"; rr(-14, -10, 30, 30, 6); ctx.fill();
    ctx.fillStyle = "hsl(" + ((tnow / 8 + b.x) % 360) + ",90%,60%)"; rr(-16, -16, 32, 32, 7); ctx.fill();
    ctx.strokeStyle = "#fff"; ctx.lineWidth = 3; ctx.stroke();
    ctx.rotate(-tnow / 600 - VIEW_ROT);
    ctx.fillStyle = "#fff"; ctx.font = "bold 22px sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText("?", 0, 1);
    ctx.textBaseline = "alphabetic";
    ctx.restore();
  }

  // 차들 (이 화면의 주인 차를 맨 위에)
  const single = humans().length === 1;
  for (const id in remotes) {
    const r = remotes[id], p = pinfo(id);
    drawCar(r.x, r.y, r.a, p.color, (p.ai ? "🤖" : "") + (p.name || ""), false, p.dnf, false, cam.z);
  }
  for (const o of locals) {
    if (o === l || !o.car) continue;
    const p = pinfo(o.id);
    drawCar(o.car.x, o.car.y, o.car.a, p.color, (o.ai ? "🤖" : "") + (p.name || ""), !o.ai, false, o.car.boost > 0, cam.z);
  }
  const me = pinfo(l.id);
  drawCar(car.x, car.y, car.a, me.color || myColor, single ? "나" : me.name || "", true, false, car.boost > 0, cam.z);

  // 떠오르는 글자 (부스터 +1 등)
  car.pops = car.pops.filter((p) => tnow - p.t < 1100);
  for (const p of car.pops) {
    const age = (tnow - p.t) / 1100;
    ctx.save(); ctx.translate(car.x, car.y); ctx.rotate(-VIEW_ROT);
    ctx.globalAlpha = 1 - age;
    ctx.font = "bold " + (20 / Math.max(0.6, cam.z)) + "px sans-serif"; ctx.textAlign = "center";
    ctx.lineWidth = 5; ctx.strokeStyle = "rgba(0,0,0,.7)";
    ctx.strokeText(p.text, 0, -55 - age * 50);
    ctx.fillStyle = "#ffe14d"; ctx.fillText(p.text, 0, -55 - age * 50);
    ctx.restore();
  }
  ctx.restore();

  // 부스터 속도선
  if (car.boost > 0) {
    ctx.save();
    ctx.beginPath(); ctx.rect(vp.x, vp.y, vp.w, vp.h); ctx.clip();
    const cx = vp.x + vp.w / 2, cy = vp.y + vp.h / 2;
    ctx.strokeStyle = "rgba(255,255,255," + (0.25 * Math.min(1, car.boost * 2)) + ")";
    ctx.lineWidth = 2;
    for (let i = 0; i < 26; i++) {
      const ang = Math.random() * Math.PI * 2, r0 = Math.min(vp.w, vp.h) * (0.35 + Math.random() * 0.2);
      const r1 = r0 + 40 + Math.random() * 80;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(ang) * r0, cy + Math.sin(ang) * r0);
      ctx.lineTo(cx + Math.cos(ang) * r1, cy + Math.sin(ang) * r1);
      ctx.stroke();
    }
    ctx.restore();
  }
  drawHud(vp, l);
}

function drawCar(x, y, a, color, name, isMine, ghost, boost, z) {
  ctx.save();
  ctx.translate(x, y);
  ctx.globalAlpha = ghost ? 0.35 : 1;
  ctx.save();
  ctx.rotate(a);
  if (boost) {
    const len = 30 + Math.random() * 22;
    ctx.fillStyle = "rgba(255,120,30,.9)";
    ctx.beginPath(); ctx.moveTo(-22, -10); ctx.lineTo(-22 - len, 0); ctx.lineTo(-22, 10); ctx.fill();
    ctx.fillStyle = "rgba(255,240,120,.95)";
    ctx.beginPath(); ctx.moveTo(-22, -5); ctx.lineTo(-22 - len * 0.55, 0); ctx.lineTo(-22, 5); ctx.fill();
  }
  ctx.fillStyle = "rgba(0,0,0,.3)"; rr(-22, -11, 48, 28, 8); ctx.fill();
  ctx.fillStyle = "#111";
  [[-15, -15], [9, -15], [-15, 10], [9, 10]].forEach(([wx, wy]) => ctx.fillRect(wx, wy, 11, 5));
  ctx.fillStyle = color || "#ccc"; rr(-24, -12, 48, 24, 8); ctx.fill();
  ctx.strokeStyle = "rgba(0,0,0,.45)"; ctx.lineWidth = 2; ctx.stroke();
  ctx.fillStyle = "rgba(20,30,60,.85)"; rr(2, -9, 11, 18, 3); ctx.fill();
  ctx.fillStyle = "rgba(255,255,255,.35)"; ctx.fillRect(-18, -2, 16, 4);
  ctx.fillStyle = "#fff8b0"; ctx.fillRect(21, -10, 3, 5); ctx.fillRect(21, 5, 3, 5);
  ctx.restore();
  ctx.rotate(-VIEW_ROT);
  ctx.font = "bold " + (14 / Math.max(0.6, z)) + "px sans-serif";
  ctx.textAlign = "center";
  ctx.lineWidth = 4; ctx.strokeStyle = "rgba(0,0,0,.7)";
  ctx.strokeText(name, 0, -30);
  ctx.fillStyle = isMine ? "#ffd23d" : "#fff";
  ctx.fillText(name, 0, -30);
  ctx.restore();
}

function rr(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}

function drawMap(x, y, w, h) {
  const bw = BOUNDS.x1 - BOUNDS.x0, bh = BOUNDS.y1 - BOUNDS.y0;
  const s = Math.min(w / bw, h / bh);
  const ox = x + (w - bw * s) / 2, oy = y + (h - bh * s) / 2;
  ctx.fillStyle = "rgba(0,0,0,.45)";
  ctx.fillRect(ox - 10, oy - 10, bw * s + 20, bh * s + 20);
  ctx.save();
  ctx.translate(ox - BOUNDS.x0 * s, oy - BOUNDS.y0 * s);
  ctx.scale(s, s);
  ctx.lineWidth = Math.max(6, 120 * s) / s; ctx.strokeStyle = "rgba(255,255,255,.75)";
  ctx.lineJoin = "round"; ctx.stroke(ROAD_PATH);
  const r0 = Math.max(4, 40 * s);
  const dot = (px, py, c, r) => { ctx.fillStyle = c; ctx.beginPath(); ctx.arc(px, py, r / s, 0, 7); ctx.fill(); };
  dot(T[0].x, T[0].y, "#000", r0);
  for (const id in remotes) dot(remotes[id].x, remotes[id].y, pinfo(id).color || "#ccc", r0);
  for (const l of locals) {
    if (!l.car) continue;
    if (!l.ai) dot(l.car.x, l.car.y, "#fff", r0 * 1.6);
    dot(l.car.x, l.car.y, pinfo(l.id).color || "#ccc", r0 * 1.1);
  }
  ctx.restore();
}

function drawHud(vp, l) {
  const now = serverNow(), car = l.car, me = pinfo(l.id);
  const st = standings();
  const pos = st.findIndex((p) => p.id === l.id) + 1;
  const tms = me.time_ms != null ? me.time_ms : Math.max(0, (now - S.start_at) * 1000);
  const multi = humans().length > 1;
  const items = [
    ["순위", pos + "/" + st.length],
    ["바퀴", Math.min(S.laps, car.lap + 1) + "/" + S.laps],
    ["시간", fmt(Math.floor(tms)).slice(0, -2)],
    ["km/h", String(Math.max(0, Math.round(car.fwd * 0.4)))],
  ];
  items.push(["⚡ " + SCHEMES[schemeOf(l)].nlabel, null]);
  const bw = Math.min(78, (vp.w - 30) / 5), bh = 46, gap = 6;
  const total = items.length * bw + (items.length - 1) * gap;
  const touch = document.body.classList.contains("touch") && !multi;
  let x = vp.x + vp.w / 2 - total / 2;
  const y = touch ? vp.y + 12 : vp.y + vp.h - bh - 14;
  ctx.textAlign = "center";
  if (multi) {
    ctx.font = "bold 14px sans-serif";
    const label = me.name + " · " + SCHEMES[schemeOf(l)].label;
    const tw = ctx.measureText(label).width + 20;
    ctx.fillStyle = "rgba(0,0,0,.6)"; rr(vp.x + vp.w / 2 - tw / 2, y - 26, tw, 22, 8); ctx.fill();
    ctx.fillStyle = me.color || "#fff"; ctx.fillText(label, vp.x + vp.w / 2, y - 10);
  }
  for (const [k, v] of items) {
    ctx.fillStyle = v === null && car.charges > 0 ? "rgba(30,60,140,.8)" : "rgba(0,0,0,.6)";
    rr(x, y, bw, bh, 10); ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,.7)"; ctx.font = "11px sans-serif"; ctx.fillText(k, x + bw / 2, y + 15);
    if (v === null) {
      // 부스터 칸: 충전된 개수 + 다음 칸 게이지
      const sw = (bw - 16) / MAX_CHARGES;
      for (let i = 0; i < MAX_CHARGES; i++) {
        const sx = x + 8 + i * sw;
        ctx.fillStyle = "rgba(255,255,255,.15)"; ctx.fillRect(sx + 1, y + 22, sw - 2, 16);
        if (i < car.charges) { ctx.fillStyle = "#ffd23d"; ctx.fillRect(sx + 1, y + 22, sw - 2, 16); }
        else if (i === car.charges) { ctx.fillStyle = "rgba(255,210,61,.5)"; ctx.fillRect(sx + 1, y + 22 + 16 * (1 - car.gauge), sw - 2, 16 * car.gauge); }
      }
    } else {
      ctx.fillStyle = k === "순위" ? "#ffd23d" : "#fff"; ctx.font = "bold 17px sans-serif"; ctx.fillText(v, x + bw / 2, y + 37);
    }
    x += bw + gap;
  }

  // 이 화면 가운데 메시지
  const cx = vp.x + vp.w / 2, cy = vp.y + vp.h * 0.4;
  const big = Math.max(40, Math.min(90, vp.w / 7));
  let main = "", sub = "";
  if (car.finished) {
    const rank = car.rank || me.rank;
    main = rank ? rank + "등!" : "골인!";
    const remain = S.first_finish_at ? Math.max(0, Math.ceil(S.first_finish_at + S.grace - now)) : 0;
    sub = "다른 플레이어를 기다리는 중… " + (remain ? remain + "초" : "");
    if (car.err) { main = ""; sub = car.err; }
  } else if (now > S.start_at + 1) {
    if (car.lap === S.laps - 1 && car.dist % N < N * 0.04 && car.dist > N) sub = "마지막 바퀴!";
    else if (S.first_finish_at) sub = Math.max(0, Math.ceil(S.first_finish_at + S.grace - now)) + "초 안에 골인!";
  }
  if (main) {
    ctx.font = "italic 900 " + big + "px sans-serif";
    ctx.lineWidth = 8; ctx.strokeStyle = "#ff4d4d"; ctx.strokeText(main, cx + 3, cy + 3);
    ctx.fillStyle = "#fff"; ctx.fillText(main, cx, cy);
  }
  if (sub) {
    ctx.font = "bold " + (main ? 20 : 30) + "px sans-serif";
    ctx.lineWidth = 5; ctx.strokeStyle = "rgba(0,0,0,.8)";
    ctx.strokeText(sub, cx, cy + (main ? 40 : 0));
    ctx.fillStyle = "#fff"; ctx.fillText(sub, cx, cy + (main ? 40 : 0));
  }
}

function updateGlobalUi() {
  const st = standings();
  const lr = $("liveRank");
  const sig = st.map((p) => p.id + p.rank + p.dnf).join();
  if (lr.dataset.sig !== sig) {
    lr.dataset.sig = sig;
    lr.innerHTML = "";
    st.forEach((p) => {
      const mine = localOf(p.id) && !p.ai;
      lr.append(el("li", { className: mine ? "me" : "", style: { color: mine ? "" : p.color } },
        (p.ai ? "🤖" : "") + p.name + (p.rank ? " 🏁" : p.dnf ? " (나감)" : "")));
    });
  }
  const left = S.start_at - serverNow();
  let html = "";
  if (left > 3) html = "준비!";
  else if (left > 0) html = String(Math.ceil(left));
  else if (left > -1) html = "GO!";
  const c = $("center");
  if (c.dataset.h !== html) { c.dataset.h = html; c.textContent = html; }
}

// ---------------------------------------------------------------- 메인 루프
let lastT = performance.now();
function frame(t) {
  const dt = Math.min(0.1, (t - lastT) / 1000);
  lastT = t;
  FRAME_DT = dt;
  if (screen === "game" && S && S.phase === "racing" && humans().length && locals.every((l) => l.car)) {
    // 입력은 프레임마다 한 번, 물리는 1/120초 단위로 잘게 나눠서 계산 (부드럽고 안정적)
    const inputs = locals.map((l) => (l.ai ? aiInput(l, dt) : humanInput(l)));
    locals.forEach((l, i) => control(l, inputs[i], dt));
    const steps = Math.max(1, Math.ceil(dt * 120));
    for (let s = 0; s < steps; s++) locals.forEach((l, i) => physics(l, inputs[i], dt / steps));
    updateRemotes(dt);
    if (!cv.width) resize();
    drawAll();
    updateGlobalUi();
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// ---------------------------------------------------------------- 입력
window.addEventListener("keydown", (e) => {
  if (screen === "game" && GAME_CODES.has(e.code)) { pressed.add(e.code); e.preventDefault(); }
});
window.addEventListener("keyup", (e) => pressed.delete(e.code));
window.addEventListener("blur", () => pressed.clear());

if (window.matchMedia("(pointer: coarse)").matches || "ontouchstart" in window) document.body.classList.add("touch");
document.querySelectorAll("#touch button").forEach((b) => {
  const k = b.dataset.k;
  const on = (e) => { e.preventDefault(); touchKeys[k] = true; b.classList.add("on"); };
  const off = (e) => { e.preventDefault(); touchKeys[k] = false; b.classList.remove("on"); };
  b.addEventListener("pointerdown", on);
  b.addEventListener("pointerup", off);
  b.addEventListener("pointerleave", off);
  b.addEventListener("pointercancel", off);
  b.addEventListener("contextmenu", (e) => e.preventDefault());
});

// ---------------------------------------------------------------- 탭 닫기 / 다른 페이지로 이동
// 대기실에서 탭을 닫으면 10초 동안 목록에 남아 그사이 시작하면 출발 그리드를 차지한다 (#23).
// pagehide 에서 sendBeacon 으로 바로 나간다. pagehide 는 새로고침에도 오므로, 같은 탭에
// 다시 들어오면(새로고침·뒤로 가기) sessionStorage 에 남긴 이름·색으로 다시 참가한다.
// 레이스/결과 중에는 보내지 않는다: 그때 나가면 새로고침해도 이어서 달리거나 결과를 볼 수 없다
// (서버가 레이스 중 참가를 막음). 그 경우는 지금처럼 10초 뒤 리타이어/제외된다.
const REJOIN_KEY = "tr_rejoin";
window.addEventListener("pagehide", () => {
  if (screen === "join" || !locals.length || !S || S.phase !== "lobby") return;
  const back = locals.map((l) => ({ name: pinfo(l.id).name, color: pinfo(l.id).color, ai: l.ai }));
  for (const l of locals) {
    const body = { id: l.id };
    if (l.token) body.tokens = { [l.id]: l.token };
    navigator.sendBeacon("/api/leave", new Blob([JSON.stringify(body)], { type: "application/json" }));
  }
  try { sessionStorage.setItem(REJOIN_KEY, JSON.stringify(back)); } catch (e) { /* ignore */ }
  netGen++;
  locals = [];
  saveLocals();
  show("join");
});
async function rejoinAfterPagehide() {
  let back = null;
  try { back = JSON.parse(sessionStorage.getItem(REJOIN_KEY)); sessionStorage.removeItem(REJOIN_KEY); }
  catch (e) { /* ignore */ }
  if (!Array.isArray(back) || !back.length || locals.length) return;
  // 이전 페이지의 leave 비콘이 먼저 처리되게 잠깐 기다린다. 아니면 옛 플레이어가 아직 색을
  // 쥐고 있어서 다른 색으로 들어간다.
  await new Promise((r) => setTimeout(r, 300));
  if (locals.length) return;
  for (const b of back) {
    try { await addLocal({ name: b.name, color: b.color, ai: b.ai }); }
    catch (e) {
      if (humans().length) continue; // 같은 PC 친구/컴퓨터 하나가 안 들어가도 나머지는 계속
      show("join");
      $("joinErr").textContent = e.message;
      return;
    }
  }
}
rejoinAfterPagehide();
window.addEventListener("pageshow", (e) => { if (e.persisted) rejoinAfterPagehide(); });

// ---------------------------------------------------------------- 시작: 새로고침이면 재접속
(async () => {
  if (!locals.length) return;
  const kept = [];
  let last = null;
  for (const l of locals) {
    // 서버가 모르는 id(404)면 새로 만들지 않고 빠짐
    try { last = await api("/api/join", { id: l.id, rejoin: true }); kept.push(l); } catch (e) { /* 빠짐 */ }
  }
  locals = kept;
  saveLocals();
  if (last && humans().length) { show("lobby"); onState(last); }
})();

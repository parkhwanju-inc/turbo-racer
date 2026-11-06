// 터보 레이서 도구 모음: MCP 서버(api/mcp.js)와 AI 도우미(api/ask.js)가 같이 쓴다.
// 게임 규칙은 Supabase tr_api / tr_admin 에만 있고, 여기는 호출과 결과 정리만 한다.

const clean = (v) => (v || "").replace(/^[﻿\s]+|[﻿\s]+$/g, "");
const SUPABASE_URL = clean(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL).replace(/\/+$/, "");
const ANON_KEY = clean(process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  || process.env.SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY);
const SECRET_KEY = clean(process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY);

const GAME_URL = "https://turbo-racer-gules.vercel.app";

// ---------------------------------------------------------------- Supabase 호출
async function rpc(fn, args, key) {
  if (!SUPABASE_URL || !key) throw new ToolError("서버 설정이 빠져 있어요 (Supabase 키)");
  const headers = { apikey: key, "Content-Type": "application/json" };
  if (!key.startsWith("sb_")) headers.Authorization = `Bearer ${key}`; // 예전 JWT 형식 키
  let r;
  try {
    r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
      method: "POST", headers, body: JSON.stringify(args), signal: AbortSignal.timeout(8000),
    });
  } catch (e) {
    throw new ToolError("데이터베이스에 연결하지 못했어요");
  }
  const data = await r.json().catch(() => null);
  if (!r.ok || !data || typeof data.status !== "number") {
    console.error("supabase error", fn, r.status, data);
    throw new ToolError("데이터베이스 오류");
  }
  if (data.status >= 400) throw new ToolError((data.body && data.body.error) || `요청이 거절됐어요 (${data.status})`);
  return data.body;
}
const game = (action, body) => rpc("tr_api", { p_action: action, p_body: body || {} }, ANON_KEY);
const admin = (action, body) => rpc("tr_admin", { p_action: action, p_body: body || {} }, SECRET_KEY);

class ToolError extends Error {}

// ---------------------------------------------------------------- 보기 좋게
const fmtTime = (ms) => (ms == null ? "-" : `${Math.floor(ms / 60000)}:${String(((ms % 60000) / 1000).toFixed(3)).padStart(6, "0")}`);
const PHASE = { lobby: "대기실", racing: "레이스 중", finished: "결과 화면" };
const DIFF = { easy: "쉬움", normal: "보통", hard: "어려움" };

function roomSummary(s) {
  const players = (s.players || []).map((p) => ({
    id: p.id, name: p.name, color: p.color, bot: !!p.ai,
    ...(s.phase === "racing" ? { lap: p.lap, progress: Math.max(0, +(+p.progress).toFixed(3)), rank: p.rank, retired: !!p.dnf } : {}),
    ...(s.phase === "finished" ? { rank: p.rank, time: fmtTime(p.time_ms), retired: !!p.dnf } : {}),
  }));
  const out = {
    phase: s.phase, phase_ko: PHASE[s.phase] || s.phase,
    laps: s.settings && s.settings.laps, difficulty: s.settings && s.settings.difficulty,
    player_count: players.length, players,
  };
  if (s.phase === "racing" && s.start_at) out.elapsed_sec = Math.max(0, Math.round((s.now - s.start_at) * 10) / 10);
  if (s.phase === "finished") out.results = (s.results || []).map((r) => ({ name: r.name, rank: r.rank, time: fmtTime(r.time_ms), bot: !!r.ai }));
  return out;
}

// ---------------------------------------------------------------- 도구
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const TOOLS = [
  {
    name: "get_game_info",
    title: "게임 소개",
    description: "터보 레이서가 어떤 게임인지, 접속 주소와 조작법, 기본 규칙을 알려 줍니다.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: READ_ONLY,
    run: async () => ({
      name: "터보 레이서", url: GAME_URL,
      summary: "브라우저에서 여럿이 함께 하는 탑뷰 자동차 경주. 방은 하나(최대 8명)이고, 같은 PC 친구·컴퓨터 차도 추가할 수 있어요.",
      controls: { 혼자: "방향키 / WASD, 부스터 Space", "한 PC 여럿이": "키보드를 나눠 쓰고 화면 분할 (부스터 Shift / Enter / U / 숫자0)", 휴대폰: "화면 버튼" },
      rules: ["바퀴 수 1~9 (기본 3), 난이도 쉬움/보통/어려움", "첫 완주 뒤 30초가 지나면 레이스 종료", "길 위 ? 상자를 먹으면 부스터 +1", "명예의 전당 최고 기록은 바퀴 수별로 따로 집계"],
    }),
  },
  {
    name: "get_room_status",
    title: "지금 방 상태",
    description: "지금 방이 대기실/레이스 중/결과 화면 중 어디인지, 참가자(이름·색·컴퓨터 여부), 바퀴 수·난이도, 레이스 중이면 진행도와 경과 시간, 끝났으면 결과를 알려 줍니다.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: READ_ONLY,
    run: async () => roomSummary(await game("state", { ids: [] })),
  },
  {
    name: "get_leaderboard",
    title: "명예의 전당",
    description: "바퀴 수별 최고 기록 TOP 10, 메달 순위 TOP 10(사람만), 지금까지 레이스 수를 알려 줍니다.",
    inputSchema: {
      type: "object",
      properties: { laps: { type: "integer", minimum: 1, maximum: 9, default: 3, description: "최고 기록을 볼 바퀴 수" } },
      additionalProperties: false,
    },
    annotations: READ_ONLY,
    run: async (a) => {
      const d = await game("leaderboard", { laps: a.laps == null ? 3 : a.laps });
      return {
        laps: d.laps, total_races: d.total_races,
        best: (d.best || []).map((r, i) => ({ rank: i + 1, name: r.player_name, time: fmtTime(r.time_ms), time_ms: r.time_ms, date: r.date })),
        medals: (d.wins || []).map((r) => ({ name: r.player_name, gold: r.gold, silver: r.silver, bronze: r.bronze, races: r.races })),
      };
    },
  },
  {
    name: "get_recent_races",
    title: "최근 레이스",
    description: "최근에 끝난 레이스들의 시각, 바퀴 수, 참가자별 등수와 기록을 최신 순으로 알려 줍니다(사람 완주자가 있는 레이스만).",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "integer", minimum: 1, maximum: 50, default: 10 } },
      additionalProperties: false,
    },
    annotations: READ_ONLY,
    run: async (a) => (await admin("recent_races", { limit: a.limit == null ? 10 : a.limit })).map((r) => ({
      race_id: r.id, started_at: r.started_at, laps: r.laps, player_count: r.player_count,
      results: (r.results || []).map((x) => ({ name: x.name, rank: x.rank, time: fmtTime(x.time_ms), finished: x.finished, bot: x.bot })),
    })),
  },
  {
    name: "get_player_history",
    title: "플레이어 기록",
    description: "닉네임 하나의 전체 전적(판 수, 금·은·동, 완주 수)과 최근 레이스별 등수·기록을 알려 줍니다. 닉네임은 정확히 같아야 합니다.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", minLength: 1, maxLength: 12, description: "게임에서 쓴 닉네임" },
        limit: { type: "integer", minimum: 1, maximum: 50, default: 20 },
      },
      required: ["name"],
      additionalProperties: false,
    },
    annotations: READ_ONLY,
    run: async (a) => {
      const d = await admin("player_history", { name: a.name, limit: a.limit == null ? 20 : a.limit });
      return { ...d, races: d.races.map((r) => ({ ...r, time: fmtTime(r.time_ms) })) };
    },
  },

  // ---------------- 운영자 (MCP_ADMIN_KEY 필요)
  {
    name: "set_room_settings",
    title: "방 설정 바꾸기",
    admin: true,
    description: "[운영자] 대기실일 때 바퀴 수(1~9)나 난이도(easy/normal/hard)를 바꿉니다. 방에 있는 모든 사람에게 바로 적용됩니다.",
    inputSchema: {
      type: "object",
      properties: {
        laps: { type: "integer", minimum: 1, maximum: 9 },
        difficulty: { type: "string", enum: ["easy", "normal", "hard"] },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: async (a) => {
      if (a.laps == null && a.difficulty == null) throw new ToolError("바꿀 값(laps 또는 difficulty)을 알려 주세요");
      const body = {};
      if (a.laps != null) body.laps = a.laps;
      if (a.difficulty != null) body.difficulty = a.difficulty;
      return roomSummary(await admin("room_settings", body));
    },
  },
  {
    name: "start_race",
    title: "레이스 시작",
    admin: true,
    description: "[운영자] 대기실에 있는 사람들로 바로 레이스를 시작합니다(3.5초 카운트다운). 사람이 한 명 이상 있어야 합니다.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    run: async () => roomSummary(await admin("start_race", {})),
  },
  {
    name: "kick_player",
    title: "플레이어 내보내기",
    admin: true,
    description: "[운영자] 플레이어를 방에서 내보냅니다. 레이스 중이면 리타이어 처리됩니다. player_id 는 get_room_status 의 players[].id 입니다.",
    inputSchema: {
      type: "object",
      properties: { player_id: { type: "string", minLength: 1 } },
      required: ["player_id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    run: async (a) => roomSummary(await admin("kick_player", { player_id: a.player_id })),
  },
  {
    name: "reset_room",
    title: "방 강제 초기화",
    admin: true,
    description: "[운영자] 레이스 중이어도 방을 대기실로 되돌립니다. 진행 중이던 레이스 기록은 남지 않고, 참가자는 대기실에 그대로 남습니다.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    run: async () => roomSummary(await admin("reset_room", {})),
  },
  {
    name: "find_suspicious_records",
    title: "의심 기록 찾기",
    admin: true,
    description: "[운영자] 바퀴당 기준 초(기본 10초)보다 빠른 완주 기록을 찾습니다. 부스터를 계속 써도 바퀴당 약 9.4초가 걸리므로 그보다 빠르면 조작이 의심됩니다. 바퀴 수를 모르는 예전 기록은 1바퀴로 계산합니다.",
    inputSchema: {
      type: "object",
      properties: { sec_per_lap: { type: "number", minimum: 1, maximum: 60, default: 10 } },
      additionalProperties: false,
    },
    annotations: READ_ONLY,
    run: async (a) => {
      const d = await admin("suspicious_records", { sec_per_lap: a.sec_per_lap == null ? 10 : a.sec_per_lap });
      return { ...d, records: d.records.map((r) => ({ ...r, time: fmtTime(r.time_ms) })) };
    },
  },
  {
    name: "delete_race",
    title: "레이스 기록 삭제",
    admin: true,
    description: "[운영자] 레이스 하나의 기록(참가자 전원 결과 포함)을 명예의 전당에서 지웁니다. 되돌릴 수 없습니다. race_id 는 get_recent_races 나 find_suspicious_records 에서 확인하세요.",
    inputSchema: {
      type: "object",
      properties: { race_id: { type: "integer", minimum: 1 } },
      required: ["race_id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    run: async (a) => admin("delete_race", { race_id: a.race_id }),
  },
];
const TOOL_BY_NAME = Object.fromEntries(TOOLS.map((t) => [t.name, t]));

// 스키마에 적은 범위대로 간단히 검사 (잘못된 값은 도구 오류로 돌려줌)
function checkArgs(tool, args) {
  if (args == null) args = {};
  if (typeof args !== "object" || Array.isArray(args)) throw new ToolError("arguments 는 객체여야 해요");
  const { properties = {}, required = [] } = tool.inputSchema;
  for (const k of required) if (args[k] == null) throw new ToolError(`'${k}' 값이 필요해요`);
  for (const [k, v] of Object.entries(args)) {
    const s = properties[k];
    if (!s) throw new ToolError(`알 수 없는 값 '${k}'`);
    if (v == null) continue;
    if (s.type === "integer" && !Number.isInteger(v)) throw new ToolError(`'${k}' 는 정수여야 해요`);
    if (s.type === "number" && (typeof v !== "number" || !Number.isFinite(v))) throw new ToolError(`'${k}' 는 숫자여야 해요`);
    if (s.type === "string" && typeof v !== "string") throw new ToolError(`'${k}' 는 문자열이어야 해요`);
    if (s.minimum != null && v < s.minimum) throw new ToolError(`'${k}' 는 ${s.minimum} 이상이어야 해요`);
    if (s.maximum != null && v > s.maximum) throw new ToolError(`'${k}' 는 ${s.maximum} 이하여야 해요`);
    if (s.minLength != null && v.length < s.minLength) throw new ToolError(`'${k}' 가 비어 있어요`);
    if (s.maxLength != null && v.length > s.maxLength) throw new ToolError(`'${k}' 는 ${s.maxLength}자 이하예요`);
    if (s.enum && !s.enum.includes(v)) throw new ToolError(`'${k}' 는 ${s.enum.join(" / ")} 중 하나예요`);
  }
  return args;
}

module.exports = { TOOLS, TOOL_BY_NAME, checkArgs, ToolError, GAME_URL, roomSummary, fmtTime };

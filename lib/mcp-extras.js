// MCP 리소스·프롬프트. 데이터는 전부 lib/turbo-tools.js 의 도구를 그대로 써서 가져온다.
//   리소스: AI 앱이 "첨부"처럼 읽어 가는 데이터 (turbo://...)
//   프롬프트: AI 앱 메뉴(/ 명령 등)에 뜨는 바로 쓰는 질문 템플릿. 최신 데이터를 담아서 돌려준다.

const { TOOL_BY_NAME, checkArgs, ToolError } = require("./turbo-tools");

const run = (name, args) => {
  const t = TOOL_BY_NAME[name];
  return t.run(checkArgs(t, args || {}));
};
const json = (o) => JSON.stringify(o, null, 2);

// ---------------------------------------------------------------- 리소스
const RESOURCES = [
  { uri: "turbo://game/info", name: "game-info", title: "게임 소개·조작법", description: "터보 레이서 소개, 접속 주소, 조작법, 기본 규칙", tool: "get_game_info" },
  { uri: "turbo://room/status", name: "room-status", title: "지금 방 상태", description: "대기실/레이스 중/결과, 참가자, 설정, 진행도", tool: "get_room_status" },
  { uri: "turbo://leaderboard", name: "leaderboard", title: "명예의 전당 (3바퀴)", description: "3바퀴 최고 기록 TOP 10과 메달 순위", tool: "get_leaderboard", args: { laps: 3 } },
  { uri: "turbo://races/recent", name: "recent-races", title: "최근 레이스 10개", description: "최근 끝난 레이스 결과", tool: "get_recent_races", args: { limit: 10 } },
];
const TEMPLATES = [
  { uriTemplate: "turbo://leaderboard/{laps}", name: "leaderboard-by-laps", title: "바퀴 수별 명예의 전당", description: "laps = 1~9", mimeType: "application/json" },
  { uriTemplate: "turbo://players/{name}", name: "player-history", title: "플레이어 전적", description: "닉네임 하나의 전적 (URL 인코딩)", mimeType: "application/json" },
];

function listResources() {
  return RESOURCES.map(({ uri, name, title, description }) => ({ uri, name, title, description, mimeType: "application/json" }));
}

// uri → { tool, args } (없으면 null)
function resolveResource(uri) {
  if (typeof uri !== "string") return null;
  const fixed = RESOURCES.find((r) => r.uri === uri);
  if (fixed) return { tool: fixed.tool, args: fixed.args || {} };
  let m = /^turbo:\/\/leaderboard\/(\d{1,2})$/.exec(uri);
  if (m) return { tool: "get_leaderboard", args: { laps: Number(m[1]) } };
  m = /^turbo:\/\/players\/(.+)$/.exec(uri);
  if (m) {
    let name;
    try { name = decodeURIComponent(m[1]); } catch (e) { return null; }
    return { tool: "get_player_history", args: { name } };
  }
  return null;
}

async function readResource(uri) {
  const r = resolveResource(uri);
  if (!r) return null;
  const data = await run(r.tool, r.args);
  return { contents: [{ uri, mimeType: "application/json", text: json(data) }] };
}

// ---------------------------------------------------------------- 프롬프트
// arguments 는 MCP 스펙상 전부 문자열로 들어온다.
const intArg = (v, lo, hi, def, label) => {
  if (v == null || v === "") return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < lo || n > hi) throw new ToolError(`${label}는 ${lo}~${hi} 사이 숫자예요`);
  return n;
};

const embedded = (uri, data) => ({ type: "resource", resource: { uri, mimeType: "application/json", text: json(data) } });
const user = (...content) => ({ role: "user", content: content.length === 1 ? content[0] : content });
const text = (t) => ({ type: "text", text: t });

const PROMPTS = [
  {
    name: "room_briefing",
    title: "지금 방 브리핑",
    description: "지금 방 상황(대기 중인 사람, 레이스 진행, 결과)을 한눈에 정리합니다.",
    arguments: [],
    build: async () => {
      const d = await run("get_room_status");
      return [
        user(embedded("turbo://room/status", d)),
        user(text("위 데이터는 터보 레이서의 지금 방 상태야. 한국어로 3~5줄로 브리핑해 줘: 단계(대기실/레이스 중/결과), 참가자(사람·컴퓨터 구분), 바퀴 수·난이도, 레이스 중이면 선두와 경과 시간, 결과면 순위. 지어내지 말고 데이터에 있는 것만.")),
      ];
    },
  },
  {
    name: "race_report",
    title: "최근 레이스 리포트",
    description: "최근 레이스들을 모아 우승자·기록·눈에 띄는 점을 리포트로 정리합니다.",
    arguments: [{ name: "count", description: "볼 레이스 수 (1~20, 기본 5)", required: false }],
    build: async (a) => {
      const count = intArg(a.count, 1, 20, 5, "count");
      const d = await run("get_recent_races", { limit: count });
      return [
        user(embedded("turbo://races/recent", d)),
        user(text(`위는 터보 레이서 최근 레이스 ${count}개 결과야. 한국어 리포트로 정리해 줘: 레이스별 한 줄(시각, 바퀴 수, 우승자와 기록), 이어서 여러 번 이긴 사람이나 접전 같은 눈에 띄는 점 2~3개. 컴퓨터(bot) 기록은 따로 표시해.`)),
      ];
    },
  },
  {
    name: "player_profile",
    title: "플레이어 프로필",
    description: "닉네임 하나의 전적을 분석해 선수 프로필처럼 소개합니다.",
    arguments: [{ name: "name", description: "게임에서 쓴 닉네임 (정확히)", required: true }],
    build: async (a) => {
      const name = String(a.name || "").trim();
      if (!name) throw new ToolError("name(닉네임)이 필요해요");
      const d = await run("get_player_history", { name: name.slice(0, 12) });
      return [
        user(embedded(`turbo://players/${encodeURIComponent(name)}`, d)),
        user(text(`위는 터보 레이서 플레이어 "${name}" 의 전적이야. 한국어로 짧은 선수 프로필을 써 줘: 판 수와 금·은·동, 완주율, 바퀴 수별 최고 기록, 최근 흐름. 기록이 없으면 아직 기록이 없다고만 말해.`)),
      ];
    },
  },
  {
    name: "leaderboard_post",
    title: "순위 발표문",
    description: "명예의 전당을 공지·단톡방에 올릴 순위 발표문으로 만들어 줍니다.",
    arguments: [{ name: "laps", description: "기준 바퀴 수 (1~9, 기본 3)", required: false }],
    build: async (a) => {
      const laps = intArg(a.laps, 1, 9, 3, "laps");
      const d = await run("get_leaderboard", { laps });
      return [
        user(embedded(`turbo://leaderboard/${laps}`, d)),
        user(text(`위는 터보 레이서 명예의 전당(${laps}바퀴 기준)이야. 단톡방에 올릴 짧고 신나는 한국어 순위 발표문을 써 줘: 최고 기록 TOP 3(이름, 기록), 메달 순위 1위, 지금까지 레이스 수, 마지막에 도전 권유 한 줄과 게임 주소. 이모지는 조금만.`)),
      ];
    },
  },
  {
    name: "cheat_audit",
    title: "의심 기록 점검",
    admin: true,
    description: "[운영자] 너무 빠른 완주 기록을 찾아 조작 의심 여부를 점검하고 지울 후보를 정리합니다.",
    arguments: [{ name: "sec_per_lap", description: "바퀴당 이 초보다 빠르면 의심 (기본 10)", required: false }],
    build: async (a) => {
      const sec = a.sec_per_lap == null || a.sec_per_lap === "" ? 10 : Number(a.sec_per_lap);
      if (!Number.isFinite(sec) || sec < 1 || sec > 60) throw new ToolError("sec_per_lap 는 1~60 사이 숫자예요");
      const d = await run("find_suspicious_records", { sec_per_lap: sec });
      return [
        user(embedded("turbo://admin/suspicious", d)),
        user(text(`위는 터보 레이서에서 바퀴당 ${sec}초보다 빠른 완주 기록이야(부스터를 계속 써도 바퀴당 약 9.4초가 걸림). 한국어로 점검 보고서를 써 줘: 기록별 race_id·닉네임·바퀴당 초, 조작이 거의 확실한 것과 애매한 것 구분, 바퀴 수를 모르는 예전 기록은 따로. 삭제가 필요해 보이면 delete_race 로 지울 race_id 목록을 제안하되, 실제로 지우기 전에 반드시 나에게 확인받아.`)),
      ];
    },
  },
];
const PROMPT_BY_NAME = Object.fromEntries(PROMPTS.map((p) => [p.name, p]));

function listPrompts(isAdmin) {
  return PROMPTS.filter((p) => !p.admin || isAdmin)
    .map(({ name, title, description, arguments: args }) => ({ name, title, description, arguments: args }));
}

module.exports = { listResources, TEMPLATES, readResource, listPrompts, PROMPT_BY_NAME };

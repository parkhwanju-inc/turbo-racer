// 터보 레이서 원격 MCP 서버 (Streamable HTTP, 상태 없음)
//
//   주소: POST https://<배포 주소>/api/mcp
//   - 누구나: 방 상태, 명예의 전당, 최근 레이스, 플레이어 기록 조회
//   - 운영자: 방 설정·시작·내보내기·초기화, 의심 기록 찾기·삭제
//     → 요청 헤더 `Authorization: Bearer <MCP_ADMIN_KEY>` (헤더를 못 넣는 클라이언트는 `?key=`)
//
// 환경변수
//   SUPABASE_URL, SUPABASE_ANON_KEY  — 게임과 같은 값 (공개 조회는 게임과 같은 tr_api 를 부름)
//   SUPABASE_SECRET_KEY              — 운영 함수 tr_admin 실행용 (service_role). 브라우저에는 절대 안 나감
//   MCP_ADMIN_KEY                    — 운영자 도구를 여는 비밀 값. 없으면 운영자 도구는 꺼짐
//
// MCP 스펙: JSON-RPC 2.0. 세션 없이 요청마다 JSON 으로 바로 답한다(SSE 안 씀).

const crypto = require("crypto");

const { TOOLS, TOOL_BY_NAME, checkArgs, ToolError } = require("../lib/turbo-tools");
const extras = require("../lib/mcp-extras"); // 리소스·프롬프트

const clean = (v) => (v || "").replace(/^[\uFEFF\s]+|[\uFEFF\s]+$/g, "");
const ADMIN_KEY = clean(process.env.MCP_ADMIN_KEY);

const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const SERVER_INFO = { name: "turbo-racer", title: "터보 레이서", version: "1.1.0" };

// ---------------------------------------------------------------- 인증
function isAdmin(req) {
  if (!ADMIN_KEY) return false;
  const h = req.headers.authorization || "";
  const m = /^Bearer\s+(.+)$/i.exec(h);
  const given = m ? m[1].trim() : typeof req.query.key === "string" ? req.query.key : "";
  if (!given) return false;
  const a = crypto.createHash("sha256").update(given).digest();
  const b = crypto.createHash("sha256").update(ADMIN_KEY).digest();
  return crypto.timingSafeEqual(a, b);
}

// ---------------------------------------------------------------- JSON-RPC
const rpcError = (id, code, message) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
const rpcResult = (id, result) => ({ jsonrpc: "2.0", id, result });

async function handleMessage(msg, ctx) {
  if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    return rpcError(msg && msg.id, -32600, "Invalid Request");
  }
  const isNotification = !("id" in msg);
  const { id, method, params = {} } = msg;
  if (isNotification) return null; // notifications/initialized 등: 응답 없음

  switch (method) {
    case "initialize": {
      const asked = params && params.protocolVersion;
      return rpcResult(id, {
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: {
          tools: { listChanged: false },
          prompts: { listChanged: false },
          resources: { subscribe: false, listChanged: false },
        },
        serverInfo: SERVER_INFO,
        instructions: "터보 레이서(브라우저 멀티플레이 자동차 경주) 정보를 조회합니다. "
          + "방 상태·명예의 전당·최근 레이스·플레이어 전적은 누구나 볼 수 있고, "
          + (ctx.admin ? "지금은 운영자 키로 연결돼 방 관리·기록 정리 도구도 쓸 수 있습니다. 기록 삭제·강제 초기화 전에는 사용자에게 확인하세요."
                       : "방 관리·기록 정리 도구는 운영자 키로 연결해야 보입니다."),
      });
    }
    case "ping":
      return rpcResult(id, {});
    case "tools/list":
      return rpcResult(id, {
        tools: TOOLS.filter((t) => !t.admin || ctx.admin).map(({ name, title, description, inputSchema, annotations }) =>
          ({ name, title, description, inputSchema, annotations })),
      });
    case "tools/call": {
      const tool = TOOL_BY_NAME[params && params.name];
      if (!tool || (tool.admin && !ctx.admin)) {
        if (tool && tool.admin) return rpcResult(id, toolError("운영자 도구예요. 운영자 키(Authorization: Bearer …)로 연결해 주세요."));
        return rpcError(id, -32602, `Unknown tool: ${params && params.name}`);
      }
      try {
        const out = await tool.run(checkArgs(tool, params.arguments));
        const structured = Array.isArray(out) ? { items: out } : out;
        return rpcResult(id, {
          content: [{ type: "text", text: JSON.stringify(out, null, 2) }],
          structuredContent: structured,
        });
      } catch (e) {
        if (e instanceof ToolError) return rpcResult(id, toolError(e.message));
        console.error(e);
        return rpcResult(id, toolError("서버 오류"));
      }
    }
    case "resources/list":
      return rpcResult(id, { resources: extras.listResources() });
    case "resources/templates/list":
      return rpcResult(id, { resourceTemplates: extras.TEMPLATES });
    case "resources/read": {
      try {
        const out = await extras.readResource(params && params.uri);
        if (!out) return rpcError(id, -32002, `Resource not found: ${params && params.uri}`);
        return rpcResult(id, out);
      } catch (e) {
        if (e instanceof ToolError) return rpcError(id, -32603, e.message);
        console.error(e);
        return rpcError(id, -32603, "서버 오류");
      }
    }
    case "prompts/list":
      return rpcResult(id, { prompts: extras.listPrompts(ctx.admin) });
    case "prompts/get": {
      const p = extras.PROMPT_BY_NAME[params && params.name];
      if (!p || (p.admin && !ctx.admin)) return rpcError(id, -32602, `Unknown prompt: ${params && params.name}`);
      const args = (params && params.arguments) || {};
      if (typeof args !== "object" || Array.isArray(args)) return rpcError(id, -32602, "arguments 는 객체여야 해요");
      try {
        return rpcResult(id, { description: p.description, messages: await p.build(args) });
      } catch (e) {
        if (e instanceof ToolError) return rpcError(id, -32602, e.message);
        console.error(e);
        return rpcError(id, -32603, "서버 오류");
      }
    }
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}
const toolError = (text) => ({ content: [{ type: "text", text }], isError: true });

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS, DELETE");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Mcp-Session-Id, Mcp-Protocol-Version, Accept");
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
}

module.exports = async (req, res) => {
  cors(res);
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method === "GET") {
    // 이 서버는 SSE 스트림을 열지 않음 (스펙상 405 로 알림)
    res.setHeader("Allow", "POST, OPTIONS");
    return res.status(405).json(rpcError(null, -32000, "이 MCP 서버는 POST 만 받아요"));
  }
  if (req.method === "DELETE") return res.status(405).end(); // 세션이 없으니 끝낼 것도 없음
  if (req.method !== "POST") return res.status(405).end();

  let body;
  // Vercel 은 Content-Type 이 JSON 인데 본문이 깨져 있으면 req.body 를 읽는 순간 예외를 던진다
  try { body = req.body; } catch (e) { return res.status(400).json(rpcError(null, -32700, "Parse error")); }
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch (e) { return res.status(400).json(rpcError(null, -32700, "Parse error")); }
  }
  if (body == null) return res.status(400).json(rpcError(null, -32700, "Parse error"));

  const ctx = { admin: isAdmin(req) };
  if (Array.isArray(body)) {
    if (!body.length) return res.status(400).json(rpcError(null, -32600, "Invalid Request"));
    const out = (await Promise.all(body.map((m) => handleMessage(m, ctx)))).filter(Boolean);
    return out.length ? res.status(200).json(out) : res.status(202).end();
  }
  const out = await handleMessage(body, ctx);
  return out ? res.status(200).json(out) : res.status(202).end();
};

// 화면 아래 AI 도우미 입력창. 게임 코드(game.js)와 따로 동작한다.
// 질문은 /api/ask 로 보내고(대화 기록은 이 탭에만 보관), 레이스 화면에서는 숨긴다.
(() => {
  "use strict";
  const MCP_URL = location.origin + "/api/mcp";
  const MAX_CHARS = 800;
  const KEY = "tr_ask_history";

  let history = [];
  try { history = JSON.parse(sessionStorage.getItem(KEY)) || []; } catch (e) { history = []; }
  const save = () => { try { sessionStorage.setItem(KEY, JSON.stringify(history.slice(-20))); } catch (e) { /* ignore */ } };

  const el = (tag, props, ...kids) => {
    const n = Object.assign(document.createElement(tag), props || {});
    for (const k of kids) n.append(k);
    return n;
  };

  // ---------------------------------------------------------------- 화면 만들기
  const log = el("div", { className: "ask-log", role: "log", ariaLive: "polite" });
  const mcpBtn = el("button", { type: "button", className: "ask-mcp", textContent: "🔌 MCP 주소 복사" });
  const closeBtn = el("button", { type: "button", className: "ask-close", textContent: "✕", ariaLabel: "닫기" });
  const panel = el("div", { className: "ask-panel", hidden: true },
    el("div", { className: "ask-head" }, el("b", { textContent: "🤖 AI 도우미" }), mcpBtn, closeBtn),
    log);
  const input = el("input", {
    className: "ask-input", type: "text", maxLength: MAX_CHARS, autocomplete: "off",
    placeholder: "AI에게 물어보세요 · 예) 지금 1등 기록 누구야?", ariaLabel: "AI에게 질문",
  });
  const send = el("button", { type: "submit", className: "ask-send", textContent: "보내기" });
  const form = el("form", { className: "ask-bar" }, input, send);
  const box = el("div", { id: "ask" }, panel, form);
  document.body.append(box);
  document.body.classList.add("has-ask");

  function bubble(role, text, extra) {
    const b = el("div", { className: "ask-msg " + role });
    // 답은 항상 글자로만 넣는다 (HTML 해석 안 함). 모델이 그래도 쓴 마크다운 강조·제목 기호는 걷어냄
    b.textContent = role.startsWith("bot")
      ? text.replace(/\*\*(.+?)\*\*/g, "$1").replace(/__(.+?)__/g, "$1").replace(/^#{1,6}\s+/gm, "")
      : text;
    if (extra) b.append(el("small", { textContent: extra }));
    log.append(b);
    log.scrollTop = log.scrollHeight;
    return b;
  }
  function open() {
    panel.hidden = false;
    if (!log.childElementCount) {
      bubble("bot", "안녕하세요! 터보 레이서에 대해 물어보세요. 지금 방 상태, 명예의 전당, 닉네임별 전적, 조작법을 실제 데이터로 알려 드려요.");
      for (const m of history) bubble(m.role === "user" ? "me" : "bot", m.content);
    }
  }

  // ---------------------------------------------------------------- 레이스 중에는 숨김
  const game = document.getElementById("game");
  const sync = () => {
    const racing = game && game.classList.contains("active");
    box.hidden = racing;
    document.body.classList.toggle("has-ask", !racing);
  };
  if (game) new MutationObserver(sync).observe(game, { attributes: true, attributeFilter: ["class"] });
  sync();

  // 입력하는 동안 게임 단축키(방향키, Space, Enter 등)로 새지 않게
  for (const t of ["keydown", "keyup"]) input.addEventListener(t, (e) => e.stopPropagation());

  // ---------------------------------------------------------------- 보내기
  let busy = false;
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const q = input.value.trim();
    if (!q || busy) { open(); return; }
    open();
    busy = true; send.disabled = true; input.value = "";
    bubble("me", q);
    history.push({ role: "user", content: q });
    const wait = bubble("bot wait", "생각하는 중…");
    try {
      const r = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: history.slice(-10) }),
        signal: AbortSignal.timeout ? AbortSignal.timeout(60000) : undefined,
      });
      const d = await r.json().catch(() => ({}));
      wait.remove();
      if (!r.ok || !d.answer) {
        history.pop(); // 실패한 질문은 기록에서 뺌 (다시 물어볼 수 있게)
        bubble("bot err", d.error || "답을 받지 못했어요. 잠시 후 다시 물어봐 주세요.");
      } else {
        history.push({ role: "assistant", content: d.answer });
        const used = (d.used_tools || []).filter(Boolean);
        bubble("bot", d.answer, used.length ? "확인한 데이터: " + [...new Set(used)].map(toolName).join(", ") : "");
      }
      save();
    } catch (err) {
      wait.remove();
      history.pop();
      bubble("bot err", navigator.onLine === false ? "인터넷 연결이 끊겼어요." : "AI 서버에 연결하지 못했어요. 잠시 후 다시 물어봐 주세요.");
    } finally {
      busy = false; send.disabled = false; input.focus();
    }
  });
  input.addEventListener("focus", open);
  closeBtn.addEventListener("click", () => { panel.hidden = true; });

  const NAMES = { get_room_status: "방 상태", get_leaderboard: "명예의 전당", get_recent_races: "최근 레이스",
                  get_player_history: "플레이어 전적", get_game_info: "게임 소개" };
  function toolName(n) { return NAMES[n] || n; }

  // ---------------------------------------------------------------- MCP 주소
  mcpBtn.addEventListener("click", async () => {
    let copied = false;
    try { await navigator.clipboard.writeText(MCP_URL); copied = true; } catch (e) { /* 클립보드 막힘 */ }
    bubble("bot", (copied ? "MCP 주소를 복사했어요: " : "MCP 주소: ") + MCP_URL
      + "\nClaude 같은 AI 앱의 커넥터(사용자 지정 MCP)에 이 주소를 넣으면, 그 AI 가 터보 레이서 방 상태와 기록을 직접 조회할 수 있어요.");
  });
})();

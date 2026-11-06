터보 레이서(브라우저 멀티플레이 자동차 경주) MCP는 Vercel에 원격 MCP로 올라가 있어요. 코드를 받을 필요 없이 주소만 등록하면 돼요.

MCP 주소: https://turbo-racer-gules.vercel.app/api/mcp  (Streamable HTTP, 조회는 인증 없음)
게임 주소: https://turbo-racer-gules.vercel.app

아래 내용을 Claude Code에 그대로 붙여 넣으면 등록해요.

---

원격 MCP 서버 `turbo-racer`를 이 프로젝트에 등록해 줘. 코드는 받지 말고 주소만 등록해.

1) 등록
   - `claude mcp add --transport http turbo-racer https://turbo-racer-gules.vercel.app/api/mcp --scope project`
   - 그러면 `.mcp.json`에 다음이 생겨:
     ```json
     { "mcpServers": { "turbo-racer": { "type": "http", "url": "https://turbo-racer-gules.vercel.app/api/mcp" } } }
     ```
   - 나만 쓰려면 `--scope user`로 등록해.

2) 확인
   - 세션을 다시 열고 `/mcp`에서 `turbo-racer`가 connected인지 봐. 처음엔 프로젝트 MCP 승인을 물어봐.
   - 도구 5개가 보여야 해: `get_game_info`, `get_room_status`, `get_leaderboard`, `get_recent_races`, `get_player_history`.
   - 프롬프트 4개도 보여: `room_briefing`, `race_report`, `player_profile`, `leaderboard_post` (`/` 메뉴에서 `turbo-racer` 로 찾을 수 있어).
   - 읽기만 하는 `get_room_status`를 한 번 불러 방 상태(대기실/레이스 중/결과)가 나오는지 확인해.
   - 모든 도구가 조회 전용이라 불러도 게임 데이터는 바뀌지 않아.

3) 써 보기 (예시 요청)
   - "지금 방에 누가 있고 레이스 중이야?" → `get_room_status`
   - "3바퀴 최고 기록 TOP 3랑 메달 1위 알려 줘" → `get_leaderboard(laps=3)`
   - "최근 레이스 5판 결과 정리해 줘" → `get_recent_races(limit=5)` 또는 프롬프트 `race_report(count=5)`
   - "'소닉' 전적 분석해서 선수 프로필 써 줘" → `get_player_history(name="소닉")` 또는 프롬프트 `player_profile(name=소닉)`
   - "단톡방에 올릴 1바퀴 순위 발표문 써 줘" → 프롬프트 `leaderboard_post(laps=1)`
   - "부스터는 어떻게 써?" → `get_game_info`

리소스(첨부처럼 읽는 데이터, JSON): `turbo://game/info`, `turbo://room/status`, `turbo://leaderboard`, `turbo://races/recent`, `turbo://leaderboard/{laps}`, `turbo://players/{name}`.

claude.ai(웹·데스크톱)에서는 설정 → 커넥터 → 사용자 지정 커넥터 추가에 같은 주소를 넣으면 돼요.

참고: 운영자 도구(방 설정·시작·내보내기·강제 초기화, 의심 기록 찾기·삭제, 프롬프트 `cheat_audit`)는 운영자 키로 연결해야 보여요. 키가 있으면 `--header "Authorization: Bearer <MCP_ADMIN_KEY>"`를 붙여 등록하고, 기록 삭제·강제 초기화는 되돌릴 수 없으니 실행 전에 꼭 확인해.

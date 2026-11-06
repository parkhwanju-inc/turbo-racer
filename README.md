# 터보 레이서

3명 이상이 함께 하는 브라우저 자동차 경주 게임.

🎮 **바로 플레이: https://turbo-racer-gules.vercel.app**

## 구조

| 위치 | 역할 |
|---|---|
| `public/` | 게임 화면 (HTML/CSS/JS) — Vercel이 정적 파일로 제공 |
| `api/[action].js` | Vercel 서버리스 함수. `/api/join`, `/api/update` 등을 Supabase `tr_api` 함수로 전달 |
| `api/mcp.js` | 원격 MCP 서버 (`/api/mcp`). AI 가 방 상태·기록을 보고, 운영자는 방 관리·기록 정리 |
| `api/ask.js`, `public/ask.js` | 화면 아래 AI 도우미 입력창. OpenRouter 모델이 MCP 와 같은 공개 조회 도구로 실제 데이터를 보고 답함 |
| `lib/turbo-tools.js` | MCP 와 AI 도우미가 같이 쓰는 도구 정의·Supabase 호출 |
| `supabase/migrations/` | 방 상태·레이스 기록 테이블과 게임 로직(`tr_api`), 운영 함수(`tr_admin`) |
| `server.py`, `start.bat` | 같은 와이파이에서 로컬로 돌릴 때 쓰는 서버 (SQLite, Supabase 불필요, MCP 없음) |

## MCP 서버 (AI 에 연결하기)

주소: **`https://turbo-racer-gules.vercel.app/api/mcp`** (Streamable HTTP, 세션 없음)

| 누구나 | 운영자 키 필요 |
|---|---|
| `get_game_info` 게임 소개·조작법 | `set_room_settings` 바퀴 수·난이도 변경 (대기실일 때) |
| `get_room_status` 지금 방 상태·참가자·진행도 | `start_race` 대기실 인원으로 바로 시작 |
| `get_leaderboard` 바퀴 수별 최고 기록·메달 순위 | `kick_player` 플레이어 내보내기 |
| `get_recent_races` 최근 레이스 결과 | `reset_room` 방 강제 초기화 |
| `get_player_history` 닉네임별 전적 | `find_suspicious_records` 너무 빠른(조작 의심) 기록 찾기 |
| | `delete_race` 레이스 기록 삭제 (되돌릴 수 없음) |

**프롬프트** (AI 앱의 `/` 메뉴 등에 뜨는 바로 쓰는 질문. 최신 데이터를 담아서 줌)

| 이름 | 하는 일 | 인자 |
|---|---|---|
| `room_briefing` | 지금 방 브리핑 | - |
| `race_report` | 최근 레이스 리포트 | `count` (1~20, 기본 5) |
| `player_profile` | 닉네임 선수 프로필 | `name` (필수) |
| `leaderboard_post` | 단톡방용 순위 발표문 | `laps` (1~9, 기본 3) |
| `cheat_audit` | [운영자] 의심 기록 점검 보고서 | `sec_per_lap` (기본 10) |

**리소스** (AI 앱이 첨부처럼 읽어 가는 데이터, JSON): `turbo://game/info`, `turbo://room/status`, `turbo://leaderboard`, `turbo://races/recent`, 템플릿 `turbo://leaderboard/{laps}`, `turbo://players/{name}`

연결 방법:

```bash
# Claude Code — 조회만
claude mcp add --transport http turbo-racer https://turbo-racer-gules.vercel.app/api/mcp
# Claude Code — 운영자 (키는 헤더로)
claude mcp add --transport http turbo-racer-admin https://turbo-racer-gules.vercel.app/api/mcp --header "Authorization: Bearer <MCP_ADMIN_KEY>"
```

- claude.ai / Claude 데스크톱: 설정 → 커넥터 → 사용자 지정 커넥터 추가 → 위 주소. 이 화면은 헤더를 넣을 수 없어서 운영자로 쓰려면 주소 끝에 `?key=<MCP_ADMIN_KEY>` 를 붙입니다. 주소에 넣은 키는 접속 기록에 남을 수 있으니 본인만 쓰고, 새어 나갔다 싶으면 키를 바꾸세요.
- AI 는 플레이어로 참가할 수 없습니다. 게임은 브라우저가 차를 직접 운전하면서 위치를 계속 보내야 해서(10초 끊기면 퇴장), 방 관리는 운영자 입장에서만 합니다.
- 운영자 키 바꾸기: `vercel env rm MCP_ADMIN_KEY production` → `vercel env add MCP_ADMIN_KEY production` → `vercel deploy --prod`.

## AI 도우미 (화면 아래 입력창)

참가·대기실·결과 화면 아래 입력창에 질문하면 `/api/ask` 가 OpenRouter 모델로 답합니다. "지금 방 어때?", "3바퀴 1등 누구야?", "○○ 전적 알려줘" 같은 질문은 MCP 의 공개 조회 도구를 직접 실행해서 실제 데이터로 답합니다(운영자 도구는 절대 안 씀). 레이스 화면에서는 숨겨집니다.

- Vercel 환경변수: `OPENROUTER_API_KEY`(필수), `OPENROUTER_MODEL`(선택, 기본 `anthropic/claude-haiku-5.5`)
- 남용 방지: 질문 800자, 대화 기록 10개, IP 당 1분 8회(함수 인스턴스별), 답 최대 700토큰, 도구 호출 4회. 누구나 쓸 수 있는 공개 입력창이라 **OpenRouter 키에 사용 한도(credit limit)를 꼭 걸어 두세요.**
- 키 바꾸기: `vercel env add OPENROUTER_API_KEY production --force` → `vercel deploy --prod`

## 배포

- **Vercel**: 프로젝트 `dbinc1/turbo-racer`, 함수 리전은 서울(`icn1`).
- **Supabase**: 프로젝트 `turbo-racer` (서울 `ap-northeast-2`).
- Vercel 환경변수: `SUPABASE_URL`, `SUPABASE_ANON_KEY` (publishable key), MCP 용 `SUPABASE_SECRET_KEY` (secret key, 운영 함수 `tr_admin` 실행용 — 브라우저로는 절대 안 나감), `MCP_ADMIN_KEY` (운영자 도구를 여는 비밀 값).

> ⚠️ 지금은 **GitHub에 push 해도 자동 배포되지 않습니다.** Vercel 프로젝트에 Git 저장소가 연결돼 있지 않아서, 아래처럼 직접 배포해야 사이트가 바뀝니다.

### 직접 배포 (지금 방식)

`main` 을 받은 폴더에서:

```bash
npx supabase db push --remote   # supabase/migrations/ 에 새 파일이 있을 때만 (먼저!)
vercel deploy --prod
```

DB 함수가 바뀌는 변경은 **DB 먼저, 그다음 Vercel** 순서로 올립니다. 새 화면 코드가 DB에 아직 없는 기능을 부르면 오류가 나기 때문입니다. 이미 올라간 마이그레이션 파일은 고치지 말고 `supabase/migrations/` 에 새 파일을 추가합니다.

### 자동 배포로 바꾸려면 (한 번만)

1. Vercel GitHub 앱 설치: https://github.com/apps/vercel/installations/new → `turbo-racer` 저장소 선택
2. 이 폴더에서 `vercel git connect` (또는 Vercel 대시보드 → Project → Settings → Git)
3. 연결되면 `main` 에 push 할 때 운영 배포, 다른 브랜치·PR 은 미리보기 주소로 배포됩니다. 이 안내 블록도 지워 주세요.

DB 마이그레이션은 자동 배포에 포함되지 않으니 연결 후에도 `npx supabase db push --remote` 는 직접 실행합니다.

### 사이트가 "데이터베이스 오류"를 낼 때

Supabase 무료 프로젝트는 한동안 사용이 없으면 일시 중지될 수 있습니다. [Supabase 대시보드](https://supabase.com/dashboard/project/gdsnjjjoyhrddbekjhmm)에서 프로젝트를 다시 시작(Restore)하면 됩니다.

## 로컬 실행

```bash
py server.py
```

→ http://localhost:5050

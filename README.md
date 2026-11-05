# 터보 레이서

3명 이상이 함께 하는 브라우저 자동차 경주 게임.

## 구조

| 위치 | 역할 |
|---|---|
| `public/` | 게임 화면 (HTML/CSS/JS) — Vercel이 정적 파일로 제공 |
| `api/[action].js` | Vercel 서버리스 함수. `/api/join`, `/api/update` 등을 Supabase `tr_api` 함수로 전달 |
| `supabase/migrations/` | 방 상태·레이스 기록 테이블과 게임 로직(`tr_api`) |
| `server.py`, `start.bat` | 같은 와이파이에서 로컬로 돌릴 때 쓰는 서버 (SQLite, Supabase 불필요) |

## 배포

- **Vercel**: GitHub에 push 하면 자동 배포. 함수 리전은 서울(`icn1`).
- **Supabase**: 프로젝트 `turbo-racer` (서울 `ap-northeast-2`).
- Vercel 환경변수: `SUPABASE_URL`, `SUPABASE_ANON_KEY` (publishable key).

DB 변경은 `supabase/migrations/`에 파일을 추가한 뒤:

```bash
npx supabase db push --remote
```

## 로컬 실행

```bash
py server.py
```

→ http://localhost:5050

# 터보 레이서

3명 이상이 함께 하는 브라우저 자동차 경주 게임.

🎮 **바로 플레이: https://turbo-racer-gules.vercel.app**

## 구조

| 위치 | 역할 |
|---|---|
| `public/` | 게임 화면 (HTML/CSS/JS) — Vercel이 정적 파일로 제공 |
| `api/[action].js` | Vercel 서버리스 함수. `/api/join`, `/api/update` 등을 Supabase `tr_api` 함수로 전달 |
| `supabase/migrations/` | 방 상태·레이스 기록 테이블과 게임 로직(`tr_api`) |
| `server.py`, `start.bat` | 같은 와이파이에서 로컬로 돌릴 때 쓰는 서버 (SQLite, Supabase 불필요) |

## 배포

- **Vercel**: 프로젝트 `dbinc1/turbo-racer`, 함수 리전은 서울(`icn1`).
- **Supabase**: 프로젝트 `turbo-racer` (서울 `ap-northeast-2`).
- Vercel 환경변수: `SUPABASE_URL`, `SUPABASE_ANON_KEY` (publishable key).

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

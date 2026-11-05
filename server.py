# -*- coding: utf-8 -*-
"""
터보 레이서 - 로컬 멀티플레이 레이싱 서버
Python 3.7+ 표준 라이브러리만 사용 (설치 필요 없음)

실행:  py server.py
접속:  같은 와이파이의 기기에서 http://<이 PC의 IP>:5050
"""
import json
import os
import socket
import sqlite3
import threading
import time
import uuid
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

PORT = int(os.environ.get("PORT", "5050"))
BASE = os.path.dirname(os.path.abspath(__file__))
STATIC = os.path.join(BASE, "public")
DB_PATH = os.path.join(BASE, "race.db")

LAPS = 3
MAX_PLAYERS = 8
STALE_SEC = 10          # 이 시간 동안 응답 없으면 로비에서 제외 / 레이스에선 리타이어
FINISH_GRACE_SEC = 30   # 1등 도착 후 남은 사람 기다리는 시간
MAX_RACE_SEC = 600
COUNTDOWN_SEC = 3.5
COLORS = ["#ff4d4d", "#3d8bff", "#ffd23d", "#3ddc84",
          "#b26bff", "#ff8c2e", "#2ee6e6", "#ff6fcf"]

lock = threading.Lock()
room = {
    "phase": "lobby",      # lobby | racing | finished
    "start_at": 0.0,
    "first_finish_at": 0.0,
    "race_id": None,
    "players": {},         # id -> dict
    "finish_order": [],    # player ids
    "results": [],
    "version": 0,
    "settings": {"laps": LAPS, "difficulty": "easy"},  # 대기실에서 바꿀 수 있음
}


# ---------------------------------------------------------------- DB
def db():
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    return con


def init_db():
    with db() as con:
        con.executescript("""
        CREATE TABLE IF NOT EXISTS races(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            started_at TEXT NOT NULL,
            finished_at TEXT NOT NULL,
            player_count INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS results(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            race_id INTEGER NOT NULL REFERENCES races(id),
            player_name TEXT NOT NULL,
            color TEXT NOT NULL,
            rank INTEGER,
            time_ms INTEGER,
            finished INTEGER NOT NULL,
            is_bot INTEGER NOT NULL DEFAULT 0
        );
        """)
        cols = [r[1] for r in con.execute("PRAGMA table_info(results)")]
        if "is_bot" not in cols:  # 예전 버전 DB 업그레이드
            con.execute("ALTER TABLE results ADD COLUMN is_bot INTEGER NOT NULL DEFAULT 0")


def ts(t):
    return time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(t))


def save_race(results, start_at, end_at):
    with db() as con:
        cur = con.execute(
            "INSERT INTO races(started_at, finished_at, player_count) VALUES (?,?,?)",
            (ts(start_at), ts(end_at), len(results)))
        rid = cur.lastrowid
        for r in results:
            con.execute(
                "INSERT INTO results(race_id, player_name, color, rank, time_ms, finished, is_bot) "
                "VALUES (?,?,?,?,?,?,?)",
                (rid, r["name"], r["color"], r["rank"], r["time_ms"],
                 1 if r["finished"] else 0, 1 if r["ai"] else 0))
    return rid


def leaderboard():
    with db() as con:
        best = [dict(r) for r in con.execute(
            "SELECT player_name, color, time_ms, r.started_at AS date FROM results "
            "JOIN races r ON r.id = results.race_id "
            "WHERE finished=1 AND is_bot=0 ORDER BY time_ms ASC LIMIT 10")]
        wins = [dict(r) for r in con.execute(
            "SELECT player_name, "
            "SUM(CASE WHEN rank=1 THEN 1 ELSE 0 END) AS gold, "
            "SUM(CASE WHEN rank=2 THEN 1 ELSE 0 END) AS silver, "
            "SUM(CASE WHEN rank=3 THEN 1 ELSE 0 END) AS bronze, "
            "COUNT(*) AS races FROM results WHERE is_bot=0 GROUP BY player_name "
            "ORDER BY gold DESC, silver DESC, bronze DESC, races DESC LIMIT 10")]
        total = con.execute("SELECT COUNT(*) FROM races").fetchone()[0]
    return {"best": best, "wins": wins, "total_races": total}


# ---------------------------------------------------------------- game logic (lock must be held)
def bump():
    room["version"] += 1


def free_slot():
    used = {p["slot"] for p in room["players"].values()}
    for i in range(MAX_PLAYERS):
        if i not in used:
            return i
    return None


def pick_color(want):
    used = {p["color"] for p in room["players"].values()}
    if want in COLORS and want not in used:
        return want
    for c in COLORS:
        if c not in used:
            return c
    return COLORS[0]


def end_race(now):
    finished = [room["players"][pid] for pid in room["finish_order"] if pid in room["players"]]
    others = [p for p in room["players"].values() if p["rank"] is None]
    others.sort(key=lambda p: -p["progress"])
    results = []
    for p in finished:
        results.append({"name": p["name"], "color": p["color"], "rank": p["rank"],
                        "time_ms": p["time_ms"], "finished": True, "ai": p["ai"]})
    for p in others:
        results.append({"name": p["name"], "color": p["color"], "rank": None,
                        "time_ms": None, "finished": False, "ai": p["ai"]})
    room["results"] = results
    room["phase"] = "finished"
    try:
        room["race_id"] = save_race(results, room["start_at"], now)
    except Exception as e:  # DB 오류가 게임을 멈추지 않도록
        print("DB 저장 실패:", e)
    bump()


def tick():
    now = time.time()
    players = room["players"]
    if room["phase"] in ("lobby", "finished"):
        for pid in [pid for pid, p in players.items() if now - p["seen"] > STALE_SEC]:
            del players[pid]
            bump()
    elif room["phase"] == "racing":
        for p in players.values():
            if p["rank"] is None and not p["dnf"] and now - p["seen"] > STALE_SEC:
                p["dnf"] = True
                bump()
        active = [p for p in players.values() if p["rank"] is None and not p["dnf"]]
        if not active:
            end_race(now)
        elif room["first_finish_at"] and now - room["first_finish_at"] > FINISH_GRACE_SEC:
            end_race(now)
        elif now - room["start_at"] > MAX_RACE_SEC:
            end_race(now)
    if not players and room["phase"] != "lobby":
        reset_room()


def reset_room():
    room["phase"] = "lobby"
    room["start_at"] = 0.0
    room["first_finish_at"] = 0.0
    room["finish_order"] = []
    room["results"] = []
    for p in room["players"].values():
        p.update(x=0, y=0, a=0, v=0, progress=-1, lap=0, rank=None, time_ms=None, dnf=False)
    bump()


def public_state(pid=None):
    now = time.time()
    return {
        "now": now,
        "phase": room["phase"],
        "start_at": room["start_at"],
        "first_finish_at": room["first_finish_at"],
        "grace": FINISH_GRACE_SEC,
        "laps": room["settings"]["laps"],
        "settings": room["settings"],
        "me": pid if pid in room["players"] else None,
        "players": [
            {"id": k, "name": p["name"], "color": p["color"], "slot": p["slot"],
             "x": p["x"], "y": p["y"], "a": p["a"], "v": p["v"],
             "progress": p["progress"], "lap": p["lap"], "rank": p["rank"],
             "time_ms": p["time_ms"], "dnf": p["dnf"], "ai": p["ai"]}
            for k, p in room["players"].items()
        ],
        "results": room["results"],
        "race_id": room["race_id"],
    }


def touch(pid):
    p = room["players"].get(pid)
    if p:
        p["seen"] = time.time()
    return p


# ---------------------------------------------------------------- API handlers
def api_join(body):
    name = str(body.get("name", "")).strip()[:12] or "플레이어"
    pid = body.get("id")
    with lock:
        tick()
        if pid in room["players"]:              # 새로고침 후 재접속
            touch(pid)
            return 200, public_state(pid)
        if room["phase"] != "lobby":
            return 409, {"error": "레이스가 진행 중이에요. 끝나면 다시 참가해 주세요!"}
        slot = free_slot()
        if slot is None:
            return 409, {"error": "방이 가득 찼어요 (최대 %d명)" % MAX_PLAYERS}
        pid = uuid.uuid4().hex[:12]
        room["players"][pid] = {
            "name": name, "color": pick_color(body.get("color")), "slot": slot,
            "seen": time.time(), "x": 0, "y": 0, "a": 0, "v": 0,
            "progress": -1, "lap": 0, "rank": None, "time_ms": None, "dnf": False,
            "ai": bool(body.get("ai")),
        }
        bump()
        return 200, public_state(pid)


def api_leave(body):
    with lock:
        pid = body.get("id")
        if pid in room["players"]:
            if room["phase"] == "racing":
                room["players"][pid]["dnf"] = True
            else:
                del room["players"][pid]
            bump()
        tick()
        return 200, {"ok": True}


def api_state(ids):
    with lock:
        for pid in ids:
            touch(pid)
        tick()
        return 200, public_state(ids[0] if ids else None)


def apply_car(c):
    p = touch(c.get("id"))
    if p and room["phase"] == "racing" and p["rank"] is None and not p["dnf"]:
        try:
            p["x"] = float(c.get("x", 0))
            p["y"] = float(c.get("y", 0))
            p["a"] = float(c.get("a", 0))
            p["v"] = float(c.get("v", 0))
            p["progress"] = float(c.get("progress", 0))
            p["lap"] = int(c.get("lap", 0))
        except (TypeError, ValueError):
            pass


def api_update(body):
    """한 브라우저가 여러 차(같은 PC 플레이어/컴퓨터)를 한 번에 보낼 수 있음.
    body: {ids: [...살아있음 표시], cars: [{id,x,y,a,v,progress,lap}, ...]}
    (예전 형식 {id, x, y, ...} 도 받음)"""
    cars = body.get("cars") if isinstance(body.get("cars"), list) else [body]
    ids = [i for i in (body.get("ids") or []) if isinstance(i, str)][:MAX_PLAYERS]
    with lock:
        for pid in ids:
            touch(pid)
        for c in cars[:MAX_PLAYERS]:
            if isinstance(c, dict):
                apply_car(c)
        tick()
        first = ids[0] if ids else body.get("id")
        return 200, public_state(first)


def api_start(body):
    with lock:
        tick()
        if room["phase"] != "lobby":
            return 409, {"error": "이미 시작했어요"}
        if body.get("id") not in room["players"]:
            return 403, {"error": "참가한 플레이어만 시작할 수 있어요"}
        now = time.time()
        room["phase"] = "racing"
        room["start_at"] = now + COUNTDOWN_SEC
        room["first_finish_at"] = 0.0
        room["finish_order"] = []
        room["results"] = []
        for p in room["players"].values():
            p.update(x=0, y=0, a=0, v=0, progress=-1, lap=0, rank=None, time_ms=None,
                     dnf=False, seen=now)
        bump()
        return 200, public_state(body.get("id"))


def api_finish(body):
    pid = body.get("id")
    with lock:
        p = touch(pid)
        now = time.time()
        if not p or room["phase"] != "racing":
            return 409, {"error": "레이스 중이 아니에요"}
        if p["rank"] is not None:
            return 200, public_state(pid)
        elapsed = now - room["start_at"]
        # 최소 검증: 바퀴 수를 다 돌았고, 말도 안 되게 빠르지 않을 것
        laps = room["settings"]["laps"]
        if int(body.get("lap", 0)) < laps or elapsed < 4 * laps:
            return 400, {"error": "완주가 확인되지 않았어요"}
        room["finish_order"].append(pid)
        p["rank"] = len(room["finish_order"])
        p["time_ms"] = int(elapsed * 1000)
        p["progress"] = max(p["progress"], float(body.get("progress", 0)))
        if p["rank"] == 1:
            room["first_finish_at"] = now
        bump()
        tick()
        return 200, public_state(pid)


def api_settings(body):
    with lock:
        if body.get("id") not in room["players"]:
            return 403, {"error": "참가한 플레이어만 바꿀 수 있어요"}
        if room["phase"] != "lobby":
            return 409, {"error": "대기실에서만 바꿀 수 있어요"}
        st = room["settings"]
        try:
            if "laps" in body:
                st["laps"] = max(1, min(9, int(body["laps"])))
        except (TypeError, ValueError):
            pass
        if body.get("difficulty") in ("easy", "normal", "hard"):
            st["difficulty"] = body["difficulty"]
        touch(body.get("id"))
        bump()
        return 200, public_state(body.get("id"))


def api_reset(body):
    with lock:
        if room["phase"] == "finished" or not room["players"]:
            reset_room()
        touch(body.get("id"))
        return 200, public_state(body.get("id"))


# ---------------------------------------------------------------- HTTP
class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=STATIC, **kw)

    def log_message(self, fmt, *args):
        pass  # 폴링 로그가 너무 많아서 숨김

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def send_json(self, code, obj):
        data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def read_body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n <= 0 or n > 10000:
            return {}
        try:
            obj = json.loads(self.rfile.read(n).decode("utf-8"))
            return obj if isinstance(obj, dict) else {}
        except Exception:
            return {}

    def do_GET(self):
        u = urlparse(self.path)
        if u.path == "/api/state":
            q = parse_qs(u.query)
            ids = ",".join(q.get("ids", []) + q.get("id", [])).split(",")
            return self.send_json(*api_state([i for i in ids if i][:MAX_PLAYERS]))
        if u.path == "/api/leaderboard":
            return self.send_json(200, leaderboard())
        if u.path.startswith("/api/"):
            return self.send_json(404, {"error": "not found"})
        return super().do_GET()

    def do_POST(self):
        routes = {
            "/api/join": api_join, "/api/leave": api_leave, "/api/update": api_update,
            "/api/start": api_start, "/api/finish": api_finish, "/api/reset": api_reset,
            "/api/settings": api_settings,
        }
        fn = routes.get(urlparse(self.path).path)
        if not fn:
            return self.send_json(404, {"error": "not found"})
        self.send_json(*fn(self.read_body()))


def lan_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))  # 실제로 패킷을 보내지 않음, 경로만 확인
        return s.getsockname()[0]
    except Exception:
        return "127.0.0.1"
    finally:
        s.close()


if __name__ == "__main__":
    init_db()
    srv = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    srv.daemon_threads = True
    ip = lan_ip()
    print("=" * 52)
    print("  터보 레이서 서버 실행 중!")
    print("  이 PC에서:        http://localhost:%d" % PORT)
    print("  같은 와이파이 기기: http://%s:%d" % (ip, PORT))
    print("  DB 파일: %s" % DB_PATH)
    print("  종료: Ctrl+C")
    print("=" * 52)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n서버 종료")

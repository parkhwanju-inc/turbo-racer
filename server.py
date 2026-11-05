# -*- coding: utf-8 -*-
#####################################################################
# TURBO RACER SERVER  v1.3.2
#
# 변경이력
#  2006.11.02  최초작성 (박대리)
#  2007.03.15  김과장 수정 - 방 꽉차면 에러나는거 수정
#  2007.08.??  AI 차 추가 (누가했는지 모름)
#  2008.01.20  DB 컬럼 추가함 is_bot  *** 운영DB 수동으로 ALTER 했음 ***
#  2009.06.11  lock 추가... 가끔 순위 꼬임 (원인 모름)
#
# !!! 주의 !!!  이 파일 함부로 고치지 마세요. 고치면 레이스 순위 꼬임
#####################################################################
import json, os, socket, sqlite3, threading, time, uuid
from http.server import *
from urllib.parse import *

PORT = int(os.environ.get("PORT", "5050"))
DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "race.db")
STATIC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "public")

#COLORS = ["#ff0000", "#0000ff", "#ffff00"]   # 예전색 (2006)
COLORS = ["#ff4d4d", "#3d8bff", "#ffd23d", "#3ddc84",
          "#b26bff", "#ff8c2e", "#2ee6e6", "#ff6fcf"]

# 전역변수 (건드리지 말것)
g_lock = threading.Lock()
g_phase = "lobby"
g_start_at = 0.0
g_first_finish_at = 0.0
g_race_id = None
g_players = {}
g_finish_order = []
g_results = []
g_version = 0
g_laps = 3
g_difficulty = "easy"
g_debug = 0   # 1로 하면 로그 찍힘
tmp_cnt = 0   # 안씀?


def getConn():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def initDB():
    conn = getConn()
    cur = conn.cursor()
    cur.execute("CREATE TABLE IF NOT EXISTS races(id INTEGER PRIMARY KEY AUTOINCREMENT, started_at TEXT NOT NULL, finished_at TEXT NOT NULL, player_count INTEGER NOT NULL)")
    cur.execute("CREATE TABLE IF NOT EXISTS results(id INTEGER PRIMARY KEY AUTOINCREMENT, race_id INTEGER NOT NULL REFERENCES races(id), player_name TEXT NOT NULL, color TEXT NOT NULL, rank INTEGER, time_ms INTEGER, finished INTEGER NOT NULL, is_bot INTEGER NOT NULL DEFAULT 0)")
    # 2008.01.20 컬럼추가
    cols = []
    for r in cur.execute("PRAGMA table_info(results)").fetchall():
        cols.append(r[1])
    flg = 0
    for c in cols:
        if c == "is_bot":
            flg = 1
    if flg == 0:
        cur.execute("ALTER TABLE results ADD COLUMN is_bot INTEGER NOT NULL DEFAULT 0")
    conn.commit()
    conn.close()


# 결과 저장 + 순위표 + ... 다 여기서 함
def doDB(mode, data=None, start_at=0, end_at=0):
    conn = getConn()
    cur = conn.cursor()
    ret = None
    try:
        if mode == "save":
            cur.execute("INSERT INTO races(started_at, finished_at, player_count) VALUES ('%s','%s',%d)" % (
                time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(start_at)),
                time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(end_at)), len(data)))
            rid = cur.lastrowid
            for i in range(0, len(data)):
                r = data[i]
                f = 0
                if r["finished"] == True:
                    f = 1
                b = 0
                if r["ai"] == True:
                    b = 1
                # TODO: 이름에 ' 들어가면 에러남?? -> ? 로 바꿈 (2009.06)
                cur.execute("INSERT INTO results(race_id, player_name, color, rank, time_ms, finished, is_bot) VALUES (?,?,?,?,?,?,?)",
                            (rid, r["name"], r["color"], r["rank"], r["time_ms"], f, b))
            conn.commit()
            ret = rid
        elif mode == "board":
            best = []
            for r in cur.execute("SELECT player_name, color, time_ms, r.started_at AS date FROM results JOIN races r ON r.id = results.race_id WHERE finished=1 AND is_bot=0 ORDER BY time_ms ASC LIMIT 10").fetchall():
                best.append({"player_name": r["player_name"], "color": r["color"], "time_ms": r["time_ms"], "date": r["date"]})
            wins = []
            for r in cur.execute("SELECT player_name, SUM(CASE WHEN rank=1 THEN 1 ELSE 0 END) AS gold, SUM(CASE WHEN rank=2 THEN 1 ELSE 0 END) AS silver, SUM(CASE WHEN rank=3 THEN 1 ELSE 0 END) AS bronze, COUNT(*) AS races FROM results WHERE is_bot=0 GROUP BY player_name ORDER BY gold DESC, silver DESC, bronze DESC, races DESC LIMIT 10").fetchall():
                wins.append({"player_name": r["player_name"], "gold": r["gold"], "silver": r["silver"], "bronze": r["bronze"], "races": r["races"]})
            total = cur.execute("SELECT COUNT(*) FROM races").fetchone()[0]
            ret = {"best": best, "wins": wins, "total_races": total}
        #elif mode == "delete":
        #    cur.execute("DELETE FROM results")   # 절대 주석 풀지 말것!!!
    finally:
        conn.close()
    return ret


def makeState(pid):
    global g_players
    pl = []
    for k in g_players:
        p = g_players[k]
        pl.append({"id": k, "name": p["name"], "color": p["color"], "slot": p["slot"],
                   "x": p["x"], "y": p["y"], "a": p["a"], "v": p["v"],
                   "progress": p["progress"], "lap": p["lap"], "rank": p["rank"],
                   "time_ms": p["time_ms"], "dnf": p["dnf"], "ai": p["ai"]})
    me = None
    if pid in g_players:
        me = pid
    return {"now": time.time(), "phase": g_phase, "start_at": g_start_at,
            "first_finish_at": g_first_finish_at, "grace": 30, "laps": g_laps,
            "settings": {"laps": g_laps, "difficulty": g_difficulty},
            "me": me, "players": pl, "results": g_results, "race_id": g_race_id}


# 매 요청마다 불러야됨!!! (안부르면 나간사람 안지워짐)
def checkAll():
    global g_phase, g_start_at, g_first_finish_at, g_finish_order, g_results, g_version, g_race_id
    now = time.time()
    if g_phase == "lobby" or g_phase == "finished":
        dels = []
        for k in g_players:
            if now - g_players[k]["seen"] > 10:
                dels.append(k)
        for k in dels:
            del g_players[k]
            g_version = g_version + 1
    elif g_phase == "racing":
        for k in g_players:
            p = g_players[k]
            if p["rank"] == None and p["dnf"] == False and now - p["seen"] > 10:
                p["dnf"] = True
                g_version = g_version + 1
        cnt = 0
        for k in g_players:
            if g_players[k]["rank"] == None and g_players[k]["dnf"] == False:
                cnt = cnt + 1
        endflg = 0
        if cnt == 0:
            endflg = 1
        else:
            if g_first_finish_at and now - g_first_finish_at > 30:
                endflg = 1
            else:
                if now - g_start_at > 600:
                    endflg = 1
        if endflg == 1:
            # ---- 레이스 끝 (예전엔 함수 따로 있었는데 합침) ----
            res = []
            for pid in g_finish_order:
                if pid in g_players:
                    p = g_players[pid]
                    res.append({"name": p["name"], "color": p["color"], "rank": p["rank"],
                                "time_ms": p["time_ms"], "finished": True, "ai": p["ai"]})
            tmp = []
            for k in g_players:
                if g_players[k]["rank"] == None:
                    tmp.append(g_players[k])
            # 정렬 (버블소트, sort 쓰면 가끔 이상하다고 해서...)
            for i in range(0, len(tmp)):
                for j in range(0, len(tmp) - 1 - i):
                    if tmp[j]["progress"] < tmp[j + 1]["progress"]:
                        t = tmp[j]
                        tmp[j] = tmp[j + 1]
                        tmp[j + 1] = t
            for p in tmp:
                res.append({"name": p["name"], "color": p["color"], "rank": None,
                            "time_ms": None, "finished": False, "ai": p["ai"]})
            g_results = res
            g_phase = "finished"
            try:
                g_race_id = doDB("save", res, g_start_at, now)
            except Exception as e:
                print("DB 저장 실패:", e)
            g_version = g_version + 1
    if len(g_players) == 0 and g_phase != "lobby":
        # 방 초기화 (resetRoom 이랑 똑같음. 고치면 둘다 고칠것)
        g_phase = "lobby"
        g_start_at = 0.0
        g_first_finish_at = 0.0
        g_finish_order = []
        g_results = []
        for k in g_players:
            g_players[k]["x"] = 0
            g_players[k]["y"] = 0
            g_players[k]["a"] = 0
            g_players[k]["v"] = 0
            g_players[k]["progress"] = -1
            g_players[k]["lap"] = 0
            g_players[k]["rank"] = None
            g_players[k]["time_ms"] = None
            g_players[k]["dnf"] = False
        g_version = g_version + 1


# API 처리 (전부 여기서)
def handleAPI(path, body):
    global g_phase, g_start_at, g_first_finish_at, g_finish_order, g_results, g_version, g_laps, g_difficulty
    g_lock.acquire()
    try:
        if path == "/api/join":
            name = str(body.get("name", "")).strip()[:12]
            if name == "":
                name = "플레이어"
            pid = body.get("id")
            checkAll()
            if pid in g_players:
                g_players[pid]["seen"] = time.time()
                return 200, makeState(pid)
            if g_phase != "lobby":
                return 409, {"error": "레이스가 진행 중이에요. 끝나면 다시 참가해 주세요!"}
            slot = None
            for i in range(0, 8):
                used = 0
                for k in g_players:
                    if g_players[k]["slot"] == i:
                        used = 1
                if used == 0:
                    slot = i
                    break
            if slot == None:
                return 409, {"error": "방이 가득 찼어요 (최대 %d명)" % 8}
            want = body.get("color")
            color = None
            usedc = []
            for k in g_players:
                usedc.append(g_players[k]["color"])
            if want in COLORS and not (want in usedc):
                color = want
            else:
                for c in COLORS:
                    if not (c in usedc):
                        color = c
                        break
                if color == None:
                    color = COLORS[0]
            pid = uuid.uuid4().hex[:12]
            ai = False
            if body.get("ai"):
                ai = True
            g_players[pid] = {"name": name, "color": color, "slot": slot, "seen": time.time(),
                              "x": 0, "y": 0, "a": 0, "v": 0, "progress": -1, "lap": 0,
                              "rank": None, "time_ms": None, "dnf": False, "ai": ai}
            g_version = g_version + 1
            return 200, makeState(pid)

        elif path == "/api/leave":
            pid = body.get("id")
            if pid in g_players:
                if g_phase == "racing":
                    g_players[pid]["dnf"] = True
                else:
                    del g_players[pid]
                g_version = g_version + 1
            checkAll()
            return 200, {"ok": True}

        elif path == "/api/state":
            ids = body.get("ids")
            for pid in ids:
                if pid in g_players:
                    g_players[pid]["seen"] = time.time()
            checkAll()
            if len(ids) > 0:
                return 200, makeState(ids[0])
            return 200, makeState(None)

        elif path == "/api/update":
            # 한 브라우저가 여러 차 보낼 수 있음 (같은 PC 2인용)
            # 예전형식 {id, x, y...} 도 받음 (구버전 클라이언트 호환 - 지우지 말것)
            cars = body.get("cars")
            if not isinstance(cars, list):
                cars = [body]
            ids = []
            if body.get("ids"):
                for i in body.get("ids"):
                    if isinstance(i, str):
                        ids.append(i)
            ids = ids[:8]
            for pid in ids:
                if pid in g_players:
                    g_players[pid]["seen"] = time.time()
            for c in cars[:8]:
                if isinstance(c, dict):
                    p = None
                    if c.get("id") in g_players:
                        p = g_players[c.get("id")]
                        p["seen"] = time.time()
                    if p != None and g_phase == "racing" and p["rank"] == None and p["dnf"] == False:
                        try:
                            p["x"] = float(c.get("x", 0))
                            p["y"] = float(c.get("y", 0))
                            p["a"] = float(c.get("a", 0))
                            p["v"] = float(c.get("v", 0))
                            p["progress"] = float(c.get("progress", 0))
                            p["lap"] = int(c.get("lap", 0))
                        except:
                            pass
            checkAll()
            if len(ids) > 0:
                return 200, makeState(ids[0])
            return 200, makeState(body.get("id"))

        elif path == "/api/start":
            checkAll()
            if g_phase != "lobby":
                return 409, {"error": "이미 시작했어요"}
            if not (body.get("id") in g_players):
                return 403, {"error": "참가한 플레이어만 시작할 수 있어요"}
            now = time.time()
            g_phase = "racing"
            g_start_at = now + 3.5
            g_first_finish_at = 0.0
            g_finish_order = []
            g_results = []
            for k in g_players:
                g_players[k]["x"] = 0
                g_players[k]["y"] = 0
                g_players[k]["a"] = 0
                g_players[k]["v"] = 0
                g_players[k]["progress"] = -1
                g_players[k]["lap"] = 0
                g_players[k]["rank"] = None
                g_players[k]["time_ms"] = None
                g_players[k]["dnf"] = False
                g_players[k]["seen"] = now
            g_version = g_version + 1
            return 200, makeState(body.get("id"))

        elif path == "/api/finish":
            pid = body.get("id")
            p = None
            if pid in g_players:
                p = g_players[pid]
                p["seen"] = time.time()
            now = time.time()
            if p == None or g_phase != "racing":
                return 409, {"error": "레이스 중이 아니에요"}
            if p["rank"] != None:
                return 200, makeState(pid)
            elapsed = now - g_start_at
            # 치팅방지 (최소한만...)
            if int(body.get("lap", 0)) < g_laps or elapsed < 4 * g_laps:
                return 400, {"error": "완주가 확인되지 않았어요"}
            g_finish_order.append(pid)
            p["rank"] = len(g_finish_order)
            p["time_ms"] = int(elapsed * 1000)
            if float(body.get("progress", 0)) > p["progress"]:
                p["progress"] = float(body.get("progress", 0))
            if p["rank"] == 1:
                g_first_finish_at = now
            g_version = g_version + 1
            checkAll()
            return 200, makeState(pid)

        elif path == "/api/reset":
            if g_phase == "finished" or len(g_players) == 0:
                # 방 초기화 (checkAll 이랑 똑같음. 고치면 둘다 고칠것)
                g_phase = "lobby"
                g_start_at = 0.0
                g_first_finish_at = 0.0
                g_finish_order = []
                g_results = []
                for k in g_players:
                    g_players[k]["x"] = 0
                    g_players[k]["y"] = 0
                    g_players[k]["a"] = 0
                    g_players[k]["v"] = 0
                    g_players[k]["progress"] = -1
                    g_players[k]["lap"] = 0
                    g_players[k]["rank"] = None
                    g_players[k]["time_ms"] = None
                    g_players[k]["dnf"] = False
                g_version = g_version + 1
            if body.get("id") in g_players:
                g_players[body.get("id")]["seen"] = time.time()
            return 200, makeState(body.get("id"))

        elif path == "/api/settings":
            if not (body.get("id") in g_players):
                return 403, {"error": "참가한 플레이어만 바꿀 수 있어요"}
            if g_phase != "lobby":
                return 409, {"error": "대기실에서만 바꿀 수 있어요"}
            if "laps" in body:
                try:
                    n = int(body["laps"])
                    if n < 1:
                        n = 1
                    if n > 9:
                        n = 9
                    g_laps = n
                except:
                    pass
            if body.get("difficulty") == "easy" or body.get("difficulty") == "normal" or body.get("difficulty") == "hard":
                g_difficulty = body["difficulty"]
            if body.get("id") in g_players:
                g_players[body.get("id")]["seen"] = time.time()
            g_version = g_version + 1
            return 200, makeState(body.get("id"))

        elif path == "/api/leaderboard":
            return 200, doDB("board")

        return 404, {"error": "not found"}
    finally:
        g_lock.release()


class MyHandler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        SimpleHTTPRequestHandler.__init__(self, *a, directory=STATIC, **kw)

    def log_message(self, fmt, *args):
        if g_debug == 1:
            SimpleHTTPRequestHandler.log_message(self, fmt, *args)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        SimpleHTTPRequestHandler.end_headers(self)

    def do_GET(self):
        u = urlparse(self.path)
        if u.path == "/api/state":
            q = parse_qs(u.query)
            lst = []
            if "ids" in q:
                lst = lst + q["ids"]
            if "id" in q:
                lst = lst + q["id"]
            ids = []
            for i in ",".join(lst).split(","):
                if i != "":
                    ids.append(i)
            code, obj = handleAPI("/api/state", {"ids": ids[:8]})
        elif u.path == "/api/leaderboard":
            code, obj = handleAPI("/api/leaderboard", {})
        elif u.path.startswith("/api/"):
            code, obj = 404, {"error": "not found"}
        else:
            return SimpleHTTPRequestHandler.do_GET(self)
        # 응답 (do_POST 랑 똑같음)
        data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        p = urlparse(self.path).path
        body = {}
        n = int(self.headers.get("Content-Length") or 0)
        if n > 0 and n <= 10000:
            try:
                body = json.loads(self.rfile.read(n).decode("utf-8"))
                if not isinstance(body, dict):
                    body = {}
            except:
                body = {}
        if p in ("/api/join", "/api/leave", "/api/update", "/api/start", "/api/finish", "/api/reset", "/api/settings"):
            code, obj = handleAPI(p, body)
        else:
            code, obj = 404, {"error": "not found"}
        # 응답 (do_GET 이랑 똑같음)
        data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


if __name__ == "__main__":
    initDB()
    srv = ThreadingHTTPServer(("0.0.0.0", PORT), MyHandler)
    srv.daemon_threads = True
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    ip = "127.0.0.1"
    try:
        s.connect(("10.255.255.255", 1))
        ip = s.getsockname()[0]
    except:
        pass
    s.close()
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

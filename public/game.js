/*****************************************************************************
 *
 *   터보 레이서 (TURBO RACER) - 클라이언트 스크립트  (game.js)
 *
 *   - 한 브라우저가 여러 대의 차를 맡을 수 있음
 *       . 사람 (키보드를 나눠 씀, 화면 분할)   . 컴퓨터(AI)
 *   - 다른 기기(와이파이)의 차는 서버에서 받아서 보간해 그림
 *   - 등수/기록은 서버가 도착 순서와 서버 시각으로 결정 -> SQLite 저장
 *
 *   [변경 이력]
 *   -------------------------------------------------------------------------
 *   v0.1    2006.08.14  박대리    최초 작성 (싱글 플레이만 됨)
 *   v0.2    2006.11.02  박대리    컴퓨터(AI) 차 추가
 *   v0.3    2007.03.20  김과장    화면 분할 (키보드 나눠쓰기) 추가
 *   v0.4    2007.07.11  김과장    서버 동기화 (XMLHttpRequest 폴링) 적용
 *   v0.4.1  2007.07.30  김과장    동기식 XHR -> 비동기로 변경 (IE 멈춤 현상)
 *   v1.0    2007.12.24  이부장님  정식 오픈 !!!
 *   v1.1    2008.04.03  최사원    부스터 / ? 상자 추가
 *   v1.2    2008.09.17  최사원    명예의 전당 (랭킹) 추가
 *   v1.2.1  2009.02.06  김과장    IE6 대응 -> 롤백 (안됨)
 *   v1.3    2009.06.30  외주(정)  난이도 / 자동가속 / 카메라 옵션
 *   v1.3.1  2009.07.02  외주(정)  핫픽스 - 시계 맞추기 (서버 시각) 수정
 *   -------------------------------------------------------------------------
 *
 *   ※ 주의: 전역변수 많음. 함수 순서 바꾸지 말 것 (2007.03 김과장)
 *   ※ TODO: 언젠가 리팩토링... (2008.01 이부장님 지시) <- 아직 못함
 *
 *****************************************************************************/

// ===========================================================================
//  전역 변수 (GLOBALS)
// ===========================================================================
var g_aColors = ["#ff4d4d", "#3d8bff", "#ffd23d", "#3ddc84", "#b26bff", "#ff8c2e", "#2ee6e6", "#ff6fcf"];
// var MAX_PLAYERS = 8;        // 2007.12 그냥 숫자로 씀
// var MAX_LOCAL_HUMANS = 4;   // 2007.12 그냥 숫자로 씀

// 트랙 제어점 (건드리면 트랙 모양 바뀜!!)
var g_aCtrl = [
  [400, 1350], [400, 700], [520, 380], [800, 280], [1150, 330], [1350, 620],
  [1650, 850], [1950, 700], [2150, 420], [2550, 380], [2820, 620], [2800, 1100],
  [2550, 1450], [2150, 1560], [1800, 1400], [1450, 1520], [1100, 1760], [700, 1780], [460, 1620]
];
// 12 = 샘플 간격(px), 95 = 도로 반폭, 75 = 잔디 폭, 170 = 95+75 (그 너머는 벽)
// var SP = 12; var ROAD = 95; var GRASS = 75; var LIMIT = ROAD + GRASS;   // <- 2008.04 숫자로 바꿈 (최사원)

var g_aTrack = [];       // 트랙 점들 (x, y, tx, ty, nx, ny)
var g_nN = 0;            // 트랙 점 개수
var g_aPads = [];        // 부스트 패드 위치 (트랙 인덱스)
var g_aTrees = [];       // 나무들
var g_objBounds = null;  // 미니맵용 범위
var g_objRoadPath = null;
var g_aBoxes = [];       // ? 상자 (줄마다 3개, 먹으면 3초 뒤 다시 생김)

var g_objCanvas = null, g_ctx = null;
var g_nW = 0, g_nH = 0, g_nDpr = 1;
var g_nViewRot = 0, g_nFrameDt = 1 / 60;
var g_nLastT = 0;

// ===========================================================================
//  공통 함수들 (util) - 2007.03 김과장 (IE 때문에 직접 만듦)
// ===========================================================================
function fnHypot(a, b) {
  // IE 에는 Math.hypot 없음
  if (Math.hypot) return Math.hypot(a, b);
  return Math.sqrt(a * a + b * b);
}

function fnTick() {
  // performance.now 없으면 Date 로... (정밀도 떨어짐)
  if (window.performance && window.performance.now) return window.performance.now();
  return new Date().getTime();
}

function fnTrim(str) {
  return String(str).replace(/^\s+|\s+$/g, "");
}

function fnEscHtml(v) {
  // innerHTML 에 넣을 때 꼭 써야 함!! (2008.09 해킹 당할뻔함 - 최사원)
  if (v === null) return "";
  var str = String(v);
  str = str.replace(/&/g, "&amp;");
  str = str.replace(/</g, "&lt;");
  str = str.replace(/>/g, "&gt;");
  str = str.replace(/"/g, "&quot;");
  str = str.replace(/'/g, "&#39;");
  return str;
}

function fnHasClass(objEl, strCls) {
  var strNow = (" " + objEl.className + " ").replace(/[\t\r\n\f]/g, " ");
  return strNow.indexOf(" " + strCls + " ") > -1;
}

function fnAddClass(objEl, strCls) {
  if (fnHasClass(objEl, strCls)) return;
  if (objEl.className == "" || objEl.className == null) objEl.className = strCls;
  else objEl.className = objEl.className + " " + strCls;
}

function fnRemoveClass(objEl, strCls) {
  var tmp = (" " + objEl.className + " ").replace(/[\t\r\n\f]/g, " ");
  while (tmp.indexOf(" " + strCls + " ") > -1) {
    tmp = tmp.replace(" " + strCls + " ", " ");
  }
  objEl.className = fnTrim(tmp);
}

function fnToggleClass(objEl, strCls) {
  if (fnHasClass(objEl, strCls)) fnRemoveClass(objEl, strCls);
  else fnAddClass(objEl, strCls);
}

function fnAddEvent(objEl, strType, fnHandler) {
  if (objEl.addEventListener) {
    objEl.addEventListener(strType, fnHandler, false);
  } else if (objEl.attachEvent) {
    // IE6,7,8
    objEl.attachEvent("on" + strType, function () { fnHandler.call(objEl, window.event); });
  } else {
    objEl["on" + strType] = fnHandler;
  }
}

// ===========================================================================
//  트랙 만들기 (페이지 로딩시 1번)
//  !!! 숫자 하나라도 바꾸면 다른 PC랑 트랙 길이가 달라짐 - 절대 수정 금지 !!!
// ===========================================================================
function fnInitTrack() {
  var aRaw = [], n = g_aCtrl.length, i, j, s, p0, p1, p2, p3, t, t2, t3, tmpX, tmpY;

  // 1) 캣멀-롬 스플라인 (Catmull-Rom)
  for (i = 0; i < n; i++) {
    p0 = g_aCtrl[(i - 1 + n) % n];
    p1 = g_aCtrl[i];
    p2 = g_aCtrl[(i + 1) % n];
    p3 = g_aCtrl[(i + 2) % n];
    for (s = 0; s < 24; s++) {
      t = s / 24;
      t2 = t * t;
      t3 = t2 * t;
      // x 좌표
      tmpX = 0.5 * (2 * p1[0] + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3);
      // y 좌표 (위에꺼 복사함)
      tmpY = 0.5 * (2 * p1[1] + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3);
      aRaw.push([tmpX, tmpY]);
    }
  }

  // 2) 12px 간격으로 다시 찍기
  var aOut = [[aRaw[0][0], aRaw[0][1]]];
  var nNeed = 12, a, b, nLen, nPos;
  for (i = 0; i < aRaw.length; i++) {
    a = aRaw[i];
    b = aRaw[(i + 1) % aRaw.length];
    nLen = fnHypot(b[0] - a[0], b[1] - a[1]);
    nPos = 0;
    while (nLen - nPos >= nNeed) {
      nPos += nNeed;
      t = nPos / nLen;
      aOut.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      nNeed = 12;
    }
    nNeed -= nLen - nPos;
  }
  var objLast = aOut[aOut.length - 1];
  if (fnHypot(objLast[0] - aOut[0][0], objLast[1] - aOut[0][1]) < 6) aOut.pop();

  // 3) 방향 / 법선 구하기
  var m = aOut.length, tx, ty;
  g_aTrack = [];
  for (i = 0; i < m; i++) {
    a = aOut[(i - 1 + m) % m];
    b = aOut[(i + 1) % m];
    nLen = fnHypot(b[0] - a[0], b[1] - a[1]);
    tx = (b[0] - a[0]) / nLen;
    ty = (b[1] - a[1]) / nLen;
    g_aTrack.push({ x: aOut[i][0], y: aOut[i][1], tx: tx, ty: ty, nx: -ty, ny: tx });
  }
  g_nN = g_aTrack.length;

  // 4) 부스트 패드
  g_aPads = [];
  g_aPads.push(Math.round(g_nN * 0.17));
  g_aPads.push(Math.round(g_nN * 0.43));
  g_aPads.push(Math.round(g_nN * 0.7));

  // 5) 나무 (seed 고정 - 모든 PC 똑같이 나옴)
  var nSeed = 7, x, y, nBest, q, k;
  g_aTrees = [];
  for (k = 0; k < 900 && g_aTrees.length < 170; k++) {
    nSeed = (nSeed * 16807) % 2147483647;
    x = -300 + (nSeed / 2147483647) * 3500;
    nSeed = (nSeed * 16807) % 2147483647;
    y = -200 + (nSeed / 2147483647) * 2300;
    nBest = 1e9;
    for (j = 0; j < g_aTrack.length; j++) {
      q = g_aTrack[j];
      nBest = Math.min(nBest, Math.pow(q.x - x, 2) + Math.pow(q.y - y, 2));
    }
    if (Math.sqrt(nBest) > 220) {   // 170 + 50
      nSeed = (nSeed * 16807) % 2147483647;
      g_aTrees.push({ x: x, y: y, r: 22 + (nSeed / 2147483647) * 22 });
    }
  }

  // 6) 범위 (미니맵)
  g_objBounds = { x0: 1e9, y0: 1e9, x1: -1e9, y1: -1e9 };
  for (i = 0; i < g_aTrack.length; i++) {
    g_objBounds = {
      x0: Math.min(g_objBounds.x0, g_aTrack[i].x), y0: Math.min(g_objBounds.y0, g_aTrack[i].y),
      x1: Math.max(g_objBounds.x1, g_aTrack[i].x), y1: Math.max(g_objBounds.y1, g_aTrack[i].y)
    };
  }

  // 7) 도로 패스
  g_objRoadPath = new Path2D();
  for (i = 0; i < g_aTrack.length; i++) {
    if (i) g_objRoadPath.lineTo(g_aTrack[i].x, g_aTrack[i].y);
    else g_objRoadPath.moveTo(g_aTrack[i].x, g_aTrack[i].y);
  }
  g_objRoadPath.closePath();
}
fnInitTrack();

function fnGridPos(nSlot) {
  var nRow = Math.floor(nSlot / 2), nCol = nSlot % 2;
  var nBack = Math.round((60 + nRow * 75) / 12);
  var i = g_nN - nBack;
  var q = g_aTrack[i], nLat = nCol ? 40 : -40;
  return { x: q.x + q.nx * nLat, y: q.y + q.ny * nLat, a: Math.atan2(q.ty, q.tx), i: i, back: nBack };
}

// ===========================================================================
//  조작키
// ===========================================================================
var g_objSchemes = {
  all:    { label: "방향키 / WASD", nlabel: "Space", up: ["ArrowUp", "KeyW"], down: ["ArrowDown", "KeyS"], left: ["ArrowLeft", "KeyA"], right: ["ArrowRight", "KeyD"], nitro: ["Space", "ShiftLeft", "ShiftRight"] },
  wasd:   { label: "W A S D",       nlabel: "Shift", up: ["KeyW"], down: ["KeyS"], left: ["KeyA"], right: ["KeyD"], nitro: ["ShiftLeft", "KeyQ", "Space"] },
  arrows: { label: "방향키",         nlabel: "Enter", up: ["ArrowUp"], down: ["ArrowDown"], left: ["ArrowLeft"], right: ["ArrowRight"], nitro: ["Enter", "ShiftRight", "Slash"] },
  ijkl:   { label: "I J K L",       nlabel: "U",     up: ["KeyI"], down: ["KeyK"], left: ["KeyJ"], right: ["KeyL"], nitro: ["KeyU", "KeyO"] },
  numpad: { label: "숫자패드 8 4 5 6", nlabel: "0",  up: ["Numpad8"], down: ["Numpad5", "Numpad2"], left: ["Numpad4"], right: ["Numpad6"], nitro: ["Numpad0", "NumpadEnter"] }
};
var g_aSplitOrder = ["wasd", "arrows", "ijkl", "numpad"];
var g_objGameCodes = {};
var g_objPressed = {};
var g_objTouchKeys = { up: false, down: false, left: false, right: false, nitro: false };

(function () {
  var strKey, i, objSc;
  for (strKey in g_objSchemes) {
    objSc = g_objSchemes[strKey];
    for (i = 0; i < objSc.up.length; i++) g_objGameCodes[objSc.up[i]] = true;
    for (i = 0; i < objSc.down.length; i++) g_objGameCodes[objSc.down[i]] = true;
    for (i = 0; i < objSc.left.length; i++) g_objGameCodes[objSc.left[i]] = true;
    for (i = 0; i < objSc.right.length; i++) g_objGameCodes[objSc.right[i]] = true;
    for (i = 0; i < objSc.nitro.length; i++) g_objGameCodes[objSc.nitro[i]] = true;
  }
})();

// ===========================================================================
//  난이도 / 옵션
// ===========================================================================
var g_objDiff = {
  //        grip: 미끄러짐(클수록 착 붙음)  turn: 핸들  grass: 잔디 속도  wall: 벽에 닿아도 유지되는 속도
  //        assist: 자동 핸들 보조  charge: 부스터 1칸 차는 시간(초)  ai: 컴퓨터 실력
  easy:   { grip: 14, turn: 2.5, grass: 0.8, wall: 0.97, assist: 2.4, charge: 6,  start: 2, ai: [0.58, 0.68], aiNitro: 0.15 },
  normal: { grip: 10, turn: 2.7, grass: 0.6, wall: 0.9,  assist: 0.9, charge: 9,  start: 1, ai: [0.75, 0.87], aiNitro: 0.5 },
  hard:   { grip: 7,  turn: 2.9, grass: 0.4, wall: 0.8,  assist: 0,   charge: 12, start: 0, ai: [0.92, 1.00], aiNitro: 1 }
  // ,crazy: { grip: 3, turn: 3.5, ... }   // 2009.06 외주(정) - 너무 어려워서 뺌
};

function fnGetDiff() {
  return g_objDiff[(g_S && g_S.settings && g_S.settings.difficulty) || "easy"] || g_objDiff.easy;
}

var g_objOpts = { rotate: true, autoGas: false };
var tmpOpt = {};
try { tmpOpt = JSON.parse(localStorage.getItem("tr_opts")) || {}; } catch (e) { /* 무시 */ }
g_objOpts.rotate = tmpOpt.rotate !== false;
g_objOpts.autoGas = !!tmpOpt.autoGas;

function fnSaveOpts() {
  try { localStorage.setItem("tr_opts", JSON.stringify(g_objOpts)); } catch (e) { /* 무시 */ }
}

// ? 상자 - 줄 4개 x 3개
(function () {
  var aRows = [Math.round(g_nN * 0.09), Math.round(g_nN * 0.32), Math.round(g_nN * 0.56), Math.round(g_nN * 0.84)];
  var aLat = [-55, 0, 55], i, j, nIdx;
  for (i = 0; i < aRows.length; i++) {
    nIdx = aRows[i];
    for (j = 0; j < aLat.length; j++) {
      g_aBoxes.push({ x: g_aTrack[nIdx].x + g_aTrack[nIdx].nx * aLat[j], y: g_aTrack[nIdx].y + g_aTrack[nIdx].ny * aLat[j], back: 0 });
    }
  }
})();
// var MAX_CHARGES = 3;   // -> 3 으로 씀

// ===========================================================================
//  상태 (STATE)
//  g_aLocals: 이 브라우저가 맡은 플레이어들 {id, ai, skill, lane, car, cam, ...}
// ===========================================================================
function fnNewLocal(o) {
  return { id: o.id, ai: !!o.ai, skill: 0.8 + Math.random() * 0.13, lane: (Math.random() - 0.5) * 70,
           car: null, cam: { x: 0, y: 0, z: 1 }, stuck: 0, rev: 0 };
}

var g_aLocals = [];
try {
  var tmpList = JSON.parse(sessionStorage.getItem("tr_locals")) || [];
  if (Object.prototype.toString.call(tmpList) != "[object Array]") throw new Error("not array");
  for (var cnt = 0; cnt < tmpList.length; cnt++) g_aLocals.push(fnNewLocal(tmpList[cnt]));
} catch (e) {
  g_aLocals = [];
}

var g_strMyColor = localStorage.getItem("tr_color") || g_aColors[Math.floor(Math.random() * 8)];
var g_S = null;            // 서버 상태 (state)
var g_nOffset = 0;         // 서버 시계 - 내 시계 (초)
var g_nBestRtt = 1e9;
var g_strScreen = "join";
var g_objRemotes = {};     // 다른 기기 차들
var g_bBusy = false;       // 폴링 중복 방지 플래그
var g_nLastPoll = 0;

function fnServerNow() {
  return new Date().getTime() / 1000 + g_nOffset;
}

function getHumans() {
  var aRet = [], i;
  for (i = 0; i < g_aLocals.length; i++) {
    if (!g_aLocals[i].ai) aRet.push(g_aLocals[i]);
  }
  return aRet;
}

function fnLocalOf(id) {
  var i;
  for (i = 0; i < g_aLocals.length; i++) {
    if (g_aLocals[i].id == id) return g_aLocals[i];
  }
  return undefined;
}

function fnPinfo(id) {
  var objP = null, i;
  if (g_S) {
    for (i = 0; i < g_S.players.length; i++) {
      if (g_S.players[i].id == id) { objP = g_S.players[i]; break; }
    }
  }
  return objP || {};
}

function fnSchemeOf(l) {
  var aHs = getHumans(), i, nIdx = -1;
  if (aHs.length <= 1) return "all";
  for (i = 0; i < aHs.length; i++) {
    if (aHs[i] == l) { nIdx = i; break; }
  }
  return g_aSplitOrder[nIdx] || "wasd";
}

function fnSaveLocals() {
  try {
    var aTmp = [], i;
    for (i = 0; i < g_aLocals.length; i++) aTmp.push({ id: g_aLocals[i].id, ai: g_aLocals[i].ai });
    sessionStorage.setItem("tr_locals", JSON.stringify(aTmp));
  } catch (e) { /* 무시 */ }
}

// ===========================================================================
//  네트워크 (AJAX)
//  2007.07 김과장: 처음엔 동기식이었는데 IE 가 멈춰서 비동기로 바꿈
//  FIXME: 시계 맞추는 코드(clock sync)가 여러군데 복붙되어 있음. 고칠때 다 고칠것!!
// ===========================================================================
function fnAjaxApi(strUrl, objBody, objCallback) {
  var xhr = window.XMLHttpRequest ? new XMLHttpRequest() : new ActiveXObject("Microsoft.XMLHTTP");
  var t0 = new Date().getTime();
  if (objBody === undefined) {
    xhr.open("GET", strUrl, true);
  } else {
    xhr.open("POST", strUrl, true);
    xhr.setRequestHeader("Content-Type", "application/json");
  }
  // xhr.open("POST", strUrl, false);   // 동기식 - 쓰지 말것 (2007.07)
  xhr.onreadystatechange = function () {
    if (xhr.readyState != 4) return;
    var objRes = null, objErr = null, t1, nRtt;
    try {
      if (xhr.status == 0) throw new TypeError("Failed to fetch");
      objRes = JSON.parse(xhr.responseText);
      t1 = new Date().getTime();
      if (objRes && typeof objRes.now == "number") {
        nRtt = t1 - t0;
        if (nRtt <= g_nBestRtt * 1.3 + 5) {
          g_nBestRtt = Math.min(g_nBestRtt, nRtt);
          g_nOffset = objRes.now - (t0 + t1) / 2000;
        }
      }
      if (xhr.status < 200 || xhr.status > 299) throw new Error(objRes.error || "오류");
    } catch (e) {
      objErr = e;
    }
    if (objErr) {
      if (objCallback && objCallback.failure) objCallback.failure(objErr);
    } else {
      if (objCallback && objCallback.success) objCallback.success(objRes);
    }
  };
  xhr.send(objBody === undefined ? null : JSON.stringify(objBody));
}

// 폴링 - 레이스중 60ms, 아니면 500ms. (30ms 타이머로 체크)
function fnNetTick() {
  if (g_bBusy || g_strScreen == "join" || !g_aLocals.length) return;
  var nNow = new Date().getTime();
  var bRacing = g_strScreen == "game" && g_S && g_S.phase == "racing";
  if (nNow - g_nLastPoll < (bRacing ? 60 : 500)) return;
  g_nLastPoll = nNow;
  g_bBusy = true;
  try {
    var aCars = [], aIds = [], i, l;
    if (bRacing) {
      for (i = 0; i < g_aLocals.length; i++) {
        l = g_aLocals[i];
        if (l.car && !l.car.finished) {
          aCars.push({
            id: l.id, x: +l.car.x.toFixed(1), y: +l.car.y.toFixed(1), a: +l.car.a.toFixed(3),
            v: +l.car.fwd.toFixed(1), progress: +(l.car.dist / g_nN).toFixed(4), lap: l.car.lap
          });
        }
      }
    }
    for (i = 0; i < g_aLocals.length; i++) aIds.push(g_aLocals[i].id);

    // ---- XHR (fnAjaxApi 랑 똑같음. 2007.07 급해서 복붙) ----
    var xhr = window.XMLHttpRequest ? new XMLHttpRequest() : new ActiveXObject("Microsoft.XMLHTTP");
    var t0 = new Date().getTime();
    xhr.open("POST", "/api/update", true);
    xhr.setRequestHeader("Content-Type", "application/json");
    xhr.onreadystatechange = function () {
      if (xhr.readyState != 4) return;
      var objRes = null, objErr = null, t1, nRtt;
      try {
        if (xhr.status == 0) throw new TypeError("Failed to fetch");
        objRes = JSON.parse(xhr.responseText);
        t1 = new Date().getTime();
        if (objRes && typeof objRes.now == "number") {
          nRtt = t1 - t0;
          if (nRtt <= g_nBestRtt * 1.3 + 5) {
            g_nBestRtt = Math.min(g_nBestRtt, nRtt);
            g_nOffset = objRes.now - (t0 + t1) / 2000;
          }
        }
        if (xhr.status < 200 || xhr.status > 299) throw new Error(objRes.error || "오류");
      } catch (e) {
        objErr = e;
      }
      if (objErr) {
        if (window.console) console.warn(objErr);
        g_bBusy = false;
        return;
      }
      try {
        fnOnState(objRes);
      } catch (e2) {
        if (window.console) console.warn(e2);
      }
      g_bBusy = false;
    };
    xhr.send(JSON.stringify({ ids: aIds, cars: aCars }));
  } catch (e) {
    if (window.console) console.warn(e);
    g_bBusy = false;
  }
}
setInterval(fnNetTick, 30);

// 서버에서 상태 받으면 여기로 옴 (중요!!)
function fnOnState(s) {
  g_S = s;
  if (g_strScreen == "join") return;
  var objIds = {}, i, p, r, g, bStarted, tx, ty, ta, nBefore, aTmp, strId;
  for (i = 0; i < s.players.length; i++) objIds[s.players[i].id] = true;
  nBefore = g_aLocals.length;
  aTmp = [];
  for (i = 0; i < g_aLocals.length; i++) {
    if (objIds[g_aLocals[i].id] === true) aTmp.push(g_aLocals[i]);
  }
  g_aLocals = aTmp;
  if (g_aLocals.length != nBefore) fnSaveLocals();
  if (!getHumans().length) {
    // 사람이 다 빠졌으면 컴퓨터도 다 빼고 처음 화면으로
    for (i = 0; i < g_aLocals.length; i++) {
      fnAjaxApi("/api/leave", { id: g_aLocals[i].id }, { success: function () {}, failure: function () {} });
    }
    g_aLocals = [];
    fnSaveLocals();
    fnShowScreen("join");
    document.getElementById("joinErr").innerHTML = "연결이 끊겨 대기실에서 나왔어요. 다시 참가해 주세요.";
    return;
  }
  for (i = 0; i < s.players.length; i++) {
    p = s.players[i];
    if (fnLocalOf(p.id)) continue;
    r = g_objRemotes[p.id];
    g = fnGridPos(p.slot);
    bStarted = p.progress > -1 || p.x !== 0;
    tx = bStarted ? p.x : g.x;
    ty = bStarted ? p.y : g.y;
    ta = bStarted ? p.a : g.a;
    if (!r) r = g_objRemotes[p.id] = { x: tx, y: ty, a: ta };
    r.tx = tx;
    r.ty = ty;
    r.ta = ta;
    r.tv = p.v;
    r.t = fnTick();
  }
  for (strId in g_objRemotes) {
    if (objIds[strId] !== true || fnLocalOf(strId)) delete g_objRemotes[strId];
  }

  if (s.phase == "lobby") {
    if (g_strScreen != "lobby") fnShowScreen("lobby");
    fnRenderLobby();
  } else if (s.phase == "racing") {
    if (g_strScreen != "game") fnStartRace();
  } else if (s.phase == "finished") {
    if (g_strScreen != "results") { fnShowScreen("results"); fnRenderResults(); }
  }
  // else { alert("알수없는 phase: " + s.phase); }   // 디버그용 2007.08
}

// ===========================================================================
//  화면 전환 / 공통
// ===========================================================================
function fnShowScreen(strName) {
  g_strScreen = strName;
  var aAll = document.getElementsByTagName("*"), i;
  for (i = 0; i < aAll.length; i++) {
    if (fnHasClass(aAll[i], "screen")) {
      if (aAll[i].id == strName) fnAddClass(aAll[i], "active");
      else fnRemoveClass(aAll[i], "active");
    }
  }
  if (strName == "game") fnResize();
}

function fnFmtTime(ms) {
  if (ms == null) return "-";
  var m = Math.floor(ms / 60000), s = (ms % 60000) / 1000;
  strSec = s.toFixed(3);    // HACK: var 빠졌는데 잘 돌아가서 그냥 둠 (2008.09)
  while (strSec.length < 6) strSec = "0" + strSec;
  return m + ":" + strSec;
}

// ===========================================================================
//  참가 화면 (join)
// ===========================================================================
document.getElementById("nameInput").value = localStorage.getItem("tr_name") || "";

function fnRenderColors() {
  var objBox = document.getElementById("colorPick");
  var strHtml = "", i;
  for (i = 0; i < 8; i++) {
    strHtml += '<button class="' + (g_aColors[i] == g_strMyColor ? "sel" : "") + '" style="background:' + g_aColors[i] + '" title="' + g_aColors[i] + '"></button>';
  }
  objBox.innerHTML = strHtml;
  var aBtns = objBox.getElementsByTagName("button");
  for (i = 0; i < aBtns.length; i++) {
    (function (strC) {
      aBtns[i].onclick = function () {
        g_strMyColor = strC;
        localStorage.setItem("tr_color", strC);
        fnRenderColors();
      };
    })(g_aColors[i]);
  }
}
fnRenderColors();

// 플레이어 추가 (사람/컴퓨터 공통)
function fnAddLocal(objBody, fnOnErr, fnFinally) {
  // ---- XHR 복붙 (2007.07) ----
  var xhr = window.XMLHttpRequest ? new XMLHttpRequest() : new ActiveXObject("Microsoft.XMLHTTP");
  var t0 = new Date().getTime();
  xhr.open("POST", "/api/join", true);
  xhr.setRequestHeader("Content-Type", "application/json");
  xhr.onreadystatechange = function () {
    if (xhr.readyState != 4) return;
    var objRes = null, objErr = null, t1, nRtt;
    try {
      if (xhr.status == 0) throw new TypeError("Failed to fetch");
      objRes = JSON.parse(xhr.responseText);
      t1 = new Date().getTime();
      if (objRes && typeof objRes.now == "number") {
        nRtt = t1 - t0;
        if (nRtt <= g_nBestRtt * 1.3 + 5) {
          g_nBestRtt = Math.min(g_nBestRtt, nRtt);
          g_nOffset = objRes.now - (t0 + t1) / 2000;
        }
      }
      if (xhr.status < 200 || xhr.status > 299) throw new Error(objRes.error || "오류");
    } catch (e) {
      objErr = e;
    }
    if (objErr) {
      fnOnErr(objErr);
    } else {
      try {
        if (!fnLocalOf(objRes.me)) g_aLocals.push(fnNewLocal({ id: objRes.me, ai: objBody.ai }));
        fnSaveLocals();
        if (g_strScreen == "join") fnShowScreen("lobby");
        fnOnState(objRes);
      } catch (e2) {
        fnOnErr(e2);
      }
    }
    if (fnFinally) fnFinally();
  };
  xhr.send(JSON.stringify(objBody));
}

document.getElementById("joinBtn").onclick = function () {
  var strName = fnTrim(document.getElementById("nameInput").value);
  if (!strName) { document.getElementById("joinErr").innerHTML = "닉네임을 입력해 주세요"; return; }
  localStorage.setItem("tr_name", strName);
  document.getElementById("joinErr").innerHTML = "";
  document.getElementById("joinBtn").disabled = true;
  fnAddLocal({ name: strName, color: g_strMyColor }, function (e) {
    document.getElementById("joinErr").innerHTML = fnEscHtml(e.message);
  }, function () {
    document.getElementById("joinBtn").disabled = false;
  });
};
fnAddEvent(document.getElementById("nameInput"), "keydown", function (e) {
  e = e || window.event;
  if (e.key == "Enter" && !e.isComposing) document.getElementById("joinBtn").click();
});

// ===========================================================================
//  대기실 (lobby)
// ===========================================================================
function fnRenderLobby() {
  var objUl = document.getElementById("lobbyList");
  var aPs = [], i, p, l, strTag, bCanRemove, nHsIdx, strHtml = "";
  var aHs = getHumans();
  var aRm = [];   // 빼기 버튼 순서대로 local 저장
  for (i = 0; i < g_S.players.length; i++) aPs.push(g_S.players[i]);
  aPs.sort(function (a, b) { return a.slot - b.slot; });
  for (i = 0; i < aPs.length; i++) {
    p = aPs[i];
    l = fnLocalOf(p.id);
    nHsIdx = -1;
    if (l) {
      for (cnt2 = 0; cnt2 < aHs.length; cnt2++) {   // FIXME var cnt2 빠짐?? (2008.11 김과장)
        if (aHs[cnt2] == l) { nHsIdx = cnt2; break; }
      }
    }
    if (p.ai) strTag = "🤖 컴퓨터";
    else if (l) strTag = aHs.length > 1 ? "⌨ " + g_objSchemes[fnSchemeOf(l)].label : "";
    else strTag = "📶 다른 기기";
    bCanRemove = l && (l.ai || nHsIdx > 0);
    strHtml += '<li>';
    strHtml += '<span class="dot" style="background:' + fnEscHtml(p.color) + '"></span>';
    strHtml += '<span>' + fnEscHtml(p.name) + '</span>';
    strHtml += '<span class="tag">' + fnEscHtml(strTag) + '</span>';
    if (l && !l.ai && nHsIdx == 0) strHtml += '<span class="me">나</span>';
    if (bCanRemove) {
      strHtml += '<button class="x" title="빼기">✕</button>';
      aRm.push(l);
    }
    strHtml += '</li>';
  }
  objUl.innerHTML = strHtml;
  var aBtns = objUl.getElementsByTagName("button");
  for (i = 0; i < aBtns.length; i++) {
    (function (objL) {
      aBtns[i].onclick = function () { fnRemoveLocal(objL); };
    })(aRm[i]);
  }
  document.getElementById("lobbyCount").innerHTML = aPs.length;
  document.getElementById("addLocalBtn").disabled = aHs.length >= 4 || aPs.length >= 8;
  document.getElementById("addBotBtn").disabled = aPs.length >= 8;
  if (aHs.length > 1) {
    document.getElementById("lobbyHint").innerHTML = "한 PC 화면 분할 · 키보드를 나눠 써요 (키 배정은 목록 오른쪽)";
  } else {
    document.getElementById("lobbyHint").innerHTML = "혼자서도 OK! 방향키/WASD · 휴대폰은 화면 버튼 · 컴퓨터를 추가해 보세요";
  }
  fnRenderOptions();
}

function fnRenderOptions() {
  var st = (g_S && g_S.settings) || { laps: 3, difficulty: "easy" };
  var aB, i;
  // 난이도
  aB = document.getElementById("optDiff").getElementsByTagName("button");
  for (i = 0; i < aB.length; i++) {
    if (aB[i].getAttribute("data-v") == String(st.difficulty)) fnAddClass(aB[i], "sel");
    else fnRemoveClass(aB[i], "sel");
  }
  // 바퀴수 (위에꺼 복사)
  aB = document.getElementById("optLaps").getElementsByTagName("button");
  for (i = 0; i < aB.length; i++) {
    if (aB[i].getAttribute("data-v") == String(st.laps)) fnAddClass(aB[i], "sel");
    else fnRemoveClass(aB[i], "sel");
  }
  // 카메라 (복사)
  aB = document.getElementById("optCam").getElementsByTagName("button");
  for (i = 0; i < aB.length; i++) {
    if (aB[i].getAttribute("data-v") == String(g_objOpts.rotate ? "rotate" : "fixed")) fnAddClass(aB[i], "sel");
    else fnRemoveClass(aB[i], "sel");
  }
  // 자동가속 (복사) - 2009.06 외주(정)
  aB = document.getElementById("optAuto").getElementsByTagName("button");
  for (i = 0; i < aB.length; i++) {
    if (aB[i].getAttribute("data-v") == String(g_objOpts.autoGas ? "on" : "off")) fnAddClass(aB[i], "sel");
    else fnRemoveClass(aB[i], "sel");
  }
  document.getElementById("lobbyLaps").innerHTML = st.laps;
}

function fnSetRoom(objChange) {
  var objBody, k;
  try {
    objBody = { id: getHumans()[0].id };
    for (k in objChange) objBody[k] = objChange[k];
  } catch (e) {
    alert(e.message);
    return;
  }
  fnAjaxApi("/api/settings", objBody, {
    success: function (s) {
      try { fnOnState(s); } catch (e) { alert(e.message); }
    },
    failure: function (e) { alert(e.message); }
  });
}

(function () {
  var aB, i;
  aB = document.getElementById("optDiff").getElementsByTagName("button");
  for (i = 0; i < aB.length; i++) {
    (function (b) {
      b.onclick = function () { fnSetRoom({ difficulty: b.getAttribute("data-v") }); };
    })(aB[i]);
  }
  aB = document.getElementById("optLaps").getElementsByTagName("button");
  for (i = 0; i < aB.length; i++) {
    (function (b) {
      b.onclick = function () { fnSetRoom({ laps: +b.getAttribute("data-v") }); };
    })(aB[i]);
  }
  aB = document.getElementById("optCam").getElementsByTagName("button");
  for (i = 0; i < aB.length; i++) {
    (function (b) {
      b.onclick = function () { g_objOpts.rotate = b.getAttribute("data-v") == "rotate"; fnSaveOpts(); fnRenderOptions(); };
    })(aB[i]);
  }
  aB = document.getElementById("optAuto").getElementsByTagName("button");
  for (i = 0; i < aB.length; i++) {
    (function (b) {
      b.onclick = function () { g_objOpts.autoGas = b.getAttribute("data-v") == "on"; fnSaveOpts(); fnRenderOptions(); };
    })(aB[i]);
  }
})();

function fnRemoveLocal(l) {
  var fnAfter = function () {
    var aTmp = [], i;
    for (i = 0; i < g_aLocals.length; i++) {
      if (g_aLocals[i] !== l) aTmp.push(g_aLocals[i]);
    }
    g_aLocals = aTmp;
    fnSaveLocals();
    if (g_S) {
      aTmp = [];
      for (i = 0; i < g_S.players.length; i++) {
        if (g_S.players[i].id !== l.id) aTmp.push(g_S.players[i]);
      }
      g_S.players = aTmp;
      fnRenderLobby();
    }
  };
  // 실패해도 그냥 뺌
  fnAjaxApi("/api/leave", { id: l.id }, { success: fnAfter, failure: fnAfter });
}

document.getElementById("addLocalBtn").onclick = function () {
  fnToggleClass(document.getElementById("addLocalForm"), "open");
  document.getElementById("localName").value = "";
  document.getElementById("localName").focus();
};
document.getElementById("localOk").onclick = function () {
  var strName = fnTrim(document.getElementById("localName").value) || "플레이어" + (getHumans().length + 1);
  fnRemoveClass(document.getElementById("addLocalForm"), "open");
  fnAddLocal({ name: strName }, function (e) { alert(e.message); });
};
fnAddEvent(document.getElementById("localName"), "keydown", function (e) {
  e = e || window.event;
  if (e.key == "Enter" && !e.isComposing) document.getElementById("localOk").click();
});

document.getElementById("addBotBtn").onclick = function () {
  var objNames = {}, k = 1, i;
  for (i = 0; i < g_S.players.length; i++) objNames[g_S.players[i].name] = true;
  while (objNames["컴퓨터" + k] === true) k++;
  fnAddLocal({ name: "컴퓨터" + k, ai: true }, function (e) { alert(e.message); });
};

document.getElementById("startBtn").onclick = function () {
  var objBody;
  try { objBody = { id: getHumans()[0].id }; } catch (e) { alert(e.message); return; }
  fnAjaxApi("/api/start", objBody, {
    success: function (s) {
      try { fnOnState(s); } catch (e) { alert(e.message); }
    },
    failure: function (e) { alert(e.message); }
  });
};

document.getElementById("leaveBtn").onclick = function () {
  var aTodo = g_aLocals, nTotal = aTodo.length, nDone = 0, i;
  var fnAllDone = function () {
    g_aLocals = [];
    fnSaveLocals();
    fnShowScreen("join");
  };
  var fnOne = function () {
    nDone++;
    if (nDone == nTotal) fnAllDone();
  };
  if (nTotal == 0) { fnAllDone(); return; }
  for (i = 0; i < nTotal; i++) {
    fnAjaxApi("/api/leave", { id: aTodo[i].id }, { success: fnOne, failure: fnOne });
  }
};

// ===========================================================================
//  결과 화면
// ===========================================================================
function fnRenderResults() {
  var rs = g_S.results || [];
  var objPod = document.getElementById("podium");
  var aRanks = [2, 1, 3], strHtml = "", i, j, r, nRank, strNm;
  for (i = 0; i < aRanks.length; i++) {
    nRank = aRanks[i];
    r = undefined;
    for (j = 0; j < rs.length; j++) {
      if (rs[j].rank === nRank) { r = rs[j]; break; }
    }
    if (!r) { strHtml += '<div class="pod"></div>'; continue; }
    strNm = (r.ai ? "🤖 " : "") + r.name;
    strHtml += '<div class="pod p' + nRank + '">';
    strHtml += '<div class="name">' + fnEscHtml(strNm) + '</div>';
    strHtml += '<div class="car" style="background:' + fnEscHtml(r.color) + '"></div>';
    strHtml += '<div class="block">' + nRank + '<div class="t">' + fnEscHtml(fnFmtTime(r.time_ms)) + '</div></div>';
    strHtml += '</div>';
  }
  objPod.innerHTML = strHtml;

  strHtml = "";
  for (i = 0; i < rs.length; i++) {
    r = rs[i];
    strNm = (r.ai ? "🤖 " : "") + r.name;   // 위에꺼 복사
    strHtml += '<tr>';
    strHtml += '<td>' + fnEscHtml(r.finished ? r.rank + "등" : "리타이어") + '</td>';
    strHtml += '<td><span class="sw" style="background:' + fnEscHtml(r.color) + '"></span>' + fnEscHtml(strNm) + '</td>';
    strHtml += '<td>' + fnEscHtml(fnFmtTime(r.time_ms)) + '</td>';
    strHtml += '</tr>';
  }
  document.getElementById("resultRows").innerHTML = strHtml;
}

document.getElementById("againBtn").onclick = function () {
  var objBody;
  try { objBody = { id: getHumans()[0].id }; } catch (e) { alert(e.message); return; }
  fnAjaxApi("/api/reset", objBody, {
    success: function (s) {
      try { fnOnState(s); } catch (e) { alert(e.message); }
    },
    failure: function (e) { alert(e.message); }
  });
};

// ---------------------------------------------------------------------------
//  명예의 전당 (2008.09 최사원)
// ---------------------------------------------------------------------------
function fnOpenBoard() {
  fnAddClass(document.getElementById("board"), "active");
  fnAjaxApi("/api/leaderboard", undefined, {
    success: function (d) {
      var i, r, strHtml;
      document.getElementById("boardTotal").innerHTML = fnEscHtml("지금까지 " + d.total_races + "번의 레이스 (컴퓨터 기록은 제외)");
      strHtml = "";
      for (i = 0; i < d.best.length; i++) {
        r = d.best[i];
        strHtml += '<tr><td>' + (i + 1) + '</td>' +
                   '<td><span class="sw" style="background:' + fnEscHtml(r.color) + '"></span>' + (r.player_name == null ? "" : fnEscHtml(r.player_name)) + '</td>' +
                   '<td>' + fnEscHtml(fnFmtTime(r.time_ms)) + '</td></tr>';
      }
      if (!d.best.length) strHtml += '<tr><td colspan="3">아직 기록이 없어요</td></tr>';
      document.getElementById("bestRows").innerHTML = strHtml;
      strHtml = "";
      for (i = 0; i < d.wins.length; i++) {
        r = d.wins[i];
        strHtml += '<tr><td>' + fnEscHtml(r.player_name) + '</td><td>' + fnEscHtml(r.gold) + '</td>' +
                   '<td>' + fnEscHtml(r.silver) + '</td><td>' + fnEscHtml(r.bronze) + '</td><td>' + fnEscHtml(r.races) + '</td></tr>';
      }
      document.getElementById("winRows").innerHTML = strHtml;
    },
    failure: function (e) {
      // TODO: 에러 메시지 보여주기 (2008.09) -> 아직 안함
    }
  });
}

(function () {
  var aAll = document.getElementsByTagName("*"), i;
  for (i = 0; i < aAll.length; i++) {
    if (aAll[i].getAttribute("data-show-board") !== null) aAll[i].onclick = fnOpenBoard;
  }
})();
document.getElementById("boardClose").onclick = function () {
  fnRemoveClass(document.getElementById("board"), "active");
};

// ===========================================================================
//  레이스
// ===========================================================================
function fnStartRace() {
  var D = fnGetDiff(), i, l, g;
  for (i = 0; i < g_aLocals.length; i++) {
    l = g_aLocals[i];
    g = fnGridPos(fnPinfo(l.id).slot || 0);
    l.car = { x: g.x, y: g.y, a: g.a, vx: 0, vy: 0, fwd: 0, idx: g.i, dist: -g.back, lap: 0, lat: 0,
              steer: 0, boost: 0, boostMax: 1, grass: false, finished: false, rank: null, err: null,
              charges: D.start, gauge: 0, nitroHeld: false, pops: [] };
    l.cam = { x: g.x, y: g.y, z: 1, a: g.a };
    l.stuck = 0;
    l.rev = 0;
    l.skill = D.ai[0] + Math.random() * (D.ai[1] - D.ai[0]);
  }
  for (i = 0; i < g_aBoxes.length; i++) g_aBoxes[i].back = 0;
  fnShowScreen("game");
}

/*****************************************************************************
 *  물리 계산 (PHYSICS)
 *
 *  !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
 *  !!!  DO NOT TOUCH  -  절대 수정 금지  !!!
 *  !!!  숫자 하나만 바꿔도 컴퓨터 차가 전부 벽에 박음 (2008.04 최사원)   !!!
 *  !!!  540 = 최고속도, 430 = 가속, 800 = 브레이크, 160 = 후진          !!!
 *  !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
 *****************************************************************************/
function fnPhysics(l, inp, dt) {
  var car = l.car, D = fnGetDiff(), i;
  var bStarted = fnServerNow() >= g_S.start_at;
  var bCtl = bStarted && !car.finished;
  var ca = Math.cos(car.a), sa = Math.sin(car.a);
  var fwd = car.vx * ca + car.vy * sa;
  var side = -car.vx * sa + car.vy * ca;

  var bBoosting = car.boost > 0;
  car.boost = Math.max(0, car.boost - dt);
  var maxv = bBoosting ? 540 * 1.45 : car.grass ? 540 * D.grass : 540;

  if (bCtl && inp.up) fwd += (bBoosting ? 430 * 2 : 430) * dt;
  else if (bCtl && inp.down) fwd -= (fwd > 0 ? 800 : 430 * 0.6) * dt;
  else fwd -= fwd * Math.min(1, 0.9 * dt);
  if (bBoosting && bCtl) fwd = Math.max(fwd, 540 * 1.2);
  if (fwd > maxv) fwd -= (fwd - maxv) * Math.min(1, 3 * dt);
  if (fwd < -160) fwd = -160;
  side -= side * Math.min(1, D.grip * dt);

  // 핸들: 부드럽게 꺾이고, 빠를수록 살짝 덜 꺾임
  var want = bCtl ? (inp.right ? 1 : 0) - (inp.left ? 1 : 0) : 0;
  car.steer += (want - car.steer) * Math.min(1, dt * 9);
  var k = Math.max(-1, Math.min(1, fwd / 160)) * (1 - 0.25 * Math.min(1, Math.abs(fwd) / 540));
  car.a += car.steer * D.turn * dt * k;

  // 자동 핸들 보조: 길 가장자리로 가면 도로 쪽으로 살짝 돌려줌 (핸들 안 꺾을 때만)
  var q0, along, edge, target, da, nSg;
  if (bCtl && D.assist && want == 0 && fwd > 60) {
    q0 = g_aTrack[car.idx];
    along = Math.atan2(q0.ty, q0.tx);
    edge = Math.max(0, Math.min(1, (Math.abs(car.lat) - 95 * 0.45) / 95));
    nSg = car.lat > 0 ? 1 : car.lat < 0 ? -1 : car.lat;   // Math.sign (IE 없음)
    target = along - nSg * 0.5 * edge;
    da = target - car.a;
    da = Math.atan2(Math.sin(da), Math.cos(da));
    if (Math.abs(da) < 1.3) car.a += da * Math.min(1, D.assist * dt) * (0.35 + edge);
  }

  var c2 = Math.cos(car.a), s2 = Math.sin(car.a);
  car.vx = fwd * c2 - side * s2;
  car.vy = fwd * s2 + side * c2;
  car.x += car.vx * dt;
  car.y += car.vy * dt;

  // 가장 가까운 트랙 점 찾기 (앞뒤 30칸만)  -- 예전 nearest() 함수
  var nGuess = car.idx, nBi = nGuess, nBd = 1e18, nI, nD, kk;
  for (kk = -30; kk <= 30; kk++) {
    nI = (((nGuess + kk) % g_nN) + g_nN) % g_nN;
    nD = Math.pow(g_aTrack[nI].x - car.x, 2) + Math.pow(g_aTrack[nI].y - car.y, 2);
    if (nD < nBd) { nBd = nD; nBi = nI; }
  }
  var q = g_aTrack[nBi];
  var n = { i: nBi, lat: (car.x - q.x) * q.nx + (car.y - q.y) * q.ny };

  // 벽: 쉬움일수록 미끄러지듯 따라가고 속도를 덜 잃음
  var nOver, vn, nKeep;
  if (Math.abs(n.lat) > 170) {
    nOver = Math.abs(n.lat) - 170;
    nSg = n.lat > 0 ? 1 : n.lat < 0 ? -1 : n.lat;   // Math.sign (복사)
    car.x -= q.nx * nOver * nSg;
    car.y -= q.ny * nOver * nSg;
    vn = car.vx * q.nx + car.vy * q.ny;
    if (vn * nSg > 0) { car.vx -= q.nx * vn * 1.15; car.vy -= q.ny * vn * 1.15; }
    nKeep = Math.pow(D.wall, dt * 60);
    car.vx *= nKeep;
    car.vy *= nKeep;
    if (D.assist) {   // 벽에 박으면 길 방향으로 차를 돌려줌
      da = Math.atan2(q.ty, q.tx) - car.a;
      da = Math.atan2(Math.sin(da), Math.cos(da));
      if (Math.abs(da) < 1.4) car.a += da * Math.min(1, dt * 4);
    }
  }
  car.lat = n.lat;
  car.grass = Math.abs(n.lat) > 95;

  // ? 상자
  var nNowMs, b;
  if (bCtl) {
    nNowMs = fnTick();
    for (i = 0; i < g_aBoxes.length; i++) {
      b = g_aBoxes[i];
      if (b.back > nNowMs) continue;
      if (Math.pow(car.x - b.x, 2) + Math.pow(car.y - b.y, 2) < 36 * 36) {
        b.back = nNowMs + 3000;
        if (car.charges < 3) {
          car.charges++;
          car.pops.push({ text: "⚡ 부스터 +1", t: fnTick() });
        } else {
          car.boost = car.boostMax = 0.8;
          car.pops.push({ text: "가득! 바로 부스터", t: fnTick() });
        }
      }
    }
  }

  // 진행도 (역주행하면 줄어듦)
  var d = n.i - car.idx;
  if (d > g_nN / 2) d -= g_nN;
  if (d < -g_nN / 2) d += g_nN;
  car.dist += d;
  car.idx = n.i;
  car.lap = Math.max(0, Math.floor(car.dist / g_nN));

  // 부스트 패드
  var dd;
  if (bCtl) {
    for (i = 0; i < g_aPads.length; i++) {
      dd = Math.abs(n.i - g_aPads[i]);
      dd = Math.min(dd, g_nN - dd);
      if (dd <= 3 && Math.abs(n.lat) < 45) {
        if (car.boost < 0.5) car.pops.push({ text: "부스트 패드!", t: fnTick() });
        car.boost = Math.max(car.boost, 1.1);
        car.boostMax = Math.max(car.boost, 1.1);
      }
    }
  }

  // 다른 차와 부딪힘
  var aOthers = [], strId, r, dx, dy, dl, nPush;
  for (strId in g_objRemotes) aOthers.push(g_objRemotes[strId]);
  for (i = 0; i < g_aLocals.length; i++) {
    if (g_aLocals[i] !== l && g_aLocals[i].car) aOthers.push(g_aLocals[i].car);
  }
  for (i = 0; i < aOthers.length; i++) {
    r = aOthers[i];
    dx = car.x - r.x;
    dy = car.y - r.y;
    dl = fnHypot(dx, dy);
    if (dl > 0.01 && dl < 36) {
      nPush = (36 - dl) * (r.vx !== undefined ? 0.5 : 1);
      car.x += (dx / dl) * nPush;
      car.y += (dy / dl) * nPush;
      vn = car.vx * dx / dl + car.vy * dy / dl;
      if (vn < 0) { car.vx -= (dx / dl) * vn * 1.3; car.vy -= (dy / dl) * vn * 1.3; }
    }
  }
  car.fwd = car.vx * Math.cos(car.a) + car.vy * Math.sin(car.a);

  // 완주 -> 서버가 등수 결정
  if (!car.finished && car.dist >= g_S.laps * g_nN) {
    car.finished = true;
    (function (objCar, strMyId) {
      // ---- XHR 복붙 (2008.04 최사원) ----
      var xhr = window.XMLHttpRequest ? new XMLHttpRequest() : new ActiveXObject("Microsoft.XMLHTTP");
      var t0 = new Date().getTime();
      xhr.open("POST", "/api/finish", true);
      xhr.setRequestHeader("Content-Type", "application/json");
      xhr.onreadystatechange = function () {
        if (xhr.readyState != 4) return;
        var objRes = null, objErr = null, t1, nRtt, objMe, j;
        try {
          if (xhr.status == 0) throw new TypeError("Failed to fetch");
          objRes = JSON.parse(xhr.responseText);
          t1 = new Date().getTime();
          if (objRes && typeof objRes.now == "number") {
            nRtt = t1 - t0;
            if (nRtt <= g_nBestRtt * 1.3 + 5) {
              g_nBestRtt = Math.min(g_nBestRtt, nRtt);
              g_nOffset = objRes.now - (t0 + t1) / 2000;
            }
          }
          if (xhr.status < 200 || xhr.status > 299) throw new Error(objRes.error || "오류");
        } catch (e) {
          objErr = e;
        }
        if (objErr) {
          objCar.err = objErr.message;
          return;
        }
        try {
          objMe = undefined;
          for (j = 0; j < objRes.players.length; j++) {
            if (objRes.players[j].id == strMyId) { objMe = objRes.players[j]; break; }
          }
          if (objMe) objCar.rank = objMe.rank;
          fnOnState(objRes);
        } catch (e2) {
          objCar.err = e2.message;
        }
      };
      xhr.send(JSON.stringify({ id: strMyId, lap: g_S.laps, progress: objCar.dist / g_nN }));
    })(car, l.id);
  }
}

// ===========================================================================
//  그리기 (DRAW)
// ===========================================================================
g_objCanvas = document.getElementById("cv");
g_ctx = g_objCanvas.getContext("2d");

function fnResize() {
  g_nDpr = Math.min(2, window.devicePixelRatio || 1);
  g_nW = g_objCanvas.clientWidth;
  g_nH = g_objCanvas.clientHeight;
  g_objCanvas.width = g_nW * g_nDpr;
  g_objCanvas.height = g_nH * g_nDpr;
}
fnAddEvent(window, "resize", fnResize);

// 둥근 사각형 (rounded rect)
function fnRoundRect(x, y, w, h, r) {
  g_ctx.beginPath();
  g_ctx.moveTo(x + r, y);
  g_ctx.arcTo(x + w, y, x + w, y + h, r);
  g_ctx.arcTo(x + w, y + h, x, y + h, r);
  g_ctx.arcTo(x, y + h, x, y, r);
  g_ctx.arcTo(x, y, x + w, y, r);
  g_ctx.closePath();
}

function fnDrawCar(x, y, a, color, strName, bMine, bGhost, bBoost, z) {
  var ctx = g_ctx, nLen;
  ctx.save();
  ctx.translate(x, y);
  ctx.globalAlpha = bGhost ? 0.35 : 1;
  ctx.save();
  ctx.rotate(a);
  if (bBoost) {
    nLen = 30 + Math.random() * 22;
    ctx.fillStyle = "rgba(255,120,30,.9)";
    ctx.beginPath(); ctx.moveTo(-22, -10); ctx.lineTo(-22 - nLen, 0); ctx.lineTo(-22, 10); ctx.fill();
    ctx.fillStyle = "rgba(255,240,120,.95)";
    ctx.beginPath(); ctx.moveTo(-22, -5); ctx.lineTo(-22 - nLen * 0.55, 0); ctx.lineTo(-22, 5); ctx.fill();
  }
  ctx.fillStyle = "rgba(0,0,0,.3)"; fnRoundRect(-22, -11, 48, 28, 8); ctx.fill();
  ctx.fillStyle = "#111";
  // 바퀴 4개
  ctx.fillRect(-15, -15, 11, 5);
  ctx.fillRect(9, -15, 11, 5);
  ctx.fillRect(-15, 10, 11, 5);
  ctx.fillRect(9, 10, 11, 5);
  ctx.fillStyle = color || "#ccc"; fnRoundRect(-24, -12, 48, 24, 8); ctx.fill();
  ctx.strokeStyle = "rgba(0,0,0,.45)"; ctx.lineWidth = 2; ctx.stroke();
  ctx.fillStyle = "rgba(20,30,60,.85)"; fnRoundRect(2, -9, 11, 18, 3); ctx.fill();
  ctx.fillStyle = "rgba(255,255,255,.35)"; ctx.fillRect(-18, -2, 16, 4);
  ctx.fillStyle = "#fff8b0"; ctx.fillRect(21, -10, 3, 5); ctx.fillRect(21, 5, 3, 5);
  ctx.restore();
  ctx.rotate(-g_nViewRot);
  ctx.font = "bold " + (14 / Math.max(0.6, z)) + "px sans-serif";
  ctx.textAlign = "center";
  ctx.lineWidth = 4; ctx.strokeStyle = "rgba(0,0,0,.7)";
  ctx.strokeText(strName, 0, -30);
  ctx.fillStyle = bMine ? "#ffd23d" : "#fff";
  ctx.fillText(strName, 0, -30);
  ctx.restore();
}

function fnDrawMap(x, y, w, h) {
  var ctx = g_ctx, strId, i, l;
  var bw = g_objBounds.x1 - g_objBounds.x0, bh = g_objBounds.y1 - g_objBounds.y0;
  var s = Math.min(w / bw, h / bh);
  var ox = x + (w - bw * s) / 2, oy = y + (h - bh * s) / 2;
  ctx.fillStyle = "rgba(0,0,0,.45)";
  ctx.fillRect(ox - 10, oy - 10, bw * s + 20, bh * s + 20);
  ctx.save();
  ctx.translate(ox - g_objBounds.x0 * s, oy - g_objBounds.y0 * s);
  ctx.scale(s, s);
  ctx.lineWidth = Math.max(6, 120 * s) / s; ctx.strokeStyle = "rgba(255,255,255,.75)";
  ctx.lineJoin = "round"; ctx.stroke(g_objRoadPath);
  var r0 = Math.max(4, 40 * s);
  // 출발선 점
  ctx.fillStyle = "#000"; ctx.beginPath(); ctx.arc(g_aTrack[0].x, g_aTrack[0].y, r0 / s, 0, 7); ctx.fill();
  // 다른 기기 차
  for (strId in g_objRemotes) {
    ctx.fillStyle = fnPinfo(strId).color || "#ccc"; ctx.beginPath(); ctx.arc(g_objRemotes[strId].x, g_objRemotes[strId].y, r0 / s, 0, 7); ctx.fill();
  }
  // 내 차들
  for (i = 0; i < g_aLocals.length; i++) {
    l = g_aLocals[i];
    if (!l.car) continue;
    if (!l.ai) { ctx.fillStyle = "#fff"; ctx.beginPath(); ctx.arc(l.car.x, l.car.y, r0 * 1.6 / s, 0, 7); ctx.fill(); }
    ctx.fillStyle = fnPinfo(l.id).color || "#ccc"; ctx.beginPath(); ctx.arc(l.car.x, l.car.y, r0 * 1.1 / s, 0, 7); ctx.fill();
  }
  ctx.restore();
}
/*
function fnDrawMap_OLD(x, y) {      // 2007.03 예전 미니맵 - 안씀
  g_ctx.drawImage(document.getElementById("mapImg"), x, y);
}
*/

/*****************************************************************************
 *  화면 전체 그리기 - 화면 나누기 + 각 화면(view) + HUD 전부 여기서
 *  (2007.03 김과장: 함수 나누면 느려서 하나로 합침)
 *****************************************************************************/
function fnDrawAll() {
  var ctx = g_ctx;
  var W = g_nW, H = g_nH;
  ctx.setTransform(g_nDpr, 0, 0, g_nDpr, 0, 0);

  // ---- 화면 나누기 (layout) ----
  var aHs = getHumans(), n = aHs.length, aVps = [], nVw, nVh, i;
  if (n <= 1) {
    aVps = [{ x: 0, y: 0, w: W, h: H, l: aHs[0] }];
  } else if (n == 2) {
    if (W >= H) aVps = [{ x: 0, y: 0, w: W / 2, h: H, l: aHs[0] }, { x: W / 2, y: 0, w: W / 2, h: H, l: aHs[1] }];
    else aVps = [{ x: 0, y: 0, w: W, h: H / 2, l: aHs[0] }, { x: 0, y: H / 2, w: W, h: H / 2, l: aHs[1] }];
  } else {
    nVw = W / 2;
    nVh = H / 2;
    for (i = 0; i < aHs.length; i++) aVps.push({ x: (i % 2) * nVw, y: Math.floor(i / 2) * nVh, w: nVw, h: nVh, l: aHs[i] });
  }

  var nVp, vp, l, car, cam, dt, nBase, nSpd, nTz, da, nVr, j, m, objT, g, f, nBlink, q, ox, tnow, b, bSingle, strId,
      r, p, objMe, objO, aPops, nAge, nCx, nCy, nAng, nR0, nR1;
  var nHudNow, aSt, nPos, nTms, bMulti, aItems, nBw, nBh, nGap, nTotal, bTouch, nX, nY, strLabel, nTw, strK, v,
      nSw, nSx, nBig, strMain, strSub, nRank, nRemain;

  for (nVp = 0; nVp < aVps.length; nVp++) {
    vp = aVps[nVp];
    l = vp.l;
    car = l.car;
    cam = l.cam;
    ctx.save();
    ctx.beginPath(); ctx.rect(vp.x, vp.y, vp.w, vp.h); ctx.clip();
    ctx.fillStyle = "#2c7a3f";
    ctx.fillRect(vp.x, vp.y, vp.w, vp.h);

    // 카메라 (프레임 속도와 상관없이 부드럽게 따라감)
    dt = g_nFrameDt;
    nBase = Math.max(0.36, Math.min(1.2, Math.min(vp.w, vp.h) / 720));
    nSpd = fnHypot(car.vx, car.vy);
    nTz = nBase * (1 - Math.min(0.22, nSpd / 3000)) * (car.boost > 0 ? 0.92 : 1);
    cam.z += (nTz - cam.z) * (1 - Math.exp(-3 * dt));
    if (g_objOpts.rotate) {
      da = car.a - cam.a;
      da = Math.atan2(Math.sin(da), Math.cos(da));
      cam.a += da * (1 - Math.exp(-5 * dt));
      cam.x += (car.x + car.vx * 0.12 - cam.x) * (1 - Math.exp(-14 * dt));
      cam.y += (car.y + car.vy * 0.12 - cam.y) * (1 - Math.exp(-14 * dt));
      g_nViewRot = -cam.a - Math.PI / 2;
      ctx.translate(vp.x + vp.w / 2, vp.y + vp.h * 0.64);
    } else {
      cam.x += (car.x + car.vx * 0.35 - cam.x) * (1 - Math.exp(-8 * dt));
      cam.y += (car.y + car.vy * 0.35 - cam.y) * (1 - Math.exp(-8 * dt));
      g_nViewRot = 0;
      ctx.translate(vp.x + vp.w / 2, vp.y + vp.h / 2);
    }
    ctx.scale(cam.z, cam.z);
    ctx.rotate(g_nViewRot);
    ctx.translate(-cam.x, -cam.y);

    // 나무
    nVr = fnHypot(vp.w, vp.h) / cam.z + 60;
    for (j = 0; j < g_aTrees.length; j++) {
      objT = g_aTrees[j];
      if (Math.abs(objT.x - cam.x) > nVr || Math.abs(objT.y - cam.y) > nVr) continue;
      ctx.fillStyle = "#1d5c2c";
      ctx.beginPath(); ctx.arc(objT.x + 6, objT.y + 8, objT.r, 0, 7); ctx.fill();
      ctx.fillStyle = "#3a9a4a";
      ctx.beginPath(); ctx.arc(objT.x, objT.y, objT.r, 0, 7); ctx.fill();
      ctx.fillStyle = "#58b862";
      ctx.beginPath(); ctx.arc(objT.x - objT.r * 0.3, objT.y - objT.r * 0.3, objT.r * 0.45, 0, 7); ctx.fill();
    }

    // 도로 (364 = 170*2+24, 340 = 170*2, 206 = 95*2+16, 190 = 95*2)
    ctx.lineJoin = "round"; ctx.lineCap = "round";
    ctx.lineWidth = 364; ctx.strokeStyle = "#d8dde6"; ctx.stroke(g_objRoadPath);
    ctx.strokeStyle = "#ff5a5a"; ctx.setLineDash([40, 40]); ctx.stroke(g_objRoadPath);
    ctx.setLineDash([]);
    ctx.lineWidth = 340; ctx.strokeStyle = "#5cbf5f"; ctx.stroke(g_objRoadPath);
    ctx.lineWidth = 206; ctx.strokeStyle = "#ffffff"; ctx.stroke(g_objRoadPath);
    ctx.strokeStyle = "#e33"; ctx.setLineDash([24, 24]); ctx.stroke(g_objRoadPath);
    ctx.setLineDash([]);
    ctx.lineWidth = 190; ctx.strokeStyle = "#4a4f5c"; ctx.stroke(g_objRoadPath);
    ctx.lineWidth = 4; ctx.strokeStyle = "rgba(255,255,255,.35)"; ctx.setLineDash([30, 40]); ctx.stroke(g_objRoadPath);
    ctx.setLineDash([]);

    // 출발 칸 8개
    for (j = 0; j < 8; j++) {
      g = fnGridPos(j);
      ctx.save(); ctx.translate(g.x, g.y); ctx.rotate(g.a);
      ctx.strokeStyle = "rgba(255,255,255,.6)"; ctx.lineWidth = 3;
      ctx.strokeRect(-26, -18, 52, 36);
      ctx.restore();
    }

    // 결승선 체크무늬 (칸 크기 19 = 95*2/10)
    f = g_aTrack[0];
    ctx.save(); ctx.translate(f.x, f.y); ctx.rotate(Math.atan2(f.ty, f.tx));
    for (j = 0; j < 2; j++) {
      for (m = 0; m < 10; m++) {
        ctx.fillStyle = (j + m) % 2 ? "#111" : "#fff";
        ctx.fillRect(-19 + j * 19, -95 + m * 19, 19, 19);
      }
    }
    ctx.restore();

    // 부스트 패드
    nBlink = (fnTick() / 300) % 1;
    for (j = 0; j < g_aPads.length; j++) {
      q = g_aTrack[g_aPads[j]];
      ctx.save(); ctx.translate(q.x, q.y); ctx.rotate(Math.atan2(q.ty, q.tx));
      ctx.fillStyle = "#1f2a8a"; ctx.fillRect(-36, -42, 72, 84);
      for (m = 0; m < 3; m++) {
        ctx.fillStyle = (m / 3 + nBlink) % 1 < 0.5 ? "#ffd23d" : "#ff9f1a";
        ctx.beginPath();
        ox = -24 + m * 18;
        ctx.moveTo(ox, -28); ctx.lineTo(ox + 18, 0); ctx.lineTo(ox, 28); ctx.lineTo(ox + 8, 0);
        ctx.fill();
      }
      ctx.restore();
    }

    // ? 상자
    tnow = fnTick();
    for (j = 0; j < g_aBoxes.length; j++) {
      b = g_aBoxes[j];
      if (b.back > tnow) continue;
      ctx.save(); ctx.translate(b.x, b.y + Math.sin(tnow / 250 + b.x) * 3); ctx.rotate(tnow / 600);
      ctx.fillStyle = "rgba(0,0,0,.25)"; fnRoundRect(-14, -10, 30, 30, 6); ctx.fill();
      ctx.fillStyle = "hsl(" + ((tnow / 8 + b.x) % 360) + ",90%,60%)"; fnRoundRect(-16, -16, 32, 32, 7); ctx.fill();
      ctx.strokeStyle = "#fff"; ctx.lineWidth = 3; ctx.stroke();
      ctx.rotate(-tnow / 600 - g_nViewRot);
      ctx.fillStyle = "#fff"; ctx.font = "bold 22px sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText("?", 0, 1);
      ctx.textBaseline = "alphabetic";
      ctx.restore();
    }

    // 차들 (이 화면의 주인 차를 맨 위에)
    bSingle = getHumans().length == 1;
    for (strId in g_objRemotes) {
      r = g_objRemotes[strId];
      p = fnPinfo(strId);
      fnDrawCar(r.x, r.y, r.a, p.color, (p.ai ? "🤖" : "") + (p.name || ""), false, p.dnf, false, cam.z);
    }
    for (j = 0; j < g_aLocals.length; j++) {
      objO = g_aLocals[j];
      if (objO == l || !objO.car) continue;
      p = fnPinfo(objO.id);
      fnDrawCar(objO.car.x, objO.car.y, objO.car.a, p.color, (objO.ai ? "🤖" : "") + (p.name || ""), !objO.ai, false, objO.car.boost > 0, cam.z);
    }
    objMe = fnPinfo(l.id);
    fnDrawCar(car.x, car.y, car.a, objMe.color || g_strMyColor, bSingle ? "나" : objMe.name || "", true, false, car.boost > 0, cam.z);

    // 떠오르는 글자 (부스터 +1 등)
    aPops = [];
    for (j = 0; j < car.pops.length; j++) {
      if (tnow - car.pops[j].t < 1100) aPops.push(car.pops[j]);
    }
    car.pops = aPops;
    for (j = 0; j < car.pops.length; j++) {
      p = car.pops[j];
      nAge = (tnow - p.t) / 1100;
      ctx.save(); ctx.translate(car.x, car.y); ctx.rotate(-g_nViewRot);
      ctx.globalAlpha = 1 - nAge;
      ctx.font = "bold " + (20 / Math.max(0.6, cam.z)) + "px sans-serif"; ctx.textAlign = "center";
      ctx.lineWidth = 5; ctx.strokeStyle = "rgba(0,0,0,.7)";
      ctx.strokeText(p.text, 0, -55 - nAge * 50);
      ctx.fillStyle = "#ffe14d"; ctx.fillText(p.text, 0, -55 - nAge * 50);
      ctx.restore();
    }
    ctx.restore();

    // 부스터 속도선
    if (car.boost > 0) {
      ctx.save();
      ctx.beginPath(); ctx.rect(vp.x, vp.y, vp.w, vp.h); ctx.clip();
      nCx = vp.x + vp.w / 2;
      nCy = vp.y + vp.h / 2;
      ctx.strokeStyle = "rgba(255,255,255," + (0.25 * Math.min(1, car.boost * 2)) + ")";
      ctx.lineWidth = 2;
      for (j = 0; j < 26; j++) {
        nAng = Math.random() * Math.PI * 2;
        nR0 = Math.min(vp.w, vp.h) * (0.35 + Math.random() * 0.2);
        nR1 = nR0 + 40 + Math.random() * 80;
        ctx.beginPath();
        ctx.moveTo(nCx + Math.cos(nAng) * nR0, nCy + Math.sin(nAng) * nR0);
        ctx.lineTo(nCx + Math.cos(nAng) * nR1, nCy + Math.sin(nAng) * nR1);
        ctx.stroke();
      }
      ctx.restore();
    }

    // ======================= HUD (계기판) =======================
    nHudNow = fnServerNow();
    objMe = fnPinfo(l.id);
    // 순위 계산 (fnUpdateGlobalUi 에도 똑같은거 있음 - 고칠때 같이!!)
    aSt = [];
    for (j = 0; j < g_S.players.length; j++) {
      p = g_S.players[j];
      objO = fnLocalOf(p.id);
      aSt.push({ id: p.id, name: p.name, color: p.color, rank: p.rank, dnf: p.dnf, ai: p.ai,
                 prog: objO && objO.car ? objO.car.dist / g_nN : p.progress });
    }
    aSt.sort(function (a, b2) {
      if (a.rank && b2.rank) return a.rank - b2.rank;
      if (a.rank) return -1;
      if (b2.rank) return 1;
      return b2.prog - a.prog;
    });
    nPos = -1;
    for (j = 0; j < aSt.length; j++) {
      if (aSt[j].id == l.id) { nPos = j; break; }
    }
    nPos = nPos + 1;
    nTms = objMe.time_ms != null ? objMe.time_ms : Math.max(0, (nHudNow - g_S.start_at) * 1000);
    bMulti = getHumans().length > 1;
    aItems = [
      ["순위", nPos + "/" + aSt.length],
      ["바퀴", Math.min(g_S.laps, car.lap + 1) + "/" + g_S.laps],
      ["시간", fnFmtTime(Math.floor(nTms)).slice(0, -2)],
      ["km/h", String(Math.max(0, Math.round(car.fwd * 0.4)))]
    ];
    aItems.push(["⚡ " + g_objSchemes[fnSchemeOf(l)].nlabel, null]);
    nBw = Math.min(78, (vp.w - 30) / 5);
    nBh = 46;
    nGap = 6;
    nTotal = aItems.length * nBw + (aItems.length - 1) * nGap;
    bTouch = fnHasClass(document.body, "touch") && !bMulti;
    nX = vp.x + vp.w / 2 - nTotal / 2;
    nY = bTouch ? vp.y + 12 : vp.y + vp.h - nBh - 14;
    ctx.textAlign = "center";
    if (bMulti) {
      ctx.font = "bold 14px sans-serif";
      strLabel = objMe.name + " · " + g_objSchemes[fnSchemeOf(l)].label;
      nTw = ctx.measureText(strLabel).width + 20;
      ctx.fillStyle = "rgba(0,0,0,.6)"; fnRoundRect(vp.x + vp.w / 2 - nTw / 2, nY - 26, nTw, 22, 8); ctx.fill();
      ctx.fillStyle = objMe.color || "#fff"; ctx.fillText(strLabel, vp.x + vp.w / 2, nY - 10);
    }
    for (j = 0; j < aItems.length; j++) {
      strK = aItems[j][0];
      v = aItems[j][1];
      ctx.fillStyle = v === null && car.charges > 0 ? "rgba(30,60,140,.8)" : "rgba(0,0,0,.6)";
      fnRoundRect(nX, nY, nBw, nBh, 10); ctx.fill();
      ctx.fillStyle = "rgba(255,255,255,.7)"; ctx.font = "11px sans-serif"; ctx.fillText(strK, nX + nBw / 2, nY + 15);
      if (v === null) {
        // 부스터 칸: 충전된 개수 + 다음 칸 게이지
        nSw = (nBw - 16) / 3;
        for (m = 0; m < 3; m++) {
          nSx = nX + 8 + m * nSw;
          ctx.fillStyle = "rgba(255,255,255,.15)"; ctx.fillRect(nSx + 1, nY + 22, nSw - 2, 16);
          if (m < car.charges) {
            ctx.fillStyle = "#ffd23d"; ctx.fillRect(nSx + 1, nY + 22, nSw - 2, 16);
          } else if (m == car.charges) {
            ctx.fillStyle = "rgba(255,210,61,.5)"; ctx.fillRect(nSx + 1, nY + 22 + 16 * (1 - car.gauge), nSw - 2, 16 * car.gauge);
          }
        }
      } else {
        ctx.fillStyle = strK == "순위" ? "#ffd23d" : "#fff"; ctx.font = "bold 17px sans-serif"; ctx.fillText(v, nX + nBw / 2, nY + 37);
      }
      nX += nBw + nGap;
    }

    // 이 화면 가운데 메시지
    nCx = vp.x + vp.w / 2;
    nCy = vp.y + vp.h * 0.4;
    nBig = Math.max(40, Math.min(90, vp.w / 7));
    strMain = "";
    strSub = "";
    if (car.finished) {
      nRank = car.rank || objMe.rank;
      strMain = nRank ? nRank + "등!" : "골인!";
      nRemain = g_S.first_finish_at ? Math.max(0, Math.ceil(g_S.first_finish_at + g_S.grace - nHudNow)) : 0;
      strSub = "다른 플레이어를 기다리는 중… " + (nRemain ? nRemain + "초" : "");
      if (car.err) { strMain = ""; strSub = car.err; }
    } else if (nHudNow > g_S.start_at + 1) {
      if (car.lap == g_S.laps - 1 && car.dist % g_nN < g_nN * 0.04 && car.dist > g_nN) strSub = "마지막 바퀴!";
      else if (g_S.first_finish_at) strSub = Math.max(0, Math.ceil(g_S.first_finish_at + g_S.grace - nHudNow)) + "초 안에 골인!";
    }
    if (strMain) {
      ctx.font = "italic 900 " + nBig + "px sans-serif";
      ctx.lineWidth = 8; ctx.strokeStyle = "#ff4d4d"; ctx.strokeText(strMain, nCx + 3, nCy + 3);
      ctx.fillStyle = "#fff"; ctx.fillText(strMain, nCx, nCy);
    }
    if (strSub) {
      ctx.font = "bold " + (strMain ? 20 : 30) + "px sans-serif";
      ctx.lineWidth = 5; ctx.strokeStyle = "rgba(0,0,0,.8)";
      ctx.strokeText(strSub, nCx, nCy + (strMain ? 40 : 0));
      ctx.fillStyle = "#fff"; ctx.fillText(strSub, nCx, nCy + (strMain ? 40 : 0));
    }
  }

  // 화면 분할선
  n = aVps.length;
  ctx.fillStyle = "#111";
  if (n == 2) {
    if (W >= H) ctx.fillRect(W / 2 - 2, 0, 4, H);
    else ctx.fillRect(0, H / 2 - 2, W, 4);
  }
  if (n >= 3) { ctx.fillRect(W / 2 - 2, 0, 4, H); ctx.fillRect(0, H / 2 - 2, W, 4); }
  // 미니맵
  var nSize, nMh;
  if (n == 3) {
    ctx.fillStyle = "#16233f"; ctx.fillRect(W / 2 + 2, H / 2 + 2, W / 2 - 2, H / 2 - 2);
    fnDrawMap(W / 2 + 20, H / 2 + 20, W / 2 - 40, H / 2 - 40);
  } else {
    nSize = n == 1 ? Math.min(170, W * 0.32) : Math.min(150, W * 0.22);
    nMh = nSize * (g_objBounds.y1 - g_objBounds.y0) / (g_objBounds.x1 - g_objBounds.x0);
    if (n == 1) fnDrawMap(W - nSize - 16, 16, nSize, nMh);
    else if (n == 2 && W >= H) fnDrawMap(W / 2 - nSize / 2, 16, nSize, nMh);
    else fnDrawMap(W / 2 - nSize / 2, H / 2 - nMh / 2, nSize, nMh);
  }
}

function fnUpdateGlobalUi() {
  var aSt = [], i, p, l, objLr, aSig, strSig, strHtml, strText, nLeft, objC;
  // 순위 계산 (fnDrawAll 에서 복사함)
  for (i = 0; i < g_S.players.length; i++) {
    p = g_S.players[i];
    l = fnLocalOf(p.id);
    aSt.push({ id: p.id, name: p.name, color: p.color, rank: p.rank, dnf: p.dnf, ai: p.ai,
               prog: l && l.car ? l.car.dist / g_nN : p.progress });
  }
  aSt.sort(function (a, b) {
    if (a.rank && b.rank) return a.rank - b.rank;
    if (a.rank) return -1;
    if (b.rank) return 1;
    return b.prog - a.prog;
  });
  objLr = document.getElementById("liveRank");
  aSig = [];
  for (i = 0; i < aSt.length; i++) aSig.push(aSt[i].id + aSt[i].rank + aSt[i].dnf);
  strSig = aSig.join(",");
  if (objLr.getAttribute("data-sig") !== strSig) {
    objLr.setAttribute("data-sig", strSig);
    strHtml = "";
    for (i = 0; i < aSt.length; i++) {
      p = aSt[i];
      flg = fnLocalOf(p.id) && !p.ai;     // 전역 flg (2007.08 누가 씀?)
      strText = (p.ai ? "🤖" : "") + p.name + (p.rank ? " 🏁" : p.dnf ? " (나감)" : "");
      if (flg) strHtml += '<li class="me">' + fnEscHtml(strText) + '</li>';
      else strHtml += '<li class="" style="color:' + fnEscHtml(p.color) + '">' + fnEscHtml(strText) + '</li>';
    }
    objLr.innerHTML = strHtml;
  }
  nLeft = g_S.start_at - fnServerNow();
  strHtml = "";
  if (nLeft > 3) strHtml = "준비!";
  else if (nLeft > 0) strHtml = String(Math.ceil(nLeft));
  else if (nLeft > -1) strHtml = "GO!";
  objC = document.getElementById("center");
  if (objC.getAttribute("data-h") !== strHtml) {
    objC.setAttribute("data-h", strHtml);
    objC.innerHTML = strHtml;
  }
}

/*****************************************************************************
 *  메인 루프 (MAIN LOOP)
 *  입력 -> 부스터/게이지 -> 물리(1/120초 단위로 잘게) -> 원격차 보간 -> 그리기
 *  2008.04 최사원: AI/키입력/부스터 함수 다 여기로 합침 (속도때문)
 *****************************************************************************/
g_nLastT = fnTick();
function fnMainLoop(t) {
  var dt = Math.min(0.1, (t - g_nLastT) / 1000);
  g_nLastT = t;
  g_nFrameDt = dt;
  var i, j, s, l, c, D, flg2, aInputs, objInp, nLook, q, tx, ty, d, bSharp, objSc, bFirst,
      bUp, bDown, bLeft, bRight, bNitro, bRacing2, nSteps, nNow, strId, r, nAge, ex, ey, k, da;

  flg2 = false;
  if (g_strScreen == "game" && g_S && g_S.phase == "racing" && getHumans().length) {
    flg2 = true;
    for (i = 0; i < g_aLocals.length; i++) {
      if (!g_aLocals[i].car) { flg2 = false; break; }
    }
  }

  if (flg2) {
    // ---- 1. 입력 (프레임마다 한 번) ----
    aInputs = [];
    for (i = 0; i < g_aLocals.length; i++) {
      l = g_aLocals[i];
      if (l.ai) {
        // ---------- 컴퓨터 (AI) - 2006.11 박대리 ----------
        c = l.car;
        nLook = 8 + Math.round(Math.max(0, c.fwd) / 55);
        q = g_aTrack[(c.idx + nLook) % g_nN];
        tx = q.x + q.nx * l.lane;
        ty = q.y + q.ny * l.lane;
        d = Math.atan2(ty - c.y, tx - c.x) - c.a;
        d = Math.atan2(Math.sin(d), Math.cos(d));
        if (fnServerNow() >= g_S.start_at + 1 && !c.finished) {
          l.stuck = Math.abs(c.fwd) < 25 ? l.stuck + dt : 0;
          if (l.stuck > 1.2) { l.rev = 0.7; l.stuck = 0; }
        }
        if (l.rev > 0) {
          // 끼었으면 후진
          l.rev -= dt;
          aInputs.push({ up: false, down: true, left: d > 0, right: d < 0 });
        } else {
          bSharp = Math.abs(d) > 0.7;
          aInputs.push({ up: c.fwd < 540 * l.skill && !(bSharp && c.fwd > 300), down: bSharp && c.fwd > 380,
                         left: d < -0.05, right: d > 0.05,
                         nitro: c.charges > 0 && Math.abs(d) < 0.12 && c.fwd > 300 && Math.random() < dt * fnGetDiff().aiNitro });
        }
        // if (l.skill > 0.95) { /* 치트 모드 - 2007.01 */ }
      } else {
        // ---------- 사람 (키보드 / 터치) ----------
        objSc = g_objSchemes[fnSchemeOf(l)];
        bFirst = getHumans()[0] == l;
        bDown = false;
        for (j = 0; j < objSc.down.length; j++) { if (g_objPressed[objSc.down[j]] === true) { bDown = true; break; } }
        bDown = bDown || (bFirst && g_objTouchKeys.down);
        bUp = false;
        for (j = 0; j < objSc.up.length; j++) { if (g_objPressed[objSc.up[j]] === true) { bUp = true; break; } }
        bUp = bUp || (bFirst && g_objTouchKeys.up);
        bLeft = false;
        for (j = 0; j < objSc.left.length; j++) { if (g_objPressed[objSc.left[j]] === true) { bLeft = true; break; } }
        bLeft = bLeft || (bFirst && g_objTouchKeys.left);
        bRight = false;
        for (j = 0; j < objSc.right.length; j++) { if (g_objPressed[objSc.right[j]] === true) { bRight = true; break; } }
        bRight = bRight || (bFirst && g_objTouchKeys.right);
        bNitro = false;
        for (j = 0; j < objSc.nitro.length; j++) { if (g_objPressed[objSc.nitro[j]] === true) { bNitro = true; break; } }
        bNitro = bNitro || (bFirst && g_objTouchKeys.nitro);
        aInputs.push({ up: bUp || (g_objOpts.autoGas && !bDown), down: bDown, left: bLeft, right: bRight, nitro: bNitro });
      }
    }

    // ---- 2. 부스터 키(누른 순간만), 게이지 충전 ----
    for (i = 0; i < g_aLocals.length; i++) {
      l = g_aLocals[i];
      objInp = aInputs[i];
      c = l.car;
      D = fnGetDiff();
      bRacing2 = fnServerNow() >= g_S.start_at && !c.finished;
      if (objInp.nitro && !c.nitroHeld && bRacing2) {
        // 부스터 사용
        if (!(c.charges <= 0 || c.finished)) {
          c.charges--;
          c.boost = c.boostMax = 1.6;
          c.pops.push({ text: "부스터!", t: fnTick() });
        }
      }
      c.nitroHeld = !!objInp.nitro;
      if (bRacing2 && c.charges < 3) {
        c.gauge += dt / D.charge;
        if (c.gauge >= 1) {
          c.gauge = 0;
          c.charges++;
          c.pops.push({ text: "⚡ +1", t: fnTick() });
        }
      }
    }

    // ---- 3. 물리는 1/120초 단위로 잘게 나눠서 계산 (부드럽고 안정적) ----
    nSteps = Math.max(1, Math.ceil(dt * 120));
    for (s = 0; s < nSteps; s++) {
      for (i = 0; i < g_aLocals.length; i++) fnPhysics(g_aLocals[i], aInputs[i], dt / nSteps);
    }

    // ---- 4. 다른 기기 차 보간 ----
    nNow = fnTick();
    for (strId in g_objRemotes) {
      r = g_objRemotes[strId];
      if (r.tx === undefined) continue;
      nAge = Math.min(0.25, (nNow - r.t) / 1000);
      ex = r.tx + Math.cos(r.ta) * (r.tv || 0) * nAge;
      ey = r.ty + Math.sin(r.ta) * (r.tv || 0) * nAge;
      k = Math.min(1, dt * 12);
      if (fnHypot(ex - r.x, ey - r.y) > 300) { r.x = ex; r.y = ey; r.a = r.ta; }
      r.x += (ex - r.x) * k;
      r.y += (ey - r.y) * k;
      da = r.ta - r.a;
      da = Math.atan2(Math.sin(da), Math.cos(da));
      r.a += da * k;
    }

    // ---- 5. 그리기 ----
    if (!g_objCanvas.width) fnResize();
    fnDrawAll();
    fnUpdateGlobalUi();
  }
  requestAnimationFrame(fnMainLoop);
}
requestAnimationFrame(fnMainLoop);

// ===========================================================================
//  입력 (키보드 / 터치)
// ===========================================================================
fnAddEvent(window, "keydown", function (e) {
  e = e || window.event;
  if (g_strScreen == "game" && g_objGameCodes[e.code] === true) {
    g_objPressed[e.code] = true;
    if (e.preventDefault) e.preventDefault(); else e.returnValue = false;
  }
});
fnAddEvent(window, "keyup", function (e) {
  e = e || window.event;
  delete g_objPressed[e.code];
});
fnAddEvent(window, "blur", function () {
  g_objPressed = {};
});

// if (navigator.userAgent.indexOf("MSIE 6") != -1) { alert("IE6 는 지원하지 않습니다"); }   // 2009.02 롤백
if ((window.matchMedia && window.matchMedia("(pointer: coarse)").matches) || "ontouchstart" in window) fnAddClass(document.body, "touch");
(function () {
  var aTouchBtns = document.getElementById("touch").getElementsByTagName("button"), i;
  for (i = 0; i < aTouchBtns.length; i++) {
    (function (b) {
      var k = b.getAttribute("data-k");
      var fnOn = function (e) {
        if (e.preventDefault) e.preventDefault(); else e.returnValue = false;
        g_objTouchKeys[k] = true;
        fnAddClass(b, "on");
      };
      var fnOff = function (e) {
        if (e.preventDefault) e.preventDefault(); else e.returnValue = false;
        g_objTouchKeys[k] = false;
        fnRemoveClass(b, "on");
      };
      fnAddEvent(b, "pointerdown", fnOn);
      fnAddEvent(b, "pointerup", fnOff);
      fnAddEvent(b, "pointerleave", fnOff);
      fnAddEvent(b, "pointercancel", fnOff);
      fnAddEvent(b, "contextmenu", function (e) {
        if (e.preventDefault) e.preventDefault(); else e.returnValue = false;
      });
    })(aTouchBtns[i]);
  }
})();

// ===========================================================================
//  시작: 새로고침이면 재접속 (한명씩 차례대로)
// ===========================================================================
(function () {
  if (!g_aLocals.length) return;
  var aKept = [], objLast = null, aList = g_aLocals, nIdx = 0;
  var fnNext = function () {
    if (nIdx >= aList.length) {
      g_aLocals = aKept;
      fnSaveLocals();
      if (objLast && getHumans().length) { fnShowScreen("lobby"); fnOnState(objLast); }
      return;
    }
    var l = aList[nIdx];
    nIdx++;
    // ---- XHR 복붙 (2009.07 외주(정)) ----
    var xhr = window.XMLHttpRequest ? new XMLHttpRequest() : new ActiveXObject("Microsoft.XMLHTTP");
    var t0 = new Date().getTime();
    xhr.open("POST", "/api/join", true);
    xhr.setRequestHeader("Content-Type", "application/json");
    xhr.onreadystatechange = function () {
      if (xhr.readyState != 4) return;
      var objRes = null, objErr = null, t1, nRtt;
      try {
        if (xhr.status == 0) throw new TypeError("Failed to fetch");
        objRes = JSON.parse(xhr.responseText);
        t1 = new Date().getTime();
        if (objRes && typeof objRes.now == "number") {
          nRtt = t1 - t0;
          if (nRtt <= g_nBestRtt * 1.3 + 5) {
            g_nBestRtt = Math.min(g_nBestRtt, nRtt);
            g_nOffset = objRes.now - (t0 + t1) / 2000;
          }
        }
        if (xhr.status < 200 || xhr.status > 299) throw new Error(objRes.error || "오류");
      } catch (e) {
        objErr = e;
      }
      if (!objErr) {
        objLast = objRes;
        aKept.push(l);
      }
      // else { /* 빠짐 */ }
      fnNext();
    };
    xhr.send(JSON.stringify({ id: l.id }));
  };
  fnNext();
})();

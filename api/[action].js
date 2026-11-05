/*
 * api/[action].js
 * 터보레이서 API 중계 (Vercel -> Supabase)
 *
 * 2009.07  최초작성
 * 2009.08  https 모듈로 바꿈 (request 모듈 설치 안됨)
 * 2009.08  BOM 문제 수정 -- 윈도우에서 환경변수 넣으면 앞에 이상한 글자 붙음!!!
 *
 * TODO: 에러처리 제대로 하기
 * FIXME: GET 이랑 POST 코드 중복 (시간없음)
 */
var https = require('https');
var urlmod = require('url');

var SB_URL = process.env.SUPABASE_URL;
if (!SB_URL) SB_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
if (!SB_URL) SB_URL = '';
var SB_KEY = process.env.SUPABASE_ANON_KEY;
if (!SB_KEY) SB_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
if (!SB_KEY) SB_KEY = process.env.SUPABASE_PUBLISHABLE_KEY;
if (!SB_KEY) SB_KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
if (!SB_KEY) SB_KEY = '';

// BOM, 공백 제거 (trim 안먹는 경우 있어서 직접함)
while (SB_URL.length > 0 && (SB_URL.charCodeAt(0) == 65279 || SB_URL.charAt(0) == ' ' || SB_URL.charAt(0) == '\n' || SB_URL.charAt(0) == '\r' || SB_URL.charAt(0) == '\t')) SB_URL = SB_URL.substring(1);
while (SB_URL.length > 0 && (SB_URL.charCodeAt(SB_URL.length - 1) == 65279 || SB_URL.charAt(SB_URL.length - 1) == ' ' || SB_URL.charAt(SB_URL.length - 1) == '\n' || SB_URL.charAt(SB_URL.length - 1) == '\r' || SB_URL.charAt(SB_URL.length - 1) == '\t' || SB_URL.charAt(SB_URL.length - 1) == '/')) SB_URL = SB_URL.substring(0, SB_URL.length - 1);
while (SB_KEY.length > 0 && (SB_KEY.charCodeAt(0) == 65279 || SB_KEY.charAt(0) == ' ' || SB_KEY.charAt(0) == '\n' || SB_KEY.charAt(0) == '\r' || SB_KEY.charAt(0) == '\t')) SB_KEY = SB_KEY.substring(1);
while (SB_KEY.length > 0 && (SB_KEY.charCodeAt(SB_KEY.length - 1) == 65279 || SB_KEY.charAt(SB_KEY.length - 1) == ' ' || SB_KEY.charAt(SB_KEY.length - 1) == '\n' || SB_KEY.charAt(SB_KEY.length - 1) == '\r' || SB_KEY.charAt(SB_KEY.length - 1) == '\t')) SB_KEY = SB_KEY.substring(0, SB_KEY.length - 1);

//var DEBUG = true;
var DEBUG = false;

module.exports = function (req, res) {
  var act = '' + (req.query.action || '');
  var i, j, tmp, tmp2, ids, body, flg;

  res.setHeader('Cache-Control', 'no-store');

  // 허용된 주소만 (switch 쓰면 IE에서... 아 여긴 서버구나)
  flg = 0;
  if (req.method == 'GET') {
    if (act == 'state' || act == 'leaderboard') flg = 1;
  } else if (req.method == 'POST') {
    if (act == 'join' || act == 'leave' || act == 'update' || act == 'start' || act == 'finish' || act == 'reset' || act == 'settings') flg = 1;
  }
  if (flg == 0) {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: 'not found' }));
    return;
  }
  if (SB_URL == '' || SB_KEY == '') {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: '서버 설정(SUPABASE_URL / SUPABASE_ANON_KEY)이 없어요' }));
    return;
  }

  if (act == 'state') {
    // ?ids=a,b&id=c  -> ['a','b','c']  (최대 8개)
    tmp = [];
    if (req.query.ids) {
      if (typeof req.query.ids == 'string') tmp.push(req.query.ids);
      else for (i = 0; i < req.query.ids.length; i++) tmp.push(req.query.ids[i]);
    }
    if (req.query.id) {
      if (typeof req.query.id == 'string') tmp.push(req.query.id);
      else for (i = 0; i < req.query.id.length; i++) tmp.push(req.query.id[i]);
    }
    tmp2 = tmp.join(',').split(',');
    ids = [];
    for (j = 0; j < tmp2.length; j++) {
      if (tmp2[j] != '' && ids.length < 8) ids.push(tmp2[j]);
    }
    body = { ids: ids };
  } else if (req.method == 'POST') {
    body = req.body;
    if (typeof body == 'string') {
      if (body.length > 10000) {
        body = {};
      } else {
        try {
          body = JSON.parse(body);
        } catch (e) {
          body = {};
        }
      }
    }
    if (body == null || typeof body != 'object' || Object.prototype.toString.call(body) == '[object Array]') body = {};
  } else {
    body = {};
  }

  var u = urlmod.parse(SB_URL + '/rest/v1/rpc/tr_api');
  var postData = JSON.stringify({ p_action: act, p_body: body });
  var hdr = {};
  hdr['apikey'] = SB_KEY;
  hdr['Content-Type'] = 'application/json';
  hdr['Content-Length'] = Buffer.byteLength(postData);
  // sb_publishable_ 키는 JWT 아님 -> Authorization 넣으면 에러남 (2009.08 반나절 날림)
  if (SB_KEY.substring(0, 3) != 'sb_') hdr['Authorization'] = 'Bearer ' + SB_KEY;

  var r2 = https.request({
    hostname: u.hostname,
    port: u.port || 443,
    path: u.path,
    method: 'POST',
    headers: hdr
  }, function (resp) {
    var chunks = [];
    resp.on('data', function (c) { chunks.push(c); });
    resp.on('end', function () {
      var txt = Buffer.concat(chunks).toString('utf8');
      var data = null;
      try {
        data = JSON.parse(txt);
      } catch (e) {
        data = null;
      }
      if (DEBUG) console.log('supabase', resp.statusCode, txt);
      if (resp.statusCode < 200 || resp.statusCode > 299 || data == null || typeof data.status != 'number') {
        console.error('supabase error', resp.statusCode, data);
        res.statusCode = 502;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ error: '데이터베이스 오류' }));
        return;
      }
      res.statusCode = data.status;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify(data.body));
    });
  });
  r2.on('error', function (e) {
    console.error(e);
    res.statusCode = 502;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: '데이터베이스에 연결하지 못했어요' }));
  });
  r2.write(postData);
  r2.end();
};

// Vercel 서버리스 함수: 기존 server.py 의 /api/* 를 그대로 받아 Supabase(tr_api)로 넘김
// 게임 화면(public/game.js)은 수정 없이 같은 주소를 호출함
const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  || process.env.SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

const GET_ACTIONS = new Set(['state', 'leaderboard']);
const POST_ACTIONS = new Set(['join', 'leave', 'update', 'start', 'finish', 'reset', 'settings']);

function headers() {
  const h = { apikey: SUPABASE_KEY, 'Content-Type': 'application/json' };
  // sb_publishable_ 키는 JWT가 아니라서 Authorization 헤더에 넣지 않음
  if (!SUPABASE_KEY.startsWith('sb_')) h.Authorization = `Bearer ${SUPABASE_KEY}`;
  return h;
}

function readBody(req) {
  let b = req.body;
  if (typeof b === 'string') {
    if (b.length > 10000) return {};
    try { b = JSON.parse(b); } catch (_) { return {}; }
  }
  return b && typeof b === 'object' && !Array.isArray(b) ? b : {};
}

function idsFromQuery(q) {
  const list = [].concat(q.ids || [], q.id || []);
  return list.join(',').split(',').filter(Boolean).slice(0, 8);
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const action = String(req.query.action || '');
  const ok = req.method === 'GET' ? GET_ACTIONS.has(action) : req.method === 'POST' && POST_ACTIONS.has(action);
  if (!ok) return res.status(404).json({ error: 'not found' });
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).json({ error: '서버 설정(SUPABASE_URL / SUPABASE_ANON_KEY)이 없어요' });
  }

  const body = action === 'state' ? { ids: idsFromQuery(req.query) } : req.method === 'POST' ? readBody(req) : {};
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/tr_api`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ p_action: action, p_body: body }),
    });
    const data = await r.json().catch(() => null);
    if (!r.ok || !data || typeof data.status !== 'number') {
      console.error('supabase error', r.status, data);
      return res.status(502).json({ error: '데이터베이스 오류' });
    }
    return res.status(data.status).json(data.body);
  } catch (e) {
    console.error(e);
    return res.status(502).json({ error: '데이터베이스에 연결하지 못했어요' });
  }
};

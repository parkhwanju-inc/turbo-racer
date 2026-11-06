-- 터보 레이서 서버 보강 (server.py 와 같은 규칙)
--  #3/#1  참가할 때 비밀 토큰 발급(해시만 저장), 쓰기 요청은 tokens 로 확인
--  #13    재접속({id, rejoin: true})인데 모르는 id/틀린 토큰이면 새로 만들지 않고 404
--  #4/#17 완주 판정: 리타이어면 거절, 서버에 저장된 진행도 기준, 최소 바퀴당 8초
--  #6/#1  숫자가 아니거나 NaN/Infinity 인 값은 400 또는 무시 (함수 오류 → 502 없음)
--  #10    레이스가 끝나는 tick 에서 끊긴 사람을 바로 정리 → 아무도 없으면 바로 대기실
--  #16    사람이 한 명도 완주하지 못한 레이스는 저장하지 않음 (예전 기록은 집계에서 제외)
--  #2     tr_races.laps 추가, 최고 기록은 바퀴 수별 (leaderboard {laps})
--  #8     leaderboard 는 방 행 잠금(FOR UPDATE) 전에 처리

-- ------------------------------------------------------------ 스키마
alter table public.tr_players add column if not exists token_hash text;
-- 마지막으로 위치(update)를 받은 시각: 완주 판정 때 네트워크 지연만큼 봐주는 데 씀
alter table public.tr_players add column if not exists moved_at double precision not null default 0;
-- 바퀴 수. 이 마이그레이션 전 기록은 NULL(알 수 없음) → 최고 기록에서 제외
alter table public.tr_races add column if not exists laps int;
create index if not exists idx_tr_races_laps on public.tr_races (laps);

-- ------------------------------------------------------------ 도우미
-- 유한한 숫자만: null 이면 def, 숫자가 아니거나 NaN/Infinity 면 오류(22P02)
create or replace function public.tr_num(j jsonb, def double precision) returns double precision
language plpgsql immutable as $$
declare
  v double precision;
begin
  if j is null or jsonb_typeof(j) = 'null' then return def; end if;
  if jsonb_typeof(j) not in ('number', 'string') then
    raise exception 'not a number' using errcode = '22P02';
  end if;
  v := (j #>> '{}')::double precision;
  if v = 'NaN'::double precision or v = 'Infinity'::double precision or v = '-Infinity'::double precision then
    raise exception 'not finite' using errcode = '22P02';
  end if;
  return v;
end $$;

create or replace function public.tr_hash(t text) returns text
language sql immutable as $$ select encode(sha256(convert_to(t, 'UTF8')), 'hex') $$;

-- b.tokens[pid] 가 그 플레이어의 토큰과 맞는지
create or replace function public.tr_authed(b jsonb, pid text) returns boolean
language sql stable as $$
  select pid is not null
    and jsonb_typeof(b->'tokens') = 'object'
    and jsonb_typeof(b->'tokens'->pid) = 'string'
    and exists (select 1 from public.tr_players p
                where p.id = pid and p.token_hash = public.tr_hash(b->'tokens'->>pid))
$$;

-- 사람이 한 명이라도 완주한 레이스인지 (집계 대상)
create or replace function public.tr_counted(rid bigint) returns boolean
language sql stable as $$
  select exists (select 1 from public.tr_results h where h.race_id = rid and h.finished and not h.is_bot)
$$;

-- ------------------------------------------------------------ 게임 로직
create or replace function public.tr_end_race(now_ double precision) returns void
language plpgsql as $$
declare
  r public.tr_room;
  res jsonb;
  rid bigint;
begin
  select * into r from public.tr_room where id = 1;
  select coalesce(jsonb_agg(x.o order by x.k1, x.k2), '[]'::jsonb) into res from (
    -- 도착한 순서대로
    select 0 as k1, f.ord::double precision as k2,
      jsonb_build_object('name', p.name, 'color', p.color, 'rank', p.rank, 'time_ms', p.time_ms,
                         'finished', true, 'ai', p.ai) as o
    from unnest(r.finish_order) with ordinality as f(pid, ord)
    join public.tr_players p on p.id = f.pid
    union all
    -- 나머지는 많이 간 순서대로
    select 1, -p.progress,
      jsonb_build_object('name', p.name, 'color', p.color, 'rank', null, 'time_ms', null,
                         'finished', false, 'ai', p.ai)
    from public.tr_players p where p.rank is null
  ) x;

  -- 사람이 한 명도 완주하지 못한 레이스(모두 나감/리타이어)는 기록하지 않음
  if exists (select 1 from jsonb_array_elements(res) e
             where (e->>'finished')::boolean and not (e->>'ai')::boolean) then
    insert into public.tr_races (started_at, finished_at, player_count, laps)
    values (to_timestamp(r.start_at), to_timestamp(now_), jsonb_array_length(res), (r.settings->>'laps')::int)
    returning id into rid;

    insert into public.tr_results (race_id, player_name, color, rank, time_ms, finished, is_bot)
    select rid, e->>'name', e->>'color', (e->>'rank')::int, (e->>'time_ms')::int,
           (e->>'finished')::boolean, (e->>'ai')::boolean
    from jsonb_array_elements(res) e;
  end if;

  update public.tr_room set results = res, phase = 'finished', race_id = rid where id = 1;
  perform public.tr_bump();
end $$;

create or replace function public.tr_tick() returns void
language plpgsql as $$
declare
  now_ double precision := public.tr_now();
  r public.tr_room;
  n int;
begin
  select * into r from public.tr_room where id = 1;
  if r.phase = 'racing' then
    update public.tr_players set dnf = true where rank is null and not dnf and now_ - seen > 10;
    get diagnostics n = row_count;
    if n > 0 then perform public.tr_bump(); end if;
    if not exists (select 1 from public.tr_players where rank is null and not dnf) then
      perform public.tr_end_race(now_);
    elsif r.first_finish_at <> 0 and now_ - r.first_finish_at > 30 then
      perform public.tr_end_race(now_);
    elsif now_ - r.start_at > 600 then
      perform public.tr_end_race(now_);
    end if;
    select * into r from public.tr_room where id = 1;
  end if;
  -- 레이스가 방금 끝났어도 같은 tick 에서 접속이 끊긴 사람을 정리 → 아무도 없으면 바로 대기실로
  if r.phase in ('lobby', 'finished') then
    delete from public.tr_players where now_ - seen > 10;
    get diagnostics n = row_count;
    if n > 0 then perform public.tr_bump(); end if;
  end if;
  if not exists (select 1 from public.tr_players) and r.phase <> 'lobby' then
    perform public.tr_reset_room();
  end if;
end $$;

-- ------------------------------------------------------------ API
create or replace function public.tr_api(p_action text, p_body jsonb default '{}'::jsonb)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  b jsonb := case when jsonb_typeof(p_body) = 'object' then p_body else '{}'::jsonb end;
  r public.tr_room;
  p public.tr_players;
  pid text;
  now_ double precision;
  v_name text;
  v_slot int;
  v_color text;
  v_token text;
  want text;
  ids text[];
  c jsonb;
  v_laps int;
  elapsed double precision;
  new_rank int;
  v_lap double precision;
  v_x double precision; v_y double precision; v_a double precision; v_v double precision;
  v_prog double precision;
  since double precision;
  st jsonb;
begin
  -- 읽기 전용 명예의 전당은 방 행 잠금 없이 처리 (레이스 요청과 경쟁하지 않게)
  if p_action = 'leaderboard' then
    begin
      v_laps := greatest(1, least(9, trunc(public.tr_num(b->'laps', 3))::int));
    exception when others then
      v_laps := 3;
    end;
    return jsonb_build_object('status', 200, 'body', jsonb_build_object(
      'best', coalesce((select jsonb_agg(t) from (
          select x.player_name, x.color, x.time_ms,
                 to_char(rc.started_at at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS') as date
          from public.tr_results x join public.tr_races rc on rc.id = x.race_id
          where x.finished and not x.is_bot and rc.laps = v_laps order by x.time_ms asc limit 10) t), '[]'::jsonb),
      'wins', coalesce((select jsonb_agg(t) from (
          select player_name,
                 count(*) filter (where rank = 1) as gold,
                 count(*) filter (where rank = 2) as silver,
                 count(*) filter (where rank = 3) as bronze,
                 count(*) as races
          from public.tr_results where not is_bot and public.tr_counted(race_id) group by player_name
          order by gold desc, silver desc, bronze desc, races desc limit 10) t), '[]'::jsonb),
      'total_races', (select count(*) from public.tr_races rc where public.tr_counted(rc.id)),
      'laps', v_laps));
  end if;

  -- id 는 문자열만
  if b ? 'id' and jsonb_typeof(b->'id') not in ('string', 'null') then
    return jsonb_build_object('status', 400, 'body', jsonb_build_object('error', '잘못된 요청이에요'));
  end if;
  pid := b->>'id';

  -- 파이썬 서버의 threading.Lock 역할: 방 행을 잠가 요청을 한 줄로 세움
  select * into r from public.tr_room where id = 1 for update;

  if p_action = 'join' then
    v_name := left(btrim(coalesce(b->>'name', '')), 12);
    if v_name = '' then v_name := '플레이어'; end if;
    perform public.tr_tick();
    select * into r from public.tr_room where id = 1;
    if public.tr_truthy(b->'rejoin') then
      -- 새로고침 후 재접속: 모르는 id 거나 토큰이 틀리면 새로 만들지 않음
      if not public.tr_authed(b, pid) then
        return jsonb_build_object('status', 404, 'body',
          jsonb_build_object('error', '참가 정보가 없어요. 다시 참가해 주세요.'));
      end if;
      perform public.tr_touch(pid);
      return jsonb_build_object('status', 200, 'body', public.tr_public_state(pid));
    end if;
    if r.phase <> 'lobby' then
      return jsonb_build_object('status', 409, 'body',
        jsonb_build_object('error', '레이스가 진행 중이에요. 끝나면 다시 참가해 주세요!'));
    end if;
    select min(s) into v_slot from generate_series(0, 7) s
      where s not in (select slot from public.tr_players);
    if v_slot is null then
      return jsonb_build_object('status', 409, 'body', jsonb_build_object('error', '방이 가득 찼어요 (최대 8명)'));
    end if;
    want := case when jsonb_typeof(b->'color') = 'string' then b->>'color' end;
    if want = any(public.tr_colors()) and not exists (select 1 from public.tr_players where color = want) then
      v_color := want;
    else
      select col into v_color from unnest(public.tr_colors()) with ordinality u(col, i)
        where col not in (select color from public.tr_players) order by i limit 1;
      v_color := coalesce(v_color, (public.tr_colors())[1]);
    end if;
    pid := left(replace(gen_random_uuid()::text, '-', ''), 12);
    v_token := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
    insert into public.tr_players (id, name, color, slot, seen, ai, token_hash)
    values (pid, v_name, v_color, v_slot, public.tr_now(), public.tr_truthy(b->'ai'), public.tr_hash(v_token));
    perform public.tr_bump();
    -- 토큰은 참가한 브라우저에만 이 응답으로 한 번 돌려줌 (공개 상태에는 없음)
    st := public.tr_public_state(pid) || jsonb_build_object('token', v_token);
    return jsonb_build_object('status', 200, 'body', st);
  end if;

  if p_action = 'leave' then
    if not public.tr_authed(b, pid) then
      return jsonb_build_object('status', 403, 'body',
        jsonb_build_object('error', '플레이어 확인에 실패했어요. 다시 참가해 주세요.'));
    end if;
    if r.phase = 'racing' then
      -- 나간 사람: 레이스가 끝나는 tick 에서 바로 정리되도록 seen = 0
      update public.tr_players set dnf = true, seen = 0 where id = pid;
    else
      delete from public.tr_players where id = pid;
    end if;
    perform public.tr_bump();
    perform public.tr_tick();
    return jsonb_build_object('status', 200, 'body', jsonb_build_object('ok', true));
  end if;

  if p_action = 'state' then
    -- 읽기 전용 (토큰이 없으니 접속 유지 표시도 하지 않음)
    select coalesce(array_agg(e #>> '{}' order by i), '{}') into ids
      from jsonb_array_elements(case when jsonb_typeof(b->'ids') = 'array' then b->'ids' else '[]' end)
           with ordinality t(e, i)
      where jsonb_typeof(e) = 'string' and i <= 8;
    perform public.tr_tick();
    return jsonb_build_object('status', 200, 'body',
      public.tr_public_state(case when cardinality(ids) > 0 then ids[1] else pid end));
  end if;

  if p_action = 'update' then
    select coalesce(array_agg(e #>> '{}' order by i), '{}') into ids
      from jsonb_array_elements(case when jsonb_typeof(b->'ids') = 'array' then b->'ids' else '[]' end)
           with ordinality t(e, i)
      where jsonb_typeof(e) = 'string' and i <= 8;
    -- 토큰이 맞는 id 만 접속 유지·위치 반영 (나머지는 조용히 무시)
    update public.tr_players set seen = public.tr_now()
      where id = any(ids) and public.tr_authed(b, id);

    for c in
      select e from jsonb_array_elements(
        case when jsonb_typeof(b->'cars') = 'array' then b->'cars' else jsonb_build_array(b) end
      ) with ordinality t(e, i) where i <= 8
    loop
      continue when jsonb_typeof(c) <> 'object' or jsonb_typeof(c->'id') <> 'string';
      continue when not public.tr_authed(b, c->>'id');
      perform public.tr_touch(c->>'id');
      select * into p from public.tr_players where id = c->>'id';
      select * into r from public.tr_room where id = 1;
      if p.id is not null and r.phase = 'racing' and p.rank is null and not p.dnf then
        begin
          v_x := public.tr_num(c->'x', 0); v_y := public.tr_num(c->'y', 0);
          v_a := public.tr_num(c->'a', 0); v_v := public.tr_num(c->'v', 0);
          v_prog := public.tr_num(c->'progress', 0);
          v_lap := public.tr_num(c->'lap', 0);
          if abs(v_lap) > 1000 then raise exception 'lap' using errcode = '22003'; end if;
          update public.tr_players set x = v_x, y = v_y, a = v_a, v = v_v,
            progress = v_prog, lap = trunc(v_lap)::int, moved_at = public.tr_now()
          where id = p.id;
        exception when others then null;  -- 이상한 값이 하나라도 있으면 그 차는 무시
        end;
      end if;
      p := null;
    end loop;

    perform public.tr_tick();
    return jsonb_build_object('status', 200, 'body',
      public.tr_public_state(case when cardinality(ids) > 0 then ids[1] else pid end));
  end if;

  if p_action = 'start' then
    perform public.tr_tick();
    select * into r from public.tr_room where id = 1;
    if r.phase <> 'lobby' then
      return jsonb_build_object('status', 409, 'body', jsonb_build_object('error', '이미 시작했어요'));
    end if;
    if not public.tr_authed(b, pid) then
      return jsonb_build_object('status', 403, 'body', jsonb_build_object('error', '참가한 플레이어만 시작할 수 있어요'));
    end if;
    now_ := public.tr_now();
    update public.tr_room set phase = 'racing', start_at = now_ + 3.5, first_finish_at = 0,
      finish_order = '{}', results = '[]' where id = 1;
    update public.tr_players set x = 0, y = 0, a = 0, v = 0, progress = -1, lap = 0,
      rank = null, time_ms = null, dnf = false, seen = now_, moved_at = 0 where true;
    perform public.tr_bump();
    return jsonb_build_object('status', 200, 'body', public.tr_public_state(pid));
  end if;

  if p_action = 'finish' then
    if not public.tr_authed(b, pid) then
      return jsonb_build_object('status', 403, 'body',
        jsonb_build_object('error', '플레이어 확인에 실패했어요. 다시 참가해 주세요.'));
    end if;
    perform public.tr_touch(pid);
    now_ := public.tr_now();
    select * into p from public.tr_players where id = pid;
    if r.phase <> 'racing' then
      return jsonb_build_object('status', 409, 'body', jsonb_build_object('error', '레이스 중이 아니에요'));
    end if;
    if p.rank is not null then
      return jsonb_build_object('status', 200, 'body', public.tr_public_state(pid));
    end if;
    if p.dnf then
      return jsonb_build_object('status', 409, 'body',
        jsonb_build_object('error', '리타이어 처리돼서 완주로 인정되지 않아요'));
    end if;
    elapsed := now_ - r.start_at;
    v_laps := (r.settings->>'laps')::int;
    begin
      v_lap := public.tr_num(b->'lap', 0);
    exception when others then
      return jsonb_build_object('status', 400, 'body', jsonb_build_object('error', '완주가 확인되지 않았어요'));
    end;
    -- 완주 판정은 서버에 저장된 진행도(update 로 받은 값) 기준.
    -- 마지막 update 이후(최대 2초) 갈 수 있었던 만큼은 봐줌: 마지막 update 와 finish 사이의 네트워크 지연
    since := case when p.moved_at > 0 then least(2, greatest(0, now_ - p.moved_at)) else 0 end;
    if v_lap < v_laps or p.progress < v_laps - 0.05 - 0.12 * since or elapsed < 8 * v_laps then
      return jsonb_build_object('status', 400, 'body', jsonb_build_object('error', '완주가 확인되지 않았어요'));
    end if;
    update public.tr_room set finish_order = finish_order || pid where id = 1
      returning cardinality(finish_order) into new_rank;
    update public.tr_players set rank = new_rank, time_ms = trunc(elapsed * 1000)::int,
      progress = greatest(progress, v_laps)
      where id = pid;
    if new_rank = 1 then
      update public.tr_room set first_finish_at = now_ where id = 1;
    end if;
    perform public.tr_bump();
    perform public.tr_tick();
    return jsonb_build_object('status', 200, 'body', public.tr_public_state(pid));
  end if;

  if p_action = 'settings' then
    if not public.tr_authed(b, pid) then
      return jsonb_build_object('status', 403, 'body', jsonb_build_object('error', '참가한 플레이어만 바꿀 수 있어요'));
    end if;
    if r.phase <> 'lobby' then
      return jsonb_build_object('status', 409, 'body', jsonb_build_object('error', '대기실에서만 바꿀 수 있어요'));
    end if;
    if b ? 'laps' then
      begin
        v_laps := trunc(greatest(1, least(9, public.tr_num(b->'laps', 3))))::int;
        update public.tr_room set settings = jsonb_set(settings, '{laps}', to_jsonb(v_laps))
          where id = 1;
      exception when others then null;
      end;
    end if;
    if b->>'difficulty' in ('easy', 'normal', 'hard') then
      update public.tr_room set settings = jsonb_set(settings, '{difficulty}', to_jsonb(b->>'difficulty'))
        where id = 1;
    end if;
    perform public.tr_touch(pid);
    perform public.tr_bump();
    return jsonb_build_object('status', 200, 'body', public.tr_public_state(pid));
  end if;

  if p_action = 'reset' then
    if not public.tr_authed(b, pid) then
      return jsonb_build_object('status', 403, 'body',
        jsonb_build_object('error', '플레이어 확인에 실패했어요. 다시 참가해 주세요.'));
    end if;
    if r.phase = 'finished' or not exists (select 1 from public.tr_players) then
      perform public.tr_reset_room();
    end if;
    perform public.tr_touch(pid);
    return jsonb_build_object('status', 200, 'body', public.tr_public_state(pid));
  end if;

  return jsonb_build_object('status', 404, 'body', jsonb_build_object('error', 'not found'));
end $$;

-- 외부(anon)에는 tr_api 하나만 공개 (새 도우미 함수 포함해 다시 막음)
revoke all on all functions in schema public from public, anon, authenticated;
grant execute on function public.tr_api(text, jsonb) to anon, authenticated;

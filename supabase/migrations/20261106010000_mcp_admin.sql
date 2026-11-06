-- MCP 서버(api/mcp.js)용 운영 함수.
-- anon(브라우저)에는 열지 않고 service_role(Vercel 에만 있는 secret key)만 실행할 수 있다.
-- 게임 규칙 자체(tr_api)는 바꾸지 않는다. 여기 있는 동작은 운영자가 방을 관리할 때만 쓴다.

create or replace function public.tr_admin(p_action text, p_body jsonb default '{}'::jsonb)
returns jsonb
language plpgsql security definer
set search_path = public
as $$
declare
  b jsonb := case when jsonb_typeof(p_body) = 'object' then p_body else '{}'::jsonb end;
  r public.tr_room;
  lim int;
  v_laps int;
  v_sec double precision;
  v_name text;
  pid text;
  n int;
  now_ double precision;
begin
  -- ---------------------------------------------------------------- 읽기 전용
  if p_action = 'recent_races' then
    begin lim := greatest(1, least(50, trunc(public.tr_num(b->'limit', 10))::int));
    exception when others then lim := 10; end;
    return jsonb_build_object('status', 200, 'body', coalesce((
      select jsonb_agg(x order by x.id desc) from (
        select rc.id,
               to_char(rc.started_at at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS') as started_at,
               rc.laps, rc.player_count,
               (select jsonb_agg(jsonb_build_object('name', t.player_name, 'rank', t.rank, 'time_ms', t.time_ms,
                                                    'finished', t.finished, 'bot', t.is_bot)
                                 order by t.rank nulls last, t.id)
                from public.tr_results t where t.race_id = rc.id) as results
        from public.tr_races rc
        where public.tr_counted(rc.id)
        order by rc.id desc limit lim) x), '[]'::jsonb));
  end if;

  if p_action = 'player_history' then
    v_name := left(btrim(coalesce(b->>'name', '')), 12);
    if v_name = '' then
      return jsonb_build_object('status', 400, 'body', jsonb_build_object('error', '이름을 알려 주세요'));
    end if;
    begin lim := greatest(1, least(50, trunc(public.tr_num(b->'limit', 20))::int));
    exception when others then lim := 20; end;
    return jsonb_build_object('status', 200, 'body', jsonb_build_object(
      'name', v_name,
      'summary', (select jsonb_build_object(
                    'races', count(*),
                    'gold', count(*) filter (where t.rank = 1),
                    'silver', count(*) filter (where t.rank = 2),
                    'bronze', count(*) filter (where t.rank = 3),
                    'finished', count(*) filter (where t.finished))
                  from public.tr_results t
                  where t.player_name = v_name and not t.is_bot and public.tr_counted(t.race_id)),
      'races', coalesce((select jsonb_agg(x order by x.race_id desc) from (
          select t.race_id, rc.laps, t.rank, t.time_ms, t.finished,
                 to_char(rc.started_at at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS') as started_at
          from public.tr_results t join public.tr_races rc on rc.id = t.race_id
          where t.player_name = v_name and not t.is_bot
          order by t.race_id desc limit lim) x), '[]'::jsonb)));
  end if;

  if p_action = 'suspicious_records' then
    -- 바퀴당 이 초보다 빠른 완주 기록 (기본 10초. 부스터를 계속 써도 바퀴당 약 9.4초가 걸림)
    begin v_sec := greatest(1, least(60, public.tr_num(b->'sec_per_lap', 10)));
    exception when others then v_sec := 10; end;
    return jsonb_build_object('status', 200, 'body', jsonb_build_object(
      'sec_per_lap', v_sec,
      'records', coalesce((select jsonb_agg(x order by x.time_ms) from (
          select t.race_id, t.player_name, t.time_ms, rc.laps,
                 round((t.time_ms / 1000.0 / coalesce(rc.laps, 1))::numeric, 2) as sec_per_lap,
                 (rc.laps is null) as laps_unknown,
                 to_char(rc.started_at at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS') as started_at
          from public.tr_results t join public.tr_races rc on rc.id = t.race_id
          where t.finished and not t.is_bot
            and t.time_ms < v_sec * 1000 * coalesce(rc.laps, 1)
          order by t.time_ms limit 50) x), '[]'::jsonb)));
  end if;

  -- ---------------------------------------------------------------- 쓰기 (방 행을 잠가 tr_api 와 한 줄로)
  select * into r from public.tr_room where id = 1 for update;

  if p_action = 'delete_race' then
    begin n := trunc(public.tr_num(b->'race_id', -1))::int;
    exception when others then n := -1; end;
    delete from public.tr_races where id = n;  -- tr_results 는 on delete cascade
    get diagnostics n = row_count;
    if n = 0 then
      return jsonb_build_object('status', 404, 'body', jsonb_build_object('error', '그 번호의 레이스가 없어요'));
    end if;
    return jsonb_build_object('status', 200, 'body', jsonb_build_object('deleted', true, 'race_id', b->'race_id'));
  end if;

  if p_action = 'room_settings' then
    perform public.tr_tick();
    select * into r from public.tr_room where id = 1;
    if r.phase <> 'lobby' then
      return jsonb_build_object('status', 409, 'body', jsonb_build_object('error', '대기실에서만 바꿀 수 있어요 (지금: ' || r.phase || ')'));
    end if;
    if b ? 'laps' then
      begin
        v_laps := trunc(greatest(1, least(9, public.tr_num(b->'laps', 3))))::int;
        update public.tr_room set settings = jsonb_set(settings, '{laps}', to_jsonb(v_laps)) where id = 1;
      exception when others then
        return jsonb_build_object('status', 400, 'body', jsonb_build_object('error', '바퀴 수는 1~9 숫자예요'));
      end;
    end if;
    if b ? 'difficulty' then
      if b->>'difficulty' not in ('easy', 'normal', 'hard') then
        return jsonb_build_object('status', 400, 'body', jsonb_build_object('error', '난이도는 easy / normal / hard 중 하나예요'));
      end if;
      update public.tr_room set settings = jsonb_set(settings, '{difficulty}', to_jsonb(b->>'difficulty')) where id = 1;
    end if;
    perform public.tr_bump();
    return jsonb_build_object('status', 200, 'body', public.tr_public_state(null));
  end if;

  if p_action = 'start_race' then
    perform public.tr_tick();
    select * into r from public.tr_room where id = 1;
    if r.phase <> 'lobby' then
      return jsonb_build_object('status', 409, 'body', jsonb_build_object('error', '대기실이 아니라 시작할 수 없어요 (지금: ' || r.phase || ')'));
    end if;
    if not exists (select 1 from public.tr_players where not ai) then
      return jsonb_build_object('status', 409, 'body', jsonb_build_object('error', '대기실에 사람이 없어요'));
    end if;
    -- tr_api 'start' 와 같은 처리
    now_ := public.tr_now();
    update public.tr_room set phase = 'racing', start_at = now_ + 3.5, first_finish_at = 0,
      finish_order = '{}', results = '[]' where id = 1;
    update public.tr_players set x = 0, y = 0, a = 0, v = 0, progress = -1, lap = 0,
      rank = null, time_ms = null, dnf = false, seen = now_, moved_at = 0 where true;
    perform public.tr_bump();
    return jsonb_build_object('status', 200, 'body', public.tr_public_state(null));
  end if;

  if p_action = 'kick_player' then
    pid := b->>'player_id';
    if pid is null or not exists (select 1 from public.tr_players where id = pid) then
      return jsonb_build_object('status', 404, 'body', jsonb_build_object('error', '방에 그 플레이어가 없어요'));
    end if;
    -- tr_api 'leave' 와 같은 처리 (레이스 중이면 리타이어)
    if r.phase = 'racing' then
      update public.tr_players set dnf = true, seen = 0 where id = pid;
    else
      delete from public.tr_players where id = pid;
    end if;
    perform public.tr_bump();
    perform public.tr_tick();
    return jsonb_build_object('status', 200, 'body', public.tr_public_state(null));
  end if;

  if p_action = 'reset_room' then
    -- 레이스 중이어도 강제로 대기실로. 기록은 남기지 않는다. 참가자는 그대로 대기실에 남는다.
    perform public.tr_reset_room();
    return jsonb_build_object('status', 200, 'body', public.tr_public_state(null));
  end if;

  return jsonb_build_object('status', 404, 'body', jsonb_build_object('error', 'not found'));
end $$;

revoke all on function public.tr_admin(text, jsonb) from public, anon, authenticated;
grant execute on function public.tr_admin(text, jsonb) to service_role;

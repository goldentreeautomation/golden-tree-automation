-- 0030_add_regina_weather_history.sql — Regina 과거 날씨 기록 (오너 요청, 2026-09-09)
--
-- 배경: "왜 바빴는지/한가했는지" 분석하려면 과거 매출(있음)과 과거 날씨(없었음)를 대조해야
-- 하는데, 지금까지는 "오늘 날씨"만 실시간 조회하고 버렸다 — 과거분이 하나도 안 남아있었음.
-- Open-Meteo Archive API(무료, 키 불필요)로 하루 단위 과거 날씨를 한 번에 받아 소급 적재한다.
-- 날씨는 매장별이 아니라 도시 전체 신호라 location_id 없이 date만 키로 둔다(0007과 동일한
-- 지리 좌표 사용).

create table if not exists public.regina_weather_history (
  date date primary key,
  temperature_max_c numeric,
  temperature_min_c numeric,
  temperature_mean_c numeric,
  feels_like_max_c numeric,
  feels_like_min_c numeric,
  precipitation_mm numeric,
  rain_mm numeric,
  snowfall_cm numeric,
  wind_speed_max_kph numeric,
  weather_code integer,
  source text not null default 'open-meteo',
  imported_at timestamptz not null default now()
);
comment on table public.regina_weather_history is 'Open-Meteo Archive API로 받은 Regina 일별 과거 날씨. 매출-날씨 상관관계 분석용(오너 요청, 2026-09-09). 매장 구분 없음(도시 전체 신호).';

alter table public.regina_weather_history enable row level security;

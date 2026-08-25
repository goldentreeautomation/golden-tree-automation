// Golden Tree — 대시보드 첫 페이지 (M1 #8)
// 정적 HTML을 그대로 서빙한다. 데이터는 브라우저가 dashboard-api를 fetch해서 채운다.
// 디자인 토큰: awesome-design-md/design-md/figma/DESIGN.md 기반 (모노크롬 + 파스텔 블록 컬러,
// 필 버튼). 다크모드는 이 시스템에 공식 정의가 없어 "가장 가까운 대안"인 block-navy를 그대로
// 썼다(문서 576줄). 실제 폰트(figmaSans)는 라이선스 문제로 시스템 폰트 폴백만 사용.

const HTML = `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="color-scheme" content="light dark" />
<title>Golden Tree — 매출 대시보드</title>
<style>
  :root {
    --ink: #000000;
    --canvas: #ffffff;
    --surface-soft: #f7f7f5;
    --hairline: #e6e6e6;
    --hairline-soft: #f1f1f1;
    --stone: #6b6b6b;
    --muted: #9a9a9a;
    --positive-bg: #dceeb1;
    --positive-text: #1a6b34;
    --negative-bg: #f3c9b6;
    --negative-text: #a13d24;
    --today-fill: #000000;
    --radius-card: 24px;
    --radius-md: 8px;
    --radius-pill: 50px;
    --chart-colors: #dceeb1, #c5b0f4, #f4ecd6, #c8e6cd, #efd4d4, #f3c9b6;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --ink: #ffffff;
      --canvas: #1f1d3d;
      --surface-soft: #292750;
      --hairline: #3c3a63;
      --hairline-soft: #322f57;
      --stone: #b9b7d6;
      --muted: #7d7ba3;
      --positive-bg: #2f4a2a;
      --positive-text: #b7e59a;
      --negative-bg: #4a2e2a;
      --negative-text: #f3b39c;
      --today-fill: #ffffff;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--surface-soft);
    color: var(--ink);
    font-family: figmaSans, -apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, sans-serif;
    -webkit-font-smoothing: antialiased;
    padding-bottom: 40px;
  }
  header {
    position: sticky;
    top: 0;
    z-index: 10;
    background: var(--canvas);
    border-bottom: 1px solid var(--hairline);
    padding: 14px 16px 12px;
  }
  .brand {
    font-family: figmaMono, ui-monospace, Menlo, monospace;
    font-size: 12px;
    font-weight: 600;
    color: var(--stone);
    letter-spacing: 0.6px;
    text-transform: uppercase;
    margin-bottom: 10px;
  }
  .week-nav {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .week-nav button {
    border: 1px solid var(--ink);
    background: var(--canvas);
    color: var(--ink);
    width: 40px;
    height: 40px;
    border-radius: var(--radius-pill);
    font-size: 18px;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .week-nav button:disabled { border-color: var(--hairline); color: var(--muted); }
  .week-label { text-align: center; flex: 1; }
  .week-label .range { font-size: 18px; font-weight: 700; letter-spacing: -0.2px; }
  .week-label .tag { font-family: figmaMono, ui-monospace, Menlo, monospace; font-size: 11px; color: var(--stone); margin-top: 2px; text-transform: uppercase; letter-spacing: 0.4px; }
  main {
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 16px;
    max-width: 720px;
    margin: 0 auto;
  }
  .loading, .error {
    text-align: center;
    color: var(--stone);
    padding: 40px 16px;
    font-size: 14px;
  }
  .error { color: var(--negative-text); }
  .card {
    background: var(--canvas);
    border: 1px solid var(--ink);
    border-radius: var(--radius-card);
    padding: 24px;
  }
  .loc-name {
    font-family: figmaMono, ui-monospace, Menlo, monospace;
    font-size: 12px;
    font-weight: 600;
    color: var(--stone);
    text-transform: uppercase;
    letter-spacing: 0.6px;
  }
  .net-sales-row {
    display: flex;
    align-items: baseline;
    gap: 10px;
    margin-top: 8px;
    flex-wrap: wrap;
  }
  .net-sales { font-size: 34px; font-weight: 700; letter-spacing: -0.6px; }
  .badge {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    font-size: 13px;
    font-weight: 700;
    padding: 3px 10px;
    border-radius: var(--radius-pill);
  }
  .badge.up { background: var(--positive-bg); color: var(--positive-text); }
  .badge.down { background: var(--negative-bg); color: var(--negative-text); }
  .badge.flat { background: var(--hairline-soft); color: var(--stone); }
  .sub-label { font-size: 12px; color: var(--stone); margin-top: 4px; }
  .stat-row { display: flex; gap: 12px; margin-top: 18px; }
  .stat { flex: 1; background: var(--surface-soft); border-radius: var(--radius-md); padding: 10px 12px; }
  .stat .label { font-family: figmaMono, ui-monospace, Menlo, monospace; font-size: 10px; color: var(--stone); font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; }
  .stat .value { font-size: 18px; font-weight: 700; margin-top: 2px; }

  .section-title {
    font-family: figmaMono, ui-monospace, Menlo, monospace;
    font-size: 11px;
    font-weight: 600;
    color: var(--stone);
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin: 20px 0 8px;
  }

  .daily-table { display: flex; flex-direction: column; gap: 1px; background: var(--hairline); border-radius: var(--radius-md); overflow: hidden; }
  .daily-row { display: flex; align-items: center; gap: 8px; background: var(--canvas); padding: 8px 10px; }
  .daily-row .day { width: 48px; font-size: 12px; color: var(--stone); flex-shrink: 0; }
  .daily-row .bar-track { flex: 1; height: 8px; background: var(--surface-soft); border-radius: 4px; overflow: hidden; }
  .daily-row .bar-fill { height: 100%; background: var(--positive-bg); border-radius: 4px; }
  .daily-row.today .bar-fill { background: var(--today-fill); }
  .daily-row .amt { width: 88px; text-align: right; font-size: 12px; font-weight: 700; flex-shrink: 0; }

  .top-items { display: flex; flex-direction: column; gap: 6px; }
  .top-item { display: flex; align-items: center; gap: 8px; font-size: 13px; }
  .top-item .rank {
    width: 18px; height: 18px; border-radius: var(--radius-pill);
    background: var(--ink); color: var(--canvas); font-size: 10px; font-weight: 700;
    display: flex; align-items: center; justify-content: center; flex-shrink: 0;
  }
  .top-item .name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .top-item .variation { color: var(--stone); font-size: 11px; }
  .top-item .amt { font-weight: 700; flex-shrink: 0; }

  .pie-row { display: flex; align-items: center; gap: 16px; margin-top: 4px; }
  .pie { width: 96px; height: 96px; border-radius: 50%; flex-shrink: 0; border: 1px solid var(--ink); }
  .legend { flex: 1; display: flex; flex-direction: column; gap: 6px; min-width: 0; }
  .legend-item { display: flex; align-items: center; gap: 6px; font-size: 12px; }
  .legend-dot { width: 10px; height: 10px; border-radius: 3px; border: 1px solid var(--ink); flex-shrink: 0; }
  .legend-name { flex: 1; color: var(--stone); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .legend-pct { font-weight: 700; }

  footer { font-family: figmaMono, ui-monospace, Menlo, monospace; text-align: center; font-size: 10px; color: var(--muted); padding: 16px; letter-spacing: 0.3px; }
  @media (min-width: 640px) {
    .locations { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
    main { padding: 24px; }
  }
</style>
</head>
<body>
<header>
  <div class="brand">82 Bakeshop — Net Sales</div>
  <div class="week-nav">
    <button id="prevWeek" aria-label="이전 주">&#8249;</button>
    <div class="week-label">
      <div class="range" id="weekRange">불러오는 중...</div>
      <div class="tag" id="weekTag"></div>
    </div>
    <button id="nextWeek" aria-label="다음 주">&#8250;</button>
  </div>
</header>
<main>
  <div id="content" class="loading">불러오는 중...</div>
</main>
<footer>매출 = NET SALES(총매출−할인), 세금·팁 제외 · 데이터는 매일 자동 갱신됩니다</footer>

<script>
const API = 'https://stfiazhmznssyfsiaxvw.supabase.co/functions/v1/dashboard-api';
const CHART_COLORS = ['#dceeb1','#c5b0f4','#f4ecd6','#c8e6cd','#efd4d4','#f3c9b6'];
let weekOffset = 0;
let loading = false;

function fmtMoney(n) {
  return '$' + Number(n).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtDateRange(start, end) {
  const s = new Date(start + 'T00:00:00');
  const e = new Date(end + 'T00:00:00');
  const opt = { month: 'short', day: 'numeric' };
  return s.toLocaleDateString('en-CA', opt) + ' – ' + e.toLocaleDateString('en-CA', opt);
}
function dayLabel(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  const dow = ['일','월','화','수','목','금','토'][d.getDay()];
  const md = d.toLocaleDateString('en-CA', { month: 'numeric', day: 'numeric' });
  return dow + ' ' + md;
}
function badgeHtml(pct) {
  if (pct === null || pct === undefined) return '<span class="badge flat">신규</span>';
  const dir = pct > 0 ? 'up' : pct < 0 ? 'down' : 'flat';
  const arrow = pct > 0 ? '▲' : pct < 0 ? '▼' : '–';
  return '<span class="badge ' + dir + '">' + arrow + ' ' + Math.abs(pct) + '%</span>';
}
function renderDaily(daily) {
  if (!daily || daily.length === 0) return '';
  const max = Math.max(...daily.map(d => d.net_sales), 1);
  const todayStr = new Date().toISOString().slice(0, 10);
  const rows = daily.map(d => {
    const w = Math.max(2, Math.round((d.net_sales / max) * 100));
    const isToday = d.business_date === todayStr;
    return '<div class="daily-row' + (isToday ? ' today' : '') + '">' +
      '<div class="day">' + dayLabel(d.business_date) + '</div>' +
      '<div class="bar-track"><div class="bar-fill" style="width:' + w + '%"></div></div>' +
      '<div class="amt">' + fmtMoney(d.net_sales) + '</div>' +
    '</div>';
  }).join('');
  return '<div class="section-title">일별 순매출</div><div class="daily-table">' + rows + '</div>';
}
function renderTopItems(items) {
  if (!items || items.length === 0) return '';
  const rows = items.map((it, i) => {
    const variation = it.variation_name ? '<span class="variation">' + it.variation_name + '</span>' : '';
    return '<div class="top-item">' +
      '<div class="rank">' + (i+1) + '</div>' +
      '<div class="name">' + it.item_name + ' ' + variation + '</div>' +
      '<div class="amt">' + fmtMoney(it.net_sales) + '</div>' +
    '</div>';
  }).join('');
  return '<div class="section-title">탑 세일 TOP 5</div><div class="top-items">' + rows + '</div>';
}
function renderCategoryPie(groups) {
  if (!groups || groups.length === 0) return '';
  let acc = 0;
  const stops = groups.map((g, i) => {
    const color = CHART_COLORS[i % CHART_COLORS.length];
    const start = acc;
    acc += g.pct;
    return color + ' ' + start + '% ' + acc + '%';
  }).join(', ');
  const pieStyle = 'background: conic-gradient(' + stops + ');';
  const legend = groups.map((g, i) => {
    const color = CHART_COLORS[i % CHART_COLORS.length];
    return '<div class="legend-item">' +
      '<div class="legend-dot" style="background:' + color + '"></div>' +
      '<div class="legend-name">' + g.name + '</div>' +
      '<div class="legend-pct">' + g.pct + '%</div>' +
    '</div>';
  }).join('');
  return '<div class="section-title">카테고리 비중</div><div class="pie-row">' +
    '<div class="pie" style="' + pieStyle + '"></div>' +
    '<div class="legend">' + legend + '</div>' +
  '</div>';
}
function renderLocation(loc) {
  return '<div class="card">' +
    '<div class="loc-name">' + loc.location_name + '</div>' +
    '<div class="net-sales-row">' +
      '<div class="net-sales">' + fmtMoney(loc.net_sales) + '</div>' +
      badgeHtml(loc.compare.net_sales_change_pct) +
    '</div>' +
    '<div class="sub-label">지난주 같은 기간 ' + fmtMoney(loc.compare.net_sales) + '</div>' +
    '<div class="stat-row">' +
      '<div class="stat"><div class="label">결제건수</div><div class="value">' + loc.order_count.toLocaleString() + '건</div></div>' +
      '<div class="stat"><div class="label">평균단가</div><div class="value">' + fmtMoney(loc.average_order_value) + '</div></div>' +
    '</div>' +
    renderDaily(loc.daily) +
    renderTopItems(loc.top_items) +
    renderCategoryPie(loc.category_groups) +
  '</div>';
}

async function load() {
  if (loading) return;
  loading = true;
  document.getElementById('prevWeek').disabled = true;
  document.getElementById('nextWeek').disabled = true;
  const content = document.getElementById('content');
  content.className = 'loading';
  content.textContent = '불러오는 중...';
  try {
    const res = await fetch(API + '?week_offset=' + weekOffset);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    document.getElementById('weekRange').textContent = fmtDateRange(data.week_start, data.week_end);
    document.getElementById('weekTag').textContent = data.is_current_week ? '이번 주 (진행 중)' : '';

    content.className = 'locations';
    content.innerHTML = data.locations.map(renderLocation).join('');
  } catch (err) {
    content.className = 'error';
    content.textContent = '불러오지 못했습니다: ' + err.message;
  } finally {
    loading = false;
    document.getElementById('prevWeek').disabled = false;
    document.getElementById('nextWeek').disabled = weekOffset >= 0;
  }
}

document.getElementById('prevWeek').addEventListener('click', () => { weekOffset -= 1; load(); });
document.getElementById('nextWeek').addEventListener('click', () => { if (weekOffset < 0) { weekOffset += 1; load(); } });

load();
</script>
</body>
</html>`;

Deno.serve(() => new Response(HTML, { headers: { "content-type": "text/html; charset=utf-8" } }));

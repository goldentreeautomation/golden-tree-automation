// Golden Tree — 재고 입력 웹페이지 (docs/decisions/0014)
// Discord `/stock`과 같은 데이터(stock_items, stock_events)를 쓴다. 대시보드와 같은 디자인
// 톤(Inter 폰트, 그림자 카드)을 재사용한다.
//
// 2026-09-07 개편(오너 피드백): 카테고리 탭으로 분류, 카운트/생산은 일괄 처리 버튼 1개씩,
// 빈 칸은 건드리지 않음, 비밀번호 게이트 제거, 통당개수 저장은 그대로 행별 개별 처리.

const HTML = `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="color-scheme" content="light" />
<title>Golden Tree — 재고 입력</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  :root {
    --ink: #17161f;
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
    --warn-bg: #f4ecd6;
    --warn-text: #8a6d1a;
    --accent: #c5b0f4;
    --radius-card: 20px;
    --radius-md: 12px;
    --radius-pill: 50px;
    --shadow-card: 0 1px 2px -1px rgba(0,0,0,.08), 0 4px 16px -4px rgba(0,0,0,.06);
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--surface-soft);
    color: var(--ink);
    font-family: Inter, "SF Pro Display", system-ui, Helvetica, sans-serif;
    -webkit-font-smoothing: antialiased;
    padding-bottom: 48px;
  }
  header {
    position: sticky; top: 0; z-index: 10;
    background: color-mix(in srgb, var(--canvas) 90%, transparent);
    backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);
    border-bottom: 1px solid var(--hairline-soft);
    padding: 14px 16px;
  }
  .brand { font-size: 13px; font-weight: 600; }
  .brand .dim { color: var(--muted); font-weight: 500; }
  main { padding: 16px; max-width: 1100px; margin: 0 auto; display: flex; flex-direction: column; gap: 12px; }

  .toolbar { position: sticky; top: 53px; z-index: 9; background: var(--surface-soft); padding: 4px 0 8px; display: flex; flex-wrap: wrap; align-items: center; justify-content: center; gap: 10px; }
  .tabs { display: flex; flex-wrap: wrap; justify-content: center; gap: 6px; flex: 1; }
  .tab { padding: 7px 14px; font-size: 12.5px; font-weight: 600; border-radius: var(--radius-pill); border: 1px solid var(--hairline); background: var(--canvas); color: var(--stone); cursor: pointer; white-space: nowrap; }
  .tab.active { background: var(--ink); color: var(--canvas); border-color: var(--ink); }
  .bulkActions { display: flex; gap: 8px; }
  .bulkActions button { padding: 9px 16px; font-size: 12.5px; font-weight: 700; border: none; border-radius: var(--radius-pill); cursor: pointer; color: var(--canvas); white-space: nowrap; }
  #bulkCountBtn { background: var(--ink); }
  #bulkProductionBtn { background: var(--positive-text); }
  .bulkStatus { text-align: center; font-size: 12px; color: var(--stone); min-height: 16px; }

  .tableWrap { background: var(--canvas); border: 1px solid var(--hairline-soft); box-shadow: var(--shadow-card); border-radius: var(--radius-card); overflow-x: auto; }
  table.stock { border-collapse: collapse; width: 100%; font-size: 12.5px; white-space: nowrap; }
  table.stock th, table.stock td { padding: 9px 10px; border-bottom: 1px solid var(--hairline-soft); text-align: left; }
  table.stock th { position: sticky; top: 0; background: var(--canvas); font-size: 10.5px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em; font-weight: 600; z-index: 2; }
  table.stock td.nameCell, table.stock th.nameCell {
    position: sticky; left: 0; background: var(--canvas); z-index: 1;
    white-space: normal; min-width: 140px; max-width: 190px; font-weight: 600; font-size: 12.5px;
    box-shadow: 1px 0 0 var(--hairline-soft);
  }
  table.stock th.nameCell { z-index: 3; }
  table.stock tr:last-child td { border-bottom: none; }
  table.stock .estCell { color: var(--stone); font-size: 12px; }
  table.stock input { width: 60px; padding: 6px 7px; font-size: 12.5px; border: 1px solid var(--hairline); border-radius: 8px; font-family: inherit; }
  table.stock button { padding: 6px 9px; font-size: 11.5px; font-weight: 600; border: none; border-radius: 8px; cursor: pointer; background: var(--surface-soft); color: var(--ink); border: 1px solid var(--hairline); margin-left: 4px; }
  .cellGroup { display: flex; align-items: center; }
  .badge { display: inline-block; font-size: 10.5px; font-weight: 600; padding: 2px 9px; border-radius: var(--radius-pill); white-space: nowrap; }
  .badge.충분 { background: var(--positive-bg); color: var(--positive-text); }
  .badge.보통 { background: var(--surface-soft); color: var(--stone); }
  .badge.조금여유 { background: var(--warn-bg); color: var(--warn-text); }
  .badge.거의없음, .badge.없음 { background: var(--negative-bg); color: var(--negative-text); }
  .badge.기록없음, .badge.알수없음 { background: var(--hairline-soft); color: var(--muted); }
  .toast { font-size: 10.5px; color: var(--stone); white-space: nowrap; }

  .loading, .error { text-align: center; color: var(--stone); padding: 60px 16px; font-size: 14px; }
  .error { color: var(--negative-text); }
  [hidden] { display: none !important; }
</style>
</head>
<body>
<header><div class="brand">82 Bakeshop <span class="dim">· 재고 입력</span></div></header>
<main>
  <div class="toolbar">
    <div class="tabs" id="tabs"></div>
    <div class="bulkActions">
      <button id="bulkCountBtn">카운트 기록</button>
      <button id="bulkProductionBtn">생산 추가</button>
    </div>
  </div>
  <div class="bulkStatus" id="bulkStatus"></div>
  <div id="content" class="loading">불러오는 중...</div>
</main>

<script>
const API = 'https://stfiazhmznssyfsiaxvw.supabase.co/functions/v1/stock-entry-api';
// 개인별 로그인 없이 웹페이지 자체는 바로 들어오게 하되(오너 요청), API 호출엔 고정
// 비밀번호를 자동으로 실어 보낸다 — 완전 공개보단 낫지만 진짜 보안은 아니다(눈속임 방지용).
const PASSCODE = '342625';
let allItems = [];
let activeCategory = null;
const STATUS_TIERS = ['충분','보통','조금여유','거의없음','없음'];

function fmtNum(n) {
  if (n === null || n === undefined) return '-';
  return Number(n).toLocaleString('en-CA', { maximumFractionDigits: 2 });
}

async function apiCall(method, body) {
  const res = await fetch(API, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-stock-passcode': PASSCODE },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data;
}

function categoryOf(name) {
  const idx = name.indexOf(' - ');
  return idx === -1 ? name : name.slice(0, idx);
}
function variantOf(name) {
  const idx = name.indexOf(' - ');
  return idx === -1 ? name : name.slice(idx + 3);
}

// 실제 카운트 기록이 아직 없는 품목(전부 다 그럼, 오너가 통당개수를 아직 안 줌)은
// "기록없음"만 계속 보여서 상태 배지가 어떻게 생겼는지 확인이 안 된다 — 오너 요청으로
// 미리보기용 랜덤 값을 붙인다. DB엔 저장 안 하고 화면에만 보여준다.
function withPreview(item) {
  if (item.status !== '기록없음') return item;
  const tier = STATUS_TIERS[Math.floor(Math.random() * STATUS_TIERS.length)];
  const containers = Math.round(Math.random() * 3 * 100) / 100;
  const days = Math.round(Math.random() * 5 * 10) / 10;
  return Object.assign({}, item, {
    status: tier,
    estimated_containers: containers,
    estimated_units: Math.round(containers * item.units_per_container),
    days_left: days,
    _preview: true,
  });
}

function renderRow(item) {
  const unit = item.container_label || '통';
  const est = item.last_count_at || item._preview
    ? \`\${fmtNum(item.estimated_containers)}\${unit} (\${fmtNum(item.estimated_units)}개)\`
    : '기록없음';
  const days = item.days_left !== null && item.days_left !== undefined ? fmtNum(item.days_left) + '일' : '-';
  return '<tr data-id="' + item.stock_item_id + '">' +
    '<td class="nameCell">' + variantOf(item.name) + (item._preview ? ' <span style="color:var(--muted);font-weight:400;">(예시)</span>' : '') + '</td>' +
    '<td><span class="badge ' + item.status + '">' + item.status + '</span></td>' +
    '<td class="estCell">' + est + '</td>' +
    '<td class="estCell">' + days + '</td>' +
    '<td><div class="cellGroup"><input type="number" step="0.01" class="unitsInput" value="' + item.units_per_container + '" /><button class="saveUnitsBtn">저장</button></div></td>' +
    '<td><input type="number" step="0.1" class="countInput" placeholder="' + unit + '수" /></td>' +
    '<td><input type="number" step="0.1" class="productionInput" placeholder="' + unit + '수" /></td>' +
    '<td class="toast"></td>' +
  '</tr>';
}

function attachRowHandlers(container) {
  container.querySelectorAll('.saveUnitsBtn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const row = btn.closest('tr');
      const id = Number(row.dataset.id);
      const toast = row.querySelector('.toast');
      const v = parseFloat(row.querySelector('.unitsInput').value);
      if (!v || v <= 0) { toast.textContent = '올바른 값 입력'; toast.style.color = 'var(--negative-text)'; return; }
      try {
        await apiCall('POST', { action: 'set_units', stock_item_id: id, units_per_container: v });
        toast.textContent = '저장됨'; toast.style.color = 'var(--stone)';
        load();
      } catch (e) { toast.textContent = '실패: ' + e.message; toast.style.color = 'var(--negative-text)'; }
    });
  });
}

function renderTabs() {
  const categories = [...new Set(allItems.map((i) => categoryOf(i.name)))];
  if (!activeCategory) activeCategory = categories[0];
  const tabs = document.getElementById('tabs');
  tabs.innerHTML = categories.map((c) =>
    '<button class="tab' + (c === activeCategory ? ' active' : '') + '" data-cat="' + c + '">' + c + '</button>'
  ).join('');
  tabs.querySelectorAll('.tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      activeCategory = btn.dataset.cat;
      renderTabs();
      renderTable();
    });
  });
}

function renderTable() {
  const content = document.getElementById('content');
  const items = allItems.filter((i) => categoryOf(i.name) === activeCategory).map(withPreview);
  if (items.length === 0) {
    content.innerHTML = '<div class="error">품목이 없습니다</div>';
    return;
  }
  content.innerHTML =
    '<div class="tableWrap"><table class="stock"><thead><tr>' +
      '<th class="nameCell">품목</th><th>상태</th><th>추정</th><th>일수</th><th>통당개수</th><th>카운트</th><th>생산</th><th></th>' +
    '</tr></thead><tbody>' +
    items.map(renderRow).join('') +
    '</tbody></table></div>';
  attachRowHandlers(content);
}

async function bulkSubmit(eventType, inputClass, button) {
  const bulkStatus = document.getElementById('bulkStatus');
  const rows = document.querySelectorAll('#content tr[data-id]');
  const jobs = [];
  rows.forEach((row) => {
    const input = row.querySelector('.' + inputClass);
    if (!input || input.value.trim() === '') return; // 빈 칸은 건드리지 않음(오너 요청)
    const v = parseFloat(input.value);
    if (isNaN(v) || v < 0) return;
    jobs.push({ id: Number(row.dataset.id), value: v, input });
  });
  if (jobs.length === 0) {
    bulkStatus.textContent = '입력된 칸이 없습니다';
    return;
  }
  button.disabled = true;
  bulkStatus.textContent = jobs.length + '건 처리 중...';
  try {
    await Promise.all(jobs.map((j) =>
      apiCall('POST', { action: 'event', stock_item_id: j.id, event_type: eventType, container_count: j.value })
    ));
    bulkStatus.textContent = jobs.length + '건 완료';
    jobs.forEach((j) => { j.input.value = ''; });
    load();
  } catch (e) {
    bulkStatus.textContent = '일부 실패: ' + e.message;
  } finally {
    button.disabled = false;
  }
}

document.getElementById('bulkCountBtn').addEventListener('click', (e) => bulkSubmit('count', 'countInput', e.target));
document.getElementById('bulkProductionBtn').addEventListener('click', (e) => bulkSubmit('production', 'productionInput', e.target));

async function load() {
  const content = document.getElementById('content');
  try {
    const data = await apiCall('GET');
    allItems = data.items || [];
    content.className = '';
    renderTabs();
    renderTable();
  } catch (e) {
    content.className = 'error';
    content.textContent = '불러오지 못했습니다: ' + e.message;
  }
}

load();
</script>
</body>
</html>`;

Deno.serve(() => new Response(HTML, { headers: { "content-type": "text/html; charset=utf-8" } }));

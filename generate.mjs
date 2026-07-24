// generate.mjs  (v4 — 방문 이력 반영 + 봇 이름 설정화)
// 매주 수요일 GitHub Actions가 실행합니다.
//  1) 지난 8주 추천 이력 불러오기 (중복 방지)
//  2) 이번 주말 날씨 (Open-Meteo, 무료·키 불필요)
//  3) Claude + 웹검색으로 후보수집 → 평가 → 제외 → 최종선별
//  4) 상세 페이지(public/index.html) + 이력(public/history.json) 생성
//  5) 텔레그램으로 링크 발송
// Node 20+ (설치 패키지 없음)

import { writeFile, mkdir } from "node:fs/promises";

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const SITE_URL = (process.env.SITE_URL || "").replace(/\/?$/, "/");

// ── 설정 ──
const BOT_NAME = process.env.BOT_NAME || "주말 참모";
const AGES = process.env.KIDS_AGES || "5, 7";
const LOCATION = process.env.LOCATION || "안양";
const RATIO = process.env.MUSEUM_RATIO || "60";
const MAX_TRAVEL = process.env.MAX_TRAVEL || "60"; // 편도 최대 이동시간(분)
const KEEP_WEEKS = Number(process.env.KEEP_WEEKS || 8); // 이력 보관 주수(= 재추천 금지 기간)

// ── 이번 주말(다가오는 토/일) 날짜 (KST) ──
function weekendDates() {
  const nowKst = new Date(Date.now() + 9 * 3600 * 1000);
  const dow = nowKst.getUTCDay();
  const sat = new Date(nowKst);
  sat.setUTCDate(nowKst.getUTCDate() + ((6 - dow + 7) % 7));
  const sun = new Date(sat);
  sun.setUTCDate(sat.getUTCDate() + 1);
  const iso = (d) =>
    `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
  const label = (d) => `${d.getUTCMonth() + 1}월 ${d.getUTCDate()}일`;
  return { satISO: iso(sat), sunISO: iso(sun), satLabel: label(sat), sunLabel: label(sun) };
}

// ── 지난 추천 이력 (published 페이지에서 읽어옴) ──
async function loadHistory() {
  if (!SITE_URL || SITE_URL === "/") return { weeks: [] };
  try {
    const res = await fetch(`${SITE_URL}history.json?t=${Date.now()}`);
    if (!res.ok) return { weeks: [] };
    const j = await res.json();
    return Array.isArray(j?.weeks) ? j : { weeks: [] };
  } catch {
    return { weeks: [] }; // 첫 실행 등
  }
}
function recentNames(hist) {
  const seen = [];
  for (const w of hist.weeks || []) for (const n of w.places || []) if (!seen.includes(n)) seen.push(n);
  return seen;
}
function mergeHistory(prev, entry) {
  return { weeks: [entry, ...(prev.weeks || [])].slice(0, KEEP_WEEKS) };
}

// ── WMO 날씨 코드 → 이모지/한글 ──
function wmo(code) {
  const m = {
    0: ["☀️", "맑음"], 1: ["🌤️", "대체로 맑음"], 2: ["⛅", "구름 조금"], 3: ["☁️", "흐림"],
    45: ["🌫️", "안개"], 48: ["🌫️", "안개"],
    51: ["🌦️", "이슬비"], 53: ["🌦️", "이슬비"], 55: ["🌦️", "이슬비"],
    61: ["🌧️", "비"], 63: ["🌧️", "비"], 65: ["🌧️", "강한 비"],
    66: ["🌧️", "어는 비"], 67: ["🌧️", "어는 비"],
    71: ["❄️", "눈"], 73: ["❄️", "눈"], 75: ["❄️", "강한 눈"], 77: ["❄️", "싸락눈"],
    80: ["🌧️", "소나기"], 81: ["🌧️", "소나기"], 82: ["🌧️", "강한 소나기"],
    85: ["🌨️", "소나기 눈"], 86: ["🌨️", "소나기 눈"],
    95: ["⛈️", "뇌우"], 96: ["⛈️", "뇌우·우박"], 99: ["⛈️", "강한 뇌우"],
  };
  return m[code] || ["🌤️", "-"];
}

// ── 날씨 (Open-Meteo) ──
async function getWeather() {
  const { satISO, sunISO } = weekendDates();
  const geo = await fetch(
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(LOCATION)}&count=1&language=ko`
  ).then((r) => r.json());
  const spot = geo?.results?.[0];
  if (!spot) throw new Error(`위치를 못 찾음: ${LOCATION} (지역명을 간단히 또는 영어로 바꿔보세요)`);
  const f = await fetch(
    `https://api.open-meteo.com/v1/forecast?latitude=${spot.latitude}&longitude=${spot.longitude}` +
      `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max` +
      `&timezone=Asia%2FSeoul&forecast_days=10`
  ).then((r) => r.json());
  const d = f.daily;
  const pick = (iso) => {
    const i = d.time.indexOf(iso);
    if (i === -1) return null;
    const [emoji, cond] = wmo(d.weather_code[i]);
    return {
      emoji,
      condition: cond,
      high: Math.round(d.temperature_2m_max[i]),
      low: Math.round(d.temperature_2m_min[i]),
      rain: d.precipitation_probability_max[i] ?? 0,
    };
  };
  return { sat: pick(satISO), sun: pick(sunISO) };
}

// ── 답변에서 JSON만 안전하게 추출 (검색 멘트 섞임 / 중간 잘림 대응) ──
function extractJson(text) {
  const clean = text.replace(/```json/gi, "").replace(/```/g, "");
  const candidates = [];
  for (let i = 0; i < clean.length; i++) {
    if (clean[i] !== "{") continue;
    let depth = 0, inStr = false, esc = false;
    for (let j = i; j < clean.length; j++) {
      const ch = clean[j];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === "\\") esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) { candidates.push(clean.slice(i, j + 1)); i = j; break; }
      }
    }
  }
  for (const c of candidates) {
    if (!c.includes('"places"')) continue;
    try { return JSON.parse(c); } catch {}
  }
  const start = clean.lastIndexOf('{"note"') !== -1 ? clean.lastIndexOf('{"note"') : clean.indexOf("{");
  if (start === -1) throw new Error("추천 결과에서 JSON을 찾지 못했습니다.");
  const body = clean.slice(start);
  const suffixes = ["", "}", "]}", "}]}", '"}]}', '""}]}'];
  for (let k = body.length; k > 0; k--) {
    if (body[k - 1] !== "}") continue;
    const head = body.slice(0, k);
    for (const s of suffixes) {
      try {
        const o = JSON.parse(head + s);
        if (o && Array.isArray(o.places)) return o;
      } catch {}
    }
  }
  throw new Error("추천 결과 형식이 올바르지 않습니다.");
}

// ── Claude 추천 ──
async function getPlaces(weather, avoid) {
  const { satLabel, sunLabel } = weekendDates();
  const wLine = (w) => (w ? `${w.condition} ${w.high}°/${w.low}°, 강수확률 ${w.rain}%` : "정보 없음");
  const avoidBlock = avoid.length
    ? `\n# 0단계) 최근 방문지 제외 (최우선)\n아래는 최근 ${KEEP_WEEKS}주 안에 이미 추천한 곳입니다. 절대 다시 추천하지 마세요.\n${avoid.join(" / ")}\n또한 위 목록과 유형·성격이 거의 같은 곳(예: 같은 종류의 시설이 이미 있으면 다른 유형으로)은 피하고, 지난주와 다른 방향·동선으로 새로움을 주세요.\n`
    : "";

  const prompt = `당신은 가족 나들이 플래너입니다. 아래 절차를 순서대로 수행하세요.
${avoidBlock}
# 기본 조건
- 기준 위치(집): ${LOCATION}
- 아이 나이: ${AGES}세
- 편도 이동시간 상한: ${MAX_TRAVEL}분
- 이번 주말 날씨
  · 토(${satLabel}): ${wLine(weather.sat)}
  · 일(${sunLabel}): ${wLine(weather.sun)}
- 성향: 박물관·전시·체험 선호(약 ${RATIO}%), 나머지는 자연·산책·실내놀이 등으로 배분. 사람이 많고 복잡한 곳 기피.

# 1단계) 후보 수집
web_search로 다음 범주에서 후보를 폭넓게 수집하세요. 잘 알려진 곳만이 아니라 덜 알려진 곳도 포함하세요.
대표 관광지 / 아이와 가기 좋은 곳 / 자연·산책 / 실내·우천 대체 / 맛집 / 카페 / 특별 체험 / 사진 명소

# 2단계) 후보 평가
다음 기준으로 평가하세요. 운영시간·휴무일·예약 여부·최근 리뷰는 web_search로 확인하고, 확인이 안 되면 그 사실을 명시하세요.
목적 적합성 / 거리·이동시간 / 운영시간 / 휴무일 / 예약 / 비용 / 아이 동반 편의성(유모차·엘리베이터·계단) / 주차 / 화장실 / 대기시간 / 최근 리뷰 / 사진 만족도 / 날씨 영향 / 대체 가능성

# 3단계) 제외
아래는 원칙적으로 제외하세요(부득이 포함 시 warning에 경고를 적을 것).
최근 방문지(0단계 목록) / 이동시간 대비 만족도가 낮은 곳 / 과도하게 붐비거나 웨이팅이 긴 곳 / ${AGES}세 아이가 힘든 곳 / 운영 여부가 불확실한 곳 / 이미 비슷한 유형이 포함된 경우 / 동선에서 크게 벗어난 곳 / 안전상 주의가 필요한 곳

# 4단계) 최종 선별
최종 5곳만 남기고, 각 장소에 추천 이유·대안과의 차이·체류시간·이동시간·비용·예약 여부·날씨 변수·아이 동반 팁을 붙이세요.

# 출력 형식 (매우 중요)
마지막 답변은 아래 JSON 객체 하나만 출력하세요. 앞뒤에 어떤 설명도 붙이지 마세요.
각 문자열은 한 문장으로 간결하게(40자 이내) 쓰세요.
{"note":"아빠에게 건네는 제안 1~2문장","excluded":"검토했으나 제외한 곳과 이유 1~2문장","places":[{"name":"장소명","type":"박물관","area":"지역","desc":"한 줄 소개","why":"추천 이유","vsAlt":"비슷한 대안 대비 나은 점","stay":"예상 체류시간","travel":"집에서 이동시간","cost":"비용","booking":"예약 필요 여부","hours":"운영시간·휴무일","weatherNote":"날씨 변수","kidTip":"아이 동반 팁","ageFit":"추천 연령","indoor":true,"crowd":"낮음","bestDay":"토","warning":""}]}
crowd는 "낮음/보통/높음", bestDay는 "토/일/주말내내".`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-5",
      max_tokens: 8000,
      messages: [{ role: "user", content: prompt }],
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 8 }],
    }),
  });

  const data = await res.json();
  if (!res.ok) throw new Error("Anthropic 오류: " + JSON.stringify(data));

  const text = data.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
  const result = extractJson(text);
  if (!Array.isArray(result.places) || result.places.length === 0) {
    throw new Error("추천 장소가 비어 있습니다. 다시 실행해보세요.");
  }
  // 혹시 이력과 겹치면 최종 안전망으로 한 번 더 걸러냄
  const before = result.places.length;
  result.places = result.places.filter((p) => !avoid.includes(p.name));
  if (result.places.length === 0) result.places = [];
  if (before !== result.places.length) {
    console.log(`ℹ️ 최근 방문지와 겹친 ${before - result.places.length}곳 제외됨`);
  }
  return result;
}

// ── 스타일 매핑 ──
function typeMeta(t = "") {
  if (/박물관|미술|전시|과학관/.test(t)) return { c: "#7C56A6", bg: "#ECE2F5", icon: "🏛️" };
  if (/체험|공방|만들기|농장|목장/.test(t)) return { c: "#DD8A2E", bg: "#FBEAD1", icon: "🎨" };
  if (/공원|자연|숲|수목원|산|바다|강|산책/.test(t)) return { c: "#3F8A5D", bg: "#DFF0E5", icon: "🌳" };
  if (/실내|키즈|놀이|카페|도서|맛집|식당/.test(t)) return { c: "#3576B8", bg: "#E2ECF7", icon: "🧩" };
  return { c: "#5A6479", bg: "#EEF1F5", icon: "📍" };
}
function crowdMeta(l = "") {
  if (/낮/.test(l)) return { c: "#3F8A5D", bg: "#DFF0E5", label: "한적함" };
  if (/높/.test(l)) return { c: "#C1503F", bg: "#F7E3DF", label: "붐빔" };
  return { c: "#DD8A2E", bg: "#FBEAD1", label: "보통" };
}
const esc = (s = "") =>
  String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// ── HTML 렌더 ──
function renderPage({ weather, note, excluded, places, satLabel, sunLabel, updated, history }) {
  const wCard = (day, date, w) =>
    w
      ? `<div class="wc"><div class="wc-top"><b>${day}</b><span>${date}</span></div>
         <div class="wc-emoji">${w.emoji}</div><div class="wc-cond">${esc(w.condition)}</div>
         <div class="wc-temp"><span class="hi">${w.high}°</span><span class="lo">${w.low}°</span></div>
         <div class="wc-rain">☔ ${w.rain}%</div></div>`
      : `<div class="wc"><div class="wc-top"><b>${day}</b><span>${date}</span></div><div class="wc-emoji">🌤️</div><div class="wc-cond">정보 없음</div></div>`;

  const row = (label, val) =>
    val ? `<div class="row"><span class="rl">${label}</span><span class="rv">${esc(val)}</span></div>` : "";

  const cards = (places || [])
    .map((p) => {
      const t = typeMeta(p.type), cr = crowdMeta(p.crowd);
      return `<article class="place" data-crowd="${esc(p.crowd)}">
        <div class="p-head">
          <span class="p-icon" style="background:${t.bg};color:${t.c}">${t.icon}</span>
          <div class="p-title"><h3>${esc(p.name)}</h3><span class="p-area">${esc(p.area)}</span></div>
          <span class="p-best">${esc(p.bestDay)}</span>
        </div>
        <p class="p-desc">${esc(p.desc)}</p>
        ${p.why ? `<p class="p-why">💡 ${esc(p.why)}</p>` : ""}
        ${p.vsAlt ? `<p class="p-alt">⚖️ ${esc(p.vsAlt)}</p>` : ""}
        <div class="info">
          ${row("체류", p.stay)}
          ${row("이동", p.travel)}
          ${row("비용", p.cost)}
          ${row("예약", p.booking)}
          ${row("운영", p.hours)}
          ${row("날씨", p.weatherNote)}
        </div>
        ${p.kidTip ? `<p class="p-kid">👶 ${esc(p.kidTip)}</p>` : ""}
        ${p.warning ? `<p class="p-warn">⚠️ ${esc(p.warning)}</p>` : ""}
        <div class="tags">
          <span class="tag" style="background:${t.bg};color:${t.c}">${esc(p.type)}</span>
          <span class="tag" style="background:${cr.bg};color:${cr.c}">${cr.label}</span>
          <span class="tag plain">${p.indoor ? "실내" : "야외"}</span>
          ${p.ageFit ? `<span class="tag plain">${esc(p.ageFit)}</span>` : ""}
        </div>
      </article>`;
    })
    .join("");

  const pastWeeks = (history?.weeks || []).slice(1, 5); // 이번 주 제외한 최근 4주
  const pastBlock = pastWeeks.length
    ? `<div class="past"><b>최근에 추천했던 곳 (당분간 제외)</b>${pastWeeks
        .map((w) => `<div class="pw"><span>${esc(w.date)}</span> ${esc((w.places || []).join(", "))}</div>`)
        .join("")}</div>`
    : "";

  return `<!doctype html><html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(BOT_NAME)}</title>
<style>
@import url('https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable.min.css');
*{box-sizing:border-box}
body{margin:0;background:#EDF1F6;font-family:'Pretendard Variable',-apple-system,'Apple SD Gothic Neo','Malgun Gothic',sans-serif;color:#20293A;-webkit-font-smoothing:antialiased}
.wrap{max-width:580px;margin:0 auto;padding:22px 16px 44px}
.head{display:flex;align-items:center;gap:12px;margin-bottom:18px}
.mark{width:44px;height:44px;border-radius:14px;display:grid;place-items:center;font-size:22px;color:#fff;background:linear-gradient(140deg,#F2A94E,#DD8A2E);box-shadow:0 6px 16px rgba(221,138,46,.3)}
h1{font-size:20px;font-weight:800;margin:0;letter-spacing:-.02em}
.sub{margin:2px 0 0;font-size:12.5px;color:#5A6479}
.note{background:linear-gradient(135deg,#FBEAD1,#F7DFC0);border-radius:16px;padding:16px 18px;margin-bottom:14px}
.note .badge{display:inline-block;background:#DD8A2E;color:#fff;font-size:11px;font-weight:800;padding:3px 10px;border-radius:20px;margin-bottom:8px}
.note p{margin:0;font-size:15px;font-weight:600;line-height:1.55;color:#6B4415}
.weather{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:16px}
.wc{background:#fff;border:1px solid #DEE5EC;border-radius:16px;padding:14px;text-align:center}
.wc-top{display:flex;justify-content:space-between;align-items:baseline}
.wc-top b{font-size:15px}.wc-top span{font-size:11.5px;color:#5A6479}
.wc-emoji{font-size:38px;margin:2px 0}
.wc-cond{font-size:13px;color:#5A6479;font-weight:600}
.wc-temp{margin-top:6px;font-weight:800}.hi{color:#C1503F;font-size:17px}.lo{color:#3576B8;font-size:15px;margin-left:8px}
.wc-rain{font-size:12px;color:#3576B8;margin-top:4px}
.bar{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px}
.bar .cnt{font-size:13px;font-weight:800}
.toggle{display:flex;align-items:center;gap:6px;font-size:12.5px;color:#5A6479;cursor:pointer;user-select:none}
.toggle input{accent-color:#DD8A2E;width:15px;height:15px}
.places{display:flex;flex-direction:column;gap:12px}
.place{background:#fff;border:1px solid #DEE5EC;border-radius:16px;padding:15px}
body.hidecrowd .place[data-crowd="높음"]{display:none}
.p-head{display:flex;align-items:flex-start;gap:11px}
.p-icon{width:38px;height:38px;flex:none;border-radius:11px;display:grid;place-items:center;font-size:19px}
.p-title{flex:1;min-width:0}.p-title h3{margin:0;font-size:16px;font-weight:800}
.p-area{font-size:12px;color:#5A6479}
.p-best{flex:none;font-size:11px;font-weight:800;color:#DD8A2E;background:#FBEAD1;padding:4px 9px;border-radius:20px}
.p-desc{margin:10px 0 0;font-size:13.5px;line-height:1.55;color:#3A4256}
.p-why,.p-alt,.p-kid{margin:7px 0 0;font-size:12.8px;line-height:1.5;color:#5A6479}
.p-warn{margin:7px 0 0;font-size:12.8px;line-height:1.5;color:#C1503F;font-weight:600}
.info{margin-top:11px;border-top:1px dashed #DEE5EC;padding-top:9px;display:flex;flex-direction:column;gap:5px}
.row{display:flex;gap:10px;font-size:12.5px;line-height:1.45}
.rl{flex:none;width:34px;color:#8A93A5;font-weight:700}
.rv{color:#3A4256}
.tags{display:flex;flex-wrap:wrap;gap:6px;margin-top:12px}
.tag{font-size:11.5px;font-weight:700;padding:4px 10px;border-radius:8px}
.tag.plain{background:#EDF1F6;color:#5A6479}
.excl,.past{margin-top:14px;background:#fff;border:1px solid #DEE5EC;border-radius:14px;padding:13px 15px;font-size:12.5px;line-height:1.55;color:#5A6479}
.excl b,.past b{color:#20293A;display:block;margin-bottom:6px;font-size:12.5px}
.pw{margin-top:3px}
.pw span{color:#8A93A5;font-weight:700;margin-right:6px}
.foot{text-align:center;font-size:11.5px;color:#5A6479;margin-top:20px;line-height:1.6}
</style></head><body>
<div class="wrap">
  <div class="head">
    <div class="mark">☀︎</div>
    <div><h1>${esc(BOT_NAME)}</h1><p class="sub">${satLabel}(토)·${sunLabel}(일) 나들이 추천</p></div>
  </div>
  ${note ? `<div class="note"><span class="badge">${esc(BOT_NAME)}</span><p>${esc(note)}</p></div>` : ""}
  <div class="weather">${wCard("토", satLabel, weather.sat)}${wCard("일", sunLabel, weather.sun)}</div>
  <div class="bar">
    <span class="cnt">추천 ${(places || []).length}곳</span>
    <label class="toggle"><input type="checkbox" id="hc">붐비는 곳 숨기기</label>
  </div>
  <div class="places">${cards}</div>
  ${excluded ? `<div class="excl"><b>검토했지만 뺀 곳</b>${esc(excluded)}</div>` : ""}
  ${pastBlock}
  <p class="foot">${updated} 업데이트 · 날씨 Open-Meteo<br>운영시간·비용은 방문 전 한 번 더 확인하세요.</p>
</div>
<script>
  document.getElementById('hc').addEventListener('change',function(e){
    document.body.classList.toggle('hidecrowd', e.target.checked);
  });
</script>
</body></html>`;
}

// ── 텔레그램 발송 ──
async function sendTelegram(text) {
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, disable_web_page_preview: false }),
  });
  if (!res.ok) throw new Error("Telegram 실패: " + (await res.text()));
}

// ── 실행 ──
try {
  const { satLabel, sunLabel } = weekendDates();

  const prevHistory = await loadHistory();
  const avoid = recentNames(prevHistory);
  console.log(`ℹ️ 최근 ${KEEP_WEEKS}주 제외 대상 ${avoid.length}곳`);

  const weather = await getWeather();
  const { note, excluded, places } = await getPlaces(weather, avoid);
  const updated = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);

  const history = mergeHistory(prevHistory, { date: updated, places: places.map((p) => p.name) });

  const html = renderPage({ weather, note, excluded, places, satLabel, sunLabel, updated, history });
  await mkdir("public", { recursive: true });
  await writeFile("public/index.html", html, "utf-8");
  await writeFile("public/history.json", JSON.stringify(history, null, 2), "utf-8");

  const w = (x) => (x ? `${x.emoji} ${x.condition} ${x.high}°/${x.low}°` : "-");
  const top = places
    .slice(0, 3)
    .map((p, i) => `${i + 1}. ${p.name}${p.travel ? ` (${p.travel})` : ""}`)
    .join("\n");
  const msg =
    `☀️ 이번 주말 나들이 추천 (${satLabel}~${sunLabel})\n\n` +
    `토: ${w(weather.sat)}\n일: ${w(weather.sun)}\n\n` +
    `${top}\n\n` +
    `체류시간·비용·예약·아이팁까지 정리해놨어요 👇\n${SITE_URL}`;
  await sendTelegram(msg);

  console.log(`✅ 완료 — 추천 ${places.length}곳, 이력 ${history.weeks.length}주 보관, 텔레그램 발송됨`);
} catch (e) {
  console.error("❌ 실패:", e.message);
  process.exit(1);
}

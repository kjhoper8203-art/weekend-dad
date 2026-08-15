// generate.mjs  (v6 — 지도링크 + 맛집 + 준비물 + 반나절코스 + 날씨 동적판단)
//  1단계: 웹검색으로 조사만 (형식 자유)
//  2단계: 조사 내용을 JSON으로 변환 (검색 없음 → 형식 안정)
//  실패 시 자동 재시도, 그래도 실패하면 원인 진단 로그 출력

import { writeFile, readFile, mkdir } from "node:fs/promises";

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const SITE_URL = (process.env.SITE_URL || "").replace(/\/?$/, "/");

// ── 설정 ──
const BOT_NAME = process.env.BOT_NAME || "주말 참모";
const AGES = process.env.KIDS_AGES || "5, 7";
const LOCATION = process.env.LOCATION || "안양";
const RATIO = process.env.MUSEUM_RATIO || "50";           // 박물관·체험 기본 비중 (날씨로 동적 조정)
const MAX_TRAVEL = process.env.MAX_TRAVEL || "60";
const KEEP_WEEKS = Number(process.env.KEEP_WEEKS || 8);
const MODEL = process.env.MODEL || "claude-sonnet-5";
const MODE = process.argv[2] || "generate";                 // generate | send
const MSG_FILE = "telegram-message.txt";
const PLACE_COUNT = Number(process.env.PLACE_COUNT || 5);   // 목표 추천 수
const MIN_PLACES = Number(process.env.MIN_PLACES || 4);     // 이보다 적으면 재시도

// ── 이번 주말 날짜 (KST) ──
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

// ── 추천 이력 ──
async function loadHistory() {
  if (!SITE_URL || SITE_URL === "/") return { weeks: [] };
  try {
    const res = await fetch(`${SITE_URL}history.json?t=${Date.now()}`);
    if (!res.ok) return { weeks: [] };
    const j = await res.json();
    return Array.isArray(j?.weeks) ? j : { weeks: [] };
  } catch {
    return { weeks: [] };
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

// ── 날씨 ──
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
      emoji, condition: cond,
      high: Math.round(d.temperature_2m_max[i]),
      low: Math.round(d.temperature_2m_min[i]),
      rain: d.precipitation_probability_max[i] ?? 0,
    };
  };
  return { sat: pick(satISO), sun: pick(sunISO) };
}

// ── 날씨 기반 실내/야외 동적 판단 ──
//  고정비율이 아니라, 그 주 강수·기온을 보고 매번 실내:야외 비중과 요일별 지침을 계산.
function weatherPlan(weather) {
  const { satLabel, sunLabel } = weekendDates();
  const days = [
    { key: "토", label: satLabel, w: weather.sat },
    { key: "일", label: sunLabel, w: weather.sun },
  ].filter((d) => d.w);
  if (!days.length) return "· 날씨 정보 없음 → 실내·야외 균형 있게, 각 절반 내외로.";

  const lines = [];
  let wetDays = 0, clearDays = 0;
  for (const { key, w } of days) {
    const rain = w.rain ?? 0;
    if (rain >= 60) {
      lines.push(`· ${key}요일(강수 ${rain}%): 실내 위주, 야외 지양`);
      wetDays++;
    } else if (rain >= 30) {
      lines.push(`· ${key}요일(강수 ${rain}%): 우천 대비 가능한 곳 위주(실내 대안 병기)`);
    } else {
      lines.push(`· ${key}요일(강수 ${rain}%): 야외 활동 좋음`);
      clearDays++;
    }
    if (w.high >= 33) lines.push(`   └ ${key} 폭염 ${w.high}° → 한낮 야외는 짧게, 물놀이·그늘·실내 고려`);
    if (w.low <= 0) lines.push(`   └ ${key} 한파 최저 ${w.low}° → 야외는 짧게, 실내 위주`);
  }

  let lean;
  if (clearDays >= 2) lean = `이번 주말 대체로 맑음 → 야외 비중을 높여 실내:야외 ≈ 40:60`;
  else if (wetDays >= 2) lean = `이번 주말 비 예보 → 실내 비중을 높여 실내:야외 ≈ 70:30`;
  else lean = `실내·야외 절반씩(≈ ${RATIO}:${100 - Number(RATIO)})을 기준으로 요일별 날씨에 맞춰 배치`;

  return lines.join("\n") + `\n· 종합 지침: ${lean}`;
}

// ── 지도 검색 링크 (코드에서 생성 → 깨진 링크 방지) ──
function mapLinks(name, area) {
  const q = encodeURIComponent(`${name || ""} ${area || ""}`.trim());
  return {
    naver: `https://map.naver.com/p/search/${q}`,
    kakao: `https://map.kakao.com/?q=${q}`,
    google: `https://www.google.com/maps/search/?api=1&query=${q}`,
  };
}

// ── 공통 API 호출 ──
async function callClaude({ prompt, maxTokens, useSearch }) {
  const body = {
    model: MODEL,
    max_tokens: maxTokens,
    messages: [{ role: "user", content: prompt }],
  };
  if (useSearch) body.tools = [{ type: "web_search_20250305", name: "web_search", max_uses: 6 }];

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error("Anthropic 오류: " + JSON.stringify(data).slice(0, 300));
  const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
  return { text, stop: data.stop_reason };
}

// ── JSON 추출 ──
function extractJson(text) {
  const clean = text.replace(/```json/gi, "").replace(/```/g, "");
  const candidates = [];
  for (let i = 0; i < clean.length; i++) {
    if (clean[i] !== "{") continue;
    let depth = 0, inStr = false, esc = false;
    for (let j = i; j < clean.length; j++) {
      const ch = clean[j];
      if (inStr) { if (esc) esc = false; else if (ch === "\\") esc = true; else if (ch === '"') inStr = false; continue; }
      if (ch === '"') inStr = true;
      else if (ch === "{") depth++;
      else if (ch === "}") { depth--; if (depth === 0) { candidates.push(clean.slice(i, j + 1)); i = j; break; } }
    }
  }
  for (const c of candidates) { if (!c.includes('"places"')) continue; try { return JSON.parse(c); } catch {} }
  const start = clean.lastIndexOf('{"note"') !== -1 ? clean.lastIndexOf('{"note"') : clean.indexOf("{");
  if (start === -1) throw new Error("응답에 JSON이 없음");
  const body = clean.slice(start);
  for (let k = body.length; k > 0; k--) {
    if (body[k - 1] !== "}") continue;
    for (const s of ["", "}", "]}", "}]}", '"}]}', '""}]}']) {
      try {
        const o = JSON.parse(body.slice(0, k) + s);
        if (o && Array.isArray(o.places)) { o.__repaired = true; return o; }
      } catch {}
    }
  }
  throw new Error("JSON 형식 복구 실패");
}

// ── 1단계: 조사 (웹검색) ──
async function research(weather, avoid) {
  const { satLabel, sunLabel } = weekendDates();
  const wLine = (w) => (w ? `${w.condition} ${w.high}°/${w.low}°, 강수확률 ${w.rain}%` : "정보 없음");
  const plan = weatherPlan(weather);
  const avoidLine = avoid.length
    ? `\n- 최근 ${KEEP_WEEKS}주 내 이미 추천한 곳(제외 필수): ${avoid.join(", ")}`
    : "";

  const prompt = `${LOCATION} 기준 이번 주말 가족 나들이 후보지를 조사해주세요.

조건
- 기준 위치(집): ${LOCATION}, 편도 ${MAX_TRAVEL}분 이내
- 아이 나이: ${AGES}세
- 성향: 박물관·전시·체험도 좋아하지만 실내에만 치우치지 않게. 자연·산책·야외 놀이도 고루 섞어서. 붐비는 곳 기피.
- 날씨: 토(${satLabel}) ${wLine(weather.sat)} / 일(${sunLabel}) ${wLine(weather.sun)}
- 날씨에 따른 실내/야외 배분 지침:
${plan}${avoidLine}

web_search로 다음을 조사하세요.
1) 후보 10~12곳 (박물관·체험·자연/공원/산책·실내놀이·사진명소 등 범주를 고루 섞어서)
2) 각 후보의 운영시간, 휴무일, 예약 필요 여부, 입장료, 주차, 아이 동반 편의성, 최근 붐빔·웨이팅 경향
3) 각 후보 근처의 아이 동반하기 좋은 식당 1곳(상호·간단한 이유·대략적 위치). 영업 여부가 불확실하면 표시.
4) 이동시간 대비 만족도가 낮거나, 붐비거나, 아이가 힘들거나, 운영이 불확실해 제외할 곳

조사 결과를 항목별로 정리해 알려주세요. 형식은 자유롭게, 사실 위주로 간결하게 쓰세요.`;

  const { text } = await callClaude({ prompt, maxTokens: 6000, useSearch: true });
  return text;
}

// ── 2단계: JSON 변환 (검색 없음) ──
async function toJson(notes, weather, avoid) {
  const { satLabel, sunLabel } = weekendDates();
  const plan = weatherPlan(weather);
  const avoidLine = avoid.length ? `\n절대 포함 금지: ${avoid.join(", ")}` : "";

  const prompt = `아래는 ${LOCATION} 주말 나들이 후보 조사 내용입니다.

===== 조사 내용 =====
${notes}
=====================

이 중에서 조건에 가장 맞는 최종 ${PLACE_COUNT}곳을 골라 JSON으로만 정리하세요.
- 반드시 ${PLACE_COUNT}개 항목을 모두 채우세요. 개수가 부족하면 안 됩니다.
- 아이 ${AGES}세 / 편도 ${MAX_TRAVEL}분 이내
- 실내(박물관·체험)에만 치우치지 말고, 아래 날씨 지침에 맞춰 실내/야외를 배분할 것:
${plan}
- 붐비는 곳, 웨이팅 긴 곳, 운영 불확실한 곳, 비슷한 유형 중복은 제외
- 토(${satLabel}) / 일(${sunLabel}) 날씨를 반영해 bestDay를 정할 것
- 각 장소마다 근처 아이 동반 식당 1곳(food)과 준비물(prep)을 채울 것
- 하루 반나절 동선 제안(course)을 상단에 1개 작성${avoidLine}

출력 규칙 (매우 중요)
- 아래 JSON 객체 하나만 출력하세요. 인사말·설명·코드블록 금지.
- course를 제외한 각 문자열은 40자 이내 한 문장. course는 2~3문장 허용.
- 조사 내용에 없는 정보는 "확인 필요"로 쓰세요.

{"note":"아빠에게 건네는 제안 1~2문장","course":"추천 반나절 코스 (예: 10시 A 도착 → 12시 근처 B에서 점심 → 오후 C) 2~3문장","excluded":"검토했으나 제외한 곳과 이유 1~2문장","places":[{"name":"장소명","type":"박물관","area":"지역","desc":"한 줄 소개","why":"추천 이유","vsAlt":"비슷한 대안 대비 나은 점","stay":"예상 체류시간","travel":"집에서 이동시간","cost":"비용","booking":"예약 필요 여부","hours":"운영시간·휴무일","weatherNote":"날씨 변수","kidTip":"아이 동반 팁","prep":"준비물 3~4개 쉼표로","food":"근처 아이동반 식당 상호","foodDesc":"그 식당 한 줄 이유","ageFit":"추천 연령","indoor":true,"crowd":"낮음","bestDay":"토","warning":""}]}

crowd는 "낮음/보통/높음", bestDay는 "토/일/주말내내". indoor는 실내면 true, 야외면 false.`;

  let lastText = "", lastStop = "", best = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const { text, stop } = await callClaude({ prompt, maxTokens: 8000, useSearch: false });
    lastText = text; lastStop = stop;
    try {
      const r = extractJson(text);
      const n = Array.isArray(r.places) ? r.places.length : 0;
      console.log(`   ${attempt}차 시도: ${n}곳 파싱${r.__repaired ? " (잘림 복구됨)" : ""}${stop === "max_tokens" ? " [응답 길이 한도 도달]" : ""}`);
      if (n && (!best || n > best.places.length)) best = r;
      if (n >= MIN_PLACES) return r;
    } catch (e) {
      console.log(`   ${attempt}차 시도 실패: ${e.message}`);
    }
  }
  if (best && best.places.length) {
    console.log(`⚠️ ${MIN_PLACES}곳을 못 채워 ${best.places.length}곳으로 진행합니다.`);
    return best;
  }
  console.log("── 진단 정보 ──");
  console.log("stop_reason:", lastStop);
  console.log("응답 길이:", lastText.length);
  console.log("응답 마지막 400자:\n" + lastText.slice(-400));
  console.log("───────────────");
  throw new Error("추천 결과 형식이 올바르지 않습니다 (위 진단 정보 참고)");
}

// ── 스타일 ──
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

// ── 지도 링크 3종 렌더 ──
function mapLinksHtml(name, area) {
  const l = mapLinks(name, area);
  return `<div class="maps">
    <a href="${l.naver}" target="_blank" rel="noopener">네이버</a>
    <a href="${l.kakao}" target="_blank" rel="noopener">카카오</a>
    <a href="${l.google}" target="_blank" rel="noopener">구글</a>
  </div>`;
}

// ── HTML ──
function renderPage({ weather, note, course, excluded, places, satLabel, sunLabel, updated, history }) {
  const wCard = (day, date, w) =>
    w
      ? `<div class="wc"><div class="wc-top"><b>${day}</b><span>${date}</span></div>
         <div class="wc-emoji">${w.emoji}</div><div class="wc-cond">${esc(w.condition)}</div>
         <div class="wc-temp"><span class="hi">${w.high}°</span><span class="lo">${w.low}°</span></div>
         <div class="wc-rain">☔ ${w.rain}%</div></div>`
      : `<div class="wc"><div class="wc-top"><b>${day}</b><span>${date}</span></div><div class="wc-emoji">🌤️</div><div class="wc-cond">정보 없음</div></div>`;
  const row = (label, val) =>
    val ? `<div class="row"><span class="rl">${label}</span><span class="rv">${esc(val)}</span></div>` : "";

  const cards = (places || []).map((p) => {
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
        ${row("체류", p.stay)}${row("이동", p.travel)}${row("비용", p.cost)}
        ${row("예약", p.booking)}${row("운영", p.hours)}${row("날씨", p.weatherNote)}
      </div>
      ${p.kidTip ? `<p class="p-kid">👶 ${esc(p.kidTip)}</p>` : ""}
      ${p.prep ? `<p class="p-prep">🎒 ${esc(p.prep)}</p>` : ""}
      ${p.warning ? `<p class="p-warn">⚠️ ${esc(p.warning)}</p>` : ""}
      ${p.food ? `<div class="p-food"><div class="pf-line">🍽️ <b>근처 맛집</b> ${esc(p.food)}${p.foodDesc ? ` · ${esc(p.foodDesc)}` : ""}</div>
        ${mapLinksHtml(p.food, p.area)}<span class="pf-warn">※ 영업·시간은 방문 전 확인</span></div>` : ""}
      <div class="p-maps"><span class="pm-label">길찾기</span>${mapLinksHtml(p.name, p.area)}</div>
      <div class="tags">
        <span class="tag" style="background:${t.bg};color:${t.c}">${esc(p.type)}</span>
        <span class="tag" style="background:${cr.bg};color:${cr.c}">${cr.label}</span>
        <span class="tag plain">${p.indoor ? "실내" : "야외"}</span>
        ${p.ageFit ? `<span class="tag plain">${esc(p.ageFit)}</span>` : ""}
      </div>
    </article>`;
  }).join("");

  const pastWeeks = (history?.weeks || []).slice(1, 5);
  const pastBlock = pastWeeks.length
    ? `<div class="past"><b>최근에 추천했던 곳 (당분간 제외)</b>${pastWeeks
        .map((w) => `<div class="pw"><span>${esc(w.date)}</span> ${esc((w.places || []).join(", "))}</div>`)
        .join("")}</div>`
    : "";

  return `<!doctype html><html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="cache-control" content="no-cache">
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
.course{background:#fff;border:1px solid #DEE5EC;border-left:4px solid #DD8A2E;border-radius:14px;padding:13px 16px;margin-bottom:14px}
.course .badge{display:inline-block;background:#3F8A5D;color:#fff;font-size:11px;font-weight:800;padding:3px 10px;border-radius:20px;margin-bottom:7px}
.course p{margin:0;font-size:13.5px;line-height:1.6;color:#3A4256}
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
.p-why,.p-alt,.p-kid,.p-prep{margin:7px 0 0;font-size:12.8px;line-height:1.5;color:#5A6479}
.p-warn{margin:7px 0 0;font-size:12.8px;line-height:1.5;color:#C1503F;font-weight:600}
.info{margin-top:11px;border-top:1px dashed #DEE5EC;padding-top:9px;display:flex;flex-direction:column;gap:5px}
.row{display:flex;gap:10px;font-size:12.5px;line-height:1.45}
.rl{flex:none;width:34px;color:#8A93A5;font-weight:700}
.rv{color:#3A4256}
.p-food{margin-top:10px;background:#F3F8F4;border:1px solid #DCEBE0;border-radius:12px;padding:10px 12px}
.pf-line{font-size:12.8px;line-height:1.5;color:#2F5B41}
.pf-line b{color:#3F8A5D}
.pf-warn{display:block;margin-top:5px;font-size:11px;color:#8A93A5}
.p-maps{display:flex;align-items:center;gap:8px;margin-top:10px}
.pm-label{font-size:11.5px;font-weight:700;color:#8A93A5}
.maps{display:flex;gap:6px;flex-wrap:wrap;margin-top:5px}
.maps a{font-size:11.5px;font-weight:700;text-decoration:none;padding:5px 11px;border-radius:8px;background:#EDF1F6;color:#3576B8}
.maps a:active{background:#DCE4EE}
.p-food .maps{margin-top:6px}
.tags{display:flex;flex-wrap:wrap;gap:6px;margin-top:12px}
.tag{font-size:11.5px;font-weight:700;padding:4px 10px;border-radius:8px}
.tag.plain{background:#EDF1F6;color:#5A6479}
.excl,.past{margin-top:14px;background:#fff;border:1px solid #DEE5EC;border-radius:14px;padding:13px 15px;font-size:12.5px;line-height:1.55;color:#5A6479}
.excl b,.past b{color:#20293A;display:block;margin-bottom:6px;font-size:12.5px}
.pw{margin-top:3px}.pw span{color:#8A93A5;font-weight:700;margin-right:6px}
.foot{text-align:center;font-size:11.5px;color:#5A6479;margin-top:20px;line-height:1.6}
</style></head><body>
<div class="wrap">
  <div class="head">
    <div class="mark">☀︎</div>
    <div><h1>${esc(BOT_NAME)}</h1><p class="sub">${satLabel}(토)·${sunLabel}(일) 나들이 추천</p></div>
  </div>
  ${note ? `<div class="note"><span class="badge">${esc(BOT_NAME)}</span><p>${esc(note)}</p></div>` : ""}
  ${course ? `<div class="course"><span class="badge">추천 코스</span><p>${esc(course)}</p></div>` : ""}
  <div class="weather">${wCard("토", satLabel, weather.sat)}${wCard("일", sunLabel, weather.sun)}</div>
  <div class="bar">
    <span class="cnt">추천 ${(places || []).length}곳</span>
    <label class="toggle"><input type="checkbox" id="hc">붐비는 곳 숨기기</label>
  </div>
  <div class="places">${cards}</div>
  ${excluded ? `<div class="excl"><b>검토했지만 뺀 곳</b>${esc(excluded)}</div>` : ""}
  ${pastBlock}
  <p class="foot">${updated} 업데이트 · 날씨 Open-Meteo<br>운영시간·비용·맛집 영업은 방문 전 한 번 더 확인하세요.</p>
</div>
<script>
  document.getElementById('hc').addEventListener('change',function(e){
    document.body.classList.toggle('hidecrowd', e.target.checked);
  });
</script>
</body></html>`;
}

// ── 텔레그램 ──
async function sendTelegram(text) {
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, disable_web_page_preview: false }),
  });
  if (!res.ok) throw new Error("Telegram 실패: " + (await res.text()).slice(0, 200));
}

// ── 실행 ──
// send 모드: 페이지 배포가 끝난 뒤 저장해둔 메시지를 발송
if (MODE === "send") {
  try {
    const msg = await readFile(MSG_FILE, "utf-8");
    await sendTelegram(msg);
    console.log("✅ 텔레그램 발송 완료");
  } catch (e) {
    console.error("❌ 발송 실패:", e.message);
    process.exit(1);
  }
} else {
  try {
    const { satLabel, sunLabel } = weekendDates();

    const prevHistory = await loadHistory();
    const avoid = recentNames(prevHistory);
    console.log(`ℹ️ 최근 ${KEEP_WEEKS}주 제외 대상 ${avoid.length}곳`);

    const weather = await getWeather();
    console.log("ℹ️ 날씨 조회 완료");
    console.log("ℹ️ 날씨 판단:\n" + weatherPlan(weather));

    const notes = await research(weather, avoid);
    console.log(`ℹ️ 1단계 조사 완료 (${notes.length}자)`);

    const result = await toJson(notes, weather, avoid);
    const parsed = (result.places || []).length;
    const places = (result.places || []).filter((p) => p && p.name && !avoid.includes(p.name));
    if (parsed !== places.length) console.log(`ℹ️ 최근 방문지와 겹쳐 ${parsed - places.length}곳 제외`);
    if (!places.length) throw new Error("최종 추천이 비어 있습니다. 다시 실행해보세요.");
    console.log(`ℹ️ 2단계 정리 완료 (${places.length}곳)`);

    const updated = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
    const history = mergeHistory(prevHistory, { date: updated, places: places.map((p) => p.name) });

    const html = renderPage({
      weather, note: result.note, course: result.course, excluded: result.excluded,
      places, satLabel, sunLabel, updated, history,
    });
    await mkdir("public", { recursive: true });
    await writeFile("public/index.html", html, "utf-8");
    await writeFile("public/history.json", JSON.stringify(history, null, 2), "utf-8");

    // 링크에 매번 다른 값을 붙여 옛 화면이 뜨는 것을 방지
    const link = `${SITE_URL}?v=${Date.now()}`;
    const w = (x) => (x ? `${x.emoji} ${x.condition} ${x.high}°/${x.low}°` : "-");
    const list = places.map((p, i) => `${i + 1}. ${p.name}${p.travel ? ` (${p.travel})` : ""}`).join("\n");
    const courseLine = result.course ? `\n🗺️ 추천 코스: ${result.course}\n` : "";
    const msg =
      `☀️ 이번 주말 나들이 추천 (${satLabel}~${sunLabel})\n\n` +
      `토: ${w(weather.sat)}\n일: ${w(weather.sun)}\n${courseLine}\n${list}\n\n` +
      `지도링크·맛집·준비물·아이팁까지 정리해놨어요 👇\n${link}`;
    await writeFile(MSG_FILE, msg, "utf-8");

    console.log(`✅ 페이지 생성 완료 — 추천 ${places.length}곳, 이력 ${history.weeks.length}주 보관`);
    console.log("   (텔레그램은 배포 완료 후 발송됩니다)");
  } catch (e) {
    console.error("❌ 실패:", e.message);
    process.exit(1);
  }
}

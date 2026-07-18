// generate.mjs  (완성본 — 이 파일 전체를 그대로 사용하세요)
// 매주 수요일 GitHub Actions가 실행합니다.
// 1) 이번 주말 날씨(무료 Open-Meteo, 키 불필요)
// 2) Claude로 아이 나이·취향 맞춤 추천
// 3) 예쁜 static 페이지(public/index.html) 생성
// 4) 텔레그램으로 그 페이지 링크 발송
// Node 20+ (별도 설치 패키지 없음)

import { writeFile, mkdir } from "node:fs/promises";

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const SITE_URL = process.env.SITE_URL || "";

// ── 가족 설정 ──
const AGES = process.env.KIDS_AGES || "5, 7";
const LOCATION = process.env.LOCATION || "서울 마포구";
const RATIO = process.env.MUSEUM_RATIO || "60";

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

// ── 날씨 가져오기 (Open-Meteo, 무료·키 불필요) ──
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

// ── Claude로 추천 받기 ──
async function getPlaces(weather) {
  const { satLabel, sunLabel } = weekendDates();
  const wLine = (w) => (w ? `${w.condition} ${w.high}°/${w.low}°, 강수 ${w.rain}%` : "정보 없음");
  const prompt = `당신은 주말 가족 나들이 추천 전문가입니다.

이번 주말 "${LOCATION}" 날씨:
- 토(${satLabel}): ${wLine(weather.sat)}
- 일(${sunLabel}): ${wLine(weather.sun)}

조건에 맞는 장소 5곳을 추천하세요.
- 아이 나이: ${AGES}세
- 박물관·전시·체험을 약 ${RATIO}% 비중으로, 나머지는 공원·자연·실내놀이로 섞기
- 사람이 아주 붐비는 곳은 피하고 한적한 곳 우선
- 위 날씨 반영(비/폭염인 날은 실내 위주)

각 장소의 desc, why는 한 문장으로 짧게 쓰세요.
아래 JSON 객체 하나만 출력(코드블록·설명 없이):
{
 "note":"아빠에게 건네는 따뜻한 제안 1~2문장",
 "places":[
  {"name":"장소명","type":"박물관","area":"지역","desc":"한 줄 소개","ageFit":"추천 연령","indoor":true,"crowd":"낮음","bestDay":"토","why":"이 가족에게 맞는 이유 한 문장"}
 ]
}
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
      max_tokens: 4000,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error("Anthropic 오류: " + JSON.stringify(data));
  const text = data.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
  const s = text.indexOf("{");
  const e = text.lastIndexOf("}");
  const slice = text.slice(s, e + 1);
  try {
    return JSON.parse(slice);
  } catch {
    // 답이 잘렸을 때: 마지막 온전한 항목까지만 살려서 복구
    const cut = slice.lastIndexOf("}", slice.lastIndexOf("}") - 1);
    return JSON.parse(slice.slice(0, cut + 1) + "]}");
  }
}

// ── 스타일 매핑 ──
function typeMeta(t = "") {
  if (/박물관|미술|전시|과학관/.test(t)) return { c: "#7C56A6", bg: "#ECE2F5", icon: "🏛️" };
  if (/체험|공방|만들기|농장|목장/.test(t)) return { c: "#DD8A2E", bg: "#FBEAD1", icon: "🎨" };
  if (/공원|자연|숲|수목원|산|바다|강/.test(t)) return { c: "#3F8A5D", bg: "#DFF0E5", icon: "🌳" };
  if (/실내|키즈|놀이|카페|도서/.test(t)) return { c: "#3576B8", bg: "#E2ECF7", icon: "🧩" };
  return { c: "#5A6479", bg: "#EEF1F5", icon: "📍" };
}
function crowdMeta(l = "") {
  if (/낮/.test(l)) return { c: "#3F8A5D", bg: "#DFF0E5", label: "한적함" };
  if (/높/.test(l)) return { c: "#C1503F", bg: "#F7E3DF", label: "붐빔" };
  return { c: "#DD8A2E", bg: "#FBEAD1", label: "보통" };
}
const esc = (s = "") =>
  String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// ── HTML 페이지 렌더 ──
function renderPage({ weather, note, places, satLabel, sunLabel, updated }) {
  const wCard = (day, date, w) =>
    w
      ? `<div class="wc"><div class="wc-top"><b>${day}</b><span>${date}</span></div>
         <div class="wc-emoji">${w.emoji}</div><div class="wc-cond">${esc(w.condition)}</div>
         <div class="wc-temp"><span class="hi">${w.high}°</span><span class="lo">${w.low}°</span></div>
         <div class="wc-rain">☔ ${w.rain}%</div></div>`
      : `<div class="wc"><div class="wc-top"><b>${day}</b><span>${date}</span></div><div class="wc-emoji">🌤️</div><div class="wc-cond">정보 없음</div></div>`;

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
        <div class="tags">
          <span class="tag" style="background:${t.bg};color:${t.c}">${esc(p.type)}</span>
          <span class="tag" style="background:${cr.bg};color:${cr.c}">${cr.label}</span>
          <span class="tag plain">${p.indoor ? "실내" : "야외"}</span>
          ${p.ageFit ? `<span class="tag plain">${esc(p.ageFit)}</span>` : ""}
        </div>
      </article>`;
    })
    .join("");

  return `<!doctype html><html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>주말 우수 남편 봇</title>
<style>
@import url('https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable.min.css');
*{box-sizing:border-box}
body{margin:0;background:#EDF1F6;font-family:'Pretendard Variable',-apple-system,'Apple SD Gothic Neo','Malgun Gothic',sans-serif;color:#20293A;-webkit-font-smoothing:antialiased}
.wrap{max-width:560px;margin:0 auto;padding:22px 16px 44px}
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
.p-why{margin:8px 0 0;font-size:13px;line-height:1.5;color:#5A6479}
.tags{display:flex;flex-wrap:wrap;gap:6px;margin-top:12px}
.tag{font-size:11.5px;font-weight:700;padding:4px 10px;border-radius:8px}
.tag.plain{background:#EDF1F6;color:#5A6479}
.foot{text-align:center;font-size:11.5px;color:#5A6479;margin-top:22px}
</style></head><body>
<div class="wrap">
  <div class="head">
    <div class="mark">☀︎</div>
    <div><h1>주말 우수 남편 봇</h1><p class="sub">${satLabel}(토)·${sunLabel}(일) 나들이 추천</p></div>
  </div>
  ${note ? `<div class="note"><span class="badge">우수 남편 봇</span><p>${esc(note)}</p></div>` : ""}
  <div class="weather">${wCard("토", satLabel, weather.sat)}${wCard("일", sunLabel, weather.sun)}</div>
  <div class="bar">
    <span class="cnt">추천 ${(places || []).length}곳</span>
    <label class="toggle"><input type="checkbox" id="hc">붐비는 곳 숨기기</label>
  </div>
  <div class="places">${cards}</div>
  <p class="foot">${updated} 업데이트 · 날씨 Open-Meteo</p>
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
  const weather = await getWeather();
  const { note, places } = await getPlaces(weather);
  const updated = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);

  const html = renderPage({ weather, note, places, satLabel, sunLabel, updated });
  await mkdir("public", { recursive: true });
  await writeFile("public/index.html", html, "utf-8");

  const w = (x) => (x ? `${x.emoji} ${x.condition} ${x.high}°/${x.low}°` : "-");
  const msg =
    `☀️ 이번 주말 나들이 추천 (${satLabel}~${sunLabel})\n\n` +
    `토: ${w(weather.sat)}\n일: ${w(weather.sun)}\n\n` +
    `아이들 데려갈 곳 ${(places || []).length}곳 골라놨어요 👇\n${SITE_URL}`;
  await sendTelegram(msg);

  console.log("✅ 페이지 생성 + 텔레그램 발송 완료");
} catch (e) {
  console.error("❌ 실패:", e.message);
  process.exit(1);
}

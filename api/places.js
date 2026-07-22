const USER_AGENT =
  "what-to-eat-roulette/1.0 (https://github.com/absolutelyfullycapable/what-to-eat-roulette)";

const NAVER_LOCAL_URL = "https://openapi.naver.com/v1/search/local.json";
const TAG_RE = /<[^>]+>/g;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function naverCredentials() {
  const clientId = (process.env.NAVER_CLIENT_ID || "").trim();
  const clientSecret = (process.env.NAVER_CLIENT_SECRET || "").trim();
  if (clientId && clientSecret) return { clientId, clientSecret };
  return null;
}

function formatFromNominatim(hit, fallback = "") {
  const display = String(hit.display_name || fallback || "").trim();
  const parts = display.split(",").map((part) => part.trim()).filter(Boolean);
  const name = parts[0] || fallback || "선택한 위치";
  const address = parts.length > 1 ? parts.slice(1, 4).join(", ") : display;
  return {
    name,
    address,
    label: display,
    lat: Number(hit.lat),
    lng: Number(hit.lon),
    type: hit.type || hit.class || "",
    source: "openstreetmap",
  };
}

function formatFromNaver(item) {
  const title = String(item.title || "").replace(TAG_RE, "").trim();
  if (!title) return null;
  const mapx = String(item.mapx || "").trim();
  const mapy = String(item.mapy || "").trim();
  if (!/^\d+$/.test(mapx) || !/^\d+$/.test(mapy)) return null;

  const lng = Number(mapx) / 10_000_000;
  const lat = Number(mapy) / 10_000_000;
  const address = String(item.roadAddress || item.address || "").trim();
  const category = String(item.category || "").trim();

  return {
    name: title,
    address,
    label: address ? `${title}, ${address}` : title,
    lat,
    lng,
    type: category,
    source: "naver",
  };
}

async function nominatimSearch(query, { limit = 8, countrycodes = "kr" } = {}) {
  const params = new URLSearchParams({
    q: query,
    format: "json",
    limit: String(limit),
    addressdetails: "0",
  });
  if (countrycodes) params.set("countrycodes", countrycodes);

  const response = await fetch(
    `https://nominatim.openstreetmap.org/search?${params}`,
    { headers: { "User-Agent": USER_AGENT, Accept: "application/json" } }
  );
  if (!response.ok) {
    const error = new Error(
      "위치 검색 서버가 잠시 바쁜 상태예요. 몇 초 뒤 다시 눌러 주세요."
    );
    error.statusCode = 502;
    throw error;
  }
  const results = await response.json();
  return Array.isArray(results) ? results : [];
}

async function naverLocalSearch(query, limit = 5) {
  const creds = naverCredentials();
  if (!creds) return [];

  const params = new URLSearchParams({
    query,
    display: String(Math.min(Math.max(limit, 1), 5)),
    start: "1",
    sort: "random",
  });

  const response = await fetch(`${NAVER_LOCAL_URL}?${params}`, {
    headers: {
      "X-Naver-Client-Id": creds.clientId,
      "X-Naver-Client-Secret": creds.clientSecret,
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    const error = new Error(
      "위치 검색 서버가 잠시 바쁜 상태예요. 몇 초 뒤 다시 눌러 주세요."
    );
    error.statusCode = 502;
    throw error;
  }

  const data = await response.json();
  const places = [];
  for (const item of data.items || []) {
    const place = formatFromNaver(item);
    if (place) places.push(place);
  }
  return places;
}

function dedupeAppend(places, candidates, limit, seenCoords, seenLabels) {
  for (const place of candidates) {
    if (places.length >= limit) return;
    const coordKey = `${place.lat.toFixed(4)},${place.lng.toFixed(4)}`;
    const labelKey = `${place.name}|${String(place.address || "").slice(0, 40)}`;
    if (seenCoords.has(coordKey) || seenLabels.has(labelKey)) continue;
    seenCoords.add(coordKey);
    seenLabels.add(labelKey);
    places.push(place);
  }
}

async function searchPlaces(query, limit = 8) {
  const places = [];
  const seenCoords = new Set();
  const seenLabels = new Set();
  let naverError = null;

  try {
    const naverPlaces = await naverLocalSearch(query, 5);
    dedupeAppend(places, naverPlaces, limit, seenCoords, seenLabels);
  } catch (error) {
    naverError = error;
  }

  if (places.length < limit) {
    let hits = await nominatimSearch(query, { limit, countrycodes: "kr" });
    if (!hits.length && !places.length) {
      await sleep(1100);
      hits = await nominatimSearch(query, { limit, countrycodes: null });
    }
    const osmPlaces = hits.map((hit) => formatFromNominatim(hit, query));
    dedupeAppend(places, osmPlaces, limit, seenCoords, seenLabels);
  }

  if (places.length) return places;

  const error = new Error(
    naverCredentials()
      ? `'${query}' 위치를 찾지 못했어요. 다른 표현으로 다시 입력해 보세요.`
      : `'${query}' 위치를 찾지 못했어요. 다른 표현으로 다시 입력해 보세요. (한국 아파트·상호는 Vercel 환경 변수에 네이버 검색 API 키를 넣으면 더 잘 나와요)`
  );
  error.statusCode = 404;
  if (naverError) error.cause = naverError;
  throw error;
}

module.exports = async function handler(req, res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }

  if (req.method !== "GET") {
    res.statusCode = 405;
    res.end(JSON.stringify({ error: "GET만 지원해요.", places: [] }));
    return;
  }

  try {
    const url = new URL(req.url, "http://localhost");
    const query = (url.searchParams.get("query") || "").trim();
    if (!query) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: "검색어를 입력해 주세요.", places: [] }));
      return;
    }

    const places = await searchPlaces(query, 8);
    res.statusCode = 200;
    res.end(
      JSON.stringify({
        query,
        places,
        provider: "openstreetmap",
      })
    );
  } catch (error) {
    const statusCode = error.statusCode || 500;
    res.statusCode = statusCode;
    res.end(
      JSON.stringify({
        error: error.message || "서버 오류가 발생했어요.",
        places: [],
      })
    );
  }
};

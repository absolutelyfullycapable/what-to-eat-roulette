const USER_AGENT =
  "what-to-eat-roulette/1.0 (https://github.com/absolutelyfullycapable/what-to-eat-roulette)";

const NAVER_LOCAL_URL = "https://openapi.naver.com/v1/search/local.json";
const TAG_RE = /<[^>]+>/g;

function haversineM(lat1, lng1, lat2, lng2) {
  const radius = 6371000;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const p1 = toRad(lat1);
  const p2 = toRad(lat2);
  const dp = toRad(lat2 - lat1);
  const dl = toRad(lng2 - lng1);
  const a =
    Math.sin(dp / 2) ** 2 +
    Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * radius * Math.asin(Math.sqrt(a));
}

function naverCredentials() {
  const clientId = (process.env.NAVER_CLIENT_ID || "").trim();
  const clientSecret = (process.env.NAVER_CLIENT_SECRET || "").trim();
  if (clientId && clientSecret) return { clientId, clientSecret };
  return null;
}

function formatFromNaver(item) {
  const title = String(item.title || "").replace(TAG_RE, "").trim();
  if (!title) return null;
  const mapx = String(item.mapx || "").trim();
  const mapy = String(item.mapy || "").trim();
  if (!/^\d+$/.test(mapx) || !/^\d+$/.test(mapy)) return null;
  return {
    name: title,
    address: String(item.roadAddress || item.address || "").trim(),
    lat: Number(mapy) / 10_000_000,
    lng: Number(mapx) / 10_000_000,
  };
}

async function naverLocalSearch(query, limit = 5) {
  const creds = naverCredentials();
  if (!creds || !query) return [];
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
  if (!response.ok) return [];
  const data = await response.json();
  const places = [];
  for (const item of data.items || []) {
    const place = formatFromNaver(item);
    if (place) places.push(place);
  }
  return places;
}

function formatReverseLabel(hit) {
  const addr = hit.address || {};
  for (const key of ["amenity", "building", "shop", "tourism", "leisure", "office"]) {
    const named = String(addr[key] || "").trim();
    if (named) return named;
  }

  const road = String(addr.road || addr.pedestrian || addr.footway || "").trim();
  const house = String(addr.house_number || "").trim();
  const neighbourhood = String(
    addr.neighbourhood || addr.suburb || addr.quarter || addr.village || ""
  ).trim();
  const borough = String(
    addr.borough || addr.city_district || addr.district || addr.county || ""
  ).trim();
  const city = String(addr.city || addr.town || "").trim();

  const primary = road ? `${road}${house ? ` ${house}` : ""}`.trim() : neighbourhood;
  const secondary = road && neighbourhood ? neighbourhood : borough || city;
  if (primary && secondary && !primary.includes(secondary)) {
    return `${primary} · ${secondary}`;
  }
  if (primary) return primary;
  if (secondary) return secondary;

  const display = String(hit.display_name || "").trim();
  const parts = display.split(",").map((part) => part.trim()).filter(Boolean);
  if (parts.length) return parts.slice(0, 2).join(" · ");
  return "";
}

async function reverseGeocodeLabel(lat, lng) {
  const params = new URLSearchParams({
    lat: String(lat),
    lon: String(lng),
    format: "json",
    addressdetails: "1",
    zoom: "18",
    "accept-language": "ko",
  });
  const response = await fetch(
    `https://nominatim.openstreetmap.org/reverse?${params}`,
    { headers: { "User-Agent": USER_AGENT, Accept: "application/json" } }
  );
  if (!response.ok) return "";
  const hit = await response.json();
  if (!hit || hit.error) return "";
  return formatReverseLabel(hit);
}

async function lookupRestaurantAddress(name, lat, lng) {
  try {
    const candidates = await naverLocalSearch(name, 5);
    if (candidates.length) {
      let best = candidates[0];
      let bestDist = haversineM(lat, lng, best.lat, best.lng);
      for (const place of candidates.slice(1)) {
        const dist = haversineM(lat, lng, place.lat, place.lng);
        if (dist < bestDist) {
          best = place;
          bestDist = dist;
        }
      }
      if (bestDist <= 800 && best.address) return best.address;
    }
  } catch (_error) {
    // fall through to nominatim
  }
  return reverseGeocodeLabel(lat, lng);
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
    res.end(JSON.stringify({ error: "GET만 지원해요.", address: "" }));
    return;
  }

  try {
    const url = new URL(req.url, "http://localhost");
    const latRaw = (url.searchParams.get("lat") || "").trim();
    const lngRaw = (url.searchParams.get("lng") || "").trim();
    const name = (url.searchParams.get("name") || "").trim();
    if (!latRaw || !lngRaw) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: "좌표가 필요해요.", address: "" }));
      return;
    }
    const lat = Number(latRaw);
    const lng = Number(lngRaw);
    const address = await lookupRestaurantAddress(name, lat, lng);
    res.statusCode = 200;
    res.end(JSON.stringify({ address, lat, lng, name }));
  } catch (error) {
    res.statusCode = 500;
    res.end(
      JSON.stringify({
        error: error.message || "서버 오류가 발생했어요.",
        address: "",
      })
    );
  }
};

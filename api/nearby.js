const USER_AGENT =
  "what-to-eat-roulette/1.0 (https://github.com/absolutelyfullycapable/what-to-eat-roulette)";

const OVERPASS_URLS = [
  "https://overpass-api.de/api/interpreter",
  "https://lz4.overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

async function geocodePlace(query) {
  const params = new URLSearchParams({
    q: query,
    format: "json",
    limit: "1",
    addressdetails: "0",
    countrycodes: "kr",
  });

  let response = await fetch(
    `https://nominatim.openstreetmap.org/search?${params}`,
    { headers: { "User-Agent": USER_AGENT, Accept: "application/json" } }
  );
  let results = await response.json();

  if (!Array.isArray(results) || results.length === 0) {
    await sleep(1100);
    const globalParams = new URLSearchParams({
      q: query,
      format: "json",
      limit: "1",
      addressdetails: "0",
    });
    response = await fetch(
      `https://nominatim.openstreetmap.org/search?${globalParams}`,
      { headers: { "User-Agent": USER_AGENT, Accept: "application/json" } }
    );
    results = await response.json();
  }

  if (!Array.isArray(results) || results.length === 0) {
    const error = new Error(
      `'${query}' 위치를 찾지 못했어요. 다른 표현으로 다시 입력해 보세요.`
    );
    error.statusCode = 404;
    throw error;
  }

  const hit = results[0];
  const name = String(hit.display_name || query).split(",")[0].trim() || query;
  return {
    name,
    lat: Number(hit.lat),
    lng: Number(hit.lon),
  };
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
  return "현재 위치";
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
  if (!response.ok) return "현재 위치";
  const hit = await response.json();
  if (!hit || hit.error) return "현재 위치";
  return formatReverseLabel(hit);
}

async function fetchOverpass(lat, lng, radiusM) {
  const query = `
[out:json][timeout:25];
(
  nwr["amenity"="restaurant"](around:${radiusM},${lat},${lng});
  nwr["amenity"="fast_food"](around:${radiusM},${lat},${lng});
  nwr["amenity"="cafe"](around:${radiusM},${lat},${lng});
  nwr["amenity"="food_court"](around:${radiusM},${lat},${lng});
);
out center tags;
`.trim();

  const body = new URLSearchParams({ data: query });
  let lastError;

  for (const url of OVERPASS_URLS) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: {
            "User-Agent": USER_AGENT,
            "Content-Type": "application/x-www-form-urlencoded",
            Accept: "application/json",
          },
          body,
        });

        if (!response.ok) {
          if ([429, 502, 503, 504].includes(response.status)) {
            lastError = new Error(`Overpass ${response.status}`);
            await sleep(800 * (attempt + 1));
            continue;
          }
          const error = new Error(`지도 서버 오류 (${response.status})`);
          error.statusCode = 502;
          throw error;
        }

        return response.json();
      } catch (error) {
        lastError = error;
        await sleep(800 * (attempt + 1));
      }
    }
  }

  const error = new Error(
    "무료 지도 서버가 잠시 바쁜 상태예요. 몇 초 뒤 다시 눌러 주세요."
  );
  error.statusCode = 502;
  error.cause = lastError;
  throw error;
}

function restaurantAddressFromTags(tags) {
  const full = String(tags["addr:full"] || "").trim();
  if (full) return full;
  const street = String(tags["addr:street"] || "").trim();
  const house = String(tags["addr:housenumber"] || "").trim();
  const city = String(
    tags["addr:city"] || tags["addr:district"] || tags["addr:suburb"] || ""
  ).trim();
  const parts = [];
  if (street) parts.push(house ? `${street} ${house}` : street);
  if (city) parts.push(city);
  return parts.join(" ");
}

function parseRestaurants(data, lat, lng) {
  const elements = data.elements || [];
  const scored = [];
  const seen = new Set();

  for (const element of elements) {
    const tags = element.tags || {};
    const name = String(tags["name:ko"] || tags.name || "").trim();
    if (!name || seen.has(name)) continue;

    let elat;
    let elng;
    if (element.lat != null && element.lon != null) {
      elat = Number(element.lat);
      elng = Number(element.lon);
    } else if (element.center?.lat != null && element.center?.lon != null) {
      elat = Number(element.center.lat);
      elng = Number(element.center.lon);
    } else {
      continue;
    }

    seen.add(name);
    scored.push([
      haversineM(lat, lng, elat, elng),
      {
        name,
        address: restaurantAddressFromTags(tags),
        lat: elat,
        lng: elng,
      },
    ]);
  }

  scored.sort((a, b) => a[0] - b[0]);
  const pool = scored.slice(0, 60).map((item) => item[1]);
  if (pool.length <= 15) {
    for (let i = pool.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    return pool;
  }

  const picked = [];
  const remaining = pool.slice();
  while (picked.length < 15 && remaining.length) {
    const index = Math.floor(Math.random() * remaining.length);
    picked.push(remaining.splice(index, 1)[0]);
  }
  for (let i = picked.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [picked[i], picked[j]] = [picked[j], picked[i]];
  }
  return picked;
}

async function fetchRestaurants(lat, lng) {
  let restaurants = parseRestaurants(await fetchOverpass(lat, lng, 1500), lat, lng);
  if (restaurants.length < 15) {
    restaurants = parseRestaurants(await fetchOverpass(lat, lng, 2500), lat, lng);
  }
  return restaurants;
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
    res.end(JSON.stringify({ error: "GET만 지원해요.", restaurants: [] }));
    return;
  }

  try {
    const url = new URL(req.url, "http://localhost");
    const query = (url.searchParams.get("query") || "").trim();
    const latRaw = (url.searchParams.get("lat") || "").trim();
    const lngRaw = (url.searchParams.get("lng") || "").trim();
    const nameRaw = (url.searchParams.get("name") || "").trim();

    let placeName = "선택한 위치";
    let lat;
    let lng;

    if (latRaw && lngRaw) {
      lat = Number(latRaw);
      lng = Number(lngRaw);
      if (!nameRaw || nameRaw === "현재 위치") {
        placeName = await reverseGeocodeLabel(lat, lng);
      } else {
        placeName = nameRaw;
      }
    } else if (query) {
      const place = await geocodePlace(query);
      placeName = place.name;
      lat = place.lat;
      lng = place.lng;
    } else {
      res.statusCode = 400;
      res.end(
        JSON.stringify({
          error: "위치를 입력하거나 현재 위치를 사용해 주세요.",
          restaurants: [],
        })
      );
      return;
    }

    const restaurants = await fetchRestaurants(lat, lng);
    if (!restaurants.length) {
      res.statusCode = 404;
      res.end(
        JSON.stringify({
          error: "근처 식당을 찾지 못했어요. 다른 위치를 시도해 주세요.",
          location: placeName,
          restaurants: [],
        })
      );
      return;
    }

    res.statusCode = 200;
    res.end(
      JSON.stringify({
        location: placeName,
        lat,
        lng,
        restaurants,
        provider: "openstreetmap",
      })
    );
  } catch (error) {
    const statusCode = error.statusCode || 500;
    res.statusCode = statusCode;
    res.end(
      JSON.stringify({
        error: error.message || "서버 오류가 발생했어요.",
        restaurants: [],
      })
    );
  }
};

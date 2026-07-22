#!/usr/bin/env python3
"""정적 파일 서버 + 근처 식당 검색.

위치 검색: OpenStreetMap Nominatim(+선택) 네이버 지역 검색 폴백
근처 식당: OpenStreetMap Overpass
"""

from __future__ import annotations

import json
import math
import os
import re
import ssl
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PORT = 8765
USER_AGENT = "what-to-eat-roulette/1.0 (https://github.com/absolutelyfullycapable/what-to-eat-roulette)"
NOMINATIM_URL = "https://nominatim.openstreetmap.org/search"
NAVER_LOCAL_URL = "https://openapi.naver.com/v1/search/local.json"
# 공개 Overpass 서버는 가끔 바빠서 504/429를 냅니다. 여러 미러를 돌아가며 시도합니다.
OVERPASS_URLS = [
    "https://overpass-api.de/api/interpreter",
    "https://lz4.overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]

# 일부 환경(회사 프록시 등)에서 macOS 기본 인증서 검증이 실패할 수 있어 로컬 실습용으로 완화
SSL_CONTEXT = ssl._create_unverified_context()
_last_nominatim_at = 0.0
TAG_RE = re.compile(r"<[^>]+>")


def load_dotenv(path: Path = ROOT / ".env") -> None:
    """간단한 .env 로더 (python-dotenv 없이). 이미 있는 환경 변수는 덮어쓰지 않음."""
    if not path.is_file():
        return
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip("'").strip('"')
        if key and key not in os.environ:
            os.environ[key] = value


load_dotenv()


def naver_credentials() -> tuple[str, str] | None:
    client_id = (os.environ.get("NAVER_CLIENT_ID") or "").strip()
    client_secret = (os.environ.get("NAVER_CLIENT_SECRET") or "").strip()
    if client_id and client_secret:
        return client_id, client_secret
    return None


def http_json(
    url: str,
    *,
    data: bytes | None = None,
    method: str = "GET",
    timeout: int = 45,
    headers: dict[str, str] | None = None,
) -> dict | list:
    request_headers = {
        "User-Agent": USER_AGENT,
        "Accept": "application/json",
    }
    if headers:
        request_headers.update(headers)
    request = urllib.request.Request(
        url,
        data=data,
        method=method,
        headers=request_headers,
    )
    if data is not None and "Content-Type" not in request_headers:
        request.add_header("Content-Type", "application/x-www-form-urlencoded")
    with urllib.request.urlopen(request, timeout=timeout, context=SSL_CONTEXT) as response:
        return json.load(response)


def _nominatim_search(query: str, *, limit: int = 8, countrycodes: str | None = "kr") -> list[dict]:
    """Nominatim 검색. 사용 정책상 초당 1회 제한 준수."""
    global _last_nominatim_at
    wait = 1.05 - (time.time() - _last_nominatim_at)
    if wait > 0:
        time.sleep(wait)

    params: dict[str, str] = {
        "q": query,
        "format": "json",
        "limit": str(limit),
        "addressdetails": "0",
    }
    if countrycodes:
        params["countrycodes"] = countrycodes

    results = http_json(f"{NOMINATIM_URL}?{urllib.parse.urlencode(params)}")
    _last_nominatim_at = time.time()
    return results if isinstance(results, list) else []


def format_place_from_nominatim(hit: dict, fallback: str = "") -> dict:
    display = (hit.get("display_name") or fallback or "").strip()
    parts = [part.strip() for part in display.split(",") if part.strip()]
    name = parts[0] if parts else (fallback or "선택한 위치")
    address = ", ".join(parts[1:4]) if len(parts) > 1 else display
    return {
        "name": name,
        "address": address,
        "label": display,
        "lat": float(hit["lat"]),
        "lng": float(hit["lon"]),
        "type": hit.get("type") or hit.get("class") or "",
        "source": "openstreetmap",
    }


def format_place_from_naver(item: dict) -> dict | None:
    title = TAG_RE.sub("", item.get("title") or "").strip()
    if not title:
        return None
    mapx = str(item.get("mapx") or "").strip()
    mapy = str(item.get("mapy") or "").strip()
    if not mapx.isdigit() or not mapy.isdigit():
        return None
    # 네이버 지역 검색 좌표는 정수(실제 위경도 × 10^7)
    lng = int(mapx) / 10_000_000
    lat = int(mapy) / 10_000_000
    address = (item.get("roadAddress") or item.get("address") or "").strip()
    category = (item.get("category") or "").strip()
    return {
        "name": title,
        "address": address,
        "label": f"{title}, {address}" if address else title,
        "lat": lat,
        "lng": lng,
        "type": category,
        "source": "naver",
    }


def _naver_local_search(query: str, *, limit: int = 5) -> list[dict]:
    creds = naver_credentials()
    if not creds:
        return []
    client_id, client_secret = creds
    params = urllib.parse.urlencode(
        {
            "query": query,
            "display": str(min(max(limit, 1), 5)),
            "start": "1",
            "sort": "random",
        }
    )
    data = http_json(
        f"{NAVER_LOCAL_URL}?{params}",
        timeout=20,
        headers={
            "X-Naver-Client-Id": client_id,
            "X-Naver-Client-Secret": client_secret,
        },
    )
    if not isinstance(data, dict):
        return []
    places: list[dict] = []
    for item in data.get("items") or []:
        place = format_place_from_naver(item)
        if place:
            places.append(place)
    return places


def _dedupe_append(
    places: list[dict],
    candidates: list[dict],
    *,
    limit: int,
    seen_coords: set[tuple[str, str]],
    seen_labels: set[tuple[str, str]],
) -> None:
    for place in candidates:
        if len(places) >= limit:
            return
        coord_key = (f"{place['lat']:.4f}", f"{place['lng']:.4f}")
        label_key = (place["name"], (place.get("address") or "")[:40])
        if coord_key in seen_coords or label_key in seen_labels:
            continue
        seen_coords.add(coord_key)
        seen_labels.add(label_key)
        places.append(place)


def search_places(query: str, limit: int = 8) -> list[dict]:
    """장소명 → 후보 목록.

    1) 네이버 지역 검색(키가 있을 때) — 한국 아파트·상호명에 강함
    2) Nominatim — 도로명·역 등 OSM 데이터
    """
    places: list[dict] = []
    seen_coords: set[tuple[str, str]] = set()
    seen_labels: set[tuple[str, str]] = set()

    naver_error: Exception | None = None
    try:
        naver_places = _naver_local_search(query, limit=5)
        _dedupe_append(
            places,
            naver_places,
            limit=limit,
            seen_coords=seen_coords,
            seen_labels=seen_labels,
        )
    except Exception as error:  # noqa: BLE001
        naver_error = error

    # 네이버 결과가 부족하면 OSM으로 보완
    if len(places) < limit:
        nominatim_hits = _nominatim_search(query, limit=limit, countrycodes="kr")
        if not nominatim_hits and not places:
            nominatim_hits = _nominatim_search(query, limit=limit, countrycodes=None)
        osm_places = [format_place_from_nominatim(hit, fallback=query) for hit in nominatim_hits]
        _dedupe_append(
            places,
            osm_places,
            limit=limit,
            seen_coords=seen_coords,
            seen_labels=seen_labels,
        )

    if places:
        return places

    if naver_error and not naver_credentials():
        raise ValueError(
            f"'{query}' 위치를 찾지 못했어요. "
            "도로명 주소로 다시 검색하거나, .env에 네이버 검색 API 키를 넣어 주세요."
        ) from naver_error
    if naver_error:
        raise ValueError(
            f"'{query}' 위치를 찾지 못했어요. 잠시 후 다시 시도하거나 도로명 주소로 검색해 보세요."
        ) from naver_error

    hint = ""
    if not naver_credentials():
        hint = " (한국 아파트·상호는 .env에 네이버 검색 API 키를 넣으면 더 잘 나와요)"
    raise ValueError(f"'{query}' 위치를 찾지 못했어요. 다른 표현으로 다시 입력해 보세요.{hint}")


def geocode_place(query: str) -> tuple[str, float, float]:
    """하위 호환: 첫 번째 후보만 사용."""
    place = search_places(query, limit=1)[0]
    return place["name"], place["lat"], place["lng"]

def haversine_m(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    radius = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * radius * math.asin(math.sqrt(a))


def fetch_restaurants(lat: float, lng: float, radius_m: int = 1500) -> list[str]:
    query = f"""
[out:json][timeout:25];
(
  nwr["amenity"="restaurant"](around:{radius_m},{lat},{lng});
  nwr["amenity"="fast_food"](around:{radius_m},{lat},{lng});
  nwr["amenity"="cafe"](around:{radius_m},{lat},{lng});
  nwr["amenity"="food_court"](around:{radius_m},{lat},{lng});
);
out center tags;
""".strip()
    payload = urllib.parse.urlencode({"data": query}).encode("utf-8")

    last_error: Exception | None = None
    data: dict | None = None
    for url in OVERPASS_URLS:
        for attempt in range(2):
            try:
                data = http_json(url, data=payload, method="POST", timeout=45)
                last_error = None
                break
            except urllib.error.HTTPError as error:
                last_error = error
                # 서버 과부하/일시 오류면 다른 미러 또는 재시도
                if error.code in {429, 502, 503, 504}:
                    time.sleep(0.8 * (attempt + 1))
                    continue
                raise
            except Exception as error:  # noqa: BLE001
                last_error = error
                time.sleep(0.8 * (attempt + 1))
        if data is not None:
            break

    if data is None:
        if isinstance(last_error, urllib.error.HTTPError):
            raise last_error
        raise RuntimeError(
            "근처 식당 서버가 잠시 바빠요. 몇 초 뒤 다시 시도해 주세요."
        ) from last_error

    elements = data.get("elements") or []

    scored: list[tuple[float, str]] = []
    seen: set[str] = set()

    for element in elements:
        tags = element.get("tags") or {}
        name = (tags.get("name:ko") or tags.get("name") or "").strip()
        if not name or name in seen:
            continue

        if "lat" in element and "lon" in element:
            elat, elng = float(element["lat"]), float(element["lon"])
        else:
            center = element.get("center") or {}
            if "lat" not in center or "lon" not in center:
                continue
            elat, elng = float(center["lat"]), float(center["lon"])

        seen.add(name)
        scored.append((haversine_m(lat, lng, elat, elng), name))

    scored.sort(key=lambda item: item[0])
    return [name for _, name in scored[:15]]


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/api/places":
            self.handle_places(urllib.parse.parse_qs(parsed.query))
            return
        if parsed.path == "/api/nearby":
            self.handle_nearby(urllib.parse.parse_qs(parsed.query))
            return
        return super().do_GET()

    def handle_places(self, query_map: dict):
        try:
            query = (query_map.get("query") or [""])[0].strip()
            if not query:
                self.json_response({"error": "검색어를 입력해 주세요.", "places": []}, 400)
                return
            places = search_places(query, limit=8)
            self.json_response({"query": query, "places": places, "provider": "openstreetmap"})
        except ValueError as error:
            self.json_response({"error": str(error), "places": []}, 404)
        except urllib.error.HTTPError as error:
            detail = error.read().decode("utf-8", errors="ignore")
            self.json_response(
                {
                    "error": "위치 검색 서버가 잠시 바쁜 상태예요. 몇 초 뒤 다시 눌러 주세요.",
                    "detail": detail[:300],
                    "places": [],
                },
                502,
            )
        except Exception as error:  # noqa: BLE001
            self.json_response({"error": str(error), "places": []}, 500)

    def handle_nearby(self, query_map: dict):
        try:
            query = (query_map.get("query") or [""])[0].strip()
            lat_raw = (query_map.get("lat") or [""])[0].strip()
            lng_raw = (query_map.get("lng") or [""])[0].strip()
            name_raw = (query_map.get("name") or [""])[0].strip()
            place_name = "선택한 위치"

            if lat_raw and lng_raw:
                lat = float(lat_raw)
                lng = float(lng_raw)
                place_name = name_raw or "현재 위치"
            elif query:
                place_name, lat, lng = geocode_place(query)
            else:
                self.json_response(
                    {"error": "위치를 입력하거나 현재 위치를 사용해 주세요.", "restaurants": []},
                    400,
                )
                return
            restaurants = fetch_restaurants(lat, lng, radius_m=1500)
            if len(restaurants) < 8:
                restaurants = fetch_restaurants(lat, lng, radius_m=2500)

            if not restaurants:
                self.json_response(
                    {
                        "error": "근처 식당을 찾지 못했어요. 다른 위치를 시도해 주세요.",
                        "location": place_name,
                        "restaurants": [],
                    },
                    404,
                )
                return

            self.json_response(
                {
                    "location": place_name,
                    "lat": lat,
                    "lng": lng,
                    "restaurants": restaurants,
                    "provider": "openstreetmap",
                }
            )
        except ValueError as error:
            self.json_response({"error": str(error), "restaurants": []}, 404)
        except urllib.error.HTTPError as error:
            detail = error.read().decode("utf-8", errors="ignore")
            if error.code in {429, 502, 503, 504}:
                message = (
                    "무료 지도 서버가 잠시 바쁜 상태예요. "
                    "몇 초 뒤 다시 눌러 주세요."
                )
            else:
                message = f"지도 서버 오류 ({error.code}). 잠시 후 다시 시도해 주세요."
            self.json_response(
                {
                    "error": message,
                    "detail": detail[:300],
                    "restaurants": [],
                },
                502,
            )
        except Exception as error:  # noqa: BLE001
            self.json_response({"error": str(error), "restaurants": []}, 500)

    def json_response(self, payload: dict, status: int = 200):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt: str, *args):
        print(f"[{self.log_date_time_string()}] {fmt % args}")


if __name__ == "__main__":
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"브라우저에서 열기 → http://127.0.0.1:{PORT}")
    if naver_credentials():
        print("위치 검색: 네이버 지역 검색 + OpenStreetMap Nominatim")
    else:
        print("위치 검색: OpenStreetMap Nominatim (한국 아파트·상호는 .env에 네이버 키 권장)")
    print("근처 식당: OpenStreetMap Overpass")
    print("종료하려면 Ctrl+C")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n서버를 종료합니다.")

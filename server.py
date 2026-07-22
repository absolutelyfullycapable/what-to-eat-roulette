#!/usr/bin/env python3
"""정적 파일 서버 + OpenStreetMap(Nominatim/Overpass) 근처 식당 검색 — API 키·요금 없음."""

from __future__ import annotations

import json
import math
import ssl
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PORT = 8765
USER_AGENT = "CursorAI-Study-RestaurantRoulette/1.0 (local learning; contact: local)"
NOMINATIM_URL = "https://nominatim.openstreetmap.org/search"
# 공개 Overpass 서버는 가끔 바빠서 504/429를 냅니다. 여러 미러를 돌아가며 시도합니다.
OVERPASS_URLS = [
    "https://overpass-api.de/api/interpreter",
    "https://lz4.overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]

# 일부 환경(회사 프록시 등)에서 macOS 기본 인증서 검증이 실패할 수 있어 로컬 실습용으로 완화
SSL_CONTEXT = ssl._create_unverified_context()
_last_nominatim_at = 0.0


def http_json(url: str, *, data: bytes | None = None, method: str = "GET", timeout: int = 45) -> dict | list:
    request = urllib.request.Request(
        url,
        data=data,
        method=method,
        headers={
            "User-Agent": USER_AGENT,
            "Accept": "application/json",
        },
    )
    if data is not None:
        request.add_header("Content-Type", "application/x-www-form-urlencoded")
    with urllib.request.urlopen(request, timeout=timeout, context=SSL_CONTEXT) as response:
        return json.load(response)


def geocode_place(query: str) -> tuple[str, float, float]:
    """장소명 → (표시 이름, lat, lng). Nominatim 사용 정책상 초당 1회 제한 준수."""
    global _last_nominatim_at
    wait = 1.05 - (time.time() - _last_nominatim_at)
    if wait > 0:
        time.sleep(wait)

    params = urllib.parse.urlencode(
        {
            "q": query,
            "format": "json",
            "limit": "1",
            "addressdetails": "0",
            "countrycodes": "kr",
        }
    )
    results = http_json(f"{NOMINATIM_URL}?{params}")
    _last_nominatim_at = time.time()

    if not isinstance(results, list) or not results:
        # 한국 한정으로 못 찾으면 전역 재시도
        wait = 1.05 - (time.time() - _last_nominatim_at)
        if wait > 0:
            time.sleep(wait)
        params = urllib.parse.urlencode(
            {"q": query, "format": "json", "limit": "1", "addressdetails": "0"}
        )
        results = http_json(f"{NOMINATIM_URL}?{params}")
        _last_nominatim_at = time.time()

    if not isinstance(results, list) or not results:
        raise ValueError(f"'{query}' 위치를 찾지 못했어요. 다른 표현으로 다시 입력해 보세요.")

    hit = results[0]
    name = hit.get("display_name") or query
    # display_name이 길면 앞부분만
    name = name.split(",")[0].strip() or query
    return name, float(hit["lat"]), float(hit["lon"])


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
        if parsed.path == "/api/nearby":
            self.handle_nearby(urllib.parse.parse_qs(parsed.query))
            return
        return super().do_GET()

    def handle_nearby(self, query_map: dict):
        try:
            query = (query_map.get("query") or [""])[0].strip()
            lat_raw = (query_map.get("lat") or [""])[0].strip()
            lng_raw = (query_map.get("lng") or [""])[0].strip()
            place_name = "선택한 위치"

            if lat_raw and lng_raw:
                lat = float(lat_raw)
                lng = float(lng_raw)
                place_name = "현재 위치"
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
    print("지도 데이터: OpenStreetMap (무료, API 키 없음)")
    print("종료하려면 Ctrl+C")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n서버를 종료합니다.")

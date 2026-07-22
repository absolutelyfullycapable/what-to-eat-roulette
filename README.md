# 🍚 오늘 뭐 먹지? — 위치 기반 식당 정하기 룰렛

근처 식당으로 오늘의 메뉴를 뽑는 룰렛 웹앱입니다.  
점심·저녁 등 식사 시간에 국한하지 않고 사용할 수 있어요.

배포 주소: https://what-to-eat-roulette.vercel.app

---

## 기능

- 위치 검색 → 후보 목록에서 선택
- 현재 위치 사용
- 근처 식당 최대 15곳으로 룰렛 구성
- 돌리기 / 다시 돌리기

---

## 기술

- 프론트: HTML / CSS / Vanilla JS
- API: Vercel Serverless (`/api/places`, `/api/nearby`)
- 위치 검색: 네이버 지역 검색(선택) + OpenStreetMap Nominatim
- 근처 식당: OpenStreetMap Overpass (API 키·요금 없음)

---

## 왜 OpenStreetMap인가

처음에는 카카오맵 MCP/API로 근처 식당을 불러오려 했습니다.  
다만 브라우저 CORS, 카카오맵 활성화(유료 안내) 등 실습 환경 한계로  
**근처 식당 데이터는 Overpass(완전 무료)** 로 가져옵니다.

---

## 왜 네이버 검색 API인가

Nominatim만으로 위치를 찾으면 **한국 아파트·상호명이 검색되지 않는 경우**가 많습니다.  
예: `우방목련아파트`처럼 OSM에 이름 데이터가 없으면 결과가 비고,  
도로명만으로는 건물 단위가 부정확할 수 있습니다.

그래서 **위치 검색(`/api/places`)만** 네이버 지역 검색을 선택적으로 사용합니다.

- 장소명 → 후보(이름·주소·좌표) 목록
- 키가 있으면 네이버 우선, 없으면 Nominatim만 사용
- 근처 식당(`/api/nearby`)은 계속 Overpass(무료)

카카오 대신 네이버를 쓴 이유:

- 실습용으로 네이버 검색 API 키를 이미 쓰는 경우가 많아 추가 맵 유료 활성화 부담이 적음
- 한국 아파트·상호명 검색이 실사용에 더 맞음
- 서버리스/로컬 서버에서만 호출해 CORS 문제가 없음

---

## Vercel 배포

1. 이 저장소를 Vercel에 Import
2. Framework는 기본값으로 Deploy
3. (권장) Project Settings → Environment Variables에 아래를 추가하면 아파트·상호명 검색이 잘 됩니다.
   - `NAVER_CLIENT_ID`
   - `NAVER_CLIENT_SECRET`

[네이버 개발자 센터](https://developers.naver.com/apps/#/list)에서 애플리케이션을 만들고 **검색** API를 켜면 됩니다.  
키가 없어도 역·도로명 등 OSM에 있는 장소는 검색됩니다.

---

## 로컬 실행

```bash
cp env.example .env
# .env 에 NAVER_CLIENT_ID / NAVER_CLIENT_SECRET 입력 (선택)

python3 server.py
# http://127.0.0.1:8765 접속
```

---

## 참고

무료 Overpass 공개 서버가 바쁠 때 일시적으로 오류가 날 수 있습니다.  
앱은 여러 미러 서버로 자동 재시도하며, 그래도 실패하면 몇 초 뒤 다시 시도하면 됩니다.

---

## 파일 구조

```
what-to-eat-roulette/
├── index.html
├── style.css
├── script.js
├── server.py          # 로컬용 (선택)
├── env.example        # 네이버 검색 API 키 예시
├── api/
│   ├── places.js      # 위치 후보 검색
│   └── nearby.js      # 근처 식당 검색
├── vercel.json
├── package.json
└── README.md
```

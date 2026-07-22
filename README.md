# 오늘 뭐 먹지? — 위치 기반 식당 정하기 룰렛

근처 식당으로 오늘의 메뉴를 뽑는 룰렛 웹앱입니다.  
점심·저녁 등 식사 시간에 국한하지 않고 사용할 수 있어요.

## 기능

- 시작 시 위치 입력 팝업 (장소명 / 현재 위치)
- 근처 식당 최대 15곳으로 룰렛 구성
- 돌리기 / 다시 돌리기

## 기술

- 프론트: HTML / CSS / Vanilla JS
- API: Vercel Serverless (`/api/nearby`)
- 데이터: OpenStreetMap Nominatim + Overpass (API 키·요금 없음)

카카오맵 MCP/API는 브라우저 CORS·활성화(유료 안내) 등 실습 환경 한계로 사용하지 않습니다.

## Vercel 배포

1. 이 저장소를 [Vercel](https://vercel.com)에 Import
2. Framework Preset은 Other / 기본값으로 두면 됩니다
3. Build 설정 없이 Deploy

배포 후 `https://your-app.vercel.app` 에서 바로 사용할 수 있습니다.

## 로컬 실행

### 방법 A — Vercel CLI

```bash
npx vercel dev
```

### 방법 B — Python 서버

```bash
python3 server.py
# http://127.0.0.1:8765
```

> `index.html`을 파일로 직접 열면(`/file://`) 식당 검색 API가 동작하지 않습니다.

## 참고

무료 Overpass 공개 서버가 바쁠 때 일시적으로 오류가 날 수 있습니다.  
앱은 여러 미러 서버로 자동 재시도하며, 그래도 실패하면 몇 초 뒤 다시 시도하면 됩니다.

## 파일 구조

```
what-to-eat-roulette/
├── index.html
├── style.css
├── script.js
├── server.py          # 로컬용 (선택)
├── api/nearby.js      # Vercel Serverless API
├── vercel.json
├── package.json
└── README.md
```

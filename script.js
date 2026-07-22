const COLORS = ["#b9d6d0", "#d7e3f0", "#f0e2c4", "#e4d2cc", "#c9dbc0"];

const wheel = document.getElementById("wheel");
const spinBtn = document.getElementById("spinBtn");
const spinBtnLabel = document.getElementById("spinBtnLabel");
const spinBtnSub = document.getElementById("spinBtnSub");
const resultCard = document.getElementById("resultCard");
const statusChip = document.getElementById("statusChip");
const resultName = document.getElementById("resultName");
const resultHint = document.getElementById("resultHint");
const resultMeta = document.getElementById("resultMeta");
const rouletteWrap = document.querySelector(".roulette-wrap");
const locationModal = document.getElementById("locationModal");
const locationInput = document.getElementById("locationInput");
const modalError = document.getElementById("modalError");
const startBtn = document.getElementById("startBtn");
const geoBtn = document.getElementById("geoBtn");
const changeLocationBtn = document.getElementById("changeLocationBtn");
const locationLabel = document.getElementById("locationLabel");
const placeResults = document.getElementById("placeResults");
const placeResultsLabel = document.getElementById("placeResultsLabel");
const placeList = document.getElementById("placeList");
const hubBtn = document.getElementById("hubBtn");
const app = document.getElementById("app");

let restaurants = [];
let locationTitle = "";
let currentRotation = 0;
let spinning = false;
let pendingIndex = null;
let ready = false;
let placeCandidates = [];

function sliceAngle() {
  return restaurants.length ? 360 / restaurants.length : 24;
}

function shortName(name) {
  return name
    .replace(/\s*(분당|경기|서울|강남|정자|네이버|역삼|선릉).*$/u, "")
    .replace(/\s*점$/u, "")
    .replace(/cafe/gi, "")
    .trim()
    .slice(0, 6) || name.slice(0, 6);
}

function degToRad(deg) {
  return (deg * Math.PI) / 180;
}

function slicePath(cx, cy, r, startDeg, endDeg) {
  const start = degToRad(startDeg);
  const end = degToRad(endDeg);
  const x1 = cx + r * Math.cos(start);
  const y1 = cy + r * Math.sin(start);
  const x2 = cx + r * Math.cos(end);
  const y2 = cy + r * Math.sin(end);
  const large = endDeg - startDeg > 180 ? 1 : 0;
  return `M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2} Z`;
}

function restaurantName(item) {
  return typeof item === "string" ? item : item?.name || "";
}

function normalizeRestaurant(item) {
  if (typeof item === "string") {
    return { name: item, address: "", lat: null, lng: null };
  }
  return {
    name: item?.name || "",
    address: item?.address || "",
    lat: item?.lat ?? null,
    lng: item?.lng ?? null,
  };
}

function buildWheel() {
  wheel.innerHTML = "";
  if (!restaurants.length) return;

  const svgNS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNS, "svg");
  svg.setAttribute("viewBox", "0 0 100 100");
  svg.setAttribute("class", "wheel-svg");
  svg.setAttribute("aria-hidden", "true");

  const cx = 50;
  const cy = 50;
  const radius = 49.2;
  const labelRadius = 33;
  const slice = sliceAngle();

  restaurants.forEach((restaurant, i) => {
    const name = restaurantName(restaurant);
    const fromTop = i * slice;
    const startDeg = -90 + fromTop;
    const endDeg = startDeg + slice;
    const midDeg = startDeg + slice / 2;

    const path = document.createElementNS(svgNS, "path");
    path.setAttribute("d", slicePath(cx, cy, radius, startDeg, endDeg));
    path.setAttribute("fill", COLORS[i % COLORS.length]);
    path.setAttribute("stroke", "rgba(21,32,30,0.1)");
    path.setAttribute("stroke-width", "0.28");
    svg.appendChild(path);

    const midRad = degToRad(midDeg);
    const lx = cx + labelRadius * Math.cos(midRad);
    const ly = cy + labelRadius * Math.sin(midRad);

    const text = document.createElementNS(svgNS, "text");
    text.setAttribute("x", lx.toFixed(3));
    text.setAttribute("y", ly.toFixed(3));
    text.setAttribute("text-anchor", "middle");
    text.setAttribute("dominant-baseline", "central");
    text.setAttribute("transform", `rotate(${midDeg}, ${lx.toFixed(3)}, ${ly.toFixed(3)})`);
    text.setAttribute("class", "wheel-label");
    text.textContent = shortName(name);
    svg.appendChild(text);
  });

  wheel.appendChild(svg);
}

function rotationForIndex(index, jitter = 0) {
  const slice = sliceAngle();
  const mid = index * slice + slice / 2 + jitter;
  return (360 - mid + 360) % 360;
}

function setSpinningUI() {
  resultCard.classList.add("is-spinning");
  resultCard.classList.remove("is-done");
  statusChip.textContent = "추첨 중";
  resultName.textContent = "돌리는 중...";
  resultHint.textContent = "잠시만 기다려 주세요";
  spinBtnLabel.textContent = "추첨 중";
  spinBtnSub.textContent = "결과가 곧 나와요";
  if (hubBtn) hubBtn.disabled = true;
}

async function fetchReverseAddress({ name, lat, lng }) {
  const params = new URLSearchParams();
  if (name) params.set("name", name);
  params.set("lat", String(lat));
  params.set("lng", String(lng));
  const response = await fetch(`/api/reverse?${params.toString()}`);
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || "주소를 찾지 못했어요.");
  }
  return (data.address || "").trim();
}

async function setDoneUI(picked) {
  const restaurant = normalizeRestaurant(picked);
  resultCard.classList.remove("is-spinning");
  resultCard.classList.add("is-done");
  statusChip.textContent = "확정";
  resultName.textContent = restaurant.name;
  spinBtnLabel.textContent = "다시 돌리기";
  spinBtnSub.textContent = "다른 식당 다시 뽑기";
  if (hubBtn) hubBtn.disabled = false;

  if (restaurant.address) {
    resultHint.textContent = restaurant.address;
    return;
  }

  if (restaurant.lat != null && restaurant.lng != null) {
    resultHint.textContent = "주소 찾는 중...";
    try {
      const address = await fetchReverseAddress(restaurant);
      resultHint.textContent = address || "주소를 찾지 못했어요";
      restaurant.address = address;
    } catch (_error) {
      resultHint.textContent = "주소를 찾지 못했어요";
    }
    return;
  }

  resultHint.textContent = "주소를 찾지 못했어요";
}

function setReadyUI() {
  ready = true;
  app.classList.remove("is-locked");
  spinBtn.disabled = false;
  if (hubBtn) hubBtn.disabled = false;
  locationLabel.textContent = `${locationTitle} · EAT`;
  resultMeta.textContent = `근처 ${restaurants.length}곳`;
  statusChip.textContent = "대기 중";
  resultCard.classList.remove("is-spinning", "is-done");
  resultName.textContent = "아직 정해지지 않았어요";
  resultHint.textContent = "아래 버튼을 눌러 룰렛을 돌려 보세요";
  spinBtnLabel.textContent = "돌리기";
  spinBtnSub.textContent = "랜덤으로 한 곳 뽑기";
  currentRotation = 0;
  wheel.style.transform = "rotate(0deg)";
  buildWheel();
}

function showModalError(message) {
  modalError.hidden = false;
  modalError.textContent = message;
}

function clearModalError() {
  modalError.hidden = true;
  modalError.textContent = "";
}

function clearPlaceResults() {
  placeCandidates = [];
  placeList.innerHTML = "";
  placeResults.hidden = true;
  placeResultsLabel.textContent = "검색 결과";
}

function openModal() {
  locationModal.classList.add("is-open");
  locationInput.focus();
}

function closeModal() {
  locationModal.classList.remove("is-open");
}

function setModalLoading(isLoading, mode = "nearby") {
  startBtn.disabled = isLoading;
  geoBtn.disabled = isLoading;
  placeList.querySelectorAll("button").forEach((btn) => {
    btn.disabled = isLoading;
  });

  if (isLoading) {
    startBtn.textContent = mode === "search" ? "검색 중..." : "식당 찾는 중...";
    geoBtn.textContent = "위치 확인 중...";
  } else {
    startBtn.textContent = "위치 검색";
    geoBtn.textContent = "현재 위치 사용";
  }
}

function explainFetchError(error) {
  const message = String(error.message || error);
  if (message.includes("Failed to fetch") || message.includes("fetch")) {
    return "서버에 연결되지 않았어요. 잠시 후 다시 시도하거나, 로컬이면 python3 server.py 실행 후 http://127.0.0.1:8765 로 열어 주세요.";
  }
  return message;
}

async function fetchPlaces(query) {
  const params = new URLSearchParams({ query });
  const response = await fetch(`/api/places?${params.toString()}`);
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || "위치를 검색하지 못했어요.");
  }
  return data;
}

async function fetchNearby({ query, lat, lng, name }) {
  const params = new URLSearchParams();
  if (query) params.set("query", query);
  if (name) params.set("name", name);
  if (lat != null && lng != null) {
    params.set("lat", String(lat));
    params.set("lng", String(lng));
  }

  const response = await fetch(`/api/nearby?${params.toString()}`);
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || "근처 식당을 불러오지 못했어요.");
  }
  return data;
}

function renderPlaceResults(places) {
  placeCandidates = places;
  placeList.innerHTML = "";

  places.forEach((place, index) => {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "place-item";
    button.setAttribute("role", "option");
    button.dataset.index = String(index);

    const title = document.createElement("span");
    title.className = "place-item-name";
    title.textContent = place.name;

    const address = document.createElement("span");
    address.className = "place-item-address";
    address.textContent = place.address || place.label || "";

    button.append(title, address);
    button.addEventListener("click", () => {
      selectPlace(place);
    });

    item.appendChild(button);
    placeList.appendChild(item);
  });

  placeResultsLabel.textContent = `검색 결과 ${places.length}곳 · 하나를 고르세요`;
  placeResults.hidden = false;
}

async function searchPlaces() {
  const query = locationInput.value.trim();
  if (!query) {
    showModalError("위치를 입력해 주세요. 예: 네이버 1784");
    locationInput.focus();
    return;
  }

  clearModalError();
  clearPlaceResults();
  setModalLoading(true, "search");

  try {
    const data = await fetchPlaces(query);
    const places = data.places || [];
    if (!places.length) {
      throw new Error("검색 결과가 없어요. 다른 표현으로 다시 입력해 보세요.");
    }
    renderPlaceResults(places);
  } catch (error) {
    showModalError(explainFetchError(error));
  } finally {
    setModalLoading(false);
  }
}

async function applyLocation(payload) {
  clearModalError();
  setModalLoading(true, "nearby");
  try {
    const data = await fetchNearby(payload);
    restaurants = (data.restaurants || []).slice(0, 15).map(normalizeRestaurant);
    if (restaurants.length < 2) {
      throw new Error("룰렛을 만들 식당이 부족해요. 다른 위치를 시도해 주세요.");
    }
    locationTitle = data.location || payload.name || payload.query || "선택한 위치";
    clearPlaceResults();
    setReadyUI();
    closeModal();
  } catch (error) {
    showModalError(explainFetchError(error));
  } finally {
    setModalLoading(false);
  }
}

async function selectPlace(place) {
  await applyLocation({
    lat: place.lat,
    lng: place.lng,
    name: place.name,
  });
}

function spin() {
  if (spinning || !ready || restaurants.length < 2) return;

  spinning = true;
  spinBtn.disabled = true;
  setSpinningUI();
  wheel.classList.add("spinning");
  rouletteWrap.classList.add("is-spinning");
  rouletteWrap.classList.remove("has-result");

  pendingIndex = Math.floor(Math.random() * restaurants.length);
  const jitter = (Math.random() - 0.5) * sliceAngle() * 0.7;
  const targetMod = rotationForIndex(pendingIndex, jitter);
  const currentMod = ((currentRotation % 360) + 360) % 360;
  let delta = (targetMod - currentMod + 360) % 360;
  delta += (5 + Math.floor(Math.random() * 4)) * 360;

  currentRotation += delta;
  wheel.style.transform = `rotate(${currentRotation}deg)`;
}

async function finishSpin() {
  if (!spinning || pendingIndex === null) return;

  const picked = restaurants[pendingIndex];
  await setDoneUI(picked);
  spinBtn.disabled = false;
  wheel.classList.remove("spinning");
  rouletteWrap.classList.remove("is-spinning");
  rouletteWrap.classList.add("has-result");
  spinning = false;
  pendingIndex = null;
}

startBtn.addEventListener("click", () => {
  searchPlaces();
});

locationInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    startBtn.click();
  }
});

locationInput.addEventListener("input", () => {
  if (placeCandidates.length) {
    clearPlaceResults();
  }
  clearModalError();
});

geoBtn.addEventListener("click", () => {
  clearModalError();
  clearPlaceResults();
  if (!navigator.geolocation) {
    showModalError("이 브라우저에서는 현재 위치를 사용할 수 없어요.");
    return;
  }

  setModalLoading(true, "nearby");
  navigator.geolocation.getCurrentPosition(
    (position) => {
      setModalLoading(false);
      applyLocation({
        lat: position.coords.latitude,
        lng: position.coords.longitude,
      });
    },
    () => {
      setModalLoading(false);
      showModalError("현재 위치를 가져오지 못했어요. 위치 권한을 확인해 주세요.");
    },
    { enableHighAccuracy: true, timeout: 10000 }
  );
});

changeLocationBtn.addEventListener("click", () => {
  clearModalError();
  openModal();
});

spinBtn.addEventListener("click", spin);
if (hubBtn) {
  hubBtn.disabled = true;
  hubBtn.addEventListener("click", spin);
}
wheel.addEventListener("transitionend", (event) => {
  if (event.target === wheel && event.propertyName === "transform") {
    finishSpin();
  }
});

// 서버 없이 파일을 연 경우를 위한 안내
if (location.protocol === "file:") {
  showModalError(
    "파일로 바로 열면 식당 검색이 안 돼요. 배포 사이트에서 열거나, 로컬에서는 python3 server.py 후 http://127.0.0.1:8765 로 열어 주세요."
  );
}
openModal();

const VH_GATE = {
  started: "veyrohood_started_v1",
  missions: "veyrohood_mission_complete_v2",
  opened: "veyrohood_mission_opened_v2",
  verified: "veyrohood_verified_v1",
  ref: "veyrohood_ref_v1"
};
function vhSaveRefFromUrl() {
  try {
    const ref = new URLSearchParams(location.search).get("ref");
    if (ref) localStorage.setItem(VH_GATE.ref, ref.replace(/^@+/, "").slice(0, 64));
  } catch (e) {}
}
function vhSavedRef() {
  try { return localStorage.getItem(VH_GATE.ref) || ""; } catch (e) { return ""; }
}
vhSaveRefFromUrl();
function vhRead(key) {
  try {
    const saved = JSON.parse(localStorage.getItem(key) || "{}");
    return saved && typeof saved === "object" ? saved : {};
  } catch (e) { return {}; }
}
function vhWrite(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) {}
}
function vhClicks() { return vhRead(VH_GATE.missions); }
function vhOpened() { return vhRead(VH_GATE.opened); }
function vhStarted() {
  try { return localStorage.getItem(VH_GATE.started) === "1"; } catch (e) { return false; }
}
function vhMissionsDone() {
  const c = vhClicks();
  return !!(c.follow && c.discord && c.quote && c.reply);
}
function vhVerified() {
  try { return localStorage.getItem(VH_GATE.verified) === "1"; } catch (e) { return false; }
}
function vhMarkStarted() {
  try { localStorage.setItem(VH_GATE.started, "1"); } catch (e) {}
}
function vhMarkOpened(name) {
  const o = vhOpened();
  o[name] = 1;
  vhWrite(VH_GATE.opened, o);
  return o;
}
function vhMarkClick(name) {
  const c = vhClicks();
  c[name] = 1;
  vhWrite(VH_GATE.missions, c);
  return c;
}
function vhMarkVerified() {
  try { localStorage.setItem(VH_GATE.verified, "1"); } catch (e) {}
}
function vhGoMissions() {
  vhMarkStarted();
  location.href = "missions.html";
}
function vhGuard(page) {
  if (page === "missions" && !vhStarted()) {
    location.replace("index.html");
    return false;
  }
  if (page === "verify" && !vhMissionsDone()) {
    location.replace(vhStarted() ? "missions.html" : "index.html");
    return false;
  }
  if (page === "dashboard" && !vhVerified()) {
    location.replace(vhMissionsDone() ? "verify.html" : (vhStarted() ? "missions.html" : "index.html"));
    return false;
  }
  return true;
}
function vhBindNav() {
  document.querySelectorAll("[data-gate]").forEach(function (a) {
    a.addEventListener("click", function (e) {
      const need = a.getAttribute("data-gate");
      if (need === "missions" && !vhStarted()) e.preventDefault();
      if (need === "verify" && !vhMissionsDone()) e.preventDefault();
      if (need === "dashboard" && !vhVerified()) e.preventDefault();
    });
    const need = a.getAttribute("data-gate");
    const ok = need === "missions" ? vhStarted() : need === "verify" ? vhMissionsDone() : need === "dashboard" ? vhVerified() : true;
    if (!ok) a.classList.add("locked");
    else a.classList.remove("locked");
  });
}
document.addEventListener("DOMContentLoaded", function () {
  const page = document.body.getAttribute("data-page");
  if (page) vhGuard(page);
  vhBindNav();
});

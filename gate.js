const VH_GATE = {
  started: "veyrohood_started_v1",
  missions: "veyrohood_mission_clicks_v1",
  verified: "veyrohood_verified_v1"
};
function vhClicks() {
  try {
    const saved = JSON.parse(localStorage.getItem(VH_GATE.missions) || "{}");
    return saved && typeof saved === "object" ? saved : {};
  } catch (e) { return {}; }
}
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
function vhMarkClick(name) {
  const c = vhClicks();
  c[name] = 1;
  try { localStorage.setItem(VH_GATE.missions, JSON.stringify(c)); } catch (e) {}
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

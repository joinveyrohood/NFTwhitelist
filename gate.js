const VH_GATE = {
  started: "veyrohood_started_v1",
  missions: "veyrohood_mission_checklist_v1",
  verified: "veyrohood_verified_v1"
};
function vhStarted() {
  try { return localStorage.getItem(VH_GATE.started) === "1"; } catch (e) { return false; }
}
function vhMissionsDone() {
  try {
    const saved = JSON.parse(localStorage.getItem(VH_GATE.missions) || "null");
    return Array.isArray(saved) && saved.filter(Boolean).length === 4;
  } catch (e) { return false; }
}
function vhVerified() {
  try { return localStorage.getItem(VH_GATE.verified) === "1"; } catch (e) { return false; }
}
function vhMarkStarted() {
  try { localStorage.setItem(VH_GATE.started, "1"); } catch (e) {}
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
      if (need === "missions" && !vhStarted()) {
        e.preventDefault();
        return;
      }
      if (need === "verify" && !vhMissionsDone()) {
        e.preventDefault();
        return;
      }
      if (need === "dashboard" && !vhVerified()) {
        e.preventDefault();
        return;
      }
    });
    const need = a.getAttribute("data-gate");
    const ok = need === "missions" ? vhStarted() : need === "verify" ? vhMissionsDone() : need === "dashboard" ? vhVerified() : true;
    if (!ok) a.classList.add("locked");
  });
}
document.addEventListener("DOMContentLoaded", function () {
  const page = document.body.getAttribute("data-page");
  if (page) vhGuard(page);
  vhBindNav();
});

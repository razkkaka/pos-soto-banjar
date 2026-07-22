// Shared auth helpers used across all internal pages
function getToken() {
  return localStorage.getItem("sb_token");
}

function getUser() {
  try {
    return JSON.parse(localStorage.getItem("sb_user") || "null");
  } catch (e) {
    return null;
  }
}

function setSession(token, user) {
  localStorage.setItem("sb_token", token);
  localStorage.setItem("sb_user", JSON.stringify(user));
}

function clearSession() {
  localStorage.removeItem("sb_token");
  localStorage.removeItem("sb_user");
}

function requireAuth() {
  if (!getToken()) {
    window.location.href = "/login.html";
  }
}

function logout() {
  clearSession();
  window.location.href = "/login.html";
}

async function apiFetch(url, options = {}) {
  const token = getToken();
  const headers = Object.assign(
    { "Content-Type": "application/json" },
    options.headers || {},
    token ? { Authorization: `Bearer ${token}` } : {}
  );
  const res = await fetch(url, { ...options, headers });
  if (res.status === 401 || res.status === 403) {
    clearSession();
    window.location.href = "/login.html";
    throw new Error("Sesi berakhir. Silakan login kembali.");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || "Terjadi kesalahan pada server.");
  }
  return data;
}

function formatRupiah(number) {
  return "Rp " + Number(number || 0).toLocaleString("id-ID");
}

function renderNavbar(active) {
  const user = getUser();
  const navEl = document.getElementById("navbar");
  if (!navEl) return;
  const links = [
    { href: "/dashboard.html", label: "Dashboard", key: "dashboard" },
    { href: "/pos.html", label: "Kasir (POS)", key: "pos" },
    { href: "/menu.html", label: "Manajemen Menu", key: "menu" },
  ];
  navEl.innerHTML = `
    <div class="max-w-7xl mx-auto px-4 sm:px-6 flex items-center justify-between h-16">
      <div class="flex items-center gap-2">
        <span class="text-xl">🍲</span>
        <span class="font-bold text-lg text-orange-700">Soto Banjar "Nyaman"</span>
      </div>
      <div class="hidden md:flex items-center gap-1">
        ${links
          .map(
            (l) => `
          <a href="${l.href}" class="px-4 py-2 rounded-lg text-sm font-medium transition ${
            active === l.key
              ? "bg-orange-600 text-white"
              : "text-gray-600 hover:bg-orange-50 hover:text-orange-700"
          }">${l.label}</a>`
          )
          .join("")}
      </div>
      <div class="flex items-center gap-3">
        <span class="hidden sm:block text-sm text-gray-500">Halo, <span class="font-semibold text-gray-700">${
          user ? user.username : ""
        }</span></span>
        <button onclick="logout()" class="px-4 py-2 rounded-lg bg-red-50 text-red-600 text-sm font-semibold hover:bg-red-100 transition">Logout</button>
      </div>
    </div>
    <div class="md:hidden flex overflow-x-auto border-t border-gray-100 px-2">
      ${links
        .map(
          (l) => `
        <a href="${l.href}" class="flex-1 text-center px-3 py-2 text-xs font-medium whitespace-nowrap ${
          active === l.key ? "text-orange-600 border-b-2 border-orange-600" : "text-gray-500"
        }">${l.label}</a>`
        )
        .join("")}
    </div>
  `;
}

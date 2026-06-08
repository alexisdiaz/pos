import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const $ = (id) => document.getElementById(id);
const money = new Intl.NumberFormat("es-SV", { style: "currency", currency: "USD" });

const ROLE_VIEWS = {
  Administrador: ["dashboard", "sale", "cash", "services", "products", "stock", "ahorrosv", "users", "reports"],
  Supervisor: ["dashboard", "sale", "cash", "services", "products", "stock", "ahorrosv", "reports"],
  Cajero: ["dashboard", "sale", "cash", "ahorrosv"],
};

const SERVICE_COMPANIES = ["Claro SV", "Tigo SV", "Movistar SV", "Digicel SV"];
const COMPANY_COLORS = {
  "Claro SV": "#d71920",
  "Tigo SV": "#174ea6",
  "Movistar SV": "#019df4",
  "Digicel SV": "#00843d",
};

let state = {
  session: null,
  user: null,
  products: [],
  services: [],
  cash: null,
  profiles: [],
  closures: [],
  reports: { summary: { tickets: 0, sold: 0, profit: 0 }, sales: [], top_products: [], low_stock: [] },
  cart: [],
};

const emailForUsername = (username) => username.includes("@") ? username.toLowerCase() : `${username.toLowerCase()}@pos.local`;
const fmt = (n) => money.format(Number(n || 0));
const allowedViews = () => ROLE_VIEWS[state.user?.role] || ["dashboard"];
const canUseView = (name) => allowedViews().includes(name);
const CACHE_KEY = "pos_sv_cache_v1";
const QUEUE_KEY = "pos_sv_offline_sales_v1";
let realtimeChannel = null;
let refreshTimer = null;
let refreshInFlight = false;

function readJson(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key) || "") || fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function offlineQueue() {
  return readJson(QUEUE_KEY, []);
}

function setOfflineQueue(items) {
  writeJson(QUEUE_KEY, items);
  renderSyncStatus();
}

function pendingOfflineCash() {
  return offlineQueue()
    .filter(sale => sale.payload?.p_payment_method === "Efectivo")
    .reduce((sum, sale) => sum + Number(sale.totals?.total || 0), 0);
}

function saveCache() {
  writeJson(CACHE_KEY, {
    saved_at: new Date().toISOString(),
    user: state.user,
    products: state.products,
    services: state.services,
    cash: state.cash,
    profiles: state.profiles,
    closures: state.closures,
    reports: state.reports,
  });
}

function loadCache() {
  return readJson(CACHE_KEY, null);
}

function isOnline() {
  return navigator.onLine !== false;
}

function renderSyncStatus() {
  if (!$("syncStatus")) return;
  const queue = offlineQueue();
  const status = isOnline() ? "Online" : "Sin internet";
  $("syncStatus").textContent = `${status}${queue.length ? ` - ${queue.length} venta(s) pendientes` : " - sincronizado"}`;
  $("syncStatus").classList.toggle("offline", !isOnline() || queue.length > 0);
}

function scheduleRefresh(reason = "cambio remoto") {
  if (!state.session || !isOnline()) return;
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(async () => {
    if (refreshInFlight) return scheduleRefresh(reason);
    refreshInFlight = true;
    try {
      await refresh();
      renderSyncStatus();
    } catch (err) {
      console.warn(`No se pudo actualizar por ${reason}`, err);
    } finally {
      refreshInFlight = false;
    }
  }, 700);
}

function setupRealtime() {
  if (realtimeChannel || !state.session) return;
  realtimeChannel = supabase
    .channel("pos-live-sync")
    .on("postgres_changes", { event: "*", schema: "public", table: "products" }, () => scheduleRefresh("productos"))
    .on("postgres_changes", { event: "*", schema: "public", table: "service_catalog" }, () => scheduleRefresh("servicios"))
    .on("postgres_changes", { event: "*", schema: "public", table: "cash_sessions" }, () => scheduleRefresh("caja"))
    .on("postgres_changes", { event: "*", schema: "public", table: "cash_movements" }, () => scheduleRefresh("movimientos de caja"))
    .on("postgres_changes", { event: "*", schema: "public", table: "sales" }, () => scheduleRefresh("ventas"))
    .on("postgres_changes", { event: "*", schema: "public", table: "sale_items" }, () => scheduleRefresh("detalle de ventas"))
    .on("postgres_changes", { event: "*", schema: "public", table: "stock_movements" }, () => scheduleRefresh("inventario"))
    .subscribe((status) => {
      if (status === "SUBSCRIBED") renderSyncStatus();
    });
}

async function teardownRealtime() {
  if (!realtimeChannel) return;
  await supabase.removeChannel(realtimeChannel);
  realtimeChannel = null;
}

function toast(msg) {
  $("toast").textContent = msg;
  $("toast").classList.add("show");
  setTimeout(() => $("toast").classList.remove("show"), 2600);
}

async function requireOk(result) {
  if (result.error) throw result.error;
  return result.data;
}

function unitsText(product) {
  const packs = Math.floor(product.stock / product.pack_size);
  const loose = product.stock % product.pack_size;
  return `${product.stock} ${product.unit_name} (${packs} ${product.pack_name}${loose ? ` + ${loose}` : ""})`;
}

function modeData(product, mode) {
  if (mode === "pack") {
    return {
      mode,
      label: product.pack_name,
      units: product.pack_size,
      price: Number(product.pack_price),
      cost: Number(product.purchase_price) * product.pack_size,
    };
  }
  return {
    mode: "unit",
    label: product.unit_name,
    units: 1,
    price: Number(product.sale_price),
    cost: Number(product.purchase_price),
  };
}

function cartUnits(productId) {
  return state.cart
    .filter(item => item.item_type !== "service" && item.product_id === productId)
    .reduce((sum, item) => sum + item.units_per_sale * item.qty, 0);
}

function totals() {
  const subtotal = state.cart.reduce((sum, item) => sum + item.unit_price * item.qty, 0);
  const cost = state.cart.reduce((sum, item) => sum + item.unit_cost * item.qty, 0);
  const tax = subtotal * 0.13;
  return { subtotal, tax, cost, total: subtotal + tax, profit: subtotal - cost };
}

function localDate(value) {
  return new Date(value).toLocaleDateString("en-CA");
}

function localDateTime(value) {
  return new Date(value).toLocaleString("es-SV");
}

function inventoryTotals() {
  return state.products.reduce((acc, product) => {
    const stock = Number(product.stock || 0);
    const cost = Number(product.purchase_price || 0) * stock;
    const revenue = Number(product.sale_price || 0) * stock;
    acc.cost += cost;
    acc.revenue += revenue;
    acc.profit += revenue - cost;
    return acc;
  }, { cost: 0, revenue: 0, profit: 0 });
}

function todaysProductSales() {
  const today = new Date().toLocaleDateString("en-CA");
  const saleIds = new Set(state.reports.sales
    .filter(sale => localDate(sale.created_at) === today)
    .map(sale => sale.id));
  return productSummaryForSales(saleIds);
}

function productRowHtml(product) {
  const name = product.product_name || product.name;
  const visual = product.image_url
    ? `<img src="${product.image_url}" alt="${name}">`
    : serviceImage(name.split(" - ")[0]);
  return `
    <div class="top-product">
      ${visual}
      <div><b>${name}</b><br>${product.units} unidades - ${fmt(product.profit)} ganancia</div>
    </div>`;
}

function productSoldUnits(productId) {
  return state.reports.sale_items
    .filter(item => item.product_id === productId)
    .reduce((sum, item) => sum + item.qty * item.units_per_sale, 0);
}

function productMargin(product) {
  return Number(product.sale_price || 0) - Number(product.purchase_price || 0);
}

function daysUntilExpiration(product) {
  if (!product.expiration_date) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const expires = new Date(`${product.expiration_date}T00:00:00`);
  return Math.ceil((expires - today) / 86400000);
}

function expirationText(product) {
  const days = daysUntilExpiration(product);
  if (days === null) return "Sin fecha";
  if (days < 0) return `Vencido hace ${Math.abs(days)} dias`;
  if (days === 0) return "Vence hoy";
  return `${product.expiration_date} (${days} dias)`;
}

function productThumb(product) {
  return `<img class="thumb" src="${product?.image_url || ""}" alt="${product?.name || "Producto"}">`;
}

function companyBadge(company) {
  const color = COMPANY_COLORS[company] || "#0f766e";
  return `<span class="company-dot" style="--company:${color}">${company}</span>`;
}

function serviceImage(company) {
  const initial = (company || "S").slice(0, 1);
  const color = COMPANY_COLORS[company] || "#0f766e";
  return `<span class="service-thumb" style="--company:${color}">${initial}</span>`;
}

function saleItemVisual(item) {
  if (item.mode === "service") {
    const company = item.product_name.split(" - ")[0];
    return serviceImage(company);
  }
  return productThumb(item.product);
}

async function bootstrap() {
  const { data } = await supabase.auth.getSession();
  state.session = data.session;
  if (!state.session) {
    $("login").classList.remove("hidden");
    $("app").classList.add("hidden");
    return;
  }

  try {
    state.user = await requireOk(await supabase.from("profiles").select("*").eq("id", state.session.user.id).single());
  } catch (err) {
    const cached = loadCache();
    if (!cached?.user) throw err;
    state.user = cached.user;
    state.products = cached.products || [];
    state.services = cached.services || [];
    state.cash = cached.cash || null;
    state.profiles = cached.profiles || [state.user];
    state.closures = cached.closures || [];
    state.reports = cached.reports || state.reports;
  }
  $("login").classList.add("hidden");
  $("app").classList.remove("hidden");
  $("reportDate").value = new Date().toISOString().slice(0, 10);
  await refresh();
  setupRealtime();
  syncOfflineSales();
}

async function refresh() {
  try {
    state.products = await requireOk(await supabase.from("products").select("*").order("name"));
    const servicesResult = await supabase.from("service_catalog").select("*").order("company").order("name");
    state.services = servicesResult.error ? [] : servicesResult.data;

    const cashRows = await requireOk(await supabase.from("cash_sessions").select("*").eq("status", "open").order("opened_at", { ascending: false }).limit(1));
    state.cash = cashRows[0] || null;
    if (state.cash) {
      state.cash.expected_cash = await requireOk(await supabase.rpc("expected_cash", { p_cash_session_id: state.cash.id }));
    }

    state.closures = await requireOk(await supabase.from("cash_sessions").select("*").eq("status", "closed").order("closed_at", { ascending: false }).limit(200));

    if (state.user.role === "Administrador") {
      state.profiles = await requireOk(await supabase.from("profiles").select("*").order("name"));
    } else {
      state.profiles = [state.user];
    }

    await loadReports();
    saveCache();
  } catch (err) {
    const cached = loadCache();
    if (!cached) throw err;
    state.products = cached.products || [];
    state.services = cached.services || [];
    state.cash = cached.cash || null;
    state.profiles = cached.profiles || [state.user];
    state.closures = cached.closures || [];
    state.reports = cached.reports || state.reports;
    toast("Modo sin internet: usando datos guardados");
  }
  renderAll();
  renderSyncStatus();
}

async function loadReports() {
  const sales = await requireOk(await supabase.from("sales").select("*").order("created_at", { ascending: false }).limit(200));
  const items = await requireOk(await supabase.from("sale_items").select("*"));
  const summary = sales.reduce((acc, sale) => {
    acc.tickets += 1;
    acc.sold += Number(sale.total);
    acc.profit += Number(sale.profit);
    return acc;
  }, { tickets: 0, sold: 0, profit: 0 });

  const topMap = new Map();
  items.forEach((item) => {
    const product = state.products.find(p => p.id === item.product_id);
    const row = topMap.get(item.product_name) || {
      product_name: item.product_name,
      image_url: product?.image_url || "",
      units: 0,
      sold: 0,
      profit: 0,
    };
    row.units += item.qty * item.units_per_sale;
    row.sold += Number(item.line_total);
    row.profit += Number(item.line_total) - Number(item.line_cost);
    topMap.set(item.product_name, row);
  });

  state.reports = {
    summary,
    sales,
    sale_items: items,
    top_products: [...topMap.values()].sort((a, b) => b.units - a.units).slice(0, 10),
    low_stock: state.products.filter(p => p.stock <= p.min_stock),
  };
}

function renderAll() {
  $("roleText").textContent = `${state.user.name} - ${state.user.role}`;
  applyRolePermissions();
  setupAhorroView();
  renderDashboard();
  renderProducts();
  renderServices();
  renderCart();
  renderCash();
  renderReportControls();
  renderReports();
  renderSelectedStockProduct();
}

function setupAhorroView() {
  const isElectron = navigator.userAgent.includes("Electron");
  const frame = $("ahorroFrame");
  const webview = $("ahorroWebview");
  if (!frame || !webview) return;
  frame.classList.toggle("hidden", isElectron);
  webview.classList.toggle("hidden", !isElectron);
  if (isElectron && webview.getAttribute("src") !== "https://ahorrosv.com/") {
    webview.setAttribute("src", "https://ahorrosv.com/");
  }
}

function activeAhorroGuest() {
  const webview = $("ahorroWebview");
  if (webview && !webview.classList.contains("hidden") && typeof webview.executeJavaScript === "function") return webview;
  return null;
}

async function searchAhorro(productName) {
  showView("ahorrosv");
  const guest = activeAhorroGuest();
  if (!guest) {
    $("ahorroFrame").src = `https://ahorrosv.com/?q=${encodeURIComponent(productName)}`;
    return;
  }
  const runSearch = async () => {
    const query = JSON.stringify(productName);
    await guest.executeJavaScript(`
      (() => {
        const q = ${query};
        const inputs = [...document.querySelectorAll('input')];
        const input = inputs.find(el => /busca|buscar|producto|search/i.test(el.placeholder || el.ariaLabel || '')) || inputs[0];
        if (!input) return false;
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
        setter ? setter.call(input, q) : input.value = q;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
        input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true }));
        const button = [...document.querySelectorAll('button')].find(btn => /buscar|search/i.test(btn.innerText || btn.ariaLabel || ''));
        if (button) button.click();
        return true;
      })();
    `);
  };
  if (guest.isLoading && guest.isLoading()) guest.addEventListener("did-stop-loading", runSearch, { once: true });
  else setTimeout(runSearch, 350);
}

async function extractAhorroProduct() {
  const guest = activeAhorroGuest();
  if (!guest) throw new Error("La importacion directa funciona en la app EXE con AhorroSV abierto");
  return await guest.executeJavaScript(`
    (() => {
      const clean = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
      const title = clean(document.querySelector('h1')?.innerText)
        || clean(document.querySelector('[class*="title" i]')?.innerText)
        || clean(document.title).replace(/AhorroSV.*/i, '');
      const bodyText = document.body.innerText || '';
      const priceMatch = bodyText.match(/\\$\\s*([0-9]+(?:[.,][0-9]{2})?)/);
      const price = priceMatch ? Number(priceMatch[1].replace(',', '.')) : 0;
      const image = [...document.images]
        .map(img => img.currentSrc || img.src)
        .filter(Boolean)
        .find(src => !/logo|icon|favicon/i.test(src)) || '';
      const crumb = [...document.querySelectorAll('a, span')]
        .map(el => clean(el.innerText))
        .filter(text => text && text.length < 40 && !/inicio|volver|compartir|visitar/i.test(text));
      const category = crumb.length > 1 ? crumb[crumb.length - 2] : 'AhorroSV';
      return { title, price, image, category, url: location.href };
    })();
  `);
}

async function importAhorroToInventory() {
  try {
    const data = await extractAhorroProduct();
    if (!data?.title) return toast("No pude detectar el nombre del producto");
    resetProductForm();
    $("code").value = `AHORRO-${Date.now()}`;
    $("name").value = data.title;
    setSelectValue("category", data.category || "AhorroSV");
    setSelectValue("unitName", "unidad");
    setSelectValue("packName", "unidad");
    $("packSize").value = 1;
    $("purchasePrice").value = 0;
    $("salePrice").value = Number(data.price || 0).toFixed(2);
    $("packPrice").value = Number(data.price || 0).toFixed(2);
    $("stock").value = "";
    $("minStock").value = 0;
    if (data.image) {
      $("preview").src = data.image;
      $("preview").classList.add("show");
    }
    showView("stock");
    $("stock").focus();
    toast("Producto importado. Solo falta agregar stock y guardar.");
  } catch (err) {
    toast(err.message);
  }
}

function currentView() {
  const active = document.querySelector(".view.active");
  return active?.id?.replace("View", "") || "dashboard";
}

function applyRolePermissions() {
  document.querySelectorAll("aside button[data-view]").forEach((button) => {
    button.hidden = !canUseView(button.dataset.view);
  });
  if (!canUseView(currentView())) showView("dashboard");
}

function renderDashboard() {
  const summary = state.reports.summary;
  const inventory = inventoryTotals();
  const todayProducts = todaysProductSales();
  $("dashSold").textContent = fmt(summary.sold);
  $("dashProfit").textContent = fmt(summary.profit);
  $("dashTickets").textContent = summary.tickets;
  $("dashLow").textContent = state.reports.low_stock.length;
  $("dashCash").textContent = state.cash ? "Abierta" : "Cerrada";
  $("dashPending").textContent = offlineQueue().length;
  if ($("inventoryValueCard")) {
    $("inventoryValueCard").hidden = state.user.role !== "Administrador";
    $("inventoryValueList").innerHTML = `
      <p><b>Costo total:</b> ${fmt(inventory.cost)}</p>
      <p><b>Venta esperada:</b> ${fmt(inventory.revenue)}</p>
      <p><b>Ganancia esperada:</b> ${fmt(inventory.profit)}</p>`;
  }
  $("lowStockList").innerHTML = state.reports.low_stock.map(product =>
    `<p><b>${product.name}</b> <span class="pill low">${product.stock}/${product.min_stock}</span></p>`
  ).join("") || "<p>Sin alertas.</p>";
  $("topList").innerHTML = state.reports.top_products.map(productRowHtml).join("") || "<p>Sin ventas.</p>";
  $("todayProductList").innerHTML = todayProducts.map(productRowHtml).join("") || "<p>Sin ventas hoy.</p>";
}

function filteredProductCatalog(products, mode) {
  const list = [...products];
  if (mode === "expiring") {
    return list
      .filter(product => {
        const days = daysUntilExpiration(product);
        return days !== null && days >= 0 && days <= 30;
      })
      .sort((a, b) => daysUntilExpiration(a) - daysUntilExpiration(b));
  }
  if (mode === "expired") return list.filter(product => daysUntilExpiration(product) !== null && daysUntilExpiration(product) < 0);
  if (mode === "low_stock") return list.filter(product => product.stock <= product.min_stock).sort((a, b) => a.stock - b.stock);
  if (mode === "less_stock") return list.sort((a, b) => a.stock - b.stock);
  if (mode === "more_stock") return list.sort((a, b) => b.stock - a.stock);
  if (mode === "best_sellers") return list.sort((a, b) => productSoldUnits(b.id) - productSoldUnits(a.id));
  if (mode === "slow_sellers") return list.sort((a, b) => productSoldUnits(a.id) - productSoldUnits(b.id));
  if (mode === "best_margin") return list.sort((a, b) => productMargin(b) - productMargin(a));
  if (mode === "no_image") return list.filter(product => !product.image_url);
  return list;
}

function renderProducts() {
  const catalogTerm = ($("catalogSearch")?.value || "").trim().toLowerCase();
  const productMode = $("productFilter")?.value || "all";
  const inventoryTerm = ($("inventorySearch")?.value || "").trim().toLowerCase();
  const matches = (product, term) => !term || `${product.name} ${product.code} ${product.category} ${product.unit_name} ${product.pack_name}`.toLowerCase().includes(term);
  const catalogProducts = filteredProductCatalog(state.products.filter(product => matches(product, catalogTerm)), productMode);
  const inventoryProducts = state.products.filter(product => matches(product, inventoryTerm));
  const inventory = inventoryTotals();

  $("productGrid").innerHTML = state.products.map(product => `
    <article class="product">
      <img src="${product.image_url || ""}" alt="${product.name}">
      <b>${product.name}</b>
      <span>${product.code} - ${product.category}</span>
      <span class="pill ${product.stock <= product.min_stock ? "low" : ""}">${unitsText(product)}</span>
      <div class="sell-actions">
        <button onclick="addCart('${product.id}', 'unit')" ${product.stock < 1 ? "disabled" : ""}>${product.unit_name} ${fmt(product.sale_price)}</button>
        <button onclick="addCart('${product.id}', 'pack')" ${product.stock < product.pack_size ? "disabled" : ""}>${product.pack_name} ${fmt(product.pack_price)}</button>
      </div>
    </article>`).join("");

  $("catalogTable").innerHTML = catalogProducts.map(product => `
    <tr>
      <td><b>${product.name}</b></td>
      <td><img class="thumb" src="${product.image_url || ""}" alt="${product.name}"></td>
      <td>${product.code}</td>
      <td>${product.unit_name}</td>
      <td>${product.pack_name} x ${product.pack_size}</td>
      <td>${fmt(product.purchase_price)}</td>
      <td>${fmt(product.sale_price)} / ${fmt(product.pack_price)}</td>
      <td>${unitsText(product)}</td>
      <td><span class="pill ${daysUntilExpiration(product) !== null && daysUntilExpiration(product) <= 15 ? "low" : ""}">${expirationText(product)}</span></td>
      <td>${productSoldUnits(product.id)}</td>
    </tr>`).join("") || `<tr><td colspan="10">No se encontraron productos</td></tr>`;

  $("productsTable").innerHTML = inventoryProducts.map(product => `
    <tr>
      <td><img class="thumb" src="${product.image_url || ""}" alt="${product.name}"> <b>${product.name}</b><br>${product.code}</td>
      <td>${product.unit_name}</td>
      <td>${product.pack_name} x ${product.pack_size}</td>
      <td>${fmt(product.purchase_price)}</td>
      <td>${fmt(product.sale_price)} / ${fmt(product.pack_price)}</td>
      <td>${unitsText(product)}</td>
      <td><button class="muted-btn" onclick="editProduct('${product.id}')">Editar</button> <button class="danger-btn" onclick="deleteProduct('${product.id}')">Eliminar</button></td>
    </tr>`).join("") || `<tr><td colspan="7">No se encontraron productos</td></tr>`;

  $("inventoryCost").textContent = fmt(inventory.cost);
  $("inventoryRevenue").textContent = fmt(inventory.revenue);
  $("inventoryProfit").textContent = fmt(inventory.profit);

  const selected = $("stockProduct").value;
  $("stockProduct").innerHTML = inventoryProducts.map(product => `<option value="${product.id}">${product.name}</option>`).join("");
  if (selected && inventoryProducts.some(p => p.id === selected)) $("stockProduct").value = selected;
  else if (inventoryProducts[0]) $("stockProduct").value = inventoryProducts[0].id;
  renderSelectedStockProduct();
}

function renderServices() {
  if (!$("saleServicesGrid")) return;
  const companyFilter = $("serviceCompanyFilter").value || "all";
  const companies = ["all", ...SERVICE_COMPANIES];
  $("serviceCompanyFilter").innerHTML = companies.map(company =>
    `<option value="${company}">${company === "all" ? "Todas las companias" : company}</option>`
  ).join("");
  $("serviceCompanyFilter").value = companies.includes(companyFilter) ? companyFilter : "all";

  const visibleServices = state.services
    .filter(service => service.active !== false)
    .filter(service => companyFilter === "all" || service.company === companyFilter);

  $("saleServicesGrid").innerHTML = visibleServices.map(service => `
    <article class="service-card">
      <div>${companyBadge(service.company)}<h3>${service.name}</h3></div>
      <p>${service.type === "recarga" ? "Recarga" : "Paquete"} ${service.custom_amount ? "de monto variable" : fmt(service.sale_price)}</p>
      <button onclick="addService('${service.id}')">${service.custom_amount ? "Agregar recarga" : `Agregar ${fmt(service.sale_price)}`}</button>
    </article>`).join("") || "<p>No hay servicios configurados. Ejecuta el SQL de servicios o agrega uno desde Administrador.</p>";

  if ($("servicesTable")) {
    $("servicesTable").innerHTML = state.services.map(service => `
      <tr>
        <td>${companyBadge(service.company)}</td>
        <td>${service.type === "recarga" ? "Recarga" : "Paquete"}</td>
        <td><b>${service.name}</b></td>
        <td>${service.custom_amount ? "Variable" : fmt(service.sale_price)}</td>
        <td>${service.custom_amount ? "Por comision" : fmt(service.cost)}</td>
        <td>${service.yvr_enabled ? `Activo ${service.yvr_product_code || "sin codigo"}` : "Manual"}</td>
        <td><button class="muted-btn" onclick="editService('${service.id}')">Editar</button> <button class="danger-btn" onclick="deleteService('${service.id}')">Eliminar</button></td>
      </tr>`).join("") || `<tr><td colspan="7">Sin servicios configurados</td></tr>`;
  }
}

window.addCart = (productId, mode = "unit") => {
  const product = state.products.find(p => p.id === productId);
  const modeInfo = modeData(product, mode);
  if (cartUnits(productId) + modeInfo.units > product.stock) return toast("Stock insuficiente");
  const id = `${productId}:${mode}`;
  const existing = state.cart.find(item => item.id === id);
  if (existing) existing.qty += 1;
  else {
    state.cart.push({
      id,
      product_id: product.id,
      product_name: product.name,
      mode,
      label: modeInfo.label,
      qty: 1,
      units_per_sale: modeInfo.units,
      unit_price: modeInfo.price,
      unit_cost: modeInfo.cost,
    });
  }
  renderCart();
};

window.addService = (serviceId) => {
  const service = state.services.find(item => item.id === serviceId);
  if (!service) return toast("Servicio no configurado");
  const phone = $("servicePhone").value.trim();
  if (!phone) return toast("Ingresa el numero de telefono");
  const amount = service.custom_amount ? Number($("serviceAmount").value || 0) : Number(service.sale_price || 0);
  if (amount <= 0) return toast("Ingresa un monto valido");
  const cost = service.custom_amount
    ? Math.max(0, amount - (amount * Number(service.commission_pct || 0) / 100))
    : Number(service.cost || 0);
  const id = `service:${service.id}:${phone}:${amount}:${Date.now()}`;
  state.cart.push({
    id,
    item_type: "service",
    service_id: service.id,
    product_id: null,
    product_name: `${service.company} - ${service.name}`,
    company: service.company,
    phone,
    mode: "service",
    label: service.type === "recarga" ? `Recarga ${phone}` : `Paquete ${phone}`,
    qty: 1,
    units_per_sale: 1,
    unit_price: amount,
    unit_cost: cost,
  });
  $("serviceAmount").value = "";
  renderCart();
};

window.qty = (id, delta) => {
  const item = state.cart.find(entry => entry.id === id);
  if (!item) return;
  if (item.item_type === "service" && delta > 0) return toast("Agrega otra recarga como linea separada");
  if (item.item_type === "service") {
    item.qty += delta;
    if (item.qty <= 0) state.cart = state.cart.filter(entry => entry.id !== id);
    return renderCart();
  }
  const product = state.products.find(entry => entry.id === item.product_id);
  if (delta > 0 && cartUnits(product.id) + item.units_per_sale > product.stock) return toast("Stock insuficiente");
  item.qty += delta;
  if (item.qty <= 0) state.cart = state.cart.filter(entry => entry.id !== id);
  renderCart();
};

async function sendYvrTopups(cartSnapshot) {
  const topups = cartSnapshot.filter(item => {
    const service = state.services.find(entry => entry.id === item.service_id);
    return item.item_type === "service" && service?.yvr_enabled;
  });
  for (const item of topups) {
    const { data, error } = await supabase.functions.invoke("yvr-topup", {
      body: {
        service_id: item.service_id,
        phone: item.phone,
        amount: item.unit_price,
      },
    });
    if (error) throw new Error(error.message || "No se pudo enviar la recarga a YoVendoRecarga");
    if (data?.error) throw new Error(data.error);
    item.provider_ref = data?.provider_ref || data?.reference || data?.transactionId || "";
  }
}

function salePayloadFromCart(cartSnapshot, paymentAmount) {
  return {
    p_items: cartSnapshot.map(item => item.item_type === "service"
      ? { item_type: "service", service_id: item.service_id, amount: item.unit_price, phone: item.phone, qty: item.qty }
      : { item_type: "product", product_id: item.product_id, mode: item.mode, qty: item.qty }),
    p_payment: paymentAmount,
    p_payment_method: $("paymentMethod").value,
  };
}

function hasOnlineOnlyService(cartSnapshot) {
  return cartSnapshot.some(item => {
    const service = state.services.find(entry => entry.id === item.service_id);
    return item.item_type === "service" && service?.yvr_enabled;
  });
}

function applyLocalStock(cartSnapshot) {
  cartSnapshot.forEach(item => {
    if (item.item_type === "service") return;
    const product = state.products.find(entry => entry.id === item.product_id);
    if (product) product.stock = Math.max(0, Number(product.stock || 0) - item.units_per_sale * item.qty);
  });
}

function queueOfflineSale(cartSnapshot, paymentAmount, totalSnapshot) {
  if (hasOnlineOnlyService(cartSnapshot)) {
    throw new Error("Las recargas por YoVendoRecarga necesitan internet");
  }
  const localTicket = `LOCAL-${Date.now()}`;
  const queue = offlineQueue();
  queue.push({
    id: crypto.randomUUID(),
    ticket: localTicket,
    created_at: new Date().toISOString(),
    payload: salePayloadFromCart(cartSnapshot, paymentAmount),
    cart: cartSnapshot,
    payment: paymentAmount,
    totals: totalSnapshot,
  });
  setOfflineQueue(queue);
  applyLocalStock(cartSnapshot);
  saveCache();
  return { ticket: localTicket, total: totalSnapshot.total, change: paymentAmount - totalSnapshot.total, offline: true };
}

let syncingOfflineSales = false;
async function syncOfflineSales() {
  if (syncingOfflineSales || !isOnline() || !state.session) return;
  let queue = offlineQueue();
  if (!queue.length) return renderSyncStatus();
  syncingOfflineSales = true;
  try {
    const remaining = [];
    for (const sale of queue) {
      try {
        await requireOk(await supabase.rpc("create_sale", sale.payload));
      } catch (err) {
        remaining.push(sale);
      }
    }
    setOfflineQueue(remaining);
    if (queue.length !== remaining.length) {
      toast(`Sincronizadas ${queue.length - remaining.length} venta(s) offline`);
      await refresh();
    }
  } finally {
    syncingOfflineSales = false;
    renderSyncStatus();
  }
}

function renderCart() {
  $("cartList").innerHTML = state.cart.map(item => `
    <div class="cart-item">
      <div><b>${item.product_name}</b><br>${item.item_type === "service" ? item.label : `${item.label} - ${item.units_per_sale * item.qty} unidades reales`} - ${fmt(item.unit_price)}</div>
      <div class="qty"><button onclick="qty('${item.id}',-1)">-</button><b>${item.qty}</b><button onclick="qty('${item.id}',1)">+</button></div>
    </div>`).join("") || "<p>Carrito vacio.</p>";
  const data = totals();
  $("subtotal").textContent = fmt(data.subtotal);
  $("tax").textContent = fmt(data.tax);
  $("cost").textContent = fmt(data.cost);
  $("total").textContent = fmt(data.total);
  $("change").textContent = fmt(Math.max(0, Number($("payment").value || 0) - data.total));
}

function renderCash() {
  const pendingCash = pendingOfflineCash();
  $("cashStatus").textContent = state.cash ? "Abierta" : "Cerrada";
  $("openingCash").textContent = fmt(state.cash?.opening_cash);
  $("expectedCash").textContent = fmt(Number(state.cash?.expected_cash || 0) + pendingCash);
  $("checkoutBtn").disabled = !state.cash;
  const lastClose = lastClosure();
  const suggestedOpening = Number(lastClose?.counted_cash ?? lastClose?.expected_cash ?? 0);
  $("lastCloseInfo").textContent = lastClose
    ? `Ultimo cierre: ${fmt(suggestedOpening)} (${localDateTime(lastClose.closed_at || lastClose.opened_at)})`
    : "Ultimo cierre: sin cierres registrados";
  if (!state.cash && !$("openAmount").value) $("openAmount").value = suggestedOpening ? suggestedOpening.toFixed(2) : "";

  const expected = Number(state.cash?.expected_cash || 0) + pendingCash;
  $("closeExpectedInfo").textContent = `Efectivo esperado: ${fmt(expected)}`;
  $("countedCash").placeholder = expected.toFixed(2);
  if (state.cash && !$("countedCash").value) $("countedCash").value = expected.toFixed(2);
}

function lastClosure() {
  return state.closures[0] || null;
}

function renderReportControls() {
  if (!$("reportCashier")) return;
  const current = $("reportCashier").value || "all";
  $("reportCashier").innerHTML = `<option value="all">Todos</option>` + state.profiles.map(profile => `<option value="${profile.id}">${profile.name} (${profile.role})</option>`).join("");
  $("reportCashier").value = state.profiles.some(profile => profile.id === current) ? current : "all";
}

function saleItemsFor(saleId) {
  return state.reports.sale_items
    .filter(item => item.sale_id === saleId)
    .map(item => ({
      ...item,
      product: state.products.find(product => product.id === item.product_id),
    }));
}

function saleCardHtml(sale) {
  const items = saleItemsFor(sale.id);
  return `
    <article class="ticket-card">
      <div class="ticket-head">
        <div><b>${sale.ticket}</b><span>${localDateTime(sale.created_at)} - ${profileName(sale.user_id)}</span></div>
        <strong>${fmt(sale.total)}</strong>
      </div>
      <div class="ticket-items">
        ${items.map(item => `
          <div class="ticket-item">
            ${saleItemVisual(item)}
            <div>
              <b>${item.product_name}</b>
              <span>${item.qty} x ${item.label} - ${item.qty * item.units_per_sale} unidades</span>
            </div>
            <strong>${fmt(item.line_total)}</strong>
          </div>`).join("") || "<p>Sin detalle de productos.</p>"}
      </div>
      <div class="ticket-foot"><span>Ganancia ${fmt(sale.profit)}</span><span>Pago ${sale.payment_method}</span></div>
    </article>`;
}

function renderReports() {
  $("salesList").innerHTML = state.reports.sales.slice(0, 50).map(saleCardHtml).join("") || "<p>Sin ventas recientes.</p>";
  if (!$("reportOutput").innerHTML.trim()) generateReport();
}

function showView(name) {
  if (!canUseView(name)) {
    toast("No tienes permiso para esta seccion");
    name = "dashboard";
  }
  document.querySelectorAll("aside button").forEach(button => button.classList.toggle("active", button.dataset.view === name));
  document.querySelectorAll(".view").forEach(view => view.classList.toggle("active", view.id === `${name}View`));
  $("title").textContent = { dashboard: "Dashboard", sale: "Venta", cash: "Caja", services: "Servicios", products: "Productos", stock: "Inventario", ahorrosv: "AhorroSV", users: "Usuarios", reports: "Reportes" }[name];
}

async function uploadImage(file) {
  if (!file) return $("preview").src || null;
  const ext = file.name.split(".").pop();
  const path = `${state.user.id}/${crypto.randomUUID()}.${ext}`;
  await requireOk(await supabase.storage.from("product-images").upload(path, file, { upsert: true }));
  const { data } = supabase.storage.from("product-images").getPublicUrl(path);
  return data.publicUrl;
}

function renderSelectedStockProduct() {
  const product = state.products.find(entry => entry.id === $("stockProduct")?.value) || state.products[0];
  if (!$("stockProductImage")) return;
  if (!product) {
    $("stockProductImage").removeAttribute("src");
    $("stockProductInfo").innerHTML = "<p>Sin producto seleccionado.</p>";
    return;
  }
  $("stockProduct").value = product.id;
  $("stockProductImage").src = product.image_url || "";
  $("stockProductInfo").innerHTML = `
    <p><b>${product.name}</b></p>
    <p>Codigo: ${product.code}</p>
    <p>Stock: ${unitsText(product)}</p>
    <p>Vencimiento: ${expirationText(product)}</p>
    <p>Compra: ${fmt(product.purchase_price)} / Venta: ${fmt(product.sale_price)} / ${fmt(product.pack_price)}</p>`;
}

function setSelectValue(id, value) {
  const select = $(id);
  if (!select || value === undefined || value === null) return;
  const normalized = String(value).trim();
  if (!normalized) return;
  const exists = [...select.options].some(option => option.value === normalized || option.textContent === normalized);
  if (!exists) select.add(new Option(normalized, normalized));
  select.value = normalized;
}

function fillProductForm(product) {
  $("productId").value = product.id;
  $("code").value = product.code;
  $("name").value = product.name;
  setSelectValue("category", product.category);
  setSelectValue("unitName", product.unit_name);
  setSelectValue("packName", product.pack_name);
  $("packSize").value = product.pack_size;
  $("purchasePrice").value = product.purchase_price;
  $("salePrice").value = product.sale_price;
  $("packPrice").value = product.pack_price;
  $("stock").value = product.stock;
  $("minStock").value = product.min_stock;
  $("expirationDate").value = product.expiration_date || "";
  $("preview").src = product.image_url || "";
  $("preview").classList.toggle("show", !!product.image_url);
}

function resetProductForm() {
  $("productForm").reset();
  $("productId").value = "";
  $("preview").removeAttribute("src");
  $("preview").classList.remove("show");
}

function selectInventoryProduct() {
  const product = state.products.find(entry => entry.id === $("stockProduct").value);
  if (!product) return;
  renderSelectedStockProduct();
  fillProductForm(product);
}

$("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = emailForUsername($("loginUser").value.trim());
  const password = $("loginPass").value;
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) return toast(error.message);
  await bootstrap();
});

$("logoutBtn").addEventListener("click", async () => { await teardownRealtime(); await supabase.auth.signOut(); location.reload(); });
document.querySelectorAll("aside button").forEach(button => button.addEventListener("click", () => showView(button.dataset.view)));

$("payment").addEventListener("input", renderCart);
$("catalogSearch").addEventListener("input", renderProducts);
$("productFilter").addEventListener("change", renderProducts);
$("inventorySearch").addEventListener("input", renderProducts);
$("serviceCompanyFilter").addEventListener("change", renderServices);
$("stockProduct").addEventListener("change", selectInventoryProduct);
$("compareProductBtn").addEventListener("click", () => {
  const product = state.products.find(entry => entry.id === $("stockProduct").value);
  if (!product) return toast("Selecciona un producto");
  searchAhorro(product.name);
});
$("newProductBtn").addEventListener("click", resetProductForm);
$("useExpectedBtn").addEventListener("click", () => {
  $("countedCash").value = Number(state.cash?.expected_cash || 0).toFixed(2);
});

$("scanBtn").addEventListener("click", () => {
  const code = $("scanInput").value.trim().toLowerCase();
  const product = state.products.find(entry => entry.code.toLowerCase() === code);
  if (!product) return toast("Producto no encontrado");
  window.addCart(product.id, "unit");
  $("scanInput").value = "";
});

$("checkoutBtn").addEventListener("click", async () => {
  try {
    if (!state.cash) return toast("Abre caja antes de vender");
    if (!state.cart.length) return toast("El carrito esta vacio");
    const cartSnapshot = [...state.cart];
    const totalSnapshot = totals();
    const paymentAmount = Number($("payment").value || 0);
    if (paymentAmount < totalSnapshot.total) return toast("Pago insuficiente");
    let result;
    if (!isOnline()) {
      result = queueOfflineSale(cartSnapshot, paymentAmount, totalSnapshot);
      toast(`Venta guardada offline ${result.ticket}`);
    } else {
      await sendYvrTopups(cartSnapshot);
      result = await requireOk(await supabase.rpc("create_sale", salePayloadFromCart(cartSnapshot, paymentAmount)));
      toast(`Venta ${result.ticket}, cambio ${fmt(result.change)}`);
    }
    printTicket(result, cartSnapshot, paymentAmount, totalSnapshot);
    state.cart = [];
    $("payment").value = "";
    if (result.offline) renderAll();
    else await refresh();
  } catch (err) { toast(err.message); }
});

$("openCashForm").addEventListener("submit", async e => {
  e.preventDefault();
  try {
    await requireOk(await supabase.rpc("open_cash", { p_opening_cash: Number($("openAmount").value || 0) }));
    await refresh();
  } catch (err) { toast(err.message); }
});

$("cashMoveForm").addEventListener("submit", async e => {
  e.preventDefault();
  if (!state.cash) return toast("No hay caja abierta");
  try {
    await requireOk(await supabase.from("cash_movements").insert({
      cash_session_id: state.cash.id,
      user_id: state.user.id,
      type: $("moveType").value,
      amount: Number($("moveAmount").value),
      reason: $("moveReason").value,
    }));
    e.target.reset();
    await refresh();
  } catch (err) { toast(err.message); }
});

$("closeCashForm").addEventListener("submit", async e => {
  e.preventDefault();
  try {
    if (state.cash) {
      state.cash.expected_cash = await requireOk(await supabase.rpc("expected_cash", { p_cash_session_id: state.cash.id }));
      if (!$("countedCash").value) $("countedCash").value = Number(state.cash.expected_cash || 0).toFixed(2);
    }
    await requireOk(await supabase.rpc("close_cash", { p_counted_cash: Number($("countedCash").value), p_notes: $("cashNotes").value }));
    e.target.reset();
    await refresh();
  } catch (err) { toast(err.message); }
});

$("imageFile").addEventListener("change", () => {
  const file = $("imageFile").files[0];
  if (!file) return;
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) return toast("Solo JPG, PNG o WEBP");
  const reader = new FileReader();
  reader.onload = () => { $("preview").src = reader.result; $("preview").classList.add("show"); };
  reader.readAsDataURL(file);
});

$("productForm").addEventListener("submit", async e => {
  e.preventDefault();
  try {
    const image_url = await uploadImage($("imageFile").files[0]);
    await requireOk(await supabase.from("products").upsert({
      id: $("productId").value || undefined,
      code: $("code").value,
      name: $("name").value,
      category: $("category").value,
      unit_name: $("unitName").value,
      pack_name: $("packName").value,
      pack_size: Number($("packSize").value),
      purchase_price: Number($("purchasePrice").value),
      sale_price: Number($("salePrice").value),
      pack_price: Number($("packPrice").value),
      stock: Number($("stock").value),
      min_stock: Number($("minStock").value),
      expiration_date: $("expirationDate").value || null,
      image_url,
    }));
    resetProductForm();
    await refresh();
  } catch (err) { toast(err.message); }
});

function resetServiceForm() {
  $("serviceForm").reset();
  $("serviceId").value = "";
  $("serviceCustomAmount").checked = false;
}

$("serviceForm").addEventListener("submit", async e => {
  e.preventDefault();
  if (!canUseView("services")) return toast("No tienes permiso para guardar servicios");
  try {
    const custom = $("serviceCustomAmount").checked;
    const salePrice = Number($("serviceSalePrice").value || 0);
    const cost = Number($("serviceCost").value || 0);
    await requireOk(await supabase.from("service_catalog").upsert({
      id: $("serviceId").value || undefined,
      company: $("serviceCompany").value,
      type: $("serviceType").value,
      name: $("serviceName").value,
      sale_price: custom ? 0 : salePrice,
      cost: custom ? 0 : cost,
      commission_pct: custom && salePrice > 0 ? salePrice : 0,
      custom_amount: custom,
      yvr_product_code: $("serviceYvrCode").value.trim() || null,
      yvr_enabled: $("serviceYvrEnabled").checked,
      active: true,
    }));
    resetServiceForm();
    await refresh();
  } catch (err) { toast(err.message); }
});

window.editService = (id) => {
  const service = state.services.find(item => item.id === id);
  if (!service) return;
  $("serviceId").value = service.id;
  $("serviceCompany").value = service.company;
  $("serviceType").value = service.type;
  $("serviceName").value = service.name;
  $("serviceCustomAmount").checked = !!service.custom_amount;
  $("serviceYvrCode").value = service.yvr_product_code || "";
  $("serviceYvrEnabled").checked = !!service.yvr_enabled;
  $("serviceSalePrice").value = service.custom_amount ? Number(service.commission_pct || 0) : Number(service.sale_price || 0);
  $("serviceCost").value = service.custom_amount ? 0 : Number(service.cost || 0);
  showView("services");
};

window.deleteService = async (id) => {
  if (!confirm("Eliminar servicio? Se desactivara para conservar el historial de ventas.")) return;
  try {
    await requireOk(await supabase.from("service_catalog").update({ active: false }).eq("id", id));
    await refresh();
  } catch (err) { toast(err.message); }
};

window.editProduct = (id) => {
  const product = state.products.find(entry => entry.id === id);
  fillProductForm(product);
  if ($("stockProduct")) {
    $("stockProduct").value = product.id;
    renderSelectedStockProduct();
  }
  showView("stock");
};

window.deleteProduct = async (id) => {
  if (!confirm("Eliminar producto? Si ya tiene ventas, Supabase puede impedirlo por historial.")) return;
  try {
    await requireOk(await supabase.from("products").delete().eq("id", id));
    await refresh();
  } catch (err) { toast(err.message); }
};

$("stockForm").addEventListener("submit", async e => {
  e.preventDefault();
  const product = state.products.find(entry => entry.id === $("stockProduct").value);
  const qty = Number($("stockQty").value);
  let stock = product.stock;
  if ($("stockType").value === "Entrada") stock += qty;
  else if ($("stockType").value === "Salida") stock -= qty;
  else stock = qty;
  if (stock < 0) return toast("Stock insuficiente");
  try {
    await requireOk(await supabase.from("products").update({ stock }).eq("id", product.id));
    await requireOk(await supabase.from("stock_movements").insert({
      product_id: product.id,
      user_id: state.user.id,
      type: $("stockType").value,
      qty,
      stock_after: stock,
      reason: $("stockReason").value,
    }));
    e.target.reset();
    await refresh();
  } catch (err) { toast(err.message); }
});

async function loadUsers() {
  if (state.user.role !== "Administrador") {
    $("usersTable").innerHTML = "";
    return toast("Solo administrador puede ver usuarios");
  }
  const users = await requireOk(await supabase.from("profiles").select("*").order("name"));
  $("usersTable").innerHTML = users.map(user => `<tr><td>${user.name}</td><td>${user.username}</td><td>${user.role}</td><td><button class="muted-btn" onclick="editUser('${user.id}', '${user.name}', '${user.username}', '${user.role}')">Editar</button></td></tr>`).join("");
}

window.editUser = (id, name, username, role) => {
  $("userId").value = id;
  $("userName").value = name;
  $("username").value = username;
  $("userRole").value = role;
  $("password").value = "";
};

$("userForm").addEventListener("submit", async e => {
  e.preventDefault();
  if (state.user.role !== "Administrador") return toast("Solo administrador puede guardar usuarios");
  try {
    await requireOk(await supabase.functions.invoke("admin-create-user", {
      body: { id: $("userId").value || null, name: $("userName").value, username: $("username").value, password: $("password").value, role: $("userRole").value, active: true },
    }));
    e.target.reset();
    $("userId").value = "";
    await loadUsers();
  } catch (err) { toast(err.message); }
});

function reportRowsForDay(date, cashierId) {
  const sales = state.reports.sales.filter(sale => {
    const matchesDate = localDate(sale.created_at) === date;
    const matchesCashier = cashierId === "all" || sale.user_id === cashierId;
    return matchesDate && matchesCashier;
  });
  const closures = state.closures.filter(closure => {
    const matchesDate = localDate(closure.closed_at || closure.opened_at) === date;
    const matchesCashier = cashierId === "all" || closure.user_id === cashierId;
    return matchesDate && matchesCashier;
  });
  return { sales, closures };
}

function generateReport() {
  if (!$("reportOutput")) return;
  const date = $("reportDate").value || new Date().toISOString().slice(0, 10);
  const cashierId = $("reportCashier").value || "all";
  const { sales, closures } = reportRowsForDay(date, cashierId);
  const profile = cashierId === "all" ? null : state.profiles.find(item => item.id === cashierId);
  const total = sales.reduce((sum, sale) => sum + Number(sale.total), 0);
  const profit = sales.reduce((sum, sale) => sum + Number(sale.profit), 0);
  const expected = closures.reduce((sum, closure) => sum + Number(closure.expected_cash || 0), 0);
  const counted = closures.reduce((sum, closure) => sum + Number(closure.counted_cash || 0), 0);
  const diff = closures.reduce((sum, closure) => sum + Number(closure.difference || 0), 0);
  const saleIds = new Set(sales.map(sale => sale.id));
  const soldProducts = productSummaryForSales(saleIds);

  $("reportOutput").innerHTML = `
    <div class="report-header">
      <h2>Reporte de ventas y cierre</h2>
      <p>Dia: ${date} - Cajero: ${profile?.name || "Todos"}</p>
    </div>
    <div class="report-summary">
      <article><span>Tickets</span><strong>${sales.length}</strong></article>
      <article><span>Total vendido</span><strong>${fmt(total)}</strong></article>
      <article><span>Ganancia</span><strong>${fmt(profit)}</strong></article>
      <article><span>Reportado cierre</span><strong>${fmt(counted)}</strong></article>
      <article><span>Esperado cierre</span><strong>${fmt(expected)}</strong></article>
      <article><span>Diferencia</span><strong>${fmt(diff)}</strong></article>
    </div>
    <h3>Ventas del dia</h3>
    <div class="ticket-list">${sales.map(saleCardHtml).join("") || "<p>Sin ventas</p>"}</div>
    <h3>Productos vendidos</h3>
    <table><thead><tr><th>Producto</th><th>Cantidad individual total</th><th>Monto vendido</th><th>Ganancia</th></tr></thead><tbody>
      ${soldProducts.map(item => `<tr><td><div class="table-product">${item.image_url ? `<img class="thumb" src="${item.image_url}" alt="${item.name}">` : serviceImage(item.name.split(" - ")[0])}<b>${item.name}</b></div></td><td>${item.units}</td><td>${fmt(item.sold)}</td><td>${fmt(item.profit)}</td></tr>`).join("") || `<tr><td colspan="4">Sin productos vendidos</td></tr>`}
    </tbody></table>
    <h3>Cierres de caja</h3>
    <table><thead><tr><th>Hora cierre</th><th>Cajero</th><th>Esperado</th><th>Reportado</th><th>Diferencia</th><th>Notas</th></tr></thead><tbody>
      ${closures.map(closure => `<tr><td>${localDateTime(closure.closed_at || closure.opened_at)}</td><td>${profileName(closure.user_id)}</td><td>${fmt(closure.expected_cash)}</td><td>${fmt(closure.counted_cash)}</td><td>${fmt(closure.difference)}</td><td>${closure.notes || ""}</td></tr>`).join("") || `<tr><td colspan="6">Sin cierres</td></tr>`}
    </tbody></table>`;
}

function productSummaryForSales(saleIds) {
  const map = new Map();
  state.reports.sale_items
    .filter(item => saleIds.has(item.sale_id))
    .forEach(item => {
      const product = state.products.find(entry => entry.id === item.product_id);
      const row = map.get(item.product_name) || {
        name: item.product_name,
        image_url: product?.image_url || "",
        units: 0,
        sold: 0,
        profit: 0,
      };
      row.units += item.qty * item.units_per_sale;
      row.sold += Number(item.line_total);
      row.profit += Number(item.line_total) - Number(item.line_cost);
      map.set(item.product_name, row);
    });
  return [...map.values()].sort((a, b) => b.units - a.units);
}

function printTicket(saleResult, cartSnapshot, paymentAmount, totalSnapshot) {
  const data = totalSnapshot;
  const ticketHtml = `
    <div class="ticket">
      <h2>POS SV</h2>
      <p>Ticket: ${saleResult.ticket}</p>
      <p>Fecha: ${localDateTime(new Date())}</p>
      <p>Cajero: ${state.user.name}</p>
      <hr>
      ${cartSnapshot.map(item => `
        <p><b>${item.product_name}</b><br>${item.qty} x ${item.label}${item.item_type === "service" ? "" : ` (${item.units_per_sale * item.qty} unidades)`} ${fmt(item.unit_price * item.qty)}</p>
      `).join("")}
      <hr>
      <p>Subtotal: ${fmt(data.subtotal)}</p>
      <p>IVA 13%: ${fmt(data.tax)}</p>
      <p><b>Total: ${fmt(data.total)}</b></p>
      <p>Pago: ${fmt(paymentAmount)}</p>
      <p>Cambio: ${fmt(saleResult.change)}</p>
    </div>`;
  const win = window.open("", "_blank", "width=380,height=620");
  win.document.write(`
    <html><head><title>Ticket ${saleResult.ticket}</title><style>
      body{font-family:Arial,sans-serif;margin:10px;color:#111}
      .ticket{width:280px}
      h2{text-align:center;margin:0 0 8px}
      p{font-size:13px;margin:5px 0}
      hr{border:0;border-top:1px dashed #999;margin:8px 0}
      @media print{body{margin:0}.ticket{width:72mm;padding:3mm}}
    </style></head><body>${ticketHtml}<script>window.onload=()=>window.print();</script></body></html>`);
  win.document.close();
}

function profileName(id) {
  return state.profiles.find(profile => profile.id === id)?.name || "Cajero";
}

function printReport() {
  generateReport();
  const win = window.open("", "_blank", "width=900,height=700");
  win.document.write(`
    <html><head><title>Reporte POS</title><style>
      body{font-family:Arial,sans-serif;margin:24px;color:#14202b}
      table{width:100%;border-collapse:collapse;margin:12px 0 22px}
      th,td{border-bottom:1px solid #d8e0e8;text-align:left;padding:8px}
      img{width:38px;height:38px;object-fit:cover;border-radius:6px}
      .ticket-list{display:grid;gap:10px}
      .ticket-card{border:1px solid #d8e0e8;border-radius:6px;padding:10px;margin-bottom:10px}
      .ticket-head,.ticket-foot{display:flex;justify-content:space-between;gap:10px}
      .ticket-item,.table-product{display:flex;align-items:center;gap:8px;border-top:1px solid #d8e0e8;padding-top:6px;margin-top:6px}
      .report-summary{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin:14px 0}
      article{border:1px solid #d8e0e8;padding:10px;border-radius:6px}
      span{display:block;color:#627083;font-size:12px;text-transform:uppercase}
    </style></head><body>${$("reportOutput").innerHTML}</body></html>`);
  win.document.close();
  win.focus();
  win.print();
}

document.querySelector('[data-view="users"]').addEventListener("click", loadUsers);
$("generateReportBtn").addEventListener("click", generateReport);
$("printReportBtn").addEventListener("click", printReport);
$("reportDate").addEventListener("change", generateReport);
$("reportCashier").addEventListener("change", generateReport);
$("reloadAhorroBtn").addEventListener("click", () => {
  if (!$("ahorroWebview").classList.contains("hidden") && typeof $("ahorroWebview").reload === "function") {
    $("ahorroWebview").reload();
    return;
  }
  $("ahorroFrame").src = "https://ahorrosv.com/";
});
$("importAhorroBtn").addEventListener("click", importAhorroToInventory);
window.addEventListener("online", () => { renderSyncStatus(); setupRealtime(); syncOfflineSales(); refresh(); });
window.addEventListener("offline", renderSyncStatus);
supabase.auth.onAuthStateChange((_event, session) => { state.session = session; });
bootstrap();

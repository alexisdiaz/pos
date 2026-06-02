import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const $ = (id) => document.getElementById(id);
const money = new Intl.NumberFormat("es-SV", { style: "currency", currency: "USD" });

const ROLE_VIEWS = {
  Administrador: ["dashboard", "sale", "cash", "products", "stock", "users", "reports"],
  Supervisor: ["dashboard", "sale", "cash", "products", "stock", "reports"],
  Cajero: ["dashboard", "sale", "cash"],
};

let state = {
  session: null,
  user: null,
  products: [],
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
  return state.cart.filter(item => item.product_id === productId).reduce((sum, item) => sum + item.units_per_sale * item.qty, 0);
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

async function bootstrap() {
  const { data } = await supabase.auth.getSession();
  state.session = data.session;
  if (!state.session) {
    $("login").classList.remove("hidden");
    $("app").classList.add("hidden");
    return;
  }

  state.user = await requireOk(await supabase.from("profiles").select("*").eq("id", state.session.user.id).single());
  $("login").classList.add("hidden");
  $("app").classList.remove("hidden");
  $("reportDate").value = new Date().toISOString().slice(0, 10);
  await refresh();
}

async function refresh() {
  state.products = await requireOk(await supabase.from("products").select("*").order("name"));

  const cashRows = await requireOk(await supabase.from("cash_sessions").select("*").eq("status", "open").order("opened_at", { ascending: false }).limit(1));
  state.cash = cashRows[0] || null;
  if (state.cash) {
    state.cash.expected_cash = await requireOk(await supabase.rpc("expected_cash", { p_cash_session_id: state.cash.id }));
  }

  if (state.user.role === "Administrador") {
    state.profiles = await requireOk(await supabase.from("profiles").select("*").order("name"));
    state.closures = await requireOk(await supabase.from("cash_sessions").select("*").eq("status", "closed").order("closed_at", { ascending: false }).limit(200));
  } else {
    state.profiles = [state.user];
    state.closures = [];
  }

  await loadReports();
  renderAll();
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
  renderDashboard();
  renderProducts();
  renderCart();
  renderCash();
  renderReportControls();
  renderReports();
  renderSelectedStockProduct();
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
  $("dashSold").textContent = fmt(summary.sold);
  $("dashProfit").textContent = fmt(summary.profit);
  $("dashTickets").textContent = summary.tickets;
  $("dashLow").textContent = state.reports.low_stock.length;
  $("lowStockList").innerHTML = state.reports.low_stock.map(product =>
    `<p><b>${product.name}</b> <span class="pill low">${product.stock}/${product.min_stock}</span></p>`
  ).join("") || "<p>Sin alertas.</p>";
  $("topList").innerHTML = state.reports.top_products.map(product => `
    <div class="top-product">
      <img src="${product.image_url || ""}" alt="${product.product_name}">
      <div><b>${product.product_name}</b><br>${product.units} unidades - ${fmt(product.profit)} ganancia</div>
    </div>`).join("") || "<p>Sin ventas.</p>";
}

function renderProducts() {
  const catalogTerm = ($("catalogSearch")?.value || "").trim().toLowerCase();
  const inventoryTerm = ($("inventorySearch")?.value || "").trim().toLowerCase();
  const matches = (product, term) => !term || `${product.name} ${product.code} ${product.category} ${product.unit_name} ${product.pack_name}`.toLowerCase().includes(term);
  const catalogProducts = state.products.filter(product => matches(product, catalogTerm));
  const inventoryProducts = state.products.filter(product => matches(product, inventoryTerm));

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
    </tr>`).join("") || `<tr><td colspan="8">No se encontraron productos</td></tr>`;

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

  const selected = $("stockProduct").value;
  $("stockProduct").innerHTML = inventoryProducts.map(product => `<option value="${product.id}">${product.name}</option>`).join("");
  if (selected && inventoryProducts.some(p => p.id === selected)) $("stockProduct").value = selected;
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

window.qty = (id, delta) => {
  const item = state.cart.find(entry => entry.id === id);
  const product = state.products.find(entry => entry.id === item.product_id);
  if (delta > 0 && cartUnits(product.id) + item.units_per_sale > product.stock) return toast("Stock insuficiente");
  item.qty += delta;
  if (item.qty <= 0) state.cart = state.cart.filter(entry => entry.id !== id);
  renderCart();
};

function renderCart() {
  $("cartList").innerHTML = state.cart.map(item => `
    <div class="cart-item">
      <div><b>${item.product_name}</b><br>${item.label} - ${item.units_per_sale * item.qty} unidades reales - ${fmt(item.unit_price)}</div>
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
  $("cashStatus").textContent = state.cash ? "Abierta" : "Cerrada";
  $("openingCash").textContent = fmt(state.cash?.opening_cash);
  $("expectedCash").textContent = fmt(state.cash?.expected_cash);
  $("checkoutBtn").disabled = !state.cash;
}

function renderReportControls() {
  if (!$("reportCashier")) return;
  const current = $("reportCashier").value || "all";
  $("reportCashier").innerHTML = `<option value="all">Todos</option>` + state.profiles.map(profile => `<option value="${profile.id}">${profile.name} (${profile.role})</option>`).join("");
  $("reportCashier").value = state.profiles.some(profile => profile.id === current) ? current : "all";
}

function renderReports() {
  $("salesTable").innerHTML = state.reports.sales.slice(0, 50).map(sale =>
    `<tr><td>${sale.ticket}</td><td>${fmt(sale.total)}</td><td>${fmt(sale.profit)}</td><td>${localDateTime(sale.created_at)}</td></tr>`
  ).join("");
  if (!$("reportOutput").innerHTML.trim()) generateReport();
}

function showView(name) {
  if (!canUseView(name)) {
    toast("No tienes permiso para esta seccion");
    name = "dashboard";
  }
  document.querySelectorAll("aside button").forEach(button => button.classList.toggle("active", button.dataset.view === name));
  document.querySelectorAll(".view").forEach(view => view.classList.toggle("active", view.id === `${name}View`));
  $("title").textContent = { dashboard: "Dashboard", sale: "Venta", cash: "Caja", products: "Productos", stock: "Inventario", users: "Usuarios", reports: "Reportes" }[name];
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
  if (!product || !$("stockProductImage")) return;
  $("stockProduct").value = product.id;
  $("stockProductImage").src = product.image_url || "";
  $("stockProductInfo").innerHTML = `
    <p><b>${product.name}</b></p>
    <p>Codigo: ${product.code}</p>
    <p>Stock: ${unitsText(product)}</p>
    <p>Compra: ${fmt(product.purchase_price)} / Venta: ${fmt(product.sale_price)} / ${fmt(product.pack_price)}</p>`;
}

$("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = emailForUsername($("loginUser").value.trim());
  const password = $("loginPass").value;
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) return toast(error.message);
  await bootstrap();
});

$("logoutBtn").addEventListener("click", async () => { await supabase.auth.signOut(); location.reload(); });
document.querySelectorAll("aside button").forEach(button => button.addEventListener("click", () => showView(button.dataset.view)));

$("payment").addEventListener("input", renderCart);
$("catalogSearch").addEventListener("input", renderProducts);
$("inventorySearch").addEventListener("input", renderProducts);
$("stockProduct").addEventListener("change", renderSelectedStockProduct);

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
    const result = await requireOk(await supabase.rpc("create_sale", {
      p_items: state.cart.map(item => ({ product_id: item.product_id, mode: item.mode, qty: item.qty })),
      p_payment: Number($("payment").value),
      p_payment_method: $("paymentMethod").value,
    }));
    toast(`Venta ${result.ticket}, cambio ${fmt(result.change)}`);
    printTicket(result, [...state.cart], Number($("payment").value || 0), totals());
    state.cart = [];
    $("payment").value = "";
    await refresh();
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
    await requireOk(await supabase.rpc("close_cash", { p_counted_cash: Number($("countedCash").value), p_notes: $("cashNotes").value }));
    e.target.reset();
    await refresh();
  } catch (err) { toast(err.message); }
});

$("imageFile").addEventListener("change", () => {
  const file = $("imageFile").files[0];
  if (!file) return;
  if (!["image/jpeg", "image/png"].includes(file.type)) return toast("Solo JPG o PNG");
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
      image_url,
    }));
    e.target.reset();
    $("productId").value = "";
    $("preview").classList.remove("show");
    await refresh();
  } catch (err) { toast(err.message); }
});

window.editProduct = (id) => {
  const product = state.products.find(entry => entry.id === id);
  $("productId").value = product.id;
  $("code").value = product.code;
  $("name").value = product.name;
  $("category").value = product.category;
  $("unitName").value = product.unit_name;
  $("packName").value = product.pack_name;
  $("packSize").value = product.pack_size;
  $("purchasePrice").value = product.purchase_price;
  $("salePrice").value = product.sale_price;
  $("packPrice").value = product.pack_price;
  $("stock").value = product.stock;
  $("minStock").value = product.min_stock;
  $("preview").src = product.image_url || "";
  $("preview").classList.toggle("show", !!product.image_url);
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
    <table><thead><tr><th>Hora</th><th>Ticket</th><th>Cajero</th><th>Total</th><th>Ganancia</th></tr></thead><tbody>
      ${sales.map(sale => `<tr><td>${localDateTime(sale.created_at)}</td><td>${sale.ticket}</td><td>${profileName(sale.user_id)}</td><td>${fmt(sale.total)}</td><td>${fmt(sale.profit)}</td></tr>`).join("") || `<tr><td colspan="5">Sin ventas</td></tr>`}
    </tbody></table>
    <h3>Productos vendidos</h3>
    <table><thead><tr><th>Producto</th><th>Cantidad individual total</th><th>Monto vendido</th><th>Ganancia</th></tr></thead><tbody>
      ${soldProducts.map(item => `<tr><td>${item.name}</td><td>${item.units}</td><td>${fmt(item.sold)}</td><td>${fmt(item.profit)}</td></tr>`).join("") || `<tr><td colspan="4">Sin productos vendidos</td></tr>`}
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
      const row = map.get(item.product_name) || { name: item.product_name, units: 0, sold: 0, profit: 0 };
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
        <p><b>${item.product_name}</b><br>${item.qty} x ${item.label} (${item.units_per_sale * item.qty} unidades) ${fmt(item.unit_price * item.qty)}</p>
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
supabase.auth.onAuthStateChange((_event, session) => { state.session = session; });
bootstrap();

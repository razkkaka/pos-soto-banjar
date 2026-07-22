const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const path = require("path");

const { initDb, query, run, persist, isTurso } = require("./db");

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "soto-banjar-nyaman-rahasia-2026";

// Initialize database immediately and store the promise
const dbPromise = initDb().catch((err) => {
  console.error("Gagal menginisialisasi database:", err);
  if (!process.env.VERCEL) process.exit(1);
});

const VALID_PAYMENT_METHODS = ["cash", "qris", "gojek", "other"];
const VALID_EXPENSE_CATEGORIES = [
  "Belanja Harian",
  "Gaji Karyawan",
  "Operasional",
  "Lainnya",
];

// All date math below intentionally uses UTC (matching SQLite's date('now'),
// which is UTC) so that JS-computed boundaries (week/month) line up exactly
// with dates stored via SQL's date('now') / datetime('now').
function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function mondayOfThisWeekStr() {
  const now = new Date();
  const day = now.getUTCDay(); // 0 = Sunday ... 6 = Saturday
  const diffToMonday = day === 0 ? -6 : 1 - day;
  const monday = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  );
  monday.setUTCDate(monday.getUTCDate() + diffToMonday);
  return monday.toISOString().slice(0, 10);
}

function firstDayOfThisMonthStr() {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, "public")));

// Ensure DB is fully initialized before handling any requests
app.use(async (req, res, next) => {
  if (req.path.startsWith("/api/")) {
    try {
      await dbPromise;
    } catch (err) {
      console.error("DB Init Error:", err);
      return res.status(500).json({ error: "Database initialization failed." });
    }
  }
  next();
});

// ---------- Auth middleware ----------
function authMiddleware(req, res, next) {
  const header = req.headers["authorization"];
  const token = header && header.split(" ")[1];
  if (!token) {
    return res.status(401).json({ error: "Token tidak ditemukan. Silakan login." });
  }
  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) {
      return res.status(403).json({ error: "Sesi tidak valid atau sudah kedaluwarsa. Silakan login kembali." });
    }
    req.user = decoded;
    next();
  });
}

// ---------- AUTH ROUTES ----------
app.post("/api/login", async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: "Username dan password wajib diisi." });
    }

    const users = await query("SELECT * FROM users WHERE username = ?", [username]);
    const user = users[0];
    if (!user) {
      return res.status(401).json({ error: "Username atau password salah." });
    }

    const valid = bcrypt.compareSync(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: "Username atau password salah." });
    }

    const token = jwt.sign(
      { id: user.id, username: user.username, role: user.role },
      JWT_SECRET,
      { expiresIn: "12h" }
    );

    res.json({
      token,
      user: { id: user.id, username: user.username, role: user.role },
    });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ error: "Terjadi kesalahan server." });
  }
});

app.get("/api/me", authMiddleware, (req, res) => {
  res.json({ user: req.user });
});

// ---------- MENU ROUTES (CRUD) ----------
app.get("/api/menu", authMiddleware, async (req, res) => {
  try {
    const items = await query(
      "SELECT * FROM menu WHERE is_active = 1 ORDER BY category, name"
    );
    res.json(items);
  } catch (err) {
    res.status(500).json({ error: "Gagal memuat menu." });
  }
});

app.post("/api/menu", authMiddleware, async (req, res) => {
  try {
    const { name, category, price } = req.body;
    if (!name || !category || price === undefined || isNaN(price) || price < 0) {
      return res.status(400).json({ error: "Nama, kategori, dan harga (angka valid) wajib diisi." });
    }
    const id = await run(
      "INSERT INTO menu (name, category, price, is_active) VALUES (?, ?, ?, 1)",
      [name, category, Math.round(Number(price))]
    );
    res.status(201).json({ id, name, category, price: Math.round(Number(price)) });
  } catch (err) {
    res.status(500).json({ error: "Gagal menambah menu." });
  }
});

app.put("/api/menu/:id", authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, category, price } = req.body;
    const existing = await query("SELECT * FROM menu WHERE id = ?", [id]);
    if (!existing[0]) {
      return res.status(404).json({ error: "Menu tidak ditemukan." });
    }
    if (!name || !category || price === undefined || isNaN(price) || price < 0) {
      return res.status(400).json({ error: "Nama, kategori, dan harga (angka valid) wajib diisi." });
    }
    await run("UPDATE menu SET name = ?, category = ?, price = ? WHERE id = ?", [
      name,
      category,
      Math.round(Number(price)),
      id,
    ]);
    res.json({ id: Number(id), name, category, price: Math.round(Number(price)) });
  } catch (err) {
    res.status(500).json({ error: "Gagal mengupdate menu." });
  }
});

app.delete("/api/menu/:id", authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const existing = await query("SELECT * FROM menu WHERE id = ?", [id]);
    if (!existing[0]) {
      return res.status(404).json({ error: "Menu tidak ditemukan." });
    }
    // Soft delete so historical transaction items still resolve correctly
    await run("UPDATE menu SET is_active = 0 WHERE id = ?", [id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Gagal menghapus menu." });
  }
});

// ---------- TRANSACTION ROUTES ----------
app.post("/api/transactions", authMiddleware, async (req, res) => {
  try {
    const { items, discount_percent, payment_method } = req.body;

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "Keranjang tidak boleh kosong." });
    }

    const discountPct = Number(discount_percent) || 0;
    if (discountPct < 0 || discountPct > 100) {
      return res.status(400).json({ error: "Diskon harus antara 0 - 100%." });
    }

    if (!payment_method || !VALID_PAYMENT_METHODS.includes(payment_method)) {
      return res.status(400).json({
        error: "Metode pembayaran wajib dipilih (Cash, QRIS, Gojek, atau Lainnya).",
      });
    }

    let subtotal = 0;
    const validatedItems = [];

    for (const item of items) {
      const menuRows = await query("SELECT * FROM menu WHERE id = ?", [item.menu_id]);
      const menuItem = menuRows[0];
      if (!menuItem) {
        return res.status(400).json({ error: `Menu dengan id ${item.menu_id} tidak ditemukan.` });
      }
      const qty = Number(item.quantity);
      if (!qty || qty <= 0) {
        return res.status(400).json({ error: "Jumlah item tidak valid." });
      }
      const lineTotal = menuItem.price * qty;
      subtotal += lineTotal;
      validatedItems.push({
        menu_id: menuItem.id,
        menu_name: menuItem.name,
        price: menuItem.price,
        quantity: qty,
        line_total: lineTotal,
      });
    }

    const discountAmount = Math.round((subtotal * discountPct) / 100);
    const grandTotal = subtotal - discountAmount;

    const now = new Date();
    const transactionCode = `TRX-${now.getTime()}`;

    const transactionId = await run(
      `INSERT INTO transactions
        (transaction_code, subtotal, discount_percent, discount_amount, grand_total, payment_method, cashier_username)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        transactionCode,
        subtotal,
        discountPct,
        discountAmount,
        grandTotal,
        payment_method,
        req.user.username,
      ]
    );

    for (const item of validatedItems) {
      await run(
        `INSERT INTO transaction_items
          (transaction_id, menu_id, menu_name, price, quantity, line_total)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [transactionId, item.menu_id, item.menu_name, item.price, item.quantity, item.line_total]
      );
    }

    const savedRows = await query("SELECT * FROM transactions WHERE id = ?", [transactionId]);
    const savedTransaction = savedRows[0];

    res.status(201).json({
      transaction: savedTransaction,
      items: validatedItems,
    });
  } catch (err) {
    console.error("Checkout error:", err);
    res.status(500).json({ error: "Gagal menyelesaikan transaksi." });
  }
});

app.get("/api/transactions", authMiddleware, async (req, res) => {
  try {
    const transactions = await query(
      "SELECT * FROM transactions ORDER BY created_at DESC LIMIT 100"
    );
    res.json(transactions);
  } catch (err) {
    res.status(500).json({ error: "Gagal memuat transaksi." });
  }
});

// Rekap transaksi per tanggal — harus di atas /:id agar tidak tertangkap wildcard
app.get("/api/transactions/recap", authMiddleware, async (req, res) => {
  try {
    const date = req.query.date || todayStr();

    const txRows = await query(
      `SELECT * FROM transactions WHERE date(created_at) = ? ORDER BY created_at DESC`,
      [date]
    );

    const summaryRows = await query(
      `SELECT COALESCE(SUM(grand_total), 0) AS gross, COUNT(*) AS count
       FROM transactions WHERE date(created_at) = ?`,
      [date]
    );

    const expenseRows = await query(
      `SELECT COALESCE(SUM(amount), 0) AS total FROM expenses WHERE expense_date = ?`,
      [date]
    );

    const expenseItems = await query(
      `SELECT * FROM expenses WHERE expense_date = ? ORDER BY created_at DESC`,
      [date]
    );

    res.json({
      date,
      gross: summaryRows[0].gross,
      count: summaryRows[0].count,
      expenses: expenseRows[0].total,
      net: summaryRows[0].gross - expenseRows[0].total,
      transactions: txRows,
      expense_items: expenseItems,
    });
  } catch (err) {
    console.error("Recap error:", err);
    res.status(500).json({ error: "Gagal memuat rekap." });
  }
});

app.get("/api/transactions/:id", authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const rows = await query("SELECT * FROM transactions WHERE id = ?", [id]);
    const transaction = rows[0];
    if (!transaction) {
      return res.status(404).json({ error: "Transaksi tidak ditemukan." });
    }
    const items = await query("SELECT * FROM transaction_items WHERE transaction_id = ?", [id]);
    res.json({ transaction, items });
  } catch (err) {
    res.status(500).json({ error: "Gagal memuat transaksi." });
  }
});

// Edit transaksi (update items, diskon, metode pembayaran)
app.put("/api/transactions/:id", authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const existingRows = await query("SELECT * FROM transactions WHERE id = ?", [id]);
    if (!existingRows[0]) {
      return res.status(404).json({ error: "Transaksi tidak ditemukan." });
    }

    const { items, discount_percent, payment_method } = req.body;

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "Item transaksi tidak boleh kosong." });
    }

    const discountPct = Number(discount_percent) || 0;
    if (discountPct < 0 || discountPct > 100) {
      return res.status(400).json({ error: "Diskon harus antara 0 - 100%." });
    }

    if (!payment_method || !VALID_PAYMENT_METHODS.includes(payment_method)) {
      return res.status(400).json({ error: "Metode pembayaran tidak valid." });
    }

    let subtotal = 0;
    const validatedItems = [];

    for (const item of items) {
      const menuRows = await query("SELECT * FROM menu WHERE id = ?", [item.menu_id]);
      const menuItem = menuRows[0];
      if (!menuItem) {
        return res.status(400).json({ error: `Menu dengan id ${item.menu_id} tidak ditemukan.` });
      }
      const qty = Number(item.quantity);
      if (!qty || qty <= 0) {
        return res.status(400).json({ error: "Jumlah item tidak valid." });
      }
      const lineTotal = menuItem.price * qty;
      subtotal += lineTotal;
      validatedItems.push({
        menu_id: menuItem.id,
        menu_name: menuItem.name,
        price: menuItem.price,
        quantity: qty,
        line_total: lineTotal,
      });
    }

    const discountAmount = Math.round((subtotal * discountPct) / 100);
    const grandTotal = subtotal - discountAmount;

    // Update transaction record
    await run(
      `UPDATE transactions SET subtotal = ?, discount_percent = ?, discount_amount = ?, grand_total = ?, payment_method = ? WHERE id = ?`,
      [subtotal, discountPct, discountAmount, grandTotal, payment_method, id]
    );

    // Delete old items and insert new ones
    await run("DELETE FROM transaction_items WHERE transaction_id = ?", [Number(id)]);

    for (const item of validatedItems) {
      await run(
        `INSERT INTO transaction_items (transaction_id, menu_id, menu_name, price, quantity, line_total) VALUES (?, ?, ?, ?, ?, ?)`,
        [Number(id), item.menu_id, item.menu_name, item.price, item.quantity, item.line_total]
      );
    }

    const updatedRows = await query("SELECT * FROM transactions WHERE id = ?", [id]);
    res.json({ transaction: updatedRows[0], items: validatedItems });
  } catch (err) {
    console.error("Edit transaction error:", err);
    res.status(500).json({ error: "Gagal mengupdate transaksi." });
  }
});

// Hapus transaksi beserta itemnya
app.delete("/api/transactions/:id", authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const existingRows = await query("SELECT * FROM transactions WHERE id = ?", [id]);
    if (!existingRows[0]) {
      return res.status(404).json({ error: "Transaksi tidak ditemukan." });
    }
    await run("DELETE FROM transaction_items WHERE transaction_id = ?", [Number(id)]);
    await run("DELETE FROM transactions WHERE id = ?", [Number(id)]);
    res.json({ success: true });
  } catch (err) {
    console.error("Delete transaction error:", err);
    res.status(500).json({ error: "Gagal menghapus transaksi." });
  }
});

// ---------- EXPENSES (Pengeluaran Harian) ----------
// Used to turn Pendapatan Kotor (gross) into Pendapatan Bersih (net):
// net = gross - expenses. Categories: belanja harian, gaji karyawan, dll.
app.get("/api/expenses", authMiddleware, async (req, res) => {
  try {
    const date = req.query.date || todayStr();
    const rows = await query(
      "SELECT * FROM expenses WHERE expense_date = ? ORDER BY created_at DESC",
      [date]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: "Gagal memuat pengeluaran." });
  }
});

app.post("/api/expenses", authMiddleware, async (req, res) => {
  try {
    const { description, category, amount, expense_date } = req.body;

    if (!description || !description.trim()) {
      return res.status(400).json({ error: "Keterangan pengeluaran wajib diisi." });
    }
    if (!category || !VALID_EXPENSE_CATEGORIES.includes(category)) {
      return res.status(400).json({
        error: `Kategori wajib salah satu dari: ${VALID_EXPENSE_CATEGORIES.join(", ")}.`,
      });
    }
    if (amount === undefined || isNaN(amount) || Number(amount) <= 0) {
      return res.status(400).json({ error: "Jumlah pengeluaran harus berupa angka lebih dari 0." });
    }

    const date = expense_date || todayStr();
    const id = await run(
      `INSERT INTO expenses (description, category, amount, expense_date, created_by)
       VALUES (?, ?, ?, ?, ?)`,
      [description.trim(), category, Math.round(Number(amount)), date, req.user.username]
    );

    const savedRows = await query("SELECT * FROM expenses WHERE id = ?", [id]);
    res.status(201).json(savedRows[0]);
  } catch (err) {
    res.status(500).json({ error: "Gagal menambah pengeluaran." });
  }
});

app.delete("/api/expenses/:id", authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const existing = await query("SELECT * FROM expenses WHERE id = ?", [id]);
    if (!existing[0]) {
      return res.status(404).json({ error: "Data pengeluaran tidak ditemukan." });
    }
    await run("DELETE FROM expenses WHERE id = ?", [id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Gagal menghapus pengeluaran." });
  }
});

// ---------- DASHBOARD ----------
app.get("/api/dashboard", authMiddleware, async (req, res) => {
  try {
    const monday = mondayOfThisWeekStr();
    const firstOfMonth = firstDayOfThisMonthStr();

    // Gross revenue (Pendapatan Kotor) — straight sum of completed transactions
    const todayGrossRows = await query(
      `SELECT COALESCE(SUM(grand_total), 0) AS total, COUNT(*) AS count
       FROM transactions WHERE date(created_at) = date('now')`
    );
    const weekGrossRows = await query(
      `SELECT COALESCE(SUM(grand_total), 0) AS total, COUNT(*) AS count
       FROM transactions WHERE date(created_at) >= ?`,
      [monday]
    );
    const monthGrossRows = await query(
      `SELECT COALESCE(SUM(grand_total), 0) AS total, COUNT(*) AS count
       FROM transactions WHERE date(created_at) >= ?`,
      [firstOfMonth]
    );
    const totalGrossRows = await query(
      `SELECT COALESCE(SUM(grand_total), 0) AS total, COUNT(*) AS count
       FROM transactions`
    );

    // Expenses (Pengeluaran) — belanja harian, gaji karyawan, operasional, dll.
    const todayExpenseRows = await query(
      `SELECT COALESCE(SUM(amount), 0) AS total FROM expenses WHERE expense_date = date('now')`
    );
    const totalExpenseRows = await query(`SELECT COALESCE(SUM(amount), 0) AS total FROM expenses`);
    const todayExpenseItems = await query(
      `SELECT * FROM expenses WHERE expense_date = date('now') ORDER BY created_at DESC`
    );

    // Net revenue (Pendapatan Bersih) = gross - expenses.
    const dailyNet = todayGrossRows[0].total - todayExpenseRows[0].total;
    const totalNet = totalGrossRows[0].total - totalExpenseRows[0].total;

    const topItems = await query(`
      SELECT menu_name, SUM(quantity) AS total_qty, SUM(line_total) AS total_revenue
      FROM transaction_items
      GROUP BY menu_name
      ORDER BY total_qty DESC
      LIMIT 5
    `);

    const paymentBreakdownToday = await query(`
      SELECT payment_method, COALESCE(SUM(grand_total), 0) AS total, COUNT(*) AS count
      FROM transactions
      WHERE date(created_at) = date('now')
      GROUP BY payment_method
    `);

    res.json({
      gross_today: todayGrossRows[0].total,
      count_today: todayGrossRows[0].count,
      expenses_today: todayExpenseRows[0].total,
      expense_items_today: todayExpenseItems,
      net_today: dailyNet,

      gross_week: weekGrossRows[0].total,
      count_week: weekGrossRows[0].count,

      gross_month: monthGrossRows[0].total,
      count_month: monthGrossRows[0].count,

      gross_total: totalGrossRows[0].total,
      count_total: totalGrossRows[0].count,
      expenses_total: totalExpenseRows[0].total,
      net_total: totalNet,

      top_items: topItems,
      payment_breakdown_today: paymentBreakdownToday,
    });
  } catch (err) {
    console.error("Dashboard error:", err);
    res.status(500).json({ error: "Gagal memuat dashboard." });
  }
});

// Chart pemasukan harian (default 7 hari terakhir)
app.get("/api/dashboard/daily-chart", authMiddleware, async (req, res) => {
  try {
    const days = Math.min(30, Math.max(1, Number(req.query.days) || 7));
    const rows = await query(
      `SELECT date(created_at) AS date, COALESCE(SUM(grand_total), 0) AS total
       FROM transactions
       WHERE date(created_at) >= date('now', '-' || ? || ' days')
       GROUP BY date(created_at)
       ORDER BY date(created_at) ASC`,
      [days]
    );

    // Fill in missing dates with 0
    const result = [];
    const today = new Date();
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - i));
      const dateStr = d.toISOString().slice(0, 10);
      const found = rows.find((r) => r.date === dateStr);
      result.push({ date: dateStr, total: found ? found.total : 0 });
    }

    res.json(result);
  } catch (err) {
    console.error("Daily chart error:", err);
    res.status(500).json({ error: "Gagal memuat data chart." });
  }
});

// ---------- Fallback ----------
app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api/")) return next();
  res.sendFile(path.join(__dirname, "public", "login.html"));
});

// ---------- Start ----------
if (!process.env.VERCEL) {
  dbPromise.then(() => {
    app.listen(PORT, () => {
      console.log(`Soto Banjar Nyaman POS berjalan di http://localhost:${PORT}`);
    });
  });
}

module.exports = app;

const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");

const DB_FILE = path.join(__dirname, "data", "pos.sqlite");

// Detect mode: Turso (cloud) vs local SQLite
const USE_TURSO = !!(process.env.TURSO_DATABASE_URL);

// ============================================================
//  TURSO (cloud) mode — used on Vercel
// ============================================================
let tursoClient = null;

function initTurso() {
  const { createClient } = require("@libsql/client");
  tursoClient = createClient({
    url: process.env.TURSO_DATABASE_URL.trim(),
    authToken: process.env.TURSO_AUTH_TOKEN ? process.env.TURSO_AUTH_TOKEN.trim() : undefined,
  });
}

async function tursoQuery(sql, params = []) {
  const result = await tursoClient.execute({ sql, args: params });
  return result.rows.map((row) => {
    const obj = {};
    for (const col of result.columns) {
      obj[col] = row[col];
    }
    return obj;
  });
}

async function tursoRun(sql, params = []) {
  const result = await tursoClient.execute({ sql, args: params });
  return Number(result.lastInsertRowid) || null;
}

// ============================================================
//  LOCAL SQLite mode — used in development
// ============================================================
let SQL = null;
let db = null;

function persist() {
  if (USE_TURSO) return; // no-op in cloud mode
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
  fs.writeFileSync(DB_FILE, buffer);
}

function localQuery(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  return rows;
}

function localRun(sql, params = []) {
  db.run(sql, params);
  const result = localQuery("SELECT last_insert_rowid() AS id");
  persist();
  return result[0] ? result[0].id : null;
}

// ============================================================
//  Shared seed data
// ============================================================
const MENU_ITEMS = [
  ["Soto Banjar Bening/Susu + Nasi/Ketupat", "Utama & Paket", 30000],
  ["Soto Banjar Bening/Susu Daging + Nasi/Ketupat", "Utama & Paket", 42000],
  ["Soto Banjar Bening/Susu Super Spesial + Nasi/Ketupat", "Utama & Paket", 48000],
  ["Sate Banjar Nyaman (ayam) 1 porsi = 8 tusuk", "Utama & Paket", 32000],
  ["Ketupat Kandangan", "Utama & Paket", 45000],
  ["Masak Habang (Intalu) Telur + Nasi", "Utama & Paket", 22000],
  ["Masak Habang Ayam + Nasi", "Utama & Paket", 30000],
  ["Masak Habang Daging + Nasi", "Utama & Paket", 38000],
  ["Masak Habang Haruan (Ikan Gabus) + Nasi", "Utama & Paket", 45000],
  ["Iga Bakar Kuah + Nasi", "Utama & Paket", 45000],
  ["Garang/Gangan Asam Patin + Nasi", "Utama & Paket", 30000],
  ["Ayam Goreng Nyaman + Nasi", "Utama & Paket", 30000],
  ["Nasi Putih", "Tambahan & Minuman", 6000],
  ["Perkedel (1 porsi = 2 pcs)", "Tambahan & Minuman", 6000],
  ["Ketupat", "Tambahan & Minuman", 6000],
  ["Telur", "Tambahan & Minuman", 6000],
  ["Kerupuk Kampung", "Tambahan & Minuman", 3000],
  ["Teh Banjar Es / Panas", "Tambahan & Minuman", 6000],
];

const CREATE_TABLES_SQL = [
  `CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'kasir',
    created_at TEXT DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS menu (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    category TEXT NOT NULL,
    price INTEGER NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 1
  )`,
  `CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    transaction_code TEXT NOT NULL,
    subtotal INTEGER NOT NULL,
    discount_percent REAL NOT NULL DEFAULT 0,
    discount_amount INTEGER NOT NULL DEFAULT 0,
    grand_total INTEGER NOT NULL,
    payment_method TEXT NOT NULL DEFAULT 'cash',
    cashier_username TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS transaction_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    transaction_id INTEGER NOT NULL,
    menu_id INTEGER,
    menu_name TEXT NOT NULL,
    price INTEGER NOT NULL,
    quantity INTEGER NOT NULL,
    line_total INTEGER NOT NULL,
    FOREIGN KEY (transaction_id) REFERENCES transactions(id)
  )`,
  `CREATE TABLE IF NOT EXISTS expenses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    description TEXT NOT NULL,
    category TEXT NOT NULL,
    amount INTEGER NOT NULL,
    expense_date TEXT NOT NULL,
    created_by TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS online_incomes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,
    amount INTEGER NOT NULL,
    income_date TEXT NOT NULL,
    created_by TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS petty_cash (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    amount INTEGER NOT NULL DEFAULT 0,
    note TEXT,
    updated_by TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`
];

// ============================================================
//  Init — picks the right backend
// ============================================================
async function initDb() {
  if (USE_TURSO) {
    console.log("🌐 Mode: Turso (cloud database)");
    initTurso();

    // Create tables (IF NOT EXISTS — safe to run multiple times)
    for (const sql of CREATE_TABLES_SQL) {
      await tursoClient.execute(sql);
    }

    // Seed user if empty
    const users = await tursoQuery("SELECT COUNT(*) AS cnt FROM users");
    if (users[0].cnt === 0) {
      const hash = bcrypt.hashSync("nyamanbanar", 10);
      await tursoRun(
        "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)",
        ["sotobanjar", hash, "admin"]
      );
    }

    // Seed menu if empty
    const menuCount = await tursoQuery("SELECT COUNT(*) AS cnt FROM menu");
    if (menuCount[0].cnt === 0) {
      for (const item of MENU_ITEMS) {
        await tursoRun(
          "INSERT INTO menu (name, category, price, is_active) VALUES (?, ?, ?, 1)",
          item
        );
      }
    }

    console.log("✅ Turso database ready.");
    return null;
  }

  // ---------- Local SQLite mode ----------
  console.log("💾 Mode: SQLite lokal (development)");
  const initSqlJs = require("sql.js");

  SQL = await initSqlJs({
    locateFile: (file) =>
      path.join(__dirname, "node_modules", "sql.js", "dist", file),
  });

  if (fs.existsSync(DB_FILE)) {
    const fileBuffer = fs.readFileSync(DB_FILE);
    db = new SQL.Database(fileBuffer);
    migrate();
  } else {
    db = new SQL.Database();

    // Create tables using semicolon-separated batch (sql.js supports this)
    db.run(CREATE_TABLES_SQL.join(";\n"));

    // Seed user
    const hash = bcrypt.hashSync("nyamanbanar", 10);
    db.run("INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)", [
      "sotobanjar",
      hash,
      "admin",
    ]);

    // Seed menu
    const stmt = db.prepare(
      "INSERT INTO menu (name, category, price, is_active) VALUES (?, ?, ?, 1)"
    );
    for (const item of MENU_ITEMS) {
      stmt.run(item);
    }
    stmt.free();

    persist();
  }

  return db;
}

// Ensures schema additions exist on older database files (local mode only)
function migrate() {
  if (USE_TURSO) return;

  const txCols = localQuery("PRAGMA table_info(transactions)");
  const hasPaymentMethod = txCols.some((c) => c.name === "payment_method");
  if (!hasPaymentMethod) {
    db.run(
      "ALTER TABLE transactions ADD COLUMN payment_method TEXT NOT NULL DEFAULT 'cash'"
    );
  }

  const expensesTable = localQuery(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='expenses'"
  );
  if (expensesTable.length === 0) {
    db.run(`
      CREATE TABLE expenses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        description TEXT NOT NULL,
        category TEXT NOT NULL,
        amount INTEGER NOT NULL,
        expense_date TEXT NOT NULL,
        created_by TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );
    `);
  }

  const onlineIncomesTable = localQuery(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='online_incomes'"
  );
  if (onlineIncomesTable.length === 0) {
    db.run(`
      CREATE TABLE online_incomes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT NOT NULL,
        amount INTEGER NOT NULL,
        income_date TEXT NOT NULL,
        created_by TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );
    `);
  }

  const pettyCashTable = localQuery(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='petty_cash'"
  );
  if (pettyCashTable.length === 0) {
    db.run(`
      CREATE TABLE petty_cash (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        amount INTEGER NOT NULL DEFAULT 0,
        note TEXT,
        updated_by TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );
    `);
  }

  persist();
}

// ============================================================
//  Unified exports — auto-switch between Turso and local
// ============================================================
function query(sql, params = []) {
  if (USE_TURSO) {
    return tursoQuery(sql, params);
  }
  return localQuery(sql, params);
}

function run(sql, params = []) {
  if (USE_TURSO) {
    return tursoRun(sql, params);
  }
  return localRun(sql, params);
}

module.exports = {
  initDb,
  query,
  run,
  persist,
  getDb: () => db,
  isTurso: () => USE_TURSO,
};

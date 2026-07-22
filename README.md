# Sistem Kasir (POS) - Soto Banjar "Nyaman" Antasari

Aplikasi Point of Sale berbasis web untuk restoran Soto Banjar "Nyaman" Antasari.

## Tech Stack

- **Backend**: Node.js, Express, sql.js (SQLite via WebAssembly), JWT, bcryptjs
- **Frontend**: HTML + Tailwind CSS (CDN) + Vanilla JavaScript
- **Database**: File SQLite (`data/pos.sqlite`), otomatis dibuat & di-seed saat pertama kali dijalankan

## Cara Menjalankan

1. Pastikan Node.js sudah terinstall (v18 ke atas disarankan).
2. Install dependencies:
   ```bash
   npm install
   ```
3. Jalankan server:
   ```bash
   npm start
   ```
4. Buka browser ke: **http://localhost:3000**

Database akan otomatis dibuat di `data/pos.sqlite` beserta data awal (seed) saat pertama kali server dijalankan. Jika ingin reset semua data (transaksi, menu, user) ke kondisi awal, hapus folder `data/` lalu jalankan ulang server.

## Akun Default

| Username    | Password      |
|-------------|---------------|
| sotobanjar  | nyamanbanar   |

## Struktur Halaman

- `/login.html` — Halaman login (gerbang utama, publik)
- `/dashboard.html` — Dashboard: pendapatan kotor/bersih hari ini, input pengeluaran harian, pendapatan minggu & bulan ini, breakdown metode pembayaran, menu terlaris, riwayat transaksi
- `/pos.html` — Halaman kasir: pilih menu (card), keranjang, input diskon (%), pilih metode pembayaran, checkout, cetak nota
- `/menu.html` — Manajemen menu (CRUD): tambah, lihat, ubah, hapus menu

Semua halaman internal (dashboard, pos, menu) dilindungi oleh token JWT yang disimpan di `localStorage`. Jika belum login atau sesi kedaluwarsa, pengguna otomatis diarahkan kembali ke halaman login.

## Alur Transaksi

1. Kasir login menggunakan akun default.
2. Di halaman POS, kasir klik menu yang dipesan → otomatis masuk ke keranjang di sisi kanan.
3. Kasir bisa mengatur jumlah (+/-) tiap item atau menghapusnya.
4. Jika ada promo, kasir memasukkan persentase diskon (0-100) — sistem otomatis menghitung Subtotal → Potongan → Grand Total secara real-time.
5. Kasir memilih metode pembayaran: **Cash**, **QRIS**, **Gojek** (GoFood/pesan-antar), atau **Lainnya**.
6. Klik "Selesaikan Pesanan" → transaksi tersimpan ke database dan otomatis muncul struk digital.
7. Struk bisa dicetak dengan tombol "Cetak Nota" (dioptimalkan untuk ukuran kertas thermal 280px / 58mm-80mm printer struk).
8. Semua metode pembayaran digabung ke **Pendapatan Kotor** hari itu di Dashboard.

## Pendapatan Kotor vs Pendapatan Bersih

- **Pendapatan Kotor Hari Ini** = total seluruh transaksi (semua metode pembayaran) pada hari berjalan.
- **Pengeluaran Hari Ini** = input manual di Dashboard untuk belanja bahan baku, gaji karyawan, operasional, atau lainnya.
- **Pendapatan Bersih Hari Ini** = Pendapatan Kotor − Pengeluaran Hari Ini.
- **Pendapatan Bersih (Akumulasi/Total)** = akumulasi pendapatan bersih dari seluruh hari sejak sistem digunakan (Total Pendapatan Kotor − Total Pengeluaran). Setiap hari, nilai bersihnya otomatis menambah ke akumulasi total ini — jadi pendapatan bersih hari ini akan terbawa dan terus terakumulasi untuk hari-hari berikutnya.
- Dashboard juga menampilkan **Pendapatan Kotor Minggu Ini** (sejak Senin) dan **Pendapatan Kotor Bulan Ini** (sejak tanggal 1).

## API Endpoints (ringkasan)

| Method | Endpoint              | Keterangan                          |
|--------|-----------------------|--------------------------------------|
| POST   | /api/login             | Login, mengembalikan JWT token       |
| GET    | /api/menu               | Daftar menu aktif                   |
| POST   | /api/menu               | Tambah menu baru                    |
| PUT    | /api/menu/:id           | Update menu                         |
| DELETE | /api/menu/:id           | Hapus menu (soft delete)            |
| POST   | /api/transactions       | Buat transaksi baru (checkout, wajib sertakan `payment_method`) |
| GET    | /api/transactions       | Riwayat transaksi (100 terbaru)     |
| GET    | /api/transactions/:id   | Detail satu transaksi + item        |
| GET    | /api/expenses           | Daftar pengeluaran (default: hari ini, atau `?date=YYYY-MM-DD`) |
| POST   | /api/expenses           | Tambah pengeluaran baru              |
| DELETE | /api/expenses/:id       | Hapus data pengeluaran               |
| GET    | /api/dashboard          | Ringkasan pendapatan kotor/bersih, mingguan, bulanan, & menu terlaris |

Semua endpoint kecuali `/api/login` memerlukan header `Authorization: Bearer <token>`.

`payment_method` yang valid: `cash`, `qris`, `gojek`, `other`.
`category` pengeluaran yang valid: `Belanja Harian`, `Gaji Karyawan`, `Operasional`, `Lainnya`.

## Catatan Teknis

- Harga & jumlah pengeluaran disimpan sebagai integer (Rupiah, tanpa desimal).
- Diskon dihitung: `Diskon = Subtotal x (persen / 100)`, `Grand Total = Subtotal - Diskon`.
- Menghapus menu tidak menghapus data secara permanen (soft delete via `is_active = 0`) agar riwayat transaksi lama tetap valid & bisa dilacak.
- Kode transaksi dibuat otomatis dengan format `TRX-<timestamp>`.
- Jika kamu sebelumnya sudah pernah menjalankan versi lama aplikasi ini (tanpa fitur pengeluaran/metode pembayaran), server akan otomatis menambahkan kolom & tabel yang dibutuhkan ke database yang sudah ada saat pertama kali dijalankan — data transaksi & menu lama tidak akan hilang.

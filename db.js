const mysql = require('mysql2/promise');

// Konfigurasi koneksi ke database XAMPP Anda
// User default XAMPP adalah 'root' dengan password kosong
const pool = mysql.createPool({
    host: 'localhost',
    user: 'root',
    password: '', // Kosongkan jika tidak ada password
    database: 'chatbot',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

console.log("📦 Koneksi ke database MySQL berhasil dibuat.");

module.exports = pool;
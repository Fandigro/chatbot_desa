document.addEventListener('DOMContentLoaded', () => {

    // Elemen untuk manajemen dokumen umum
    const uploadForm = document.getElementById('upload-form');
    const uploadStatus = document.getElementById('upload-status');
    const runIndexerBtn = document.getElementById('run-indexer-btn');
    const indexerStatus = document.getElementById('indexer-status');
    const fileListBody = document.getElementById('file-list-body');
    const refreshListBtn = document.getElementById('refresh-list-btn');
    const rebuildIndexerBtn = document.getElementById('rebuild-indexer-btn');
    const rebuildStatus = document.getElementById('rebuild-status');
    const cacheListCard = document.getElementById("cache-list-card");
    const viewCacheBtn = document.getElementById("view-cache-btn");
    const refreshCacheBtn = document.getElementById("refresh-cache-btn");
    const cacheListBody = document.getElementById("cache-list-body");

    // TAMBAHAN: Elemen untuk manajemen statistik
    const uploadStatistikForm = document.getElementById('upload-statistik-form');
    const statistikStatus = document.getElementById('statistik-status');

    // Fungsi untuk menampilkan pesan status
    function showMessage(element, message, type) {
        element.textContent = message;
        element.className = `status-message ${type}`; // 'success', 'error', 'info'
    }

    // Fungsi untuk mengambil dan menampilkan daftar file
    async function fetchFiles() {
        try {
            const response = await fetch('/documents');
            if (!response.ok) {
                throw new Error('Gagal mengambil data file.');
            }
            const files = await response.json();

            if (files.length === 0) {
                fileListBody.innerHTML = '<tr><td colspan="5" style="text-align:center;">Belum ada dokumen yang diupload.</td></tr>';
                return;
            }

            // Gunakan fungsi populateTable agar tombol hapus ikut ditambahkan
            populateTable(files);

        } catch (error) {
            console.error('Error fetching files:', error);
            fileListBody.innerHTML = `<tr><td colspan="5" style="text-align:center; color:red;">${error.message}</td></tr>`;
        }
    }

    async function fetchDocumentStats() {
        try {
            const res = await fetch('/documents/stats');
            const data = await res.json();
            if (!data.success) throw new Error(data.message);

            document.getElementById("total-docs").textContent = data.total;
            document.getElementById("indexed-docs").textContent = data.indexed;
            document.getElementById("pending-docs").textContent = data.pending;
            document.getElementById("failed-docs").textContent = data.failed;
            document.getElementById("last-indexed-time").textContent = data.last_index
                ? new Date(data.last_index).toLocaleString("id-ID", {
                    dateStyle: "medium",
                    timeStyle: "short"
                })
                : "Belum Pernah";
        } catch (err) {
            console.error('Gagal memuat statistik dokumen:', err);
        }
    }

    viewCacheBtn.addEventListener("click", async () => {
        if (cacheListCard.style.display === "none") {
            cacheListCard.style.display = "block";
            await loadCacheList();
        } else {
            cacheListCard.style.display = "none";
        }
    });

    // Refresh cache
    refreshCacheBtn.addEventListener("click", loadCacheList);

    // Bersihkan cache
    document.getElementById("clear-cache-btn").addEventListener("click", async () => {
        if (!confirm("Yakin ingin menghapus semua cache?")) return;
        await fetch("/cache/clear", { method: "DELETE" });
        alert("Cache berhasil dibersihkan.");
        if (cacheListCard.style.display === "block") loadCacheList();
    });

    // Fungsi untuk memuat data cache
    async function loadCacheList() {
        cacheListBody.innerHTML = "<tr><td colspan='6'>Memuat data cache...</td></tr>";
        try {
            const res = await fetch("/cache/list");
            const data = await res.json();

            if (!data.length) {
                cacheListBody.innerHTML = "<tr><td colspan='6'>Tidak ada cache tersimpan.</td></tr>";
                return;
            }

            cacheListBody.innerHTML = data.map((c, i) => `
                <tr>
                    <td>${i + 1}</td>
                    <td>${c.question.length > 60 ? c.question.slice(0, 60) + "..." : c.question}</td>
                    <td>${c.source || "-"}</td>
                    <td>${c.usage_count || 1}</td>
                    <td>${c.last_accessed ? new Date(c.last_accessed).toLocaleString() : "-"}</td>
                    <td><button class="delete-cache-btn" data-id="${c.id}"><i class="fas fa-trash"></i></button></td>
                </tr>
            `).join("");

            document.querySelectorAll(".delete-cache-btn").forEach(btn => {
                btn.addEventListener("click", async () => {
                    if (!confirm("Hapus cache ini?")) return;
                    const id = btn.dataset.id;
                    await fetch(`/cache/delete/${id}`, { method: "DELETE" });
                    loadCacheList();
                });
            });

        } catch (err) {
            console.error("Gagal memuat cache:", err);
            cacheListBody.innerHTML = "<tr><td colspan='6'>Gagal memuat data cache.</td></tr>";
        }
    }

    // Event listener untuk form upload DOKUMEN UMUM
    uploadForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const formData = new FormData(uploadForm);

        showMessage(uploadStatus, 'Mengupload...', 'info');

        try {
            const response = await fetch('/upload', {
                method: 'POST',
                body: formData
            });

            const result = await response.json();

            if (response.ok && result.success) {
                showMessage(uploadStatus, result.message, 'success');
                uploadForm.reset(); // Kosongkan form setelah berhasil
                fetchFiles(); // Refresh daftar file
            } else {
                throw new Error(result.message || 'Upload gagal.');
            }
        } catch (error) {
            showMessage(uploadStatus, error.message, 'error');
        }
    });

    // Event listener untuk tombol indexing
    runIndexerBtn.addEventListener('click', async () => {
        showMessage(indexerStatus, 'Memulai proses indexing di background...', 'info');
        try {
            const response = await fetch('/run-incremental-indexer', { method: 'POST' });
            const result = await response.json();
            if (result.success) {
                showMessage(indexerStatus, 'Permintaan indexing berhasil dikirim. Proses berjalan di background, refresh daftar file dalam beberapa saat untuk melihat perubahan status.', 'success');
            } else {
                throw new Error(result.message || 'Gagal memulai indexing.');
            }
        } catch (error) {
            showMessage(indexerStatus, error.message, 'error');
        }
    });

    rebuildIndexerBtn.addEventListener('click', async () => {
        // Pesan awal untuk admin
        showMessage(rebuildStatus, '📂 Memulai proses indexing penuh. Mohon tunggu...', 'info');
        document.getElementById("progress-container").style.display = "block";
        document.getElementById("progressBar").value = 0;
        document.getElementById("progressText").innerText = "Menyiapkan proses... (0%)";

        // Minta server mulai indexing
        const res = await fetch('/run-indexer', { method: 'POST' });
        const result = await res.json();
        if (!result.success) {
            showMessage(rebuildStatus, result.message, 'error');
            return;
        }

        // Mulai polling progress
        const intervalId = setInterval(async () => {
            try {
                const progressRes = await fetch('/index-progress');
                const progressData = await progressRes.json();

                const percent = progressData.total > 0
                    ? Math.round((progressData.done / progressData.total) * 100)
                    : 0;

                // Update progress
                document.getElementById("progressBar").value = progressData.percent;
                document.getElementById("progressText").innerText =
                    `${progressData.message} (${progressData.percent}%)`;

                // Kalau proses selesai
                if (!progressData.running) {
                    clearInterval(intervalId);
                    document.getElementById("progressBar").value = 100;
                    document.getElementById("progressText").innerText =
                        `✅ Indexing selesai! Semua dokumen siap digunakan AI. (100%)`;
                    showMessage(rebuildStatus, 'Indexing selesai! Semua dokumen siap digunakan AI.', 'success');
                }
            } catch (err) {
                clearInterval(intervalId);
                showMessage(rebuildStatus, '❌ Gagal mengambil progres indexing.', 'error');
            }
        }, 1000);
    });

    // Event listener untuk tombol refresh
    refreshListBtn.addEventListener('click', fetchFiles);

    // --- EVENT LISTENER BARU UNTUK UPLOAD STATISTIK ---
    uploadStatistikForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const formData = new FormData(uploadStatistikForm);

        showMessage(statistikStatus, 'Mengupload file statistik...', 'info');

        try {
            const response = await fetch('/upload-statistik', {
                method: 'POST',
                body: formData
            });

            const result = await response.json();

            if (response.ok && result.success) {
                showMessage(statistikStatus, result.message, 'success');
                uploadStatistikForm.reset();
            } else {
                throw new Error(result.message || 'Upload file statistik gagal.');
            }
        } catch (error) {
            showMessage(statistikStatus, error.message, 'error');
        }
    });

    // admin_script.js (dalam fungsi refreshList misalnya)
    function populateTable(documents) {
        const tbody = document.getElementById("file-list-body");
        tbody.innerHTML = "";
        documents.forEach((doc, index) => {
            const uploadDate = doc.upload_timestamp
                ? new Date(doc.upload_timestamp).toLocaleString("id-ID", {
                    dateStyle: "medium",
                    timeStyle: "short",
                })
                : "Tidak tersedia";

            const indexedDate = doc.last_indexed_timestamp
                ? new Date(doc.last_indexed_timestamp).toLocaleString("id-ID", {
                    dateStyle: "medium",
                    timeStyle: "short",
                })
                : "—";

            const row = document.createElement("tr");
            row.innerHTML = `
                <td>${index + 1}</td>
                <td>${doc.original_name || "Tidak diketahui"}</td>
                <td>${doc.status || "Belum Diproses"}</td>
                <td>${uploadDate}</td>
                <td>${indexedDate}</td> <!-- Kolom baru -->
                <td><button class="download-doc-btn" data-id="${doc.id}">Download</button></td>
                <td><button class="delete-btn" data-id="${doc.id}">Hapus</button></td>
            `;
            tbody.appendChild(row);
        });

        // Tombol hapus
        document.querySelectorAll(".delete-btn").forEach(btn => {
            btn.addEventListener("click", function () {
                const docId = this.getAttribute("data-id");
                if (confirm("Yakin ingin menghapus dokumen ini?")) {
                    deleteDocument(docId);
                }
            });
        });

        document.querySelectorAll(".download-btn").forEach(btn => {
            btn.addEventListener("click", function () {
                const docId = this.getAttribute("data-id");
                if (!docId) return alert("ID dokumen tidak ditemukan.");

                // buka tab baru untuk mendownload
                window.open(`/download/${docId}`, "_blank");
            });
        });
    }

    function deleteDocument(docId) {
        fetch(`/delete-document/${docId}`, { method: "DELETE" })
            .then(response => response.json())
            .then(result => {
                alert(result.message);
                document.getElementById("refresh-list-btn").click(); // Refresh daftar
            })
            .catch(error => {
                alert("Gagal menghapus dokumen.");
                console.error(error);
            });
    }
    function fetchTotalSize() {
        fetch("/documents/size")
            .then(res => res.json())
            .then(data => {
                const totalMB = (data.totalBytes / (1024 * 1024)).toFixed(2);
                const percent = (data.totalBytes / (1024 * 1024 * 1024) * 100).toFixed(1); // bandingkan dengan 1GB

                const label = `${totalMB} MB dari 1024 MB (${percent}%)`;
                document.getElementById("total-size").textContent = label;

                // Optional: warning kalau di atas 90%
                if (percent >= 90) {
                    document.getElementById("total-size").style.color = "red";
                    document.getElementById("total-size").style.fontWeight = "bold";
                }
            })
            .catch(err => {
                document.getElementById("total-size").textContent = "Gagal memuat.";
            });
    }

    // Muat daftar file saat halaman pertama kali dibuka
    fetchFiles();
    fetchDocumentStats();
    fetchTotalSize();
    fetchStorageStatsAndUpdateChart();

    // ----------------- TAMBAHAN: TOGGLE CHATBOT -----------------
    window.toggleChatbot = async function () {
        try {
            const res = await fetch("/chatbot/toggle", { method: "POST" });
            const data = await res.json();

            const status = document.getElementById("statusChatbot");
            const chatUI = document.getElementById("chatUI");

            if (data.active) {
                status.textContent = "Chatbot Aktif ✅";
                status.classList.remove("nonaktif");
                status.classList.add("aktif");
                chatUI.style.display = "block";
            } else {
                status.textContent = "Chatbot Nonaktif ❌";
                status.classList.remove("aktif");
                status.classList.add("nonaktif");
                chatUI.style.display = "none";
            }
        } catch (err) {
            console.error("Gagal update status chatbot", err);
        }
    };
});
document.addEventListener('DOMContentLoaded', function () {
    const chat = document.getElementById("chat");
    const input = document.getElementById("input");
    const chatbot = document.getElementById("chatbot-container");
    const toggleBtn = document.getElementById("chat-toggle");
    const closeBtn = document.querySelector("#chatbot-container .close-btn");
    const chatForm = document.getElementById("chat-form");

    let sessionId = localStorage.getItem("sessionId") || null;

    function toggleChat() {
        const isMobile = window.innerWidth <= 600;
        const isOpen = chatbot.style.display === "flex";

        chatbot.style.display = isOpen ? "none" : "flex";

        if (isMobile) {
            toggleBtn.style.display = isOpen ? "flex" : "none";
        }
    }

    toggleBtn.addEventListener("click", toggleChat);
    closeBtn.addEventListener("click", toggleChat);

    function addMessage(text, sender) {
        const div = document.createElement("div");
        div.className = `bubble ${sender}`;
        // Gunakan marked.parse jika pengirim adalah 'ai', jika tidak, tampilkan sebagai teks biasa
        div.innerHTML = sender === "ai" ? marked.parse(text) : text.replace(/</g, "&lt;").replace(/>/g, "&gt;");
        chat.appendChild(div);
        chat.scrollTop = chat.scrollHeight;
    }

    let chatbotAktif = localStorage.getItem("chatbotAktif") !== "false"; // default aktif

    async function cekStatusChatbot() {
        try {
            const res = await fetch("/chatbot/status");
            const data = await res.json();
    
            chatbotAktif = data.active; // <-- sinkronkan status
    
            const toggleBtn = document.getElementById("chat-toggle");
            const chatbot = document.getElementById("chatbot-container");
    
            if (!data.active) {
                toggleBtn.style.display = "none";
                chatbot.style.display = "none";
            } else {
                toggleBtn.style.display = "flex";
            }
        } catch (err) {
            console.error("Gagal cek status chatbot", err);
        }
    }
    

    // Panggil saat halaman load

    async function send() {
        const msg = input.value.trim();
        if (!msg) return;

        // kalau nonaktif, jangan kirim ke backend
        if (!chatbotAktif) {
            addMessage("Chatbot sedang nonaktif.", "ai");
            input.value = "";
            return;
        }

        addMessage(msg, "user");
        input.value = "";

        // Tambahkan bubble loading
        const loadingBubble = document.createElement("div");
        loadingBubble.className = "bubble ai";
        loadingBubble.innerHTML = "Mengetik...";
        chat.appendChild(loadingBubble);
        chat.scrollTop = chat.scrollHeight;

        try {
            const res = await fetch("/ask", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ question: msg, sessionId })
            });

            if (!res.ok) {
                throw new Error("Gagal mendapatkan respon dari server.");
            }

            const data = await res.json();
            sessionId = data.sessionId;
            localStorage.setItem("sessionId", sessionId);

            // Hapus bubble loading dan ganti dengan jawaban asli
            chat.removeChild(loadingBubble);
            addMessage(data.answer, "ai");

        } catch (error) {
            console.error(error);
            // Hapus bubble loading dan ganti dengan pesan error
            chat.removeChild(loadingBubble);
            addMessage("Maaf, terjadi kesalahan. Silakan coba lagi.", "ai");
        }
    }

    chatForm.addEventListener("submit", function (event) {
        event.preventDefault();
        send();
    });

    cekStatusChatbot();
});
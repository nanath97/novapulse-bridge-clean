require("dotenv").config();
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const axios = require("axios");
const Airtable = require("airtable");

console.log("🔥 NOVAPULSE BRIDGE STABLE BOOT");

// =======================
// EXPRESS INIT
// =======================
const app = express();
const server = http.createServer(app);

app.use(cors());
app.use(express.json());

const io = new Server(server, {
  cors: { origin: "*" },
});

app.get("/", (req, res) => res.send("NovaPulse Bridge OK 🚀"));

// =======================
// AIRTABLE
// =======================
const base = new Airtable({
  apiKey: process.env.AIRTABLE_API_KEY,
}).base(process.env.AIRTABLE_BASE_ID);

const tablePWA = base(process.env.AIRTABLE_TABLE_PWA);

// =======================
// CONFIG TELEGRAM
// =======================
const BOT_API_URL = process.env.BOT_API_URL; // https://api.telegram.org/botXXXX
const STAFF_GROUP_ID = process.env.STAFF_GROUP_ID;

// =======================
// HELPERS
// =======================
function normEmail(email) {
  return String(email || "").trim().toLowerCase();
}
function normSlug(slug) {
  return String(slug || "").trim().toLowerCase();
}
function pwaRoom(email, sellerSlug) {
  return `pwa:${normSlug(sellerSlug)}:${normEmail(email)}`;
}

// ==================================================
// SOCKET.IO CONNECTION
// ==================================================
io.on("connection", (socket) => {
  console.log("🔌 PWA connected:", socket.id);

  socket.on("init", ({ email, sellerSlug }) => {
    const e = normEmail(email);
    const s = normSlug(sellerSlug);

    socket.data.email = e;
    socket.data.sellerSlug = s;

    const room = pwaRoom(e, s);
    socket.join(room);

    console.log("✅ INIT:", e, s, "→", room);
  });

  socket.on("disconnect", () => {
    console.log("❌ PWA disconnected:", socket.id);
  });
});

// ==================================================
// PWA → TELEGRAM (ROUTE CRITIQUE)
// ==================================================
app.post("/telegram/send", async (req, res) => {
  try {
    const { email, sellerSlug, text } = req.body;

    if (!email || !sellerSlug || !text) {
      return res.status(400).json({ error: "Missing fields" });
    }

    const e = normEmail(email);
    const s = normSlug(sellerSlug);

    console.log("📨 PWA → TELEGRAM:", e, s, text);

    const records = await tablePWA
      .select({
        filterByFormula: `AND({email}='${e}', {seller_slug}='${s}')`,
      })
      .firstPage();

    if (!records.length) {
      console.log("❌ No Airtable topic match");
      return res.status(404).json({ error: "Client not found" });
    }

    const topicId = records[0].fields.topic_id;

    await axios.post(`${BOT_API_URL}/sendMessage`, {
      chat_id: STAFF_GROUP_ID,
      text: `💬 Client:\n${text}`,
      message_thread_id: topicId,
    });

    console.log("📩 Sent to Telegram topic:", topicId);

    return res.json({ ok: true });

  } catch (err) {
    console.error("❌ /telegram/send error:", err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ==================================================
// TELEGRAM → PWA (ADMIN REPLY)
// ==================================================
app.post("/webhook", (req, res) => {
  try {
    const { email, sellerSlug, text } = req.body;

    const room = pwaRoom(email, sellerSlug);

    io.to(room).emit("admin_message", {
      text,
      from: "admin",
    });

    console.log("📤 Admin → PWA:", room, text);

    res.json({ ok: true });
  } catch (err) {
    console.error("Webhook error:", err.message);
    res.status(500).json({ ok: false });
  }
});

// =======================
// START SERVER
// =======================
const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`🚀 Bridge running on port ${PORT}`);
});

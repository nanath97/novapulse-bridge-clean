require("dotenv").config();
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const axios = require("axios");
const Airtable = require("airtable");

console.log("🔥 NOVAPULSE BRIDGE STABLE");

const app = express();
const server = http.createServer(app);

app.use(cors());
app.use(express.json());

const io = new Server(server, {
  cors: { origin: "*" },
});

app.get("/", (req, res) => res.send("Bridge OK"));

// =======================
// AIRTABLE
// =======================
const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY })
  .base(process.env.AIRTABLE_BASE_ID);

const tablePWA = base(process.env.AIRTABLE_TABLE_PWA);

// =======================
// CONFIG TELEGRAM
// =======================
const STAFF_GROUP_ID = process.env.STAFF_GROUP_ID;
const BOT_API_URL = process.env.BOT_API_URL;

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

    console.log("✅ INIT:", e, s, "room=", room);
  });

  socket.on("disconnect", () => {
    console.log("❌ PWA disconnected:", socket.id);
  });
});

// ==================================================
// CLIENT → TELEGRAM (PWA -> ADMIN)
// ==================================================
app.post("/telegram/send", async (req, res) => {
  try {
    const { email, sellerSlug, text } = req.body;

    const e = normEmail(email);
    const s = normSlug(sellerSlug);

    const records = await tablePWA.select({
      filterByFormula: `AND({email}='${e}', {seller_slug}='${s}')`,
    }).firstPage();

    if (!records.length) {
      return res.status(404).json({ ok: false, error: "Topic not found" });
    }

    const topicId = records[0].fields.topic_id;

    await axios.post(`${BOT_API_URL}/sendMessage`, {
      chat_id: STAFF_GROUP_ID,
      text: `💬 Client:\n${text}`,
      message_thread_id: topicId,
    });

    console.log("📩 Client → Telegram topic:", topicId);

    res.json({ ok: true });
  } catch (err) {
    console.error("❌ Client→Telegram:", err.message);
    res.status(500).json({ ok: false });
  }
});

// ==================================================
// TELEGRAM → PWA (ADMIN -> CLIENT)
// ==================================================
app.post("/webhook", async (req, res) => {
  const update = req.body;
  if (!update.message) return res.sendStatus(200);

  const message = update.message;

  try {
    if (
      message.chat?.type === "supergroup" &&
      message.message_thread_id &&
      !message.from?.is_bot &&
      message.text
    ) {
      const threadId = String(message.message_thread_id);

      const records = await tablePWA.select({
        filterByFormula: `{topic_id} = "${threadId}"`,
      }).firstPage();

      if (!records.length) return res.sendStatus(200);

      const row = records[0].fields;
      const email = normEmail(row.email);
      const sellerSlug = normSlug(row.seller_slug);
      const room = pwaRoom(email, sellerSlug);

      io.to(room).emit("admin_message", {
        text: message.text,
        from: "admin",
      });

      console.log("📤 Admin → PWA:", room, message.text);
    }
  } catch (err) {
    console.error("❌ Webhook error:", err.message);
  }

  res.sendStatus(200);
});

// =======================
// START SERVER
// =======================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Bridge running on port ${PORT}`);
});

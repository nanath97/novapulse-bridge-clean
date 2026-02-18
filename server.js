require("dotenv").config();
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const axios = require("axios");
const Airtable = require("airtable");
const multer = require("multer");
const { v2: cloudinary } = require("cloudinary");

console.log("🔥 SERVER.JS FULL BRIDGE LOADED");

// =======================
// CONFIG CLOUDINARY
// =======================
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const upload = multer({ dest: "uploads/" });

// =======================
// EXPRESS INIT
// =======================
const app = express();
const server = http.createServer(app);

app.use(cors());
app.use(express.json());

const io = new Server(server, { cors: { origin: "*" } });

app.get("/", (req, res) => res.send("NovaPulse Bridge running 🚀"));

// =======================
// Airtable
// =======================
const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY })
  .base(process.env.AIRTABLE_BASE_ID);

const tablePWA = base(process.env.AIRTABLE_TABLE_PWA);
const tableMessages = base(process.env.AIRTABLE_TABLE_PWA_MESSAGES);

// =======================
// CONFIG BOT
// =======================
const BOT_TOKEN = process.env.BRIDGE_BOT_TOKEN;
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
// 📸 UPLOAD MEDIA
// ==================================================
app.post("/upload-media", upload.single("file"), async (req, res) => {
  try {
    const { sellerSlug, clientEmail, amount } = req.body;

    if (!req.file) {
      return res.status(400).json({ success: false, error: "No file uploaded" });
    }

    const result = await cloudinary.uploader.upload(req.file.path, {
      resource_type: "auto",
      folder: `novapulse/${sellerSlug}/${clientEmail}`,
    });

    return res.json({
      success: true,
      mediaUrl: result.secure_url,
      publicId: result.public_id,
      amount,
      sellerSlug,
      clientEmail,
    });

  } catch (err) {
    console.error("UPLOAD ERROR:", err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ==================================================
// 📤 SEND PAID CONTENT TO PWA
// ==================================================
app.post("/pwa/send-paid-content", async (req, res) => {
  try {
    const { email, sellerSlug, text, checkout_url, isMedia, amount, mediaUrl } = req.body;

    const e = normEmail(email);
    const s = normSlug(sellerSlug);
    const room = pwaRoom(e, s);

    io.to(room).emit("paid_content", {
      text,
      checkout_url,
      isMedia: !!isMedia,
      mediaUrl: mediaUrl || null,
      amount: amount || null,
      from: "system",
    });

    console.log("💸 Paid content sent to PWA:", room);

    return res.json({ ok: true });

  } catch (err) {
    console.error("❌ /pwa/send-paid-content error:", err.message);
    return res.status(500).json({ ok: false });
  }
});

// ==================================================
// 🧠 SOCKET.IO (CLIENT ⇄ ADMIN)
// ==================================================
io.on("connection", (socket) => {
  console.log("PWA socket connected:", socket.id);

  socket.on("init", ({ email, sellerSlug }) => {
    const e = normEmail(email);
    const s = normSlug(sellerSlug);

    socket.data.email = e;
    socket.data.sellerSlug = s;

    const room = pwaRoom(e, s);
    socket.join(room);

    console.log("✅ INIT received:", e, s, "room=", room);
  });

  // 🔥 CLIENT → ADMIN TELEGRAM
  socket.on("client_message", async ({ text }) => {
    try {
      const email = socket.data.email;
      const sellerSlug = socket.data.sellerSlug;

      if (!email || !sellerSlug || !text) return;

      const records = await tablePWA.select({
        filterByFormula: `AND({email}='${email}', {seller_slug}='${sellerSlug}')`
      }).firstPage();

      if (!records.length) {
        console.log("❌ No Airtable topic match for client message");
        return;
      }

      const topicId = records[0].fields.topic_id;

      await axios.post(`${BOT_API_URL}/sendMessage`, {
        chat_id: STAFF_GROUP_ID,
        text: `💬 Client:\n${text}`,
        message_thread_id: topicId,
      });

      console.log("📩 Client message sent to Telegram topic:", topicId);

    } catch (err) {
      console.error("PWA → Telegram error:", err.message);
    }
  });

  socket.on("disconnect", () => {
    console.log("PWA socket disconnected:", socket.id);
  });
});

// =======================
// START SERVER
// =======================
const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`Bridge running on port ${PORT}`);
});

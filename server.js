require("dotenv").config();
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const axios = require("axios");
const Airtable = require("airtable");

// =======================
// ENV (IMPORTANT)
// =======================
// ✅ Ton token doit être dans Render sous: BOT_TOKEN
// (fallback si tu veux)
const TELEGRAM_BOT_TOKEN =
  process.env.BOT_TOKEN ||
  process.env.BRIDGE_BOT_TOKEN ||
  process.env.BRIDGE_TELEGRAM_TOKEN;

const STAFF_GROUP_ID = process.env.STAFF_GROUP_ID; // ex: -1003418175247
const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
const AIRTABLE_TABLE_PWA = process.env.AIRTABLE_TABLE_PWA;
const AIRTABLE_TABLE_PWA_MESSAGES = process.env.AIRTABLE_TABLE_PWA_MESSAGES;

console.log("🔥 SERVER.JS BRIDGE LOADED");




const multer = require("multer");
const cloudinary = require("cloudinary").v2;
const streamifier = require("streamifier");

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const upload = multer({ storage: multer.memoryStorage() });





// =======================
// HARD FAIL IF MISSING
// =======================
function assertEnv() {
  const missing = [];
  if (!TELEGRAM_BOT_TOKEN) missing.push("BOT_TOKEN (or BRIDGE_BOT_TOKEN)");
  if (!STAFF_GROUP_ID) missing.push("STAFF_GROUP_ID");
  if (!AIRTABLE_API_KEY) missing.push("AIRTABLE_API_KEY");
  if (!AIRTABLE_BASE_ID) missing.push("AIRTABLE_BASE_ID");
  if (!AIRTABLE_TABLE_PWA) missing.push("AIRTABLE_TABLE_PWA");
  if (!AIRTABLE_TABLE_PWA_MESSAGES) missing.push("AIRTABLE_TABLE_PWA_MESSAGES");

  if (missing.length) {
    console.error("❌ Missing ENV:", missing.join(", "));
  } else {
    console.log("✅ ENV OK");
  }
}
assertEnv();

// =======================
// EXPRESS / SOCKET
// =======================
const app = express();
const server = http.createServer(app);

app.use(cors({ origin: "*", methods: ["GET", "POST", "OPTIONS"] }));
app.use(express.json({ limit: "2mb" }));

const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});

// =======================
// Airtable
// =======================
const base = new Airtable({ apiKey: AIRTABLE_API_KEY }).base(AIRTABLE_BASE_ID);
const tablePWA = base(AIRTABLE_TABLE_PWA);
const tableMessages = base(AIRTABLE_TABLE_PWA_MESSAGES);

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

async function tgSendMessage({ text, message_thread_id }) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;

  return axios.post(url, {
    chat_id: STAFF_GROUP_ID,
    text,
    message_thread_id,
  });
}

async function findTopicIdByEmailSlug(email, sellerSlug) {
  const e = normEmail(email);
  const s = normSlug(sellerSlug);

  // ⚠️ topic_id est un champ texte chez toi => on compare avec des quotes
  const records = await tablePWA
    .select({
      filterByFormula: `AND({email}='${e}', {seller_slug}='${s}')`,
      maxRecords: 1,
    })
    .firstPage();

  if (!records.length) return null;
  const topicId = records[0].fields.topic_id;
  return topicId ? String(topicId).trim() : null;
}

// =======================
// ROUTES BASIC
// =======================
app.get("/", (req, res) => res.status(200).send("NovaPulse Bridge running 🚀"));
app.get("/health", (req, res) => res.json({ ok: true }));

// =======================
// TELEGRAM → PWA (admin -> client)
// Telegram webhook points here
// =======================
app.post("/webhook", async (req, res) => {
  const update = req.body;
  if (!update || !update.message) return res.sendStatus(200);

  const message = update.message;

  try {
    // Only staff supergroup topic messages
    if (
      message.chat?.type === "supergroup" &&
      message.message_thread_id &&
      !message.from?.is_bot
    ) {
      // ignore /env commands
      const text = message.text?.trim() || "";
      if (text.toLowerCase().startsWith("/env")) return res.sendStatus(200);

      const threadId = String(message.message_thread_id).trim();

      // find client by topic_id
      const records = await tablePWA
        .select({
          filterByFormula: `{topic_id}='${threadId}'`,
          maxRecords: 1,
        })
        .firstPage();

      if (!records.length) return res.sendStatus(200);

      const row = records[0].fields;
      const email = normEmail(row.email);
      const sellerSlug = normSlug(row.seller_slug);
      const room = pwaRoom(email, sellerSlug);

      if (text) {
        await tableMessages.create({
          email,
          seller_slug: sellerSlug,
          topic_id: threadId,
          sender: "admin",
          text,
        });

        io.to(room).emit("admin_message", {
          text,
          from: "admin",
        });

        console.log("📤 Admin → PWA:", room, text);
      }
    }
  } catch (err) {
    console.error("❌ /webhook error:", err.response?.data || err.message);
  }

  return res.sendStatus(200);
});

// =======================
// SOCKET.IO (PWA ⇄ TELEGRAM)
// =======================
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

  // ✅ PWA → TELEGRAM (client -> staff topic) : VIA BRIDGE BOT TOKEN
  socket.on("client_message", async ({ text }) => {
    try {
      const email = socket.data.email;
      const sellerSlug = socket.data.sellerSlug;
      const cleanText = String(text || "").trim();

      if (!email || !sellerSlug || !cleanText) return;

      if (!TELEGRAM_BOT_TOKEN) {
        console.error("❌ PWA → Telegram error: BOT_TOKEN missing in ENV");
        return;
      }

      const topicId = await findTopicIdByEmailSlug(email, sellerSlug);
      if (!topicId) {
        console.error("❌ No Airtable topic for", email, sellerSlug);
        return;
      }

      await tableMessages.create({
        email,
        seller_slug: sellerSlug,
        topic_id: topicId,
        sender: "client",
        text: cleanText,
      });

      await tgSendMessage({
        message_thread_id: Number(topicId), // Telegram expects int
        text: `💬 Client (${email})\n${cleanText}`,
      });

      console.log("📩 PWA → Telegram OK topic:", topicId);
    } catch (err) {
      console.error("❌ PWA → Telegram error:", err.response?.data || err.message);
    }
  });

  socket.on("disconnect", () => {
    console.log("❌ PWA disconnected:", socket.id);
  });
});

// =======================
// UPLOAD MEDIA → CLOUDINARY
// =======================
app.post("/upload-media", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: "No file uploaded" });
    }

    console.log("📤 Uploading media to Cloudinary...");

    const uploadStream = cloudinary.uploader.upload_stream(
      { folder: "novapulse_media" },
      (error, result) => {
        if (error) {
          console.error("❌ Cloudinary error:", error);
          return res.status(500).json({ success: false, error: "Cloudinary upload failed" });
        }

        console.log("✅ Media uploaded:", result.secure_url);

        return res.json({
          success: true,
          mediaUrl: result.secure_url,
        });
      }
    );

    streamifier.createReadStream(req.file.buffer).pipe(uploadStream);
  } catch (err) {
    console.error("❌ /upload-media error:", err.message);
    return res.status(500).json({ success: false, error: "Upload failed" });
  }
});


// =======================
// START
// =======================
const PORT = process.env.PORT || 10000;

server.listen(PORT, () => {
  console.log(`🚀 Bridge running on port ${PORT}`);
});

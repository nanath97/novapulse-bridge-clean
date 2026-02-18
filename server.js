require("dotenv").config();
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const axios = require("axios");
const Airtable = require("airtable");

console.log("🔥 SERVER.JS FULL BRIDGE LOADED");




const multer = require("multer");
const { v2: cloudinary } = require("cloudinary");

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const upload = multer({ dest: "uploads/" });

// =======================
// Airtable
// =======================
const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY })
  .base(process.env.AIRTABLE_BASE_ID);

const tablePWA = base(process.env.AIRTABLE_TABLE_PWA); // PWA Clients
const tableMessages = base(process.env.AIRTABLE_TABLE_PWA_MESSAGES); // PWA Messages

// =======================
// Config
// =======================
const BOT_TOKEN = process.env.BRIDGE_BOT_TOKEN;
const STAFF_GROUP_ID = process.env.STAFF_GROUP_ID;
const BOT_API_URL = process.env.BOT_API_URL; // ex: https://mini-jessie-bot.onrender.com

const app = express();
const server = http.createServer(app);

app.use(cors());
app.use(express.json());

const io = new Server(server, { cors: { origin: "*" } });

app.get("/", (req, res) => res.send("NovaPulse Bridge running 🚀"));

// =======================
// Helpers
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



// =======================
// 📸 UPLOAD MEDIA (BOT -> BRIDGE -> CLOUDINARY)
// =======================
app.post("/pwa/upload-media", upload.single("file"), async (req, res) => {
  try {
    const { email, sellerSlug } = req.body;
    if (!req.file) {
      return res.status(400).json({ ok: false, error: "No file uploaded" });
    }

    const result = await cloudinary.uploader.upload(req.file.path, {
      resource_type: "auto",
      folder: "novapulse_paid_content",
    });

    const mediaUrl = result.secure_url;

    console.log("📸 Media uploaded:", mediaUrl);

    return res.json({
      ok: true,
      mediaUrl,
    });
  } catch (err) {
    console.error("❌ Upload media error:", err.message);
    return res.status(500).json({ ok: false, error: "upload failed" });
  }
});

// =======================
// 📤 SEND PAID CONTENT TO PWA (BOT -> BRIDGE -> PWA)
// =======================
app.post("/pwa/send-paid-content", async (req, res) => {
  try {
    const { email, sellerSlug, text, checkout_url, isMedia, amount } = req.body;

    if (!email || !sellerSlug || !checkout_url) {
      return res.status(400).json({ ok: false, error: "Missing email/sellerSlug/checkout_url" });
    }

    const e = normEmail(email);
    const s = normSlug(sellerSlug);
    const room = pwaRoom(e, s);

    // Sauvegarde historique (message "system/paid")
    await tableMessages.create({
      email: e,
      seller_slug: s,
      sender: "system",
      text: text || "💳 Paiement requis.",
    });

    io.to(room).emit("paid_content", {
      text: text || "💳 Paiement requis.",
      checkout_url,
      isMedia: !!isMedia,
      mediaUrl: req.body.mediaUrl || null,
      amount: amount || null,
      from: "system",
    });

    console.log("💸 Paid content sent to PWA:", room);

    return res.json({ ok: true });
  } catch (err) {
    console.error("❌ /pwa/send-paid-content error:", err.response?.data || err.message);
    return res.status(500).json({ ok: false, error: "failed" });
  }
});

// =======================
// SOCKET.IO (CLIENT PWA)
// =======================
io.on("connection", (socket) => {
  console.log("PWA socket connected:", socket.id);

  socket.on("init", ({ email, sellerSlug }) => {
    const e = normEmail(email);
    const s = normSlug(sellerSlug);

    if (!e || !s) {
      console.log("❌ init missing email/sellerSlug");
      return;
    }

    socket.data.email = e;
    socket.data.sellerSlug = s;

    const room = pwaRoom(e, s);
    socket.join(room);

    console.log("✅ INIT received:", e, s, "room=", room);
  });

  // =======================
  // 📚 HISTORY
  // =======================
  socket.on("load_history", async () => {
    try {
      const email = socket.data.email;
      const sellerSlug = socket.data.sellerSlug;
      if (!email || !sellerSlug) return;

      const records = await tableMessages.select({
        filterByFormula: `AND({email}="${email}", {seller_slug}="${sellerSlug}")`,
        sort: [{ field: "created_at", direction: "asc" }],
        maxRecords: 30,
      }).firstPage();

      const history = records.map((rec) => ({
        text: rec.fields.text,
        from: rec.fields.sender,
      }));

      socket.emit("history_messages", history);
      console.log("📚 History sent:", history.length);
    } catch (err) {
      console.error("❌ load_history error:", err.message);
    }
  });

  // =======================
  // 💬 MESSAGE CLIENT → TELEGRAM
  // =======================
  socket.on("client_message", async ({ text }) => {
    try {
      const email = socket.data.email;
      const sellerSlug = socket.data.sellerSlug;
      if (!email || !sellerSlug) return;

      const safeText = String(text || "").trim();
      if (!safeText) return;

      console.log("📩 PWA message:", email, sellerSlug, safeText);

      const records = await tablePWA.select({
        filterByFormula: `AND({email}="${email}", {seller_slug}="${sellerSlug}")`,
      }).firstPage();

      let topicId = records.length > 0 ? records[0].fields.topic_id : null;

      // create topic si absent
      if (!topicId) {
        const topicTitle = `[PWA] ${email} (${sellerSlug})`;
        const topicResponse = await axios.post(
          `https://api.telegram.org/bot${BOT_TOKEN}/createForumTopic`,
          { chat_id: STAFF_GROUP_ID, name: topicTitle }
        );

        topicId = topicResponse.data.result.message_thread_id;

        await tablePWA.create({
          email: email,
          seller_slug: sellerSlug,
          topic_id: topicId,
        });
      }

      await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        chat_id: STAFF_GROUP_ID,
        text: safeText,
        message_thread_id: topicId,
      });

      await tableMessages.create({
        email,
        seller_slug: sellerSlug,
        topic_id: String(topicId),
        sender: "client",
        text: safeText,
      });
    } catch (error) {
      console.error("❌ client_message error:", error.response?.data || error.message);
    }
  });

  // =======================
  // 💳 DEMANDE DE PAIEMENT (client-driven) - tu peux garder, mais modèle A ne l'utilise pas
  // =======================
  socket.on("client_payment", async ({ amount_cents }) => {
    try {
      const { email, sellerSlug } = socket.data;
      if (!email || !sellerSlug) return;

      console.log("💳 Payment request:", email, sellerSlug, amount_cents);

      const response = await axios.post(`${BOT_API_URL}/create-checkout`, {
        amount_cents,
        email,
        seller_slug: sellerSlug,
      });

      const { checkout_url } = response.data;
      if (!checkout_url) {
        return socket.emit("payment_error", { message: "Erreur création paiement" });
      }

      socket.emit("checkout_session", { url: checkout_url });
    } catch (err) {
      console.error("❌ Bridge → Bot error:", err.message);
      socket.emit("payment_error", { message: "Paiement impossible" });
    }
  });

  socket.on("disconnect", () => {
    console.log("PWA socket disconnected:", socket.id);
  });
});

// =======================
// TELEGRAM → PWA (admin messages normaux)
// =======================
app.post("/webhook", async (req, res) => {
  const update = req.body;
  if (!update.message) return res.sendStatus(200);

  const message = update.message;

  try {
    if (
      message.chat?.type === "supergroup" &&
      message.message_thread_id &&
      !message.from?.is_bot
    ) {
      // ne pas forward /envXX
      if (message.text && message.text.trim().toLowerCase().startsWith("/env")) {
        return res.sendStatus(200);
      }

      const threadId = String(message.message_thread_id);

      const records = await tablePWA.select({
        filterByFormula: `{topic_id} = "${threadId}"`,
      }).firstPage();

      if (records.length === 0) return res.sendStatus(200);

      const row = records[0].fields;
      const email = normEmail(row.email);
      const sellerSlug = normSlug(row.seller_slug);

      const room = pwaRoom(email, sellerSlug);

      if (message.text) {
        await tableMessages.create({
          email,
          seller_slug: sellerSlug,
          topic_id: threadId,
          sender: "admin",
          text: message.text,
        });

        io.to(room).emit("admin_message", {
          text: message.text,
          topicId: threadId,
          from: "admin",
        });

        console.log("Admin message pushed to:", room);
      }
    }
  } catch (error) {
    console.error("Webhook error:", error.response?.data || error.message);
  }

  res.sendStatus(200);
});

// =======================
// START SERVER
// =======================
const PORT = process.env.PORT || 3000;

async function testTelegram() {
  try {
    const response = await axios.get(`https://api.telegram.org/bot${BOT_TOKEN}/getMe`);
    console.log("Telegram connected:", response.data.result.username);
  } catch (error) {
    console.error("Telegram connection failed:", error.message);
  }
}

testTelegram();

server.listen(PORT, () => {
  console.log(`Bridge running on port ${PORT}`);
});

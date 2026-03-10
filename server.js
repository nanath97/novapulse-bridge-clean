require("dotenv").config();
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const axios = require("axios");
const Airtable = require("airtable");
const nodemailer = require("nodemailer");
const PDFDocument = require("pdfkit")
const fs = require("fs")
const webpush = require("web-push");

console.log("🔥 SERVER.JS BRIDGE LOADED");


// LOG RENDER//
// =======================
// ENV (IMPORTANT)
// =======================
const TELEGRAM_BOT_TOKEN =
  process.env.BOT_TOKEN ||
  process.env.BRIDGE_BOT_TOKEN ||
  process.env.BRIDGE_TELEGRAM_TOKEN;

const STAFF_GROUP_ID = process.env.STAFF_GROUP_ID; // ex: -1003418175247
const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
const AIRTABLE_TABLE_PWA = process.env.AIRTABLE_TABLE_PWA;
const AIRTABLE_TABLE_PWA_MESSAGES = process.env.AIRTABLE_TABLE_PWA_MESSAGES;
const SMTP_EMAIL = process.env.SMTP_EMAIL;
const SMTP_PASS = process.env.SMTP_PASS;

const mailTransporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: SMTP_EMAIL,
    pass: SMTP_PASS,
  },
});

const FormData = require("form-data");

const multer = require("multer");
const streamifier = require("streamifier");
const cloudinary = require("cloudinary").v2;
const path = require("path");



if (process.env.CLOUDINARY_URL) {
  cloudinary.config(process.env.CLOUDINARY_URL);
} else {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
  });
}

console.log("CLOUDINARY CONFIG CHECK:", {
  using_url: !!process.env.CLOUDINARY_URL,
  cloud_name: cloudinary.config().cloud_name,
  api_key_present: !!cloudinary.config().api_key,
  api_secret_present: !!cloudinary.config().api_secret,
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 20 * 1024 * 1024, // 20 MB
  },
});

// ============================
// PUSH CONFIGURATION
// ============================

webpush.setVapidDetails(
  process.env.VAPID_SUBJECT,
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

console.log("🔔 Web Push configuré");

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
app.use(express.json({ limit: "20mb" })); // un peu plus safe pour certains payloads

const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});
app.get("/quote", (req,res)=>{
res.sendFile(path.join(__dirname,"quote.html"))
})

// =======================
// Airtable
// =======================
const base = new Airtable({ apiKey: AIRTABLE_API_KEY }).base(AIRTABLE_BASE_ID);
const tablePWA = base(AIRTABLE_TABLE_PWA);
const tableMessages = base(AIRTABLE_TABLE_PWA_MESSAGES);
const tablePaymentLinks = base("Payment Links");

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

function escapeAirtableString(str) {
  // Airtable formula strings use double quotes; we escape them.
  return String(str || "").replace(/"/g, '\\"');
}

function inferMediaMeta(mediaUrl, fallbackName = "") {
  const url = String(mediaUrl || "");
  const name = String(fallbackName || "");

  // 1) type
  let mediaType = null;
  if (url.includes("/video/upload/") || url.includes("/video/")) mediaType = "video";
  else if (url.includes("/raw/upload/") || url.includes("/raw/")) mediaType = "document";
  else mediaType = "photo";

  // 2) fileName
  let fileName = name || url.split("/").pop() || "";

  // Cloudinary raw URLs n'ont pas toujours d'extension -> on force un .pdf par défaut
  if (mediaType === "document") {
    const hasExt = /\.[a-z0-9]{2,5}$/i.test(fileName);
    if (!hasExt) fileName = "document.pdf";
  }

  return { mediaType, fileName };
}

async function tgSendMessage({ text, message_thread_id, reply_markup }) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  return axios.post(url, {
    chat_id: STAFF_GROUP_ID,
    text,
    message_thread_id,
    ...(reply_markup ? { reply_markup } : {}),
  });
}

async function tgAnswerCallbackQuery(callback_query_id, text) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/answerCallbackQuery`;
  return axios.post(url, {
    callback_query_id,
    ...(text ? { text } : {}),
  });
}

async function findTopicIdByEmailSlug(email, sellerSlug) {
  const e = normEmail(email);
  const s = normSlug(sellerSlug);

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

async function findPwaClientRecord({ seller_slug, topic_id }) {
  const formula = `AND({seller_slug}="${escapeAirtableString(
    seller_slug
  )}",{topic_id}="${escapeAirtableString(topic_id)}")`;

  const records = await base("PWA Clients")
    .select({ filterByFormula: formula, maxRecords: 1 })
    .firstPage();

  return records[0] || null;
}

async function sendEmailNotification(toEmail, messageText) {
  if (!SMTP_EMAIL || !SMTP_PASS || !toEmail) return;

  try {
    await mailTransporter.sendMail({
      from: `"NovaPulse" <${SMTP_EMAIL}>`,
      to: toEmail,
      subject: "Nouveau message reçu",
      text: `Vous avez reçu un nouveau message :\n\n${messageText}\n\nReconnectez-vous à votre espace pour répondre.`,
    });

    console.log("📧 Email envoyé à", toEmail);
  } catch (err) {
    console.error("❌ Email error:", err.message);
  }
}
// =======================
// CENTRAL NOTIFICATION HELPER (multi-devices + missed counter)
// =======================

async function sendPushNotification(room, payload) {

  try {

    const parts = room.split(":");
    const sellerSlug = parts[1];
    const email = parts[2];

    const key = `${sellerSlug}:${email}`;

    const subscription = pushSubscriptions.get(key);

    if (!subscription) {
      console.log("⚠️ No push subscription for", key);
      return;
    }

    const pushPayload = JSON.stringify({
      title: "Nouveau message",
      body: payload?.text || "Vous avez reçu un message",
      url: `https://app.nova-pulse.app/${sellerSlug}`
    });

    console.log("📲 Sending PUSH to", key);

    await webpush.sendNotification(subscription, pushPayload);

    console.log("✅ PUSH sent");

  } catch (err) {

    console.error("❌ Push error:", err.message);

  }

}

async function notifyClient(room, eventName, payload) {
  try {

    console.log("=======================================");
    console.log("📡 notifyClient CALLED");
    console.log("📌 EVENT NAME:", eventName);
    console.log("📌 ROOM TARGET:", room);
    console.log("📌 ACTIVE ROOMS OBJECT:", activeRooms);
    console.log("📌 ACTIVE COUNT FOR ROOM:", activeRooms[room]);
    console.log("=======================================");

    
    const activeCount = activeRooms[room] || 0;

    if (activeCount > 0) {
      console.log("✅ REALTIME EMIT TRIGGERED");
      io.to(room).emit(eventName, payload);
    }

    // Email UNIQUEMENT si la room est réellement offline
    if (activeCount === 0) {
      console.log("📴 CLIENT OFFLINE → push + email");
      missedCounts[room] = (missedCounts[room] || 0) + 1;

      const parts = room.split(":");
      const clientEmail = parts[2];

      if (clientEmail) {
        await sendEmailNotification(
          clientEmail,
          payload?.text || "Vous avez reçu un nouveau message."
        );
      }
    }

  } catch (err) {
    console.error("❌ notifyClient error:", err.message);
  }
}

// =======================
// NOTES PERSISTANTES (PWA)
// =======================
// On garde en mémoire quel topic attend une note tapée par l’admin
// key = topicId (string), value = { seller_slug, startedAt }
const pendingPwaNotes = Object.create(null);

// Ajout cumulatif : on concatène, on n’écrase pas
function appendNote(oldNote, newNote) {
  const cleanOld = String(oldNote || "").trim();
  const cleanNew = String(newNote || "").trim();
  if (!cleanNew) return cleanOld;

  // format simple, lisible, persist
  // tu peux changer le préfixe si tu veux
  const line = `• ${cleanNew}`;
  if (!cleanOld) return line;
  return `${cleanOld}\n${line}`;
}

// =======================
// ROUTES BASIC
// =======================
app.get("/", (req, res) => res.status(200).send("NovaPulse Bridge running 🚀"));
app.get("/health", (req, res) => res.json({ ok: true }));
// =======================
// STRIPE REDIRECT MVP (SUCCESS / CANCEL)
// =======================
app.get("/success", (req, res) => {
  const sessionId = req.query.session_id || "";
  res
    .status(200)
    .send(`✅ Paiement réussi. Tu peux fermer cette page. session_id=${sessionId}`);
});

app.get("/cancel", (req, res) => {
  res.status(200).send("❌ Paiement annulé. Tu peux fermer cette page et réessayer.");
});
app.get("/pwa/download", async (req, res) => {
  try {
    const fileUrl = String(req.query.url || "").trim();
    const name = String(req.query.name || "document.pdf").trim();

    if (!fileUrl) return res.status(400).send("Missing url");

    // sécurité minimale: n'autorise QUE Cloudinary
    if (!fileUrl.includes("res.cloudinary.com/")) {
      return res.status(403).send("Forbidden");
    }

    // Nom safe
    const safeName = name
      .replace(/[\/\\?%*:|"<>]/g, "_")
      .slice(0, 120) || "document.pdf";

    const resp = await axios.get(fileUrl, {
      responseType: "stream",
      timeout: 30000,
      validateStatus: () => true,
      headers: { "User-Agent": "Mozilla/5.0" },
    });

    if (resp.status !== 200) {
      console.log("❌ download proxy failed status:", resp.status);
      return res.status(502).send("Download failed");
    }

    // Content-Type: si Cloudinary donne un type, on le garde, sinon fallback PDF
    const ct = (resp.headers?.["content-type"] || "").toLowerCase();
    const contentType = ct || "application/pdf";

    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Disposition", `attachment; filename="${safeName}"`);
    res.setHeader("Cache-Control", "no-store");

    resp.data.pipe(res);
  } catch (e) {
    console.error("❌ /pwa/download error:", e?.message);
    res.status(500).send("Internal error");
  }
});

// ============================
// PUSH SUBSCRIPTION
// ============================

const pushSubscriptions = new Map();

app.post("/pwa/subscribe", (req, res) => {
  try {
    const { email, sellerSlug, subscription } = req.body;

    console.log("🔔 Nouvelle subscription push reçue");
    console.log("Email:", email);
    console.log("Seller:", sellerSlug);

    if (!email || !sellerSlug || !subscription) {
      console.log("❌ Subscription invalide");
      return res.status(400).json({ success: false });
    }

    const key = `${sellerSlug}:${email}`;

    pushSubscriptions.set(key, subscription);

    console.log("✅ Subscription enregistrée:", key);

    // 🔎 DEBUG IMPORTANT
    console.log("📦 PUSH MAP SIZE:", pushSubscriptions.size);
    console.log("📦 PUSH KEYS:", Array.from(pushSubscriptions.keys()));

    res.json({ success: true });

  } catch (err) {
    console.error("❌ Subscribe error:", err);
    res.status(500).json({ success: false });
  }
});
// =======================
// TELEGRAM → PWA (admin -> client) + CALLBACKS
// Telegram webhook points here
// =======================
app.post("/webhook", async (req, res) => {
  const update = req.body;

  try {
    // =========================
    // 1) CALLBACK QUERY (boutons inline)
    // =========================
    if (update?.callback_query) {
      const cb = update.callback_query;
      const data = String(cb.data || "");
      const threadId = cb.message?.message_thread_id
        ? String(cb.message.message_thread_id).trim()
        : null;

      console.log("📌 CALLBACK:", data, "threadId=", threadId);

      // Répond à Telegram pour enlever le "loading"
      try {
        await tgAnswerCallbackQuery(cb.id);
      } catch (e) {
        // non bloquant
      }

      // ✅ On ne gère ici QUE les callbacks PWA
      if (data.startsWith("annoter_pwa_") && threadId) {
        // On récupère le client (seller_slug) via topic_id pour être cohérent
        const records = await tablePWA
          .select({
            filterByFormula: `{topic_id}='${threadId}'`,
            maxRecords: 1,
          })
          .firstPage();

        if (!records.length) {
          await tgSendMessage({
            message_thread_id: Number(threadId),
            text: "⚠️ Client PWA introuvable dans Airtable pour ce topic.",
          });
          return res.sendStatus(200);
        }

        const seller_slug = normSlug(records[0].fields.seller_slug);

        // On met le topic en mode "attente note"
        pendingPwaNotes[threadId] = { seller_slug, startedAt: Date.now() };

        await tgSendMessage({
          message_thread_id: Number(threadId),
          text: "📝 Envoie maintenant ta note dans ce topic (le prochain message texte sera enregistré).",
        });

        return res.sendStatus(200);
      }

      return res.sendStatus(200);
    }

// =========================
// 2) MESSAGE (supergroup topics)
// =========================
if (!update || !update.message) return res.sendStatus(200);

const message = update.message;
const caption = (message.caption || "").toLowerCase();
const isPaywallCommand = caption.includes("/env");

// Only staff supergroup topic messages
if (
  message.chat?.type === "supergroup" &&
  message.message_thread_id &&
  !message.from?.is_bot
) {
  const threadId = String(message.message_thread_id).trim();
  const text = (message.text || "").trim();

  // A) SI on attend une note pour ce topic -> on l'enregistre (TEXTE ONLY)
  if (pendingPwaNotes[threadId]) {
    if (!text) {
      await tgSendMessage({
        message_thread_id: Number(threadId),
        text: "❌ Merci d’envoyer uniquement du TEXTE pour la note.",
      });
      return res.sendStatus(200);
    }

    const ctx = pendingPwaNotes[threadId];
    delete pendingPwaNotes[threadId];

    const record = await findPwaClientRecord({
      seller_slug: ctx.seller_slug,
      topic_id: threadId,
    });

    if (!record) {
      await tgSendMessage({
        message_thread_id: Number(threadId),
        text: "⚠️ Impossible de trouver la ligne PWA Clients (seller_slug/topic_id).",
      });
      return res.sendStatus(200);
    }

    const oldNote = record.fields?.admin_note || "";
    const merged = appendNote(oldNote, text);

    await base("PWA Clients").update(record.id, {
      admin_note: merged,
    });

    const panelMessageId = record.fields?.panel_message_id;

    if (panelMessageId) {
      try {
        await axios.post(
          `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/editMessageText`,
          {
            chat_id: STAFF_GROUP_ID,
            message_id: Number(panelMessageId),
            text:
              "🧐 PANEL DE CONTRÔLE PWA\n\n" +
              `📧 Email : ${record.fields.email || "—"}\n` +
              `🏷️ Seller : ${record.fields.seller_slug || "—"}\n\n` +
              `📒 Notes :\n${merged || "Aucune note"}\n\n` +
              "👤 Admin en charge : Aucun",
            reply_markup: {
  inline_keyboard: [
    [
      {
        text: "📝 Ajouter une note",
        callback_data: `annoter_pwa_${threadId}`,
      },
    ],
    [
      {
        text: "📄 Créer un devis",
        url: `https://novapulse-bridge.onrender.com/quote?topic=${threadId}`
      },
    ],
  ],
},
          }
        );

        console.log("🧠 Panel updated for topic:", threadId);
      } catch (e) {
        console.error("❌ Failed to edit panel:", e.response?.data || e.message);
      }
    } else {
      console.warn("⚠️ panel_message_id manquant pour topic:", threadId);
    }

    await tgSendMessage({
      message_thread_id: Number(threadId),
      text: "✅ Note enregistrée",
    });

    console.log("✅ PWA note saved topic:", threadId);
    return res.sendStatus(200);
  }

  // B) ignore /env commands (pour ne pas polluer la PWA)
  if (text.toLowerCase().startsWith("/env")) return res.sendStatus(200);

  // C) trouver le client lié au topic (obligatoire pour TEXTE + MEDIA)
  const pwaRows = await tablePWA
    .select({
      filterByFormula: `{topic_id}='${threadId}'`,
      maxRecords: 1,
    })
    .firstPage();

  if (!pwaRows.length) return res.sendStatus(200);

  const row = pwaRows[0].fields;
  const email = normEmail(row.email);
  const sellerSlug = normSlug(row.seller_slug);
  const room = pwaRoom(email, sellerSlug);
  console.log("📡 Emitting quote to PWA room:", room)

  // C1) admin -> PWA texte normal
  if (text && !message.photo && !message.video && !message.document) {
    await tableMessages.create({
      email,
      seller_slug: sellerSlug,
      topic_id: threadId,
      sender: "admin",
      text,
    });

    await notifyClient(room, "admin_message", {
      text,
      from: "admin",
    });

    console.log("📤 Admin TEXT → PWA:", room, text);
  }

  // D) admin -> PWA media (photo, video, document)
  // PHOTO
  if (message.photo && message.photo.length > 0) {
    if (isPaywallCommand) {
      console.log("⛔ PHOTO ignorée (paywall géré par Python)");
      return res.sendStatus(200);
    }

    const fileId = message.photo[message.photo.length - 1].file_id;

    const fileResp = await axios.get(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getFile?file_id=${fileId}`
    );

    const filePath = fileResp.data?.result?.file_path;
    if (filePath) {
      const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${filePath}`;


      // 🔥 2) ENVOI DE LA PHOTO
      io.to(room).emit("admin_media", {
        type: "photo",
        url: fileUrl,
        fileName: "photo",
        text: message.caption || "",
        from: "admin",
      });
      pushPwaHistory(room, {
        from: "admin",
        type: "media",
        mediaType: "photo",
        url: fileUrl,
        fileName: "photo",
        text: message.caption || "",
      });
      console.log("🧠 HISTORY +1 admin PHOTO →", room);

      console.log("📸 Admin PHOTO + caption → PWA:", room);
    }
  }

    if (message.video) {
  if (isPaywallCommand) return res.sendStatus(200);

  const fileId = message.video.file_id;

  const fileResp = await axios.get(
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getFile?file_id=${fileId}`
  );

  const filePath = fileResp.data?.result?.file_path;
  if (filePath) {
    const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${filePath}`;

    io.to(room).emit("admin_media", {
      type: "video",
      url: fileUrl,
      fileName: message.video.file_name || "video",
      text: message.caption || "",
      from: "admin",
    });
    pushPwaHistory(room, {
      from: "admin",
      type: "media",
      mediaType: "video",
      url: fileUrl,
      fileName: message.video.file_name || "video",
      text: message.caption || "",
    });
    console.log("🧠 HISTORY +1 admin VIDEO →", room);

    console.log("🎥 Admin VIDEO + caption → PWA:", room);
  }
}

    if (message.document) {
  if (isPaywallCommand) return res.sendStatus(200);

  const fileId = message.document.file_id;
  const fileName = message.document.file_name || "document";

  const fileResp = await axios.get(
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getFile?file_id=${fileId}`
  );

  const filePath = fileResp.data?.result?.file_path;
  if (filePath) {
    const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${filePath}`;

    io.to(room).emit("admin_media", {
      type: "document",
      url: fileUrl,
      fileName,
      text: message.caption || "",
      from: "admin",
    });
    pushPwaHistory(room, {
      from: "admin",
      type: "media",
      mediaType: "document",
      url: fileUrl,
      fileName,
      text: message.caption || "",
    });
    console.log("🧠 HISTORY +1 admin DOCUMENT →", room);

    console.log("📄 Admin DOCUMENT + caption → PWA:", room);
  }
}
} // ← ferme le if(supergroup topic)
} catch (err) {
  console.error("❌ /webhook error:", err.response?.data || err.message);
}

return res.sendStatus(200);
});



// =======================
// TRACK ROOMS CONNECTED (multi-devices)
// =======================
// room -> nombre de connexions actives
const activeRooms = Object.create(null);

// Compteur de messages manqués par room
const missedCounts = Object.create(null);

// =======================
// PWA VISIBILITY (visible / invisible)
// =======================
// room -> true (visible) / false (invisible)
const roomVisibility = Object.create(null);

// Dernier "signal de vie" par room (heartbeat)
const roomLastSeen = Object.create(null);

// Dernière activité utilisateur par room (timestamp)
const lastActivity = Object.create(null);

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

    activeRooms[room] = (activeRooms[room] || 0) + 1; // ← ajout propre
    roomLastSeen[room] = Date.now();
    lastActivity[room] = Date.now();
    console.log("✅ INIT:", e, s, "room=", room, "connections=", activeRooms[room]);
  });
// 👁️ PWA → SERVER : visibilité (mobile background / app hidden)
  socket.on("pwa_visibility", ({ isVisible }) => {
    const email = socket.data.email;
    const sellerSlug = socket.data.sellerSlug;
    if (!email || !sellerSlug) return;

    const room = pwaRoom(email, sellerSlug);
    roomVisibility[room] = !!isVisible;


    console.log("👁 VISIBILITY:", room, "visible=", roomVisibility[room]);
  });
  // 💓 Heartbeat : signal de vie PWA
  socket.on("heartbeat", () => {
    const email = socket.data.email;
    const sellerSlug = socket.data.sellerSlug;
    if (!email || !sellerSlug) return;

    const room = pwaRoom(email, sellerSlug);
    roomLastSeen[room] = Date.now();

    console.log("💓 HEARTBEAT:", room);
  });

  // ✅ PWA → TELEGRAM (client -> staff topic)
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
        message_thread_id: Number(topicId),
        text: `💬 Client (${email})\n${cleanText}`,
      });

      console.log("📩 PWA → Telegram OK topic:", topicId);
    } catch (err) {
      console.error("❌ PWA → Telegram error:", err.response?.data || err.message);
    }
  });

  socket.on("disconnect", () => {
    const email = socket.data.email;
    const sellerSlug = socket.data.sellerSlug;

    if (email && sellerSlug) {
      const room = pwaRoom(email, sellerSlug);
      roomVisibility[room] = false;
      const socketsInRoom = io.sockets.adapter.rooms.get(room);

      if (activeRooms[room]) {
        activeRooms[room] = Math.max(0, activeRooms[room] - 1);
      }
      if (activeRooms[room] === 0) {
        delete activeRooms[room];
        console.log("📴 ROOM INACTIVE:", room);
      } else {
        console.log("👥 ROOM STILL ACTIVE:", room, "connections=", activeRooms[room]);
      }
    }

    console.log("❌ PWA disconnected:", socket.id);
  });
});

// =======================
// UPLOAD MEDIA → CLOUDINARY
// =======================

app.post("/upload-media", upload.single("file"), async (req, res) => {
  console.log("🔥 /upload-media route HIT");

  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: "No file uploaded" });
    }

    const mimeType = req.file.mimetype || "";
    const originalName = req.file.originalname || "file";
    const ext = path.extname(originalName).replace(".", "").toLowerCase(); // ex: "pdf"
    const baseName = path
      .basename(originalName, path.extname(originalName))
      .replace(/[^\w\-]+/g, "_")
      .slice(0, 60);

    let resourceType = "image";

    if (mimeType.startsWith("video")) {
      resourceType = "video";
    } else if (
      mimeType.includes("pdf") ||
      mimeType.includes("msword") ||
      mimeType.includes("officedocument") ||
      mimeType.includes("application")
    ) {
      resourceType = "raw";
    }

    console.log("📦 Upload type detected:", mimeType, "→", resourceType);
    console.log("📎 originalname:", req.file.originalname);



    const uploadOpts = {
      folder: "novapulse_media",
      resource_type: resourceType,
    };

    // 🔥 Si c’est un RAW (pdf, doc, etc.), on force un nom + format
    if (resourceType === "raw") {
      uploadOpts.public_id = `${baseName}_${Date.now()}`;
      if (ext) uploadOpts.format = ext; // ex: "pdf"
    }
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        folder: "novapulse_media",
        resource_type: resourceType,
        // IMPORTANT: on ne force PAS le format dans l'URL pour raw.
        // On garde l'URL Cloudinary telle qu'elle est retournée.
      },
      (error, result) => {
        if (error) {
          console.error("❌ Cloudinary error:", error);
          return res.status(500).json({ success: false, error: "Cloudinary upload failed" });
        }

        console.log("✅ Media uploaded:", result.secure_url);

        // 🔥 NE PAS MODIFIER L'URL (pas de .pdf ajouté)
        return res.json({
          success: true,
          mediaUrl: result.secure_url,
          originalName: req.file.originalname || "",
          mimeType,
          resourceType,
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
// PERSISTENT HISTORY (TEXT + MEDIA)
// =======================
const pwaHistoryStore = {}; 
// clé = room ("pwa:seller:email"), valeur = array de messages

function pushPwaHistory(room, msg) {
  if (!room) return;
  if (!pwaHistoryStore[room]) pwaHistoryStore[room] = [];

  pwaHistoryStore[room].push({
    ...msg,
    ts: Date.now(), // timestamp unique serveur
  });

  // garde une taille raisonnable (ex: 300 derniers)
  if (pwaHistoryStore[room].length > 300) {
    pwaHistoryStore[room] = pwaHistoryStore[room].slice(-300);
  }
}
// =======================
// PWA: SEND PAID CONTENT (BLUR + CHECKOUT)
// =======================
const pendingPaidContent = {}; // mémoire temporaire (phase test validée)
const contentMediaStore = {}; 
// clé = contentId, valeur = { mediaUrl, mediaType, fileName }

app.post("/pwa/send-paid-content", async (req, res) => {
  try {
    const { email, sellerSlug, text, checkout_url, mediaUrl, mediaType, fileName, contentId, amount, isMedia } =
      req.body;
      console.log("🧾 Payload reçu:", req.body);
      console.log("🔑 contentId reçu:", contentId);


      // Sauvegarde persistante du média par contentId
    if (contentId && mediaUrl) {
      const meta = inferMediaMeta(mediaUrl, fileName);
      contentMediaStore[contentId] = {
        mediaUrl,
        mediaType: mediaType || meta.mediaType,
        fileName: fileName || meta.fileName,
      };
      console.log("📦 Stored media for contentId:", contentId);
    }

    const room = pwaRoom(email, sellerSlug);

    console.log("💰 SEND PAID CONTENT →", room);
    console.log("Media URL:", mediaUrl);

    pendingPaidContent[room] = {
      mediaUrl,
      amount,
      createdAt: Date.now(),
    };

    io.to(room).emit("paid_content_locked", {
      text: text || "Contenu premium verrouillé.",
      checkout_url,
      amount,
      isMedia,
    });

    return res.json({ success: true });
  } catch (err) {
    console.error("❌ /pwa/send-paid-content error:", err.message);
    return res.status(500).json({ success: false });
  }
});

app.get("/pwa/content", async (req, res) => {
  try {
    const { contentId } = req.query;
    if (!contentId) {
      return res.status(400).json({ error: "Missing contentId" });
    }

    const media = contentMediaStore[contentId];
    if (!media) {
      return res.json({ success: false, reason: "media_not_found" });
    }

    res.json({ success: true, media });
  } catch (err) {
    console.error("❌ Error fetching content media:", err);
    res.status(500).json({ error: "Internal error" });
  }
});
// =======================
// PWA: SEND SIMPLE PAYMENT (NO MEDIA)
// =======================
app.post("/pwa/send-simple-payment", async (req, res) => {
  try {
    const { email, sellerSlug, text, checkout_url, amount } = req.body;

    const room = pwaRoom(email, sellerSlug);

    console.log("💳 SEND SIMPLE PAYMENT →", room);

    io.to(room).emit("simple_payment_request", {
      text: text || "💳 Paiement requis.",
      checkout_url,
      amount,
    });

    return res.json({ success: true });
  } catch (err) {
    console.error("❌ /pwa/send-simple-payment error:", err.message);
    return res.status(500).json({ success: false });
  }
});
// =======================
// PWA: UNLOCK AFTER PAYMENT (called by Python webhook)
// =======================
// =======================
// PWA: UNLOCK CONTENT AFTER PAYMENT
// =======================
app.post("/pwa/unlock", async (req, res) => {
  try {
    const { email, sellerSlug, contentId, sessionId } = req.body;

    const room = pwaRoom(email, sellerSlug);

    console.log("🔓 UNLOCK REQUEST:",  {
    
      sellerSlug,
      contentId,
      sessionId,
      room,
    });
    
    console.log("🧠 contentMediaStore keys sample:", Object.keys(contentMediaStore).slice(0, 5));
    console.log("🧠 contentMediaStore lookup:", contentId, contentMediaStore?.[contentId]);



    const pending = pendingPaidContent[room];

    if (!pending) {
      console.warn("⚠️ No pending content found for room:", room);
      return res.json({ success: false, reason: "no_pending_content" });
    }

    console.log("📦 Unlocking media:", pending.mediaUrl);


    const stored = contentId ? contentMediaStore[contentId] : null;
    const meta = inferMediaMeta(stored?.mediaUrl || pending.mediaUrl, stored?.fileName);

    io.to(room).emit("paid_content_unlocked", {
      mediaUrl: stored?.mediaUrl || pending.mediaUrl,
      mediaType: stored?.mediaType || meta.mediaType,
      fileName: stored?.fileName || meta.fileName,
      amount: pending.amount,
      contentId,
    });
    

    // nettoyage mémoire
    delete pendingPaidContent[room];

    return res.json({ success: true });
  } catch (err) {
    console.error("❌ /pwa/unlock error:", err.message);
    return res.status(500).json({ success: false });
  }
});


app.get("/pwa/purchases", async (req, res) => {
  try {
    const { email } = req.query;
    if (!email) {
      return res.status(400).json({ error: "Missing email" });
    }

    const filterFormula = `AND({Client Key}="${email}", {Status}="Paid")`;

    const records = await base("Payment Links")
      .select({ filterByFormula: filterFormula })
      .all();

    const purchases = records.map(r => ({
      content_id: r.fields["Content ID"],
      paid_at: r.fields["Paid At"],
      amount_cents: r.fields["Amount Cents"],
      checkout_session_id: r.fields["Checkout Session ID"],
      caption: r.fields["Caption"] || null
    }));

    res.json({ success: true, purchases });
  } catch (err) {
    console.error("❌ Error fetching purchases:", err);
    res.status(500).json({ error: "Internal error" });
  }
});
// =======================
// PWA: GET LAST 30 MESSAGES HISTORY (timeline unifiée)
// =======================
app.get("/pwa/history", async (req, res) => {
  try {
    const email = normEmail(req.query.email);
    const sellerSlug = normSlug(req.query.sellerSlug);
    const topicId = String(req.query.topicId || "").trim();
    

    if (!email || !sellerSlug || !topicId) {
      return res.status(400).json({ success: false, error: "Missing params" });
    }
    const room = pwaRoom(email, sellerSlug);

    // 🔄 Reset compteur de messages manqués dès chargement historique
    if (missedCounts[room]) {
      console.log("🔁 RESET MISSED COUNT:", room, "old=", missedCounts[room]);
      missedCounts[room] = 0;
    }
    
    console.log("📜 HISTORY REQUEST:", { email, sellerSlug, topicId });

    const topicNum = Number(topicId);
    const topicFormula = Number.isFinite(topicNum)
      ? `{topic_id}=${topicNum}`
      : `{topic_id}='${topicId.replace(/'/g, "\\'")}'`;

    const safeEmail = email.replace(/'/g, "\\'");
    const safeSlug = sellerSlug.replace(/'/g, "\\'");

    const filterByFormula = `AND({email}='${safeEmail}', {seller_slug}='${safeSlug}', ${topicFormula})`;

    // =======================
    // 1) Messages classiques
    // =======================
    const messageRecords = await tableMessages
      .select({
        filterByFormula,
        maxRecords: 200,
      })
      .all();

    messageRecords.sort((a, b) => {
      const aTime = new Date(a._rawJson?.createdTime || 0).getTime();
      const bTime = new Date(b._rawJson?.createdTime || 0).getTime();
      return aTime - bTime;
    });

    const messageEvents = messageRecords.map((rec) => ({
      text: rec.fields.text || "",
      from: rec.fields.sender === "admin" ? "admin" : "client",
      type: "text",
      createdTime: rec._rawJson?.createdTime || null,
    }));

    // =======================
    // 2) Paiements (événements système)
    // =======================
    const paymentRecords = await tablePaymentLinks
      .select({
        filterByFormula: `AND({Client Key}='${safeEmail}', FIND('${safeSlug}_', {Content ID})=1)`,
        maxRecords: 200,
      })
      .firstPage();

    const paymentEvents = paymentRecords.map((rec) => {
      const centsRaw = rec.fields["Amount Cents"];
      const cents = Number(String(centsRaw ?? 0).replace(",", ".")) || 0;
      const amount = (cents / 100).toFixed(2);

      const sentAt =
        rec.fields["Sent At"] ||
        rec._rawJson?.createdTime ||
        null;

      return {
        text: `💳 Demande de paiement – ${amount} €`,
        from: "admin",
        type: "payment",
        createdTime: sentAt,
      };
    });

    // =======================
    // 3) Fusion timeline
    // =======================
    // =======================
    // Médias persistés en mémoire
    // =======================
    const memoryMedia = (pwaHistoryStore[room] || []).map((m) => ({
      text: m.text || "",
      from: m.from || "admin",
      type: "media",
      mediaType: m.mediaType,
      url: m.url,
      fileName: m.fileName,
      createdTime: new Date(m.ts).toISOString(),
    }));

    const merged = [
      ...messageEvents,
      ...paymentEvents,
      ...memoryMedia,
    ].filter((e) => e.createdTime);

    merged.sort((a, b) => {
      const aTime = new Date(a.createdTime).getTime();
      const bTime = new Date(b.createdTime).getTime();
      return aTime - bTime;
    });

    // On garde seulement les 30 derniers événements globaux
    const finalHistory = merged.slice(-30);

    return res.json({ success: true, history: finalHistory });
  } catch (err) {
    console.error("❌ /pwa/history error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
});
// =======================
// PWA: GET MISSED MESSAGES COUNT
// =======================
app.get("/pwa/missed-count", async (req, res) => {
  try {
    const email = normEmail(req.query.email);
    const sellerSlug = normSlug(req.query.sellerSlug);

    if (!email || !sellerSlug) {
      return res.status(400).json({
        success: false,
        error: "Missing email or sellerSlug",
      });
    }

    const room = pwaRoom(email, sellerSlug);
    const count = missedCounts[room] || 0;

    console.log("📊 MISSED COUNT REQUEST:", room, "count=", count);

    return res.json({
      success: true,
      missed: count,
    });
  } catch (err) {
    console.error("❌ /pwa/missed-count error:", err.message);
    return res.status(500).json({ success: false });
  }
});
// =======================
// PWA: GET PAYMENT OFFERS (Pending/Paid)
// Filtre: Client Key + (URL Render si fourni, sinon Content ID prefix sellerSlug_)
// =======================
app.get("/pwa/payments", async (req, res) => {
  try {
    const email = normEmail(req.query.email);
    const sellerSlug = normSlug(req.query.sellerSlug); // ex: coach-matthieu
    const urlRender = String(req.query.urlRender || "").trim(); // optionnel

    if (!email || !sellerSlug) {
      return res.status(400).json({
        success: false,
        error: "Missing params: email, sellerSlug",
      });
    }

    const safeEmail = email.replace(/'/g, "\\'");
    const safeSeller = sellerSlug.replace(/'/g, "\\'");
    const safeUrl = urlRender.replace(/'/g, "\\'");

    // Si urlRender est fourni -> filtre le plus fiable
    // Sinon -> on se base sur Content ID: "sellerSlug_..."
    const vendorFormula = urlRender
      ? `{URL Render}='${safeUrl}'`
      : `FIND('${safeSeller}_', {Content ID})=1`;

    const filterByFormula = `AND({Client Key}='${safeEmail}', ${vendorFormula})`;

    console.log("💳 PAYMENTS REQUEST:", {
      email,
      sellerSlug,
      urlRender: urlRender || null,
      filterByFormula,
    });

    const records = await tablePaymentLinks
      .select({
        filterByFormula,
        sort: [{ field: "Sent At", direction: "desc" }],
        maxRecords: 200,
      })
      .firstPage();

    const items = records.map((rec) => {
      const centsRaw = rec.fields["Amount Cents"];
      const cents = Number(String(centsRaw ?? 0).replace(",", ".")) || 0;

      const status = String(rec.fields["Status"] || "")
        .toLowerCase()
        .trim() || "pending";

      return {
        id: rec.id,
        caption: rec.fields["Caption"] || "",
        amount_cents: cents,
        amount_eur: (cents / 100).toFixed(2),

        status, // paid | pending
        sent_at: rec.fields["Sent At"] || null,
        paid_at: rec.fields["Paid At"] || null,

        payment_link_url: rec.fields["Payment Link URL"] || null,

        // debug utile
        content_id: rec.fields["Content ID"] || null,
        checkout_session_id: rec.fields["Checkout Session ID"] || null,
        url_render: rec.fields["URL Render"] || null,
      };
    });

    const pending = items.filter((x) => x.status === "pending");
    const paid = items.filter((x) => x.status === "paid");

    return res.json({ success: true, pending, paid, all: items });
  } catch (err) {
    console.error("❌ /pwa/payments error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
});
// =======================
// GET TOPIC ID FOR PWA
// =======================
app.get("/pwa/get-topic", async (req, res) => {
  try {
    const email = normEmail(req.query.email);
    const sellerSlug = normSlug(req.query.sellerSlug);

    const topicId = await findTopicIdByEmailSlug(email, sellerSlug);
    if (!topicId) {
      return res.json({ topicId: null });
    }

    return res.json({ topicId });
  } catch (err) {
    console.error("❌ /pwa/get-topic error:", err.message);
    return res.status(500).json({ topicId: null });
  }
});

// =======================
// REGISTER NEW PWA CLIENT (CREATE TOPIC + AIRTABLE)
// =======================
app.post("/pwa/register-client", async (req, res) => {
  try {
    const email = normEmail(req.body.email);
    const sellerSlug = normSlug(req.body.sellerSlug);

    if (!email || !sellerSlug) {
      return res
        .status(400)
        .json({ success: false, error: "Missing email or sellerSlug" });
    }

    console.log("🆕 REGISTER CLIENT:", email, sellerSlug);

    const existing = await tablePWA
      .select({
        filterByFormula: `AND({email}='${email}', {seller_slug}='${sellerSlug}')`,
        maxRecords: 1,
      })
      .firstPage();

    if (existing.length > 0) {
      const topicId = existing[0].fields.topic_id;
      console.log("🔁 Client already exists:", topicId);
      return res.json({ success: true, topicId, isNew: false });
    }

    const topicTitle = `Client ${email}`;

    // 1️⃣ Création du topic Telegram
    const tgResp = await axios.post(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/createForumTopic`,
      {
        chat_id: STAFF_GROUP_ID,
        name: topicTitle,
      }
    );

    const topicId = tgResp.data.result.message_thread_id;
    console.log("🧵 New topic created:", topicId);

    // 2️⃣ Création de la ligne Airtable
    const createdRecord = await tablePWA.create({
      email,
      seller_slug: sellerSlug,
      topic_id: String(topicId),
    });

    console.log("💾 Airtable client created:", email);

    // 3️⃣ Envoi du panel Telegram + récupération message_id
    try {
      const panelResp = await axios.post(
        `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
        {
          chat_id: STAFF_GROUP_ID,
          message_thread_id: Number(topicId),
          text: `🧐 PANEL DE CONTRÔLE PWA

📧 Email : ${email}
🏷️ Seller : ${sellerSlug}
📒 Notes :
👤 Admin en charge : Aucun`,
          reply_markup: {
            inline_keyboard: [
  [
    {
      text: "📝 Ajouter une note",
      callback_data: `annoter_pwa_${topicId}`,
    },
  ],
  [
    {
      text: "📄 Créer un devis",
      url: `https://novapulse-bridge.onrender.com/quote?topic=${topicId}`,
    },
  ],
],
          },
        }
      );

      // 🔥 CRUCIAL : récupérer le message_id du panel
      const panelMessageId = panelResp.data.result.message_id;
      console.log("📌 Panel message_id:", panelMessageId);

      // 🔥 On l’enregistre dans Airtable pour pouvoir l’éditer plus tard
      await tablePWA.update(createdRecord.id, {
        panel_message_id: String(panelMessageId),
      });

      console.log("💾 panel_message_id saved in Airtable");
    } catch (notifyErr) {
      console.error(
        "⚠️ Failed to send panel trigger message:",
        notifyErr.response?.data || notifyErr.message
      );
    }

    return res.json({ success: true, topicId, isNew: true });
  } catch (err) {
    console.error(
      "❌ /pwa/register-client error:",
      err.response?.data || err.message
    );
    return res.status(500).json({ success: false });
  }
});

// =======================
// NOTES (PWA Clients) API
// =======================

// GET note for a topic
app.get("/api/pwa/note", async (req, res) => {
  try {
    const { seller_slug, topic_id } = req.query;
    if (!seller_slug || !topic_id) {
      return res
        .status(400)
        .json({ error: "seller_slug and topic_id required" });
    }

    const record = await findPwaClientRecord({
      seller_slug: String(seller_slug),
      topic_id: String(topic_id),
    });
    if (!record) return res.json({ note: "" });

    return res.json({ note: record.fields?.admin_note || "" });
  } catch (err) {
    console.error("GET /api/pwa/note error:", err);
    return res.status(500).json({ error: "internal_error" });
  }
});

// POST update note for a topic (ICI aussi : on append, pas overwrite)
app.post("/api/pwa/note", async (req, res) => {
  try {
    const { seller_slug, topic_id, note } = req.body || {};
    if (!seller_slug || !topic_id) {
      return res
        .status(400)
        .json({ error: "seller_slug and topic_id required" });
    }

    const record = await findPwaClientRecord({
      seller_slug: String(seller_slug),
      topic_id: String(topic_id),
    });

    if (!record) {
      return res.status(404).json({ error: "client_topic_not_found" });
    }

    const oldNote = record.fields?.admin_note || "";
    const merged = appendNote(oldNote, note || "");

    await base("PWA Clients").update(record.id, {
      admin_note: merged,
    });

    return res.json({ ok: true, note: merged });
  } catch (err) {
    console.error("POST /api/pwa/note error:", err);
    return res.status(500).json({ error: "internal_error" });
  }
});


// =======================
// PWA: SEND SYSTEM ADMIN MESSAGE (POST PAYMENT CONFIRMATION)
// =======================
app.post("/pwa/send-admin-message", async (req, res) => {
  try {
    const { email, sellerSlug, text } = req.body;

    const e = normEmail(email);
    const s = normSlug(sellerSlug);
    const room = pwaRoom(e, s);

    console.log("📩 SEND ADMIN MESSAGE →", room, text);

    // 1️⃣ Trouver le topic_id pour stockage historique
    const topicId = await findTopicIdByEmailSlug(e, s);

    if (topicId) {
      await tableMessages.create({
        email: e,
        seller_slug: s,
        topic_id: topicId,
        sender: "admin",
        text,
      });
    }

    // 2️⃣ Utiliser le helper central (gère online + offline + badge)
    await notifyClient(room, "admin_message", {
      text,
      from: "admin",
    });

    return res.json({ success: true });
  } catch (err) {
    console.error("❌ /pwa/send-admin-message error:", err.message);
    return res.status(500).json({ success: false });
  }
});
// =======================
// PWA: SEND SYSTEM ADMIN MEDIA (NORMAL MEDIA MESSAGE)
// =======================
app.post("/pwa/send-admin-media", async (req, res) => {
  try {
    const { email, sellerSlug, text, mediaUrl, mediaType } = req.body;

    const room = pwaRoom(email, sellerSlug);
    // 🔥 Persistance mémoire des médias admin (groupé / programmé / direct)
    if (!pwaHistoryStore[room]) {
      pwaHistoryStore[room] = [];
    }

    pwaHistoryStore[room].push({
      from: "admin",
      type: "media",
      mediaType: mediaType,
      url: mediaUrl,
      fileName: mediaUrl?.split("/").pop(),
      text: text || "",
      ts: Date.now(),
    });

    // Limite sécurité (évite mémoire infinie)
    if (pwaHistoryStore[room].length > 100) {
      pwaHistoryStore[room] = pwaHistoryStore[room].slice(-100);
    }

    console.log("🖼️ SEND ADMIN MEDIA →", room, mediaUrl, text, mediaType);

    // 🔥 priorité au type envoyé par la PWA
    let finalType = mediaType;

    // fallback sécurité si jamais oublié côté PWA
    if (!finalType) {
      if (mediaUrl?.includes("/video/")) finalType = "video";
      else if (mediaUrl?.toLowerCase().includes(".pdf")) finalType = "document";
      else finalType = "photo";
    }

    io.to(room).emit("admin_media", {
      type: finalType,
      url: mediaUrl,
      fileName: mediaUrl?.split("/").pop(),
      text: text || "",
      from: "admin",
    });

    return res.json({ success: true });
  } catch (err) {
    console.error("❌ /pwa/send-admin-media error:", err.message);
    return res.status(500).json({ success: false });
  }
});



// =======================
// HELPERS (add near other helpers)
// =======================
function previewBody(data) {
  try {
    if (!data) return "";
    if (Buffer.isBuffer(data)) return data.toString("utf8").slice(0, 300);
    if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8").slice(0, 300);
    if (typeof data === "string") return data.slice(0, 300);
    return JSON.stringify(data).slice(0, 300);
  } catch {
    return "";
  }
}

async function downloadFileBuffer({ mediaUrl, fileName }) {
  // construit des variantes d’URL SANS casser l’original
  const ext = (fileName && fileName.includes(".")) ? fileName.split(".").pop().toLowerCase() : null;

  const candidates = [];
  candidates.push(mediaUrl);

  // Si Cloudinary "image/upload" pour un pdf -> tenter raw/upload
  if (mediaUrl.includes("/image/upload/")) {
    candidates.push(mediaUrl.replace("/image/upload/", "/raw/upload/"));
  }

  // Si pas d’extension dans l’URL mais fileName en a une -> ajouter .ext
  if (ext && !mediaUrl.toLowerCase().includes(`.${ext}`)) {
    candidates.push(`${mediaUrl}.${ext}`);
    if (mediaUrl.includes("/image/upload/")) {
      candidates.push(`${mediaUrl.replace("/image/upload/", "/raw/upload/")}.${ext}`);
    }
  }

  // Cloudinary parfois plus “fetchable” avec fl_attachment
  candidates.push(`${mediaUrl}${mediaUrl.includes("?") ? "&" : "?"}fl_attachment=true`);

  // remove duplicates
  const uniq = [...new Set(candidates)];

  let lastErr = null;

  for (const url of uniq) {
    try {
      console.log("📄 Trying download URL:", url);

      const resp = await axios.get(url, {
        responseType: "arraybuffer",
        timeout: 20000,
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
        validateStatus: () => true, // on gère nous-mêmes
      });

      if (resp.status !== 200) {
        const body = previewBody(resp.data);
        console.log("⚠️ Download failed:", resp.status, "headers:", resp.headers);
        console.log("⚠️ Body preview:", body);
        lastErr = new Error(`download_failed_status_${resp.status}`);
        continue;
      }

      const buf = Buffer.from(resp.data);
      if (!buf || buf.length === 0) {
        lastErr = new Error("download_empty_buffer");
        continue;
      }

      const contentType = (resp.headers?.["content-type"] || "").toLowerCase();
      console.log("✅ Download OK:", url, "bytes=", buf.length, "content-type=", contentType);

      return { buffer: buf, usedUrl: url, contentType };
    } catch (e) {
      lastErr = e;
      console.log("⚠️ Download exception:", e?.message);
    }
  }

  throw lastErr || new Error("download_failed_all_candidates");
}

// =======================
// PWA: CLIENT SEND MEDIA → TELEGRAM TOPIC
// =======================
app.post("/pwa/client-send-media", async (req, res) => {
  try {
    const { email, sellerSlug, mediaUrl, mediaType, fileName } = req.body;

    const topicId = await findTopicIdByEmailSlug(email, sellerSlug);
    if (!topicId) {
      return res.status(404).json({ success: false, error: "topic_not_found" });
    }

    console.log("📥 CLIENT MEDIA → TELEGRAM:", email, mediaType, mediaUrl, "fileName:", fileName);

    // 📸 PHOTO (URL directe)
    if (mediaType === "photo") {
      await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendPhoto`, {
        chat_id: STAFF_GROUP_ID,
        message_thread_id: Number(topicId),
        photo: mediaUrl,
        caption: `📎 Média client (${email})`,
      });

      console.log("✅ CLIENT PHOTO SENT topic:", topicId);
      return res.json({ success: true });
    }

    // 🎥 VIDEO (URL directe)
    if (mediaType === "video") {
      await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendVideo`, {
        chat_id: STAFF_GROUP_ID,
        message_thread_id: Number(topicId),
        video: mediaUrl,
        caption: `📎 Vidéo client (${email})`,
      });

      console.log("✅ CLIENT VIDEO SENT topic:", topicId);
      return res.json({ success: true });
    }

    // 📄 DOCUMENT: on télécharge le buffer depuis Cloudinary (URL exacte) puis upload Telegram
    console.log("📄 Document: downloading buffer before Telegram upload...");
    console.log("📄 Trying download URL:", mediaUrl);

    const fileResp = await axios.get(mediaUrl, {
      responseType: "arraybuffer",
      timeout: 20000,
      // parfois Cloudinary renvoie mieux avec un User-Agent
      headers: { "User-Agent": "Mozilla/5.0" },
      validateStatus: () => true,
    });

    if (fileResp.status !== 200 || !fileResp.data || fileResp.data.byteLength === 0) {
      console.warn("⚠️ Download failed:", fileResp.status, "headers:", fileResp.headers);
      return res.status(500).json({ success: false, error: `download_failed_status_${fileResp.status}` });
    }

    const safeName = String(fileName || "document.pdf")
      .replace(/[\/\\?%*:|"<>]/g, "_")
      .slice(0, 120);

    const buf = Buffer.from(fileResp.data);

    const formData = new FormData();
    formData.append("chat_id", String(STAFF_GROUP_ID));
    formData.append("message_thread_id", String(Number(topicId)));
    formData.append("caption", `📎 Document client (${email})`);
    formData.append("document", buf, {
      filename: safeName,
      contentType: "application/octet-stream",
    });

    await axios.post(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendDocument`,
      formData,
      { headers: formData.getHeaders(), timeout: 30000 }
    );

    console.log("✅ CLIENT DOCUMENT SENT topic:", topicId);
    return res.json({ success: true });
  } catch (err) {
    console.error("❌ /pwa/client-send-media error:", err.response?.data || err.message);
    return res.status(500).json({ success: false, error: "send_failed" });
  }
});
// =======================
// GENERATE QUOTE PDF → TELEGRAM
// =======================

app.post("/generate-quote", async (req,res)=>{

try{

const {topic,email,seller,items} = req.body

console.log("🧾 GENERATE QUOTE REQUEST:", { topic, email, seller, items })

if(!topic || !items || !items.length){
return res.status(400).json({error:"missing data"})
}

// ===== CREATE PDF =====

// ===== CREATE PDF =====

const doc = new PDFDocument({ margin: 40 })
// ICI 👇 on ajoute le titre

doc.font("Helvetica-Bold")
doc.fontSize(32)
doc.text("NovaPulse", { align: "center" })

doc.moveDown(0.3)

doc.font("Helvetica")
doc.fontSize(14)
doc.text("DEVIS", { align: "center" })

doc.moveDown()

doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke()

doc.moveDown(2)

const buffers = []
doc.on("data", buffers.push.bind(buffers))

// ===== WRITE PDF CONTENT =====
// ===== Helpers =====
const euro = (n) =>
  new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" }).format(Number(n || 0))

// Marges
const left = 50
const right = 545
const tableWidth = right - left

// Colonnes (largeurs fixes)
const colServiceX = left
const colServiceW = 260

const colQtyX = colServiceX + colServiceW
const colQtyW = 55

const colPriceX = colQtyX + colQtyW
const colPriceW = 90

const colTotalX = colPriceX + colPriceW
const colTotalW = right - colTotalX

const rowH = 26

function hr(y) {
  doc.moveTo(left, y).lineTo(right, y).stroke()
}

function drawHeaderRow(y) {
  // bande grise légère (optionnel mais pro)
  doc.save()
  doc.rect(left, y - 6, tableWidth, rowH).fill("#F3F4F6")
  doc.fillColor("black")
  doc.restore()

  doc.font("Helvetica-Bold").fontSize(11)
  doc.text("Service", colServiceX, y, { width: colServiceW })
  doc.text("Qté", colQtyX, y, { width: colQtyW, align: "center" })
  doc.text("Prix unitaire", colPriceX, y, { width: colPriceW, align: "right" })
  doc.text("Total", colTotalX, y, { width: colTotalW, align: "right" })
}

function drawItemRow(y, item) {
  const qty = Number(item.qty || 0)
  const price = Number(item.price || 0)
  const lineTotal = qty * price

  doc.font("Helvetica").fontSize(11)

  // Service (avec ellipsis simple si trop long)
  const service = String(item.service || "").trim()
  doc.text(service, colServiceX, y, { width: colServiceW, ellipsis: true })

  doc.text(String(qty), colQtyX, y, { width: colQtyW, align: "center" })
  doc.text(euro(price), colPriceX, y, { width: colPriceW, align: "right" })
  doc.text(euro(lineTotal), colTotalX, y, { width: colTotalW, align: "right" })

  return lineTotal
}
// ===== Infos client (alignées) =====
doc.font("Helvetica").fontSize(11)

const yInfo = doc.y + 10
doc.text(`Client : ${email || "-"}`, left, yInfo, { width: 260 })
doc.text(`Date : ${new Date().toLocaleDateString("fr-FR")}`, 0, yInfo, { align: "right" })

doc.moveDown(2)

// ===== Tableau =====
let y = doc.y + 10
hr(y)               // ligne haut
y += 12

drawHeaderRow(y)
y += rowH

hr(y - 6)           // ligne sous header

let total = 0
items.forEach((it) => {
  total += drawItemRow(y, it)
  y += rowH
})

// ligne fin tableau
hr(y - 6)

// ===== Total (bloc à droite, propre) =====
y += 18
doc.font("Helvetica-Bold").fontSize(12)
doc.text("TOTAL", colPriceX, y, { width: colPriceW, align: "right" })
doc.fontSize(16)
doc.text(euro(total), colTotalX, y - 4, { width: colTotalW, align: "right" })

// Footer
doc.font("Helvetica").fontSize(9)
doc.text("Propulsé par NovaPulse", 0, y + 50, { align: "center" })

doc.end()

await new Promise(resolve => doc.on("end", resolve))

const pdfBuffer = Buffer.concat(buffers)


// ===== SEND TO TELEGRAM =====

const form = new FormData()

form.append("chat_id", STAFF_GROUP_ID)
form.append("message_thread_id", String(topic))
form.append("document", pdfBuffer, {
filename:"quote.pdf",
contentType:"application/pdf"
})

console.log("📤 Sending quote to Telegram topic:", topic)

await axios.post(
`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendDocument`,
form,
{headers: form.getHeaders()}
)

console.log("✅ Quote sent to Telegram successfully")

// ===== SAVE + SEND TO PWA =====

console.log("🔎 Searching Airtable client with topic:", topic)

const records = await tablePWA
.select({
filterByFormula: `{topic_id}='${topic}'`,
maxRecords: 1
})
.firstPage()

if(records.length){

const row = records[0].fields
const emailClient = normEmail(row.email)
const sellerSlug = normSlug(row.seller_slug)

await tableMessages.create({
email: emailClient,
seller_slug: sellerSlug,
topic_id: topic,
sender: "admin",
text: "📄 Nouveau devis disponible"
})

const room = pwaRoom(emailClient, sellerSlug)

console.log("📡 Emitting quote to PWA room:", room)


const quoteUrl = `data:application/pdf;base64,${pdfBuffer.toString("base64")}`

io.to(room).emit("admin_media",{
type:"document",
url: quoteUrl,
fileName:"quote.pdf",
text:"📄 Nouveau devis",
from:"admin"
})

pushPwaHistory(room,{
from:"admin",
type:"media",
mediaType:"document",
url: quoteUrl,
fileName:"quote.pdf",
text:"📄 Nouveau devis"
})

console.log("📄 Quote sent to PWA:", room)

}

res.json({success:true})

}catch(err){

console.error("❌ generate quote error:",err.message)
res.status(500).json({success:false})

}

})


const PORT = process.env.PORT || 10000;

server.listen(PORT, () => {
  console.log(`🚀 Bridge running on port ${PORT}`);
});
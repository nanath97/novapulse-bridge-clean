require("dotenv").config();
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const axios = require("axios");
const Airtable = require("airtable");

console.log("🔥 SERVER.JS BRIDGE LOADED");

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

const multer = require("multer");
const streamifier = require("streamifier");
const cloudinary = require("cloudinary").v2;

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
app.use(express.json({ limit: "20mb" })); // un peu plus safe pour certains payloads

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

function escapeAirtableString(str) {
  // Airtable formula strings use double quotes; we escape them.
  return String(str || "").replace(/"/g, '\\"');
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

    // Only staff supergroup topic messages
    if (
      message.chat?.type === "supergroup" &&
      message.message_thread_id &&
      !message.from?.is_bot
    ) {
      const text = (message.text || "").trim();
      const threadId = String(message.message_thread_id).trim();

      // =========================
      // A) SI on attend une note pour ce topic -> on l'enregistre
      // =========================
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

        // Mise à jour persistante dans Airtable
        await base("PWA Clients").update(record.id, {
          admin_note: merged,
        });

        // 🔥 UPDATE DU PANEL EXISTANT (sans duplication)
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

      // =========================
      // B) ignore /env commands (pour ne pas polluer la PWA)
      // =========================
      if (text.toLowerCase().startsWith("/env")) return res.sendStatus(200);

      // =========================
      // C) admin -> PWA message normal + calcul room
      // =========================
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

      // =========================
      // D) admin -> PWA MEDIA normal (photo / video / document)
      // =========================
      if (message.photo || message.video || message.document) {
        let fileId = null;
        let mediaType = "photo";

        if (message.photo) {
          fileId = message.photo[message.photo.length - 1].file_id;
          mediaType = "photo";
        } else if (message.video) {
          fileId = message.video.file_id;
          mediaType = "video";
        } else if (message.document) {
          fileId = message.document.file_id;
          mediaType = "document";
        }

        if (!fileId) return res.sendStatus(200);

        try {
          // 1) récupérer fichier Telegram
          const fileResp = await axios.get(
            `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getFile?file_id=${fileId}`
          );

          const filePath = fileResp.data.result.file_path;
          const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${filePath}`;

          // 2) télécharger le fichier
          const fileDownload = await axios.get(fileUrl, {
            responseType: "arraybuffer",
          });

          // 3) upload Cloudinary
          const uploadResult = await new Promise((resolve, reject) => {
            const stream = cloudinary.uploader.upload_stream(
              { folder: "novapulse_media" },
              (error, result) => {
                if (error) return reject(error);
                resolve(result);
              }
            );

            streamifier.createReadStream(fileDownload.data).pipe(stream);
          });

          const mediaUrl = uploadResult.secure_url;

          // 4) envoyer à la PWA
          io.to(room).emit("MEDIA_MESSAGE", {
            url: mediaUrl,
            kind: mediaType,
            caption: message.caption || "",
          });

          console.log("📸 MEDIA SENT:", mediaType, mediaUrl);
        } catch (err) {
          console.error("❌ MEDIA NORMAL ERROR:", err.response?.data || err.message);
        }
      }

      return res.sendStatus(200);
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
    console.log("❌ PWA disconnected:", socket.id);
  });
});

// =======================
// UPLOAD MEDIA → CLOUDINARY
// =======================
app.post("/upload-media", upload.single("file"), async (req, res) => {
  console.log("🔥 /upload-media route HIT");

  try {
    console.log("REQ.FILE =", !!req.file);

    if (!req.file) {
      return res.status(400).json({ success: false, error: "No file uploaded" });
    }

    console.log("📤 Uploading media to Cloudinary...");

    const uploadStream = cloudinary.uploader.upload_stream(
      { folder: "novapulse_media" },
      (error, result) => {
        if (error) {
          console.error("❌ Cloudinary error:", error);
          return res
            .status(500)
            .json({ success: false, error: "Cloudinary upload failed" });
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
// PWA: SEND PAID CONTENT (BLUR + CHECKOUT)
// =======================
const pendingPaidContent = {}; // mémoire temporaire (phase test validée)

app.post("/pwa/send-paid-content", async (req, res) => {
  try {
    const { email, sellerSlug, text, checkout_url, mediaUrl, amount, isMedia } =
      req.body;

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

    console.log("🔓 UNLOCK REQUEST:", {
      email,
      sellerSlug,
      contentId,
      sessionId,
      room,
    });

    const pending = pendingPaidContent[room];

    if (!pending) {
      console.warn("⚠️ No pending content found for room:", room);
      return res.json({ success: false, reason: "no_pending_content" });
    }

    console.log("📦 Unlocking media:", pending.mediaUrl);

    io.to(room).emit("paid_content_unlocked", {
      mediaUrl: pending.mediaUrl,
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
// =======================
// PWA: GET LAST 30 MESSAGES HISTORY
// =======================
app.get("/pwa/history", async (req, res) => {
  try {
    const email = normEmail(req.query.email);
    const sellerSlug = normSlug(req.query.sellerSlug);
    const topicId = String(req.query.topicId || "").trim();

    if (!email || !sellerSlug || !topicId) {
      return res.status(400).json({ success: false, error: "Missing params" });
    }

    console.log("📜 HISTORY REQUEST:", email, sellerSlug, topicId);

    const records = await tableMessages
      .select({
        filterByFormula: `AND({email}='${email}', {seller_slug}='${sellerSlug}', {topic_id}='${topicId}')`,
        sort: [{ field: "created_at", direction: "desc" }],
        maxRecords: 30,
      })
      .firstPage();

    const history = records
      .reverse()
      .map((rec) => ({
        text: rec.fields.text || "",
        from: rec.fields.sender === "admin" ? "admin" : "client",
        type: "text",
      }));

    return res.json({ success: true, history });
  } catch (err) {
    console.error("❌ /pwa/history error:", err.message);
    return res.status(500).json({ success: false });
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

    const room = pwaRoom(email, sellerSlug);

    console.log("📩 SEND ADMIN MESSAGE →", room, text);

    io.to(room).emit("admin_message", {
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
// START
// =======================
const PORT = process.env.PORT || 10000;

server.listen(PORT, () => {
  console.log(`🚀 Bridge running on port ${PORT}`);
});
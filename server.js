const express = require("express");
const axios = require("axios");
const cors = require("cors");
const QRCode = require("qrcode");
const admin = require("firebase-admin");
const jwt = require("jsonwebtoken");
const nodemailer = require("nodemailer");
const crypto = require("crypto");

const app = express();

app.use(cors());
app.use(express.json());

const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET;
const JWT_SECRET = process.env.JWT_SECRET || "secret";

// ==========================
// ✅ EMAIL CONFIG (PORT 465 - BREVO)
// ==========================
const EMAIL_USER = process.env.EMAIL_USER;
const EMAIL_PASS = process.env.EMAIL_PASS;

let transporter = null;

if (EMAIL_USER && EMAIL_PASS) {
  try {
    transporter = nodemailer.createTransport({
      host: "mail.starsgospel.ng",
      port: 465,
      secure: true,
      auth: {
        user: EMAIL_USER,
        pass: EMAIL_PASS
      },
      tls: {
        rejectUnauthorized: false
      },
      connectionTimeout: 20000,
      greetingTimeout: 20000,
      socketTimeout: 20000
    });

    console.log("✅ Email transporter ready (PORT 465)");

  } catch (err) {
    console.error("❌ Email setup error:", err.message);
  }
} else {
  console.warn("⚠️ Email credentials not set");
}

// ==========================
// 🔁 EMAIL RETRY FUNCTION
// ==========================
async function sendEmailWithRetry(mailOptions, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      await transporter.sendMail(mailOptions);
      console.log("📧 Email sent successfully");
      return;
    } catch (err) {
      console.error(`❌ Email attempt ${i + 1} failed:`, err.message);

      if (i < retries - 1) {
        await new Promise(res => setTimeout(res, 3000));
      }
    }
  }
}

// ==========================
// 🔥 FIREBASE INIT
// ==========================
let db = null;

try {
  const raw = process.env.FIREBASE_KEY;

  if (raw) {
    const serviceAccount = JSON.parse(raw);

    if (serviceAccount.private_key) {
      serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
    }

    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
      });
    }

    db = admin.firestore();
    console.log("✅ Firebase initialized");
  }

} catch (err) {
  console.error("❌ Firebase init error:", err.message);
}

// ==========================
// 🔐 ADMIN LOGIN
// ==========================
app.post("/admin/login", async (req, res) => {
  const { email, password } = req.body;

  const adminEmail = process.env.ADMIN_EMAIL;
  const adminPassword = process.env.ADMIN_PASSWORD;

  if (email !== adminEmail || password !== adminPassword) {
    return res.status(401).json({ error: "Invalid credentials" });
  }

  const token = jwt.sign({ email }, JWT_SECRET, { expiresIn: "6h" });

  res.json({ token });
});

// ==========================
// 🛡️ MIDDLEWARE
// ==========================
function verifyAdmin(req, res, next) {
  const token = req.headers.authorization?.split(" ")[1];

  if (!token) return res.status(401).json({ error: "No token" });

  try {
    jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(403).json({ error: "Invalid token" });
  }
}

// ==========================
// 📧 TEST EMAIL
// ==========================
app.get("/test-email", async (req, res) => {
  try {
    if (!transporter) return res.status(500).send("Email not configured");

    await transporter.sendMail({
      from: `"STARS Test" <${EMAIL_USER}>`,
      to: EMAIL_USER,
      subject: "Test Email",
      html: "<h2>Email working perfectly</h2>"
    });

    res.send("OK");
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// ==========================
// 📊 ADMIN STATS
// ==========================
app.get("/admin/stats", verifyAdmin, async (req, res) => {
  try {
    const votesSnap = await db.collection("votes").get();
    const jurySnap = await db.collection("jury").get();

    res.json({
      totalVotes: votesSnap.size,
      totalJury: jurySnap.size
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================
// 🆕 QR IMAGE
// ==========================
app.get("/qr/:reference.png", async (req, res) => {
  try {
    const buffer = await QRCode.toBuffer(
      JSON.stringify({ reference: req.params.reference })
    );

    res.setHeader("Content-Type", "image/png");
    res.send(buffer);

  } catch (err) {
    res.status(500).send("QR error");
  }
});

// ==========================
// 🔐 VERIFY (MANUAL FALLBACK)
// ==========================
app.post("/verify", async (req, res) => {
  const { reference, ticket, qty, email, testMode } = req.body;

  try {
    let success = false;

    if (testMode === true) {
      success = true;
    } else {
      const response = await axios.get(
        "https://api.paystack.co/transaction/verify/" + reference,
        {
          headers: {
            Authorization: "Bearer " + PAYSTACK_SECRET
          }
        }
      );

      success = response.data.data?.status === "success";
    }

    if (success) {
      const qrData = JSON.stringify({ reference, ticket, qty, email });

      if (db) {
        await db.collection("tickets").doc(reference).set({
          reference,
          ticket,
          qty,
          email,
          qrData,
          used: false,
          createdAt: new Date()
        });
      }

      if (transporter && email) {
        const mailOptions = {
          from: `"STARS Tickets" <${EMAIL_USER}>`,
          to: email,
          subject: "Your Ticket",
          html: `
            <h2>STARS EVENT</h2>
            <p><b>Ticket:</b> ${ticket}</p>
            <p><b>Qty:</b> ${qty}</p>
            <p><b>Ref:</b> ${reference}</p>
            <img src="https://stars-ticket-backend.onrender.com/qr/${reference}.png" width="250"/>
          `
        };

        sendEmailWithRetry(mailOptions);
      }

      return res.json({ success: true, reference });
    }

    res.json({ success: false });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================
// 🆕 PAYSTACK WEBHOOK (NEW - PRIMARY FLOW)
// ==========================
app.post("/paystack-webhook", async (req, res) => {
  try {
    const hash = crypto
      .createHmac("sha512", PAYSTACK_SECRET)
      .update(JSON.stringify(req.body))
      .digest("hex");

    if (hash !== req.headers["x-paystack-signature"]) {
      return res.status(401).send("Invalid signature");
    }

    const event = req.body;

    if (event.event === "charge.success") {
      const data = event.data;

      const reference = data.reference;
      const email = data.customer.email;
      const amount = data.amount;

      const ticket = data.metadata?.ticket || "STANDARD";
      const qty = data.metadata?.qty || 1;

      const qrData = JSON.stringify({ reference, ticket, qty, email });

      if (db) {
        await db.collection("tickets").doc(reference).set({
          reference,
          ticket,
          qty,
          email,
          qrData,
          used: false,
          createdAt: new Date()
        });
      }

      if (transporter && email) {
        const mailOptions = {
          from: `"STARS Tickets" <${EMAIL_USER}>`,
          to: email,
          subject: "Your STARS Ticket 🎟️",
          html: `
            <h2>STARS GRAND FINALE</h2>
            <p><b>Ticket:</b> ${ticket}</p>
            <p><b>Qty:</b> ${qty}</p>
            <p><b>Ref:</b> ${reference}</p>
            <img src="https://stars-ticket-backend.onrender.com/qr/${reference}.png" width="250"/>
          `
        };

        sendEmailWithRetry(mailOptions);
      }
    }

    res.sendStatus(200);

  } catch (err) {
    console.error(err.message);
    res.sendStatus(500);
  }
});

// ==========================
// 🎫 SCAN
// ==========================
app.post("/scan", async (req, res) => {
  const { reference } = req.body;

  const doc = await db.collection("tickets").doc(reference).get();

  if (!doc.exists) {
    return res.json({ success: false });
  }

  const data = doc.data();

  if (data.used) {
    return res.json({ success: false, message: "Used" });
  }

  await doc.ref.update({ used: true });

  res.json({ success: true, ticket: data });
});

// ==========================
// ROOT
// ==========================
app.get("/", (req, res) => {
  res.send("STARS backend running");
});

// ==========================
const PORT = process.env.PORT || 10000;

app.listen(PORT, () => {
  console.log("Server running on " + PORT);
});

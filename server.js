const express = require("express");
const axios = require("axios");
const cors = require("cors");
const QRCode = require("qrcode");
const admin = require("firebase-admin");
const jwt = require("jsonwebtoken");
const nodemailer = require("nodemailer");

const app = express();

app.use(cors());
app.use(express.json());

const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET;
const JWT_SECRET = process.env.JWT_SECRET || "secret";

// ==========================
// ✅ EMAIL CONFIG (UPDATED)
// ==========================
const EMAIL_USER = process.env.EMAIL_USER;
const EMAIL_PASS = process.env.EMAIL_PASS;

let transporter = null;

if (EMAIL_USER && EMAIL_PASS) {
  try {
    transporter = nodemailer.createTransport({
      host: "mail.starsgospel.ng",
      port: 587,
      secure: false,
      auth: {
        user: EMAIL_USER,
        pass: EMAIL_PASS
      },
      tls: {
        rejectUnauthorized: false
      }
    });

    console.log("✅ Email transporter ready");

  } catch (err) {
    console.error("❌ Email setup error:", err.message);
  }
} else {
  console.warn("⚠️ Email credentials not set");
}

// ==========================
// 🔥 FIREBASE INIT (SAFE)
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
// 📧 TEST EMAIL ROUTE
// ==========================
app.get("/test-email", async (req, res) => {
  try {

    if (!transporter) {
      return res.status(500).send("❌ Email not configured");
    }

    await transporter.sendMail({
      from: `"STARS Test" <${EMAIL_USER}>`,
      to: EMAIL_USER,
      subject: "Test Email from STARS 🚀",
      html: "<h2>Email is working perfectly ✅</h2>"
    });

    res.send("✅ Test email sent successfully");

  } catch (err) {
    console.error("❌ Test email error:", err.message);
    res.status(500).send("❌ Email failed: " + err.message);
  }
});

// ==========================
// 📊 ADMIN STATS
// ==========================
app.get("/admin/stats", verifyAdmin, async (req, res) => {
  try {
    if (!db) throw new Error("DB not ready");

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
// 🧑‍⚖️ ADMIN JURY VIEW
// ==========================
app.get("/admin/jury", verifyAdmin, async (req, res) => {
  try {
    if (!db) throw new Error("DB not ready");

    const snapshot = await db.collection("jury").get();

    const data = [];
    snapshot.forEach(doc => data.push({ id: doc.id, ...doc.data() }));

    res.json(data);

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================
// 📊 VOTER HISTORY
// ==========================
app.get("/admin/voter-history", verifyAdmin, async (req, res) => {
  try {
    if (!db) throw new Error("DB not ready");

    const snapshot = await db.collection("votes").orderBy("createdAt", "desc").get();

    const votes = [];
    snapshot.forEach(doc => votes.push({ id: doc.id, ...doc.data() }));

    res.json(votes);

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================
// 🧹 DELETE SINGLE VOTE
// ==========================
app.delete("/admin/vote/:id", verifyAdmin, async (req, res) => {
  try {
    if (!db) throw new Error("DB not ready");

    await db.collection("votes").doc(req.params.id).delete();

    res.json({ success: true, message: "Vote deleted" });

  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==========================
// 🧹 DELETE ALL VOTES
// ==========================
app.delete("/admin/votes/reset", verifyAdmin, async (req, res) => {
  try {
    if (!db) throw new Error("DB not ready");

    const snapshot = await db.collection("votes").get();
    const batch = db.batch();

    snapshot.forEach(doc => batch.delete(doc.ref));

    await batch.commit();

    res.json({ success: true, message: "All votes deleted" });

  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==========================
// 🧹 RESET JURY SCORES
// ==========================
app.delete("/admin/jury/reset", verifyAdmin, async (req, res) => {
  try {
    if (!db) throw new Error("DB not ready");

    const snapshot = await db.collection("jury").get();
    const batch = db.batch();

    snapshot.forEach(doc => batch.delete(doc.ref));

    await batch.commit();

    res.json({ success: true, message: "All jury scores deleted" });

  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==========================
// 🔐 VERIFY PAYMENT (EMAIL + QR + TEST MODE)
// ==========================
app.post("/verify", async (req, res) => {
  const { reference, ticket, qty, email, testMode } = req.body;

  try {

    let success = false;

    // ✅ TEST MODE (bypass Paystack)
    if (testMode === true) {
      console.log("🧪 TEST MODE ACTIVE");
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

      const data = response.data.data;
      success = data && data.status === "success";
    }

    if (success) {

      const qrData = JSON.stringify({ reference, ticket, qty, email });
      const qrImage = await QRCode.toDataURL(qrData);

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
        try {
          await transporter.sendMail({
            from: `"STARS Tickets" <${EMAIL_USER}>`,
            to: email,
            subject: "Your STARS Ticket 🎟️",
            html: `
              <h2>STARS GRAND FINALE</h2>
              <p><b>Ticket:</b> ${ticket}</p>
              <p><b>Qty:</b> ${qty}</p>
              <p><b>Ref:</b> ${reference}</p>
              <br/>
              <img src="${qrImage}" style="width:250px;" />
            `
          });

          console.log("📧 Email sent");

        } catch (mailErr) {
          console.error("❌ Email failed:", mailErr.message);
        }
      }

      return res.json({
        success: true,
        qr: qrImage,
        reference
      });

    } else {
      return res.json({
        success: false,
        message: "Payment not successful"
      });
    }

  } catch (error) {
    return res.status(500).json({
      error: "Verification failed",
      details: error.response?.data || error.message
    });
  }
});

// ==========================
// 🎫 SCAN
// ==========================
app.post("/scan", async (req, res) => {
  const { reference } = req.body;

  try {
    if (!db) throw new Error("Database not initialized");

    const docRef = db.collection("tickets").doc(reference);
    const doc = await docRef.get();

    if (!doc.exists) {
      return res.json({ success: false, message: "Invalid ticket" });
    }

    const ticketData = doc.data();

    if (ticketData.used) {
      return res.json({ success: false, message: "Ticket already used" });
    }

    await docRef.update({
      used: true,
      usedAt: new Date()
    });

    return res.json({
      success: true,
      message: "Access granted",
      ticket: ticketData
    });

  } catch (err) {
    res.status(500).json({
      success: false,
      message: "Server error",
      error: err.message
    });
  }
});

// ==========================
// ROOT
// ==========================
app.get("/", (req, res) => {
  res.send("STARS backend running 🚀");
});

// ==========================
// START SERVER
// ==========================
const PORT = process.env.PORT || 10000;

app.listen(PORT, () => {
  console.log("🚀 Server running on port " + PORT);
});

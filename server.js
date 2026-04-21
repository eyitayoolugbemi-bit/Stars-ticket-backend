const express = require("express");
const axios = require("axios");
const cors = require("cors");
const QRCode = require("qrcode");
const admin = require("firebase-admin");
const jwt = require("jsonwebtoken");

const app = express();

app.use(cors());
app.use(express.json());

const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET;
const JWT_SECRET = process.env.JWT_SECRET || "secret";

// ==========================
// 📧 BREVO EMAIL ONLY CONFIG
// ==========================
const BREVO_API_KEY = process.env.BREVO_API_KEY;
const EMAIL_USER = process.env.EMAIL_USER; // sender email (verified in Brevo)

// ==========================
// 📧 BREVO EMAIL FUNCTION
// ==========================
async function sendEmail(mailOptions) {
  try {
    if (!BREVO_API_KEY) {
      console.error("❌ BREVO_API_KEY not set");
      return;
    }

    await axios.post(
      "https://api.brevo.com/v3/smtp/email",
      {
        sender: {
          name: "STARS Tickets",
          email: EMAIL_USER
        },
        to: [{ email: mailOptions.to }],
        subject: mailOptions.subject,
        htmlContent: mailOptions.html
      },
      {
        headers: {
          "api-key": BREVO_API_KEY,
          "Content-Type": "application/json"
        }
      }
    );

    console.log("📧 Email sent via Brevo");

  } catch (err) {
    console.error("❌ Brevo email failed:", err.response?.data || err.message);
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
      serviceAccount.private_key =
        serviceAccount.private_key.replace(/\\n/g, "\n");
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
// 📧 TEST EMAIL (BREVO)
// ==========================
app.get("/test-email", async (req, res) => {
  try {
    await sendEmail({
      to: EMAIL_USER,
      subject: "STARS Test Email 🚀",
      html: "<h2>Email system (Brevo) is working perfectly ✅</h2>"
    });

    res.send("✅ Test email sent via Brevo");

  } catch (err) {
    res.status(500).send("❌ Email failed");
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
// 🆕 QR IMAGE ENDPOINT
// ==========================
app.get("/qr/:reference.png", async (req, res) => {
  try {
    const { reference } = req.params;

    const buffer = await QRCode.toBuffer(
      JSON.stringify({ reference })
    );

    res.setHeader("Content-Type", "image/png");
    res.send(buffer);

  } catch (err) {
    res.status(500).send("QR generation failed");
  }
});

// ==========================
// 🔐 VERIFY PAYMENT
// ==========================
app.post("/verify", async (req, res) => {
  const { reference, ticket, qty, email, testMode } = req.body;

  try {

    let success = false;

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

      // 📧 SEND EMAIL VIA BREVO
      if (email) {
        sendEmail({
          to: email,
          subject: "Your STARS Ticket 🎟️",
          html: `
            <h2>STARS GRAND FINALE</h2>
            <p><b>Ticket:</b> ${ticket}</p>
            <p><b>Qty:</b> ${qty}</p>
            <p><b>Ref:</b> ${reference}</p>
            <br/>
            <img src="https://stars-ticket-backend.onrender.com/qr/${reference}.png" style="width:250px;" />
          `
        });
      }

      return res.json({ success: true, reference });
    }

    return res.json({
      success: false,
      message: "Payment not successful"
    });

  } catch (error) {
    return res.status(500).json({
      error: "Verification failed",
      details: error.message
    });
  }
});

// ==========================
// 🎫 SCAN
// ==========================
app.post("/scan", async (req, res) => {
  const { reference } = req.body;

  try {
    if (!db) throw new Error("DB not initialized");

    const docRef = db.collection("tickets").doc(reference);
    const doc = await docRef.get();

    if (!doc.exists) {
      return res.json({ success: false, message: "Invalid ticket" });
    }

    const data = doc.data();

    if (data.used) {
      return res.json({ success: false, message: "Already used" });
    }

    await docRef.update({
      used: true,
      usedAt: new Date()
    });

    return res.json({
      success: true,
      message: "Access granted",
      ticket: data
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
  res.send("STARS backend running 🚀 (Brevo Email Active)");
});

// ==========================
// START SERVER
// ==========================
const PORT = process.env.PORT || 10000;

app.listen(PORT, () => {
  console.log("🚀 Server running on port " + PORT);
});

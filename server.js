const express = require("express");
const axios = require("axios");
const cors = require("cors");
const QRCode = require("qrcode");
const admin = require("firebase-admin");

const app = express();

app.use(cors());
app.use(express.json());

const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET;

// ==========================
// 🔥 FIREBASE INIT (SAFE)
// ==========================
let db = null;

try {
  const raw = process.env.FIREBASE_KEY;

  if (raw) {
    const serviceAccount = JSON.parse(raw);
    serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');

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
// 🔐 VERIFY PAYMENT
// ==========================
app.post("/verify", async (req, res) => {
  const { reference, ticket, qty, email } = req.body;

  try {
    const response = await axios.get(
      "https://api.paystack.co/transaction/verify/" + reference,
      {
        headers: {
          Authorization: "Bearer " + PAYSTACK_SECRET
        }
      }
    );

    const data = response.data.data;

    if (data && data.status === "success") {

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
// 📊 TICKETS
// ==========================
app.get("/tickets", async (req, res) => {
  try {
    if (!db) throw new Error("DB not ready");

    const snapshot = await db.collection("tickets").get();

    const tickets = [];
    snapshot.forEach(doc => tickets.push(doc.data()));

    res.json({ success: true, count: tickets.length, tickets });

  } catch (err) {
    res.status(500).json({
      success: false,
      message: "Failed to fetch tickets",
      error: err.message
    });
  }
});


// ==========================
// 🗳️ VOTING (FRONTEND MATCHED)
// ==========================

// Vote
app.post("/api/vote", async (req, res) => {
  try {
    if (!db) throw new Error("DB not ready");

    const { contestant, votes, paymentRef, email, amount, referral } = req.body;

    if (!contestant || !votes || !email) {
      return res.status(400).json({ success: false, message: "Missing fields" });
    }

    await db.collection("votes").add({
      contestant,
      votes,
      paymentRef,
      email,
      amount,
      referral,
      createdAt: new Date()
    });

    res.json({ success: true });

  } catch (err) {
    res.status(500).json({
      success: false,
      message: "Vote failed",
      error: err.message
    });
  }
});


// Leaderboard
app.get("/api/leaderboard", async (req, res) => {
  try {
    if (!db) throw new Error("DB not ready");

    const snapshot = await db.collection("votes").get();

    const counts = {};

    snapshot.forEach(doc => {
      const data = doc.data();
      counts[data.contestant] = (counts[data.contestant] || 0) + data.votes;
    });

    const leaderboard = Object.keys(counts).map(code => ({
      code: code,
      votes: counts[code],
      jury: 0,
      total: counts[code]
    }));

    res.json(leaderboard);

  } catch (err) {
    res.status(500).json({
      success: false,
      message: "Leaderboard failed",
      error: err.message
    });
  }
});


// Jury
app.post("/api/jury", async (req, res) => {
  try {
    if (!db) throw new Error("DB not ready");

    const { contestant, score, email } = req.body;

    if (!contestant || !score || !email) {
      return res.status(400).json({ success: false, message: "Missing fields" });
    }

    await db.collection("jury").add({
      contestant,
      score,
      email,
      createdAt: new Date()
    });

    res.json({ success: true });

  } catch (err) {
    res.status(500).json({
      success: false,
      message: "Jury failed",
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
// FIREBASE TEST
// ==========================
app.get("/test-db", async (req, res) => {
  try {
    if (!db) throw new Error("DB not ready");

    await db.collection("test").doc("check").set({
      status: "connected",
      time: new Date()
    });

    res.send("Firebase connected");

  } catch (err) {
    res.status(500).json({
      message: "Error connecting to Firebase",
      error: err.message
    });
  }
});


// ==========================
// START SERVER
// ==========================
const PORT = process.env.PORT || 10000;

app.listen(PORT, () => {
  console.log("🚀 Server running on port " + PORT);
});

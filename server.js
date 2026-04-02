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
// 📊 ADMIN - ALL VOTES
// ==========================
app.get("/admin/votes", verifyAdmin, async (req, res) => {
  try {
    if (!db) throw new Error("DB not ready");

    const snapshot = await db.collection("votes").orderBy("createdAt","desc").get();

    const votes = [];
    snapshot.forEach(doc => votes.push(doc.data()));

    res.json(votes);

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================
// 📊 ADMIN - ALL JURY
// ==========================
app.get("/admin/jury", verifyAdmin, async (req, res) => {
  try {
    if (!db) throw new Error("DB not ready");

    const snapshot = await db.collection("jury").orderBy("createdAt","desc").get();

    const jury = [];
    snapshot.forEach(doc => jury.push(doc.data()));

    res.json(jury);

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================
// 📊 ADMIN - LEADERBOARD
// ==========================
app.get("/admin/leaderboard", verifyAdmin, async (req, res) => {
  try {
    if (!db) throw new Error("DB not ready");

    const votesSnap = await db.collection("votes").get();
    const jurySnap = await db.collection("jury").get();

    const votes = {};
    const jury = {};

    votesSnap.forEach(doc => {
      const d = doc.data();
      votes[d.contestant] = (votes[d.contestant] || 0) + d.votes;
    });

    jurySnap.forEach(doc => {
      const d = doc.data();
      jury[d.contestant] = (jury[d.contestant] || 0) + d.score;
    });

    const allContestants = new Set([...Object.keys(votes), ...Object.keys(jury)]);

    const leaderboard = [];

    allContestants.forEach(code => {
      const v = votes[code] || 0;
      const j = jury[code] || 0;

      const total = (v * 0.7) + (j * 0.3);

      leaderboard.push({
        code,
        votes: v,
        jury: j,
        total
      });
    });

    leaderboard.sort((a, b) => b.total - a.total);

    res.json(leaderboard);

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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
// 🗳️ VOTING
// ==========================
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

// ==========================
// 🧠 LEADERBOARD (PUBLIC)
// ==========================
app.get("/api/leaderboard", async (req, res) => {
  try {
    if (!db) throw new Error("DB not ready");

    const votesSnap = await db.collection("votes").get();
    const jurySnap = await db.collection("jury").get();

    const votes = {};
    const jury = {};

    votesSnap.forEach(doc => {
      const d = doc.data();
      votes[d.contestant] = (votes[d.contestant] || 0) + d.votes;
    });

    jurySnap.forEach(doc => {
      const d = doc.data();
      jury[d.contestant] = (jury[d.contestant] || 0) + d.score;
    });

    const allContestants = new Set([...Object.keys(votes), ...Object.keys(jury)]);

    const leaderboard = [];

    allContestants.forEach(code => {
      const v = votes[code] || 0;
      const j = jury[code] || 0;

      const total = (v * 0.7) + (j * 0.3);

      leaderboard.push({
        code,
        votes: v,
        jury: j,
        total
      });
    });

    leaderboard.sort((a, b) => b.total - a.total);

    res.json(leaderboard);

  } catch (err) {
    res.status(500).json({
      success: false,
      message: "Leaderboard failed",
      error: err.message
    });
  }
});

// ==========================
// 🧑‍⚖️ JURY
// ==========================
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
// START SERVER
// ==========================
const PORT = process.env.PORT || 10000;

app.listen(PORT, () => {
  console.log("🚀 Server running on port " + PORT);
});

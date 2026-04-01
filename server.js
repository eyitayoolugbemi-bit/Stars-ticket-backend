const express = require("express");
const axios = require("axios");
const cors = require("cors");
const QRCode = require("qrcode");
const admin = require("firebase-admin");

const app = express();

app.use(cors());
app.use(express.json());

const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET;

// 🔥 SAFE FIREBASE INITIALIZATION
let db = null;

try {
  const raw = process.env.FIREBASE_KEY;

  if (!raw) {
    throw new Error("FIREBASE_KEY is missing from environment variables");
  }

  const serviceAccount = JSON.parse(raw);

  // Fix private key formatting
  serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');

  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
  }

  db = admin.firestore();

  console.log("✅ Firebase initialized successfully");

} catch (err) {
  console.error("❌ Firebase initialization error:");
  console.error(err.message);
}

// ✅ VERIFY ROUTE (WITH FIREBASE STORAGE)
app.post("/verify", async (req, res) => {
  const { reference, ticket, qty, email } = req.body;

  console.log("🔥 VERIFY HIT:", req.body);

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

      const qrData = JSON.stringify({
        reference,
        ticket,
        qty,
        email
      });

      const qrImage = await QRCode.toDataURL(qrData);

      // Save to Firebase
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

        console.log("✅ Ticket saved to Firebase");
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
    console.error("❌ VERIFY ERROR:", error.response?.data || error.message);

    return res.status(500).json({
      error: "Verification failed",
      details: error.response?.data || error.message
    });
  }
});

// ✅ SCAN ROUTE (VALIDATE TICKET)
app.post("/scan", async (req, res) => {
  const { reference } = req.body;

  console.log("🔍 SCAN REQUEST:", reference);

  try {
    if (!db) {
      throw new Error("Firestore not initialized");
    }

    const docRef = db.collection("tickets").doc(reference);
    const doc = await docRef.get();

    if (!doc.exists) {
      return res.json({
        success: false,
        message: "Invalid ticket"
      });
    }

    const ticketData = doc.data();

    if (ticketData.used) {
      return res.json({
        success: false,
        message: "Ticket already used"
      });
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
    console.error("❌ SCAN ERROR:", err.message);

    res.status(500).json({
      success: false,
      message: "Server error",
      error: err.message
    });
  }
});


// ✅ 🔥 ADMIN ROUTE (THIS IS WHAT YOUR ADMIN HTML CALLS)
app.get("/tickets", async (req, res) => {
  try {
    if (!db) {
      throw new Error("Firestore not initialized");
    }

    const snapshot = await db.collection("tickets").get();

    const tickets = [];

    snapshot.forEach(doc => {
      tickets.push(doc.data());
    });

    res.json({
      success: true,
      count: tickets.length,
      tickets
    });

  } catch (err) {
    console.error("❌ TICKETS ERROR:", err.message);

    res.status(500).json({
      success: false,
      message: "Failed to fetch tickets",
      error: err.message
    });
  }
});


// ✅ ROOT TEST
app.get("/", (req, res) => {
  res.send("STARS backend running");
});

// ✅ FIREBASE TEST
app.get("/test-db", async (req, res) => {
  try {
    if (!db) {
      throw new Error("Firestore not initialized");
    }

    await db.collection("test").doc("check").set({
      status: "connected",
      time: new Date()
    });

    res.send("Firebase connected");

  } catch (err) {
    console.error("🔥 FIREBASE ERROR:", err.message);

    res.status(500).json({
      message: "Error connecting to Firebase",
      error: err.message,
      code: err.code || "no-code"
    });
  }
});

// ✅ PORT
const PORT = process.env.PORT || 10000;

app.listen(PORT, () => {
  console.log("🚀 Server running on port " + PORT);
});

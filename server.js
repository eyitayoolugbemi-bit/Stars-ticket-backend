const express = require("express");
const axios = require("axios");
const cors = require("cors");
const QRCode = require("qrcode");
const admin = require("firebase-admin");

const app = express();

app.use(cors());
app.use(express.json());

const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET;

// 🔥 SAFE FIREBASE INITIALIZATION (FULLY FIXED)
let db = null;

try {
  const raw = process.env.FIREBASE_KEY;

  if (!raw) {
    throw new Error("FIREBASE_KEY is missing from environment variables");
  }

  const serviceAccount = JSON.parse(raw);

  // ✅ Fix private key formatting
  serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });

  db = admin.firestore();

  console.log("✅ Firebase initialized successfully");

} catch (err) {
  console.error("❌ Firebase initialization error:");
  console.error(err.message);
}

// ✅ VERIFY ROUTE (STABLE VERSION)
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

    console.log("✅ PAYSTACK:", response.data);

    const data = response.data.data;

    if (data && data.status === "success") {

      const qrData = JSON.stringify({
        reference: reference,
        ticket: ticket,
        qty: qty,
        email: email
      });

      const qrImage = await QRCode.toDataURL(qrData);

      return res.json({
        success: true,
        qr: qrImage,
        reference: reference
      });

    } else {
      return res.json({
        success: false,
        message: "Payment not successful"
      });
    }

  } catch (error) {
    console.error("❌ ERROR:", error.response?.data || error.message);

    return res.status(500).json({
      error: "Verification failed",
      details: error.response?.data || error.message
    });
  }
});

// ✅ ROOT TEST
app.get("/", (req, res) => {
  res.send("STARS backend running");
});

// ✅ FIREBASE TEST ROUTE (NOW SHOWS REAL ERROR)
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
    console.error("🔥 FULL FIREBASE ERROR:", err);

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
  console.log("Server running on port " + PORT);
});

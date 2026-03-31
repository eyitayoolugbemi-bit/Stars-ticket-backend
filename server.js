const express = require("express");
const axios = require("axios");
const cors = require("cors");
const QRCode = require("qrcode");
const admin = require("firebase-admin");

const serviceAccount = JSON.parse(process.env.FIREBASE_KEY);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();
const app = express();

app.use(cors());
app.use(express.json());

const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET;

// ✅ VERIFY ROUTE (STABLE VERSION)
app.post("/verify", async (req, res) => {
  const { reference, ticket, qty, email } = req.body;

  console.log("🔥 VERIFY HIT:", req.body);

  try {
    // 🔹 Call Paystack
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

    // ✅ Check if payment successful
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

// ✅ PORT (IMPORTANT FOR RENDER)
const PORT = process.env.PORT || 10000;

app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});
app.get("/test-db", async (req, res) => {
  try {
    await db.collection("test").doc("check").set({
      status: "connected",
      time: new Date()
    });

    res.send("Firebase connected");
  } catch (err) {
    console.error(err);
    res.status(500).send("Error connecting to Firebase");
  }
});

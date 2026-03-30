const express = require("express");
const axios = require("axios");
const cors = require("cors");
const QRCode = require("qrcode");

const app = express();
app.use(cors());
app.use(express.json());

const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET;

app.post("/verify", async (req, res) => {
  const { reference, ticket, qty, email } = req.body;

  try {
    const verify = await axios.get(
      `https://api.paystack.co/transaction/verify/${reference}`,
      {
        headers: {
          Authorization: `Bearer ${PAYSTACK_SECRET}`
        }
      }
    );

    if (verify.data.data.status === "success") {
      const qrData = JSON.stringify({ ref: reference, ticket, qty, email });
      const qrImage = await QRCode.toDataURL(qrData);

      return res.json({ success: true, qr: qrImage });
    } else {
      return res.json({ success: false });
    }

  } catch (err) {
    return res.status(500).json({ error: "Verification failed" });
  }
});

app.get("/", (req, res) => {
  res.send("STARS backend running");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running on port " + PORT));

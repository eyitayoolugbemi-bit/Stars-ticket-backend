const express = require("express");
const axios = require("axios");
const cors = require("cors");
const QRCode = require("qrcode");

const app = express();
app.use(cors());
app.use(express.json());

const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET;

app.post("/verify", async (req, res) => {
  console.log("REQUEST BODY:", req.body);

  try {
    const { reference, ticket, qty, email } = req.body;

    const verify = await axios.get(
      `https://api.paystack.co/transaction/verify/${reference}`,
      {
        headers: {
          Authorization: `Bearer ${PAYSTACK_SECRET}`
        }
      }
    );

    console.log("PAYSTACK RESPONSE:", verify.data);

    const status = verify?.data?.data?.status;

    if (status === "success") {

      const qrData = JSON.stringify({
        reference,
        ticket,
        qty,
        email
      });

      console.log("QR DATA:", qrData);

      const qrImage = await QRCode.toDataURL(qrData);

      return res.json({
        success: true,
        qr: qrImage
      });

    } else {

      return res.json({
        success: false,
        message: "Payment not successful"
      });

    }

  } catch (err) {

    console.error("ERROR:", err.response?.data || err.message);

    return res.status(500).json({
      error: "Verification failed",
      details: err.response?.data || err.message
    });

  }
});

app.get("/", (req, res) => {
  res.send("STARS backend running");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running on port " + PORT));

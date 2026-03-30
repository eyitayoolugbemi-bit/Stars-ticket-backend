app.post("/verify", async (req, res) => {
  const { reference, ticket, qty, email } = req.body;

  console.log("🔥 VERIFY ROUTE HIT:", req.body);

  try {
    const verify = await axios.get(
      `https://api.paystack.co/transaction/verify/${reference}`,
      {
        headers: {
          Authorization: `Bearer ${PAYSTACK_SECRET}`
        }
      }
    );

    console.log("PAYSTACK RESPONSE:", verify.data);

    const paymentData = verify.data.data;

    if (paymentData.status === "success") {

      const qrData = JSON.stringify({
        ref: reference,
        ticket,
        qty,
        email
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

  } catch (err) {
    console.error("❌ VERIFY ERROR:", err.response?.data || err.message);

    return res.status(500).json({
      error: "Verification failed",
      details: err.response?.data || err.message
    });
  }
});

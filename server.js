const express = require("express");
const axios = require("axios");
const cors = require("cors");
const QRCode = require("qrcode");
const admin = require("firebase-admin");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const PDFDocument = require("pdfkit");
const fs = require("fs");

const app = express();

app.use(cors());
app.use(express.json());

const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET;
const JWT_SECRET = process.env.JWT_SECRET || "secret";

// ==========================
// BREVO API CONFIG (NEW EMAIL SYSTEM)
// ==========================
const BREVO_API_KEY = process.env.BREVO_API_KEY;

// ==========================
// EMAIL VIA BREVO API (REPLACED SMTP)
// ==========================
async function sendEmailWithRetry(payload, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      await axios.post(
        "https://api.brevo.com/v3/smtp/email",
        payload,
        {
          headers: {
            "api-key": BREVO_API_KEY,
            "Content-Type": "application/json",
            "accept": "application/json"
          }
        }
      );

      console.log("📧 Email sent successfully via Brevo API");
      return;

    } catch (err) {
      console.error(`❌ Email attempt ${i + 1} failed:`, err.response?.data || err.message);
      if (i < retries - 1) {
        await new Promise(r => setTimeout(r, 3000));
      }
    }
  }
}

// ==========================
// PDF GENERATOR (UNCHANGED)
// ==========================
async function generateTicketPDF(reference, ticket, qty, email, used = false) {
  const doc = new PDFDocument({ margin: 40 });
  const filePath = `/tmp/${reference}.pdf`;

  const stream = fs.createWriteStream(filePath);
  doc.pipe(stream);

  const qrBuffer = await QRCode.toBuffer(
    JSON.stringify({ reference }),
    { type: "png" }
  );

  doc.fontSize(20).text("STARS GOSPEL MUSIC EXPERIENCE", { align: "center" });
  doc.moveDown();

  doc.fontSize(12);
  doc.text(`Ticket: ${ticket}`);
  doc.text(`Quantity: ${qty}`);
  doc.text(`Reference: ${reference}`);
  doc.text(`Email: ${email}`);

  doc.moveDown(2);
  doc.image(qrBuffer, { fit: [200, 200], align: "center" });

  doc.moveDown();
  doc.fontSize(10).text("Present this QR code at the venue entrance.", { align: "center" });

  if (used) {
    doc.rotate(45, { origin: [300, 300] });
    doc.fontSize(50).fillColor("red").opacity(0.3).text("USED", 150, 300);
    doc.opacity(1).fillColor("black");
  }

  doc.end();

  return new Promise(resolve => {
    stream.on("finish", () => resolve(filePath));
  });
}

// ==========================
// FIREBASE INIT (UNCHANGED)
// ==========================
let db = null;

try {
  const raw = process.env.FIREBASE_KEY;

  if (raw) {
    const serviceAccount = JSON.parse(raw);

    if (serviceAccount.private_key) {
      serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, "\n");
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
// ADMIN LOGIN (UNCHANGED)
// ==========================
app.post("/admin/login", async (req, res) => {
  const { email, password } = req.body;

  if (email !== process.env.ADMIN_EMAIL || password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: "Invalid credentials" });
  }

  const token = jwt.sign({ email }, JWT_SECRET, { expiresIn: "6h" });
  res.json({ token });
});

// ==========================
// QR IMAGE (UNCHANGED)
// ==========================
app.get("/qr/:reference.png", async (req, res) => {
  try {
    const buffer = await QRCode.toBuffer(
      JSON.stringify({ reference: req.params.reference })
    );
    res.setHeader("Content-Type", "image/png");
    res.send(buffer);
  } catch {
    res.status(500).send("QR error");
  }
});

// ==========================
// VERIFY (UNCHANGED LOGIC, ONLY EMAIL SWITCHED)
// ==========================
app.post("/verify", async (req, res) => {
  const { reference, ticket, qty, email, testMode } = req.body;

  try {
    let success = false;

    if (testMode) success = true;
    else {
      const r = await axios.get(
        `https://api.paystack.co/transaction/verify/${reference}`,
        {
          headers: { Authorization: `Bearer ${PAYSTACK_SECRET}` }
        }
      );
      success = r.data.data?.status === "success";
    }

    if (!success) return res.json({ success: false });

    const existing = await db.collection("tickets").doc(reference).get();
    if (existing.exists) return res.json({ success: true, duplicate: true });

    const qrData = JSON.stringify({ reference, ticket, qty, email });

    await db.collection("tickets").doc(reference).set({
      reference,
      ticket,
      qty,
      email,
      qrData,
      used: false,
      createdAt: new Date()
    });

    if (email) {
      const pdfPath = await generateTicketPDF(reference, ticket, qty, email);

      await sendEmailWithRetry({
        sender: {
          name: "STARS Gospel Music Experience",
          email: "info@starsgospel.ng"
        },
        to: [{ email }],
        subject: "Your STARS Ticket 🎟️",
        htmlContent: `
          <h2>STARS GOSPEL MUSIC EXPERIENCE</h2>
          <p><b>Ticket:</b> ${ticket}</p>
          <p><b>Qty:</b> ${qty}</p>
          <p><b>Ref:</b> ${reference}</p>
          <img src="https://stars-ticket-backend.onrender.com/qr/${reference}.png" width="220"/>
        `,
        attachment: [
          {
            name: "ticket.pdf",
            content: fs.readFileSync(pdfPath).toString("base64")
          }
        ]
      });
    }

    res.json({ success: true, reference });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================
// PAYSTACK WEBHOOK (UNCHANGED)
// ==========================
app.post("/paystack-webhook", async (req, res) => {
  try {
    const isTest = req.headers["x-internal-test"] === "true";

    if (!isTest) {
      const hash = crypto.createHmac("sha512", PAYSTACK_SECRET)
        .update(JSON.stringify(req.body))
        .digest("hex");

      if (hash !== req.headers["x-paystack-signature"]) {
        return res.status(401).send("Invalid signature");
      }
    }

    const event = req.body;

    if (event.event === "charge.success") {
      const data = event.data;

      const reference = data.reference;
      const email = data.customer.email;
      const ticket = data.metadata?.ticket || "STANDARD";
      const qty = data.metadata?.qty || 1;

      const existing = await db.collection("tickets").doc(reference).get();
      if (existing.exists) return res.sendStatus(200);

      const qrData = JSON.stringify({ reference, ticket, qty, email });

      await db.collection("tickets").doc(reference).set({
        reference,
        ticket,
        qty,
        email,
        qrData,
        used: false,
        createdAt: new Date()
      });

      if (email) {
        const pdfPath = await generateTicketPDF(reference, ticket, qty, email);

        await sendEmailWithRetry({
          sender: {
            name: "STARS Gospel Music Experience",
            email: "info@starsgospel.ng"
          },
          to: [{ email }],
          subject: "Your STARS Ticket 🎟️",
          htmlContent: `
            <h2>STARS GOSPEL MUSIC EXPERIENCE</h2>
            <p><b>Ticket:</b> ${ticket}</p>
            <p><b>Qty:</b> ${qty}</p>
            <p><b>Ref:</b> ${reference}</p>
            <img src="https://stars-ticket-backend.onrender.com/qr/${reference}.png" width="220"/>
          `,
          attachment: [
            {
              name: "ticket.pdf",
              content: fs.readFileSync(pdfPath).toString("base64")
            }
          ]
        });
      }
    }

    res.sendStatus(200);

  } catch (err) {
    console.error(err.message);
    res.sendStatus(500);
  }
});

// ==========================
// TEST PAYMENT FLOW (UNCHANGED)
// ==========================
app.post("/test-payment-flow", async (req, res) => {
  try {
    const { email, ticket, qty } = req.body;

    const reference = "TEST_" + Date.now();

    const fakeEvent = {
      event: "charge.success",
      data: {
        reference,
        customer: { email: email || "test@starsgospel.ng" },
        metadata: {
          ticket: ticket || "STANDARD",
          qty: qty || 1
        }
      }
    };

    await axios.post(
      "https://stars-ticket-backend.onrender.com/paystack-webhook",
      fakeEvent,
      { headers: { "x-internal-test": "true" } }
    );

    res.json({ success: true, reference, email, ticket, qty });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================
// SCAN (UNCHANGED)
// ==========================
app.post("/scan", async (req, res) => {
  const { reference } = req.body;

  const doc = await db.collection("tickets").doc(reference).get();

  if (!doc.exists) return res.json({ success: false });

  const data = doc.data();

  if (data.used) return res.json({ success: false, message: "Used" });

  await doc.ref.update({ used: true, usedAt: new Date() });

  res.json({ success: true, ticket: data });
});

// ==========================
app.get("/", (req, res) => res.send("STARS backend running"));

const PORT = process.env.PORT || 10000;

app.listen(PORT, () => console.log("Server running on " + PORT));

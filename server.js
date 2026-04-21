const express = require("express");
const axios = require("axios");
const cors = require("cors");
const QRCode = require("qrcode");
const admin = require("firebase-admin");
const jwt = require("jsonwebtoken");
const nodemailer = require("nodemailer");
const crypto = require("crypto");
const PDFDocument = require("pdfkit");
const fs = require("fs");

const app = express();

app.use(cors());
app.use(express.json());

const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET;
const JWT_SECRET = process.env.JWT_SECRET || "secret";

// ==========================
// EMAIL CONFIG (PORT 465)
// ==========================
const EMAIL_USER = process.env.EMAIL_USER;
const EMAIL_PASS = process.env.EMAIL_PASS;

let transporter = null;

if (EMAIL_USER && EMAIL_PASS) {
  try {
    transporter = nodemailer.createTransport({
      host: "mail.starsgospel.ng",
      port: 465,
      secure: true,
      auth: {
        user: EMAIL_USER,
        pass: EMAIL_PASS
      },
      tls: { rejectUnauthorized: false },
      connectionTimeout: 20000,
      greetingTimeout: 20000,
      socketTimeout: 20000
    });

    console.log("✅ Email transporter ready (PORT 465)");
  } catch (err) {
    console.error("❌ Email setup error:", err.message);
  }
}

// ==========================
// PDF GENERATOR (QR + USED WATERMARK)
// ==========================
function generateTicketPDF(reference, ticket, qty, email, used = false) {
  const doc = new PDFDocument({ margin: 40 });
  const filePath = `/tmp/${reference}.pdf`;

  const stream = fs.createWriteStream(filePath);
  doc.pipe(stream);

  const qrUrl = `https://stars-ticket-backend.onrender.com/qr/${reference}.png`;

  doc.fontSize(20).text("STARS GOSPEL MUSIC EXPERIENCE", { align: "center" });
  doc.moveDown();

  doc.fontSize(12);
  doc.text(`Ticket: ${ticket}`);
  doc.text(`Quantity: ${qty}`);
  doc.text(`Reference: ${reference}`);
  doc.text(`Email: ${email}`);

  doc.moveDown(2);

  doc.image(qrUrl, { fit: [200, 200], align: "center" });

  doc.moveDown();
  doc.fontSize(10).text("Present this QR code at the venue entrance.", { align: "center" });

  // WATERMARK IF USED
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
// EMAIL RETRY
// ==========================
async function sendEmailWithRetry(mailOptions, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      await transporter.sendMail(mailOptions);
      console.log("📧 Email sent successfully");
      return;
    } catch (err) {
      console.error(`❌ Email attempt ${i + 1} failed:`, err.message);
      if (i < retries - 1) await new Promise(r => setTimeout(r, 3000));
    }
  }
}

// ==========================
// FIREBASE INIT
// ==========================
let db = null;

try {
  const raw = process.env.FIREBASE_KEY;

  if (raw) {
    const serviceAccount = JSON.parse(raw);

    if (serviceAccount.private_key) {
      serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
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
// ADMIN LOGIN
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
// QR IMAGE
// ==========================
app.get("/qr/:reference.png", async (req, res) => {
  try {
    const buffer = await QRCode.toBuffer(JSON.stringify({ reference: req.params.reference }));
    res.setHeader("Content-Type", "image/png");
    res.send(buffer);
  } catch {
    res.status(500).send("QR error");
  }
});

// ==========================
// VERIFY (FALLBACK)
// ==========================
app.post("/verify", async (req, res) => {
  const { reference, ticket, qty, email, testMode } = req.body;

  try {
    let success = false;

    if (testMode) success = true;
    else {
      const r = await axios.get(`https://api.paystack.co/transaction/verify/${reference}`, {
        headers: { Authorization: `Bearer ${PAYSTACK_SECRET}` }
      });
      success = r.data.data?.status === "success";
    }

    if (!success) return res.json({ success: false });

    const existing = await db.collection("tickets").doc(reference).get();
    if (existing.exists) return res.json({ success: true, duplicate: true });

    const qrData = JSON.stringify({ reference, ticket, qty, email });

    await db.collection("tickets").doc(reference).set({
      reference, ticket, qty, email, qrData, used: false, createdAt: new Date()
    });

    if (transporter && email) {
      const pdfPath = await generateTicketPDF(reference, ticket, qty, email);

      await sendEmailWithRetry({
        from: `"STARS Gospel Music Experience 🎟️" <${EMAIL_USER}>`,
        to: email,
        subject: "Your STARS Ticket 🎟️",
        headers: { "X-Priority": "1", "Importance": "high" },
        text: `Ticket: ${ticket}\nRef: ${reference}`,
        html: `<h2>STARS</h2><p>${ticket}</p><img src="https://stars-ticket-backend.onrender.com/qr/${reference}.png"/>`,
        attachments: [{ filename: "ticket.pdf", path: pdfPath }]
      });
    }

    res.json({ success: true, reference });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================
// PAYSTACK WEBHOOK (PRIMARY)
// ==========================
app.post("/paystack-webhook", async (req, res) => {
  try {
    const hash = crypto.createHmac("sha512", PAYSTACK_SECRET)
      .update(JSON.stringify(req.body))
      .digest("hex");

    if (hash !== req.headers["x-paystack-signature"]) {
      return res.status(401).send("Invalid signature");
    }

    const event = req.body;

    if (event.event === "charge.success") {
      const data = event.data;

      const reference = data.reference;
      const email = data.customer.email;
      const ticket = data.metadata?.ticket || "STANDARD";
      const qty = data.metadata?.qty || 1;

      const existing = await db.collection("tickets").doc(reference).get();
      if (existing.exists) {
        console.log("⚠️ Duplicate webhook ignored:", reference);
        return res.sendStatus(200);
      }

      const qrData = JSON.stringify({ reference, ticket, qty, email });

      await db.collection("tickets").doc(reference).set({
        reference, ticket, qty, email, qrData, used: false, createdAt: new Date()
      });

      if (transporter && email) {
        const pdfPath = await generateTicketPDF(reference, ticket, qty, email);

        await sendEmailWithRetry({
          from: `"STARS Gospel Music Experience 🎟️" <${EMAIL_USER}>`,
          to: email,
          subject: "Your STARS Ticket 🎟️",
          headers: { "X-Priority": "1", "Importance": "high" },
          text: `Ticket: ${ticket}\nRef: ${reference}`,
          html: `<h2>STARS GOSPEL MUSIC EXPERIENCE</h2>
                 <p><b>Ticket:</b> ${ticket}</p>
                 <p><b>Qty:</b> ${qty}</p>
                 <p><b>Ref:</b> ${reference}</p>
                 <img src="https://stars-ticket-backend.onrender.com/qr/${reference}.png" width="220"/>`,
          attachments: [{ filename: "STARS_TICKET.pdf", path: pdfPath }]
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
// SCAN (NOW ADDS USED TIMESTAMP)
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

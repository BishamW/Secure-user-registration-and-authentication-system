import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import { fileURLToPath } from "url";
import nodemailer from "nodemailer";
import twilio from "twilio";
import dotenv from "dotenv";
import bcrypt from "bcryptjs";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  // API Routes
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok" });
  });

  // Nodemailer Transporter
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || "587"),
    secure: false, // true for 465, false for other ports
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });

  // Twilio Client
  const twilioClient = twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
  );

  // --- Security Endpoints ---

  // Hash a value
  app.post("/api/auth/hash", async (req, res) => {
    const { value } = req.body;
    try {
      const salt = await bcrypt.genSalt(10);
      const hash = await bcrypt.hash(value, salt);
      res.json({ hash });
    } catch (error) {
      console.error("Hash error:", error);
      res.status(500).json({ error: "Failed to hash value" });
    }
  });

  // Verify a hash
  app.post("/api/auth/verify", async (req, res) => {
    const { value, hash } = req.body;
    try {
      const isValid = await bcrypt.compare(value, hash);
      res.json({ isValid });
    } catch (error) {
      console.error("Verify error:", error);
      res.status(500).json({ error: "Failed to verify hash" });
    }
  });

  // Send Verification Email
  app.post("/api/auth/send-verification", async (req, res) => {
    const { email, link } = req.body;
    try {
      await transporter.sendMail({
        from: `"SecureGuard" <${process.env.SMTP_USER}>`,
        to: email,
        subject: "Verify your SecureGuard Account",
        text: `Please verify your account by clicking this link: ${link}`,
        html: `<p>Please verify your account by clicking this link: <a href="${link}">${link}</a></p>`,
      });
      res.json({ success: true });
    } catch (error) {
      console.error("Email error:", error);
      res.status(500).json({ error: "Failed to send verification email" });
    }
  });

  // Send SMS (Optional, for phone verification)
  app.post("/api/auth/send-sms", async (req, res) => {
    const { phone, message } = req.body;
    try {
      await twilioClient.messages.create({
        body: message,
        from: process.env.TWILIO_PHONE_NUMBER,
        to: phone,
      });
      res.json({ success: true });
    } catch (error) {
      console.error("Twilio error:", error);
      res.status(500).json({ error: "Failed to send SMS" });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();

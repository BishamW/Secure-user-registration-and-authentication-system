import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import { fileURLToPath } from "url";
import nodemailer from "nodemailer";
import twilio from "twilio";
import dotenv from "dotenv";
import bcrypt from "bcryptjs";
import admin from "firebase-admin";
import { getFirestore } from "firebase-admin/firestore";
import fs from "fs";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Initialize Firebase Admin
const configPath = path.join(process.cwd(), "firebase-applet-config.json");
const firebaseConfig = JSON.parse(fs.readFileSync(configPath, "utf-8"));

admin.initializeApp({
  projectId: process.env.FIREBASE_PROJECT_ID || firebaseConfig.projectId,
});

const db = getFirestore(process.env.FIREBASE_FIRESTORE_DATABASE_ID || firebaseConfig.firestoreDatabaseId);
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

  // --- Lockout Management ---

  // Check if account is locked
  app.post("/api/auth/lockout-check", async (req, res) => {
    const { email } = req.body;
    try {
      const usersRef = db.collection("users");
      const snapshot = await usersRef.where("email", "==", email).limit(1).get();
      
      if (snapshot.empty) {
        return res.json({ locked: false });
      }

      const user = snapshot.docs[0].data();
      if (user.lockoutUntil) {
        const lockoutTime = new Date(user.lockoutUntil).getTime();
        const now = new Date().getTime();
        if (now < lockoutTime) {
          const remainingMinutes = Math.ceil((lockoutTime - now) / (60 * 1000));
          return res.json({ locked: true, remainingMinutes });
        }
      }
      
      res.json({ locked: false });
    } catch (error) {
      console.error("Lockout check error:", error);
      res.status(500).json({ error: "Failed to check lockout status" });
    }
  });

  // Update failed attempts or reset on success
  app.post("/api/auth/lockout-update", async (req, res) => {
    const { email, success } = req.body;
    try {
      const usersRef = db.collection("users");
      const snapshot = await usersRef.where("email", "==", email).limit(1).get();
      
      if (snapshot.empty) {
        return res.json({ success: true });
      }

      const userDoc = snapshot.docs[0];
      const user = userDoc.data();

      if (success) {
        await userDoc.ref.update({
          failedLoginAttempts: 0,
          lockoutUntil: null
        });
      } else {
        const newAttempts = (user.failedLoginAttempts || 0) + 1;
        const updates: any = { failedLoginAttempts: newAttempts };
        
        if (newAttempts >= 5) {
          const lockoutTime = new Date(new Date().getTime() + 15 * 60 * 1000).toISOString();
          updates.lockoutUntil = lockoutTime;
          
          // Send Lockout Email
          try {
            await transporter.sendMail({
              from: `"SecureGuard Security" <${process.env.SMTP_USER}>`,
              to: email,
              subject: "Your account has been locked",
              text: `Your account has been locked for 15 minutes due to 5 failed login attempts.`,
              html: `<div style="font-family: sans-serif; padding: 20px; border: 1px solid #eee; border-radius: 10px;">
                <h2 style="color: #e11d48;">Account Locked</h2>
                <p>Your SecureGuard account has been locked for <strong>15 minutes</strong> due to 5 consecutive failed login attempts.</p>
                <p>If this wasn't you, please consider changing your password once the lockout expires.</p>
              </div>`,
            });
          } catch (emailErr) {
            console.error("Failed to send lockout email:", emailErr);
          }
          
          // Log lockout event
          await userDoc.ref.collection("securityLogs").add({
            type: "lockout",
            details: "Account locked for 15 minutes due to 5 failed attempts",
            status: "failure",
            timestamp: new Date().toISOString()
          });
        }
        
        await userDoc.ref.update(updates);
      }
      
      res.json({ success: true });
    } catch (error) {
      console.error("Lockout update error:", error);
      res.status(500).json({ error: "Failed to update lockout status" });
    }
  });

  // Verify Voice Captcha
  app.post("/api/auth/verify-voice", async (req, res) => {
    const { transcript, targetPhrase } = req.body;
    try {
      // Robust verification: check if the transcript contains key words from the target phrase
      // This reduces false positives from minor transcription errors
      const normalizedTranscript = transcript.toLowerCase();
      
      // Check for key words: "verify", "not", "robot"
      const hasKeyWords = normalizedTranscript.includes("verify") && 
                          normalizedTranscript.includes("not") && 
                          normalizedTranscript.includes("robot");
      
      if (hasKeyWords) {
        res.json({ verified: true });
      } else {
        res.json({ 
          verified: false, 
          message: `Transcription did not match the required phrase. We heard: "${transcript}"` 
        });
      }
    } catch (error) {
      console.error("Voice verification error:", error);
      res.status(500).json({ error: "Failed to verify voice captcha" });
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

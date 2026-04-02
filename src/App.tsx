import React, { useState, useEffect, useRef } from 'react';
import { 
  onAuthStateChanged, 
  signInWithEmailAndPassword, 
  createUserWithEmailAndPassword, 
  signInWithPopup,
  signOut, 
  sendEmailVerification,
  updatePassword,
  User
} from 'firebase/auth';
import { 
  doc, 
  getDoc, 
  setDoc, 
  updateDoc, 
  collection, 
  addDoc, 
  query, 
  where, 
  getDocs, 
  orderBy, 
  limit,
  Timestamp
} from 'firebase/firestore';
import { auth, db, googleProvider } from './firebase';
import { Shield, Lock, User as UserIcon, Mail, Phone, Globe, Mic, CheckCircle, AlertTriangle, Key, RefreshCw, LogOut, X, Activity, Clock, Volume2 } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { cn } from './lib/utils';
import { GoogleGenAI } from "@google/genai";

// --- Types ---
interface UserProfile {
  uid: string;
  fullName: string;
  email: string;
  phone: string;
  country: string;
  isVerified: boolean;
  passwordChangedAt: string;
  lastPinVerifiedAt: string;
  pinHash: string;
  failedLoginAttempts: number;
  lockoutUntil: string | null;
}

interface SecurityLog {
  id?: string;
  type: 'login' | 'failed_login' | 'password_change' | '2fa_success' | '2fa_failure' | 'signup' | 'lockout';
  details: string;
  status: 'success' | 'failure';
  timestamp: string;
  ip?: string; // Optional for simulation
}

// --- Helper Functions ---

const getPasswordStrength = (password: string) => {
  let score = 0;
  if (!password) return { score, label: 'None', color: 'bg-slate-200' };
  if (password.length >= 8) score++;
  if (/[A-Z]/.test(password)) score++;
  if (/[0-9]/.test(password)) score++;
  if (/[^A-Za-z0-9]/.test(password)) score++;

  if (score <= 1) return { score, label: 'Weak', color: 'bg-red-500' };
  if (score <= 3) return { score, label: 'Medium', color: 'bg-orange-500' };
  return { score, label: 'Strong', color: 'bg-green-500' };
};

const PasswordStrengthIndicator = ({ password }: { password: string }) => {
  const { score, label, color } = getPasswordStrength(password);
  if (!password) return null;

  return (
    <div className="space-y-1.5">
      <div className="flex justify-between items-center">
        <span className="text-[10px] uppercase tracking-wider font-bold text-slate-400">Strength</span>
        <span className={cn("text-[10px] uppercase tracking-wider font-bold", color.replace('bg-', 'text-'))}>{label}</span>
      </div>
      <div className="h-1.5 w-full bg-slate-100 rounded-full overflow-hidden">
        <motion.div 
          initial={{ width: 0 }}
          animate={{ width: `${(score / 4) * 100}%` }}
          className={cn("h-full transition-all duration-500", color)}
        />
      </div>
    </div>
  );
};

const logSecurityEvent = async (uid: string, type: SecurityLog['type'], details: string, status: SecurityLog['status']) => {
  try {
    await addDoc(collection(db, `users/${uid}/securityLogs`), {
      type,
      details,
      status,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    if (isAbortError(err)) return;
    console.error("Failed to log security event:", err);
  }
};

const isAbortError = (err: any) => {
  const message = err.message?.toLowerCase() || '';
  return (
    message.includes('aborted') ||
    message.includes('failed to fetch') ||
    message.includes('signal is aborted') ||
    err.name === 'AbortError' ||
    err.code === 'auth/popup-closed-by-user'
  );
};

// --- Components ---

const VoiceCaptcha = ({ onVerified }: { onVerified: () => void }) => {
  const [isRecording, setIsRecording] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [error, setError] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const targetPhrase = "Hi this is to verify that I am not a robot";

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream);
      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      mediaRecorder.onstop = async () => {
        const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
        await processAudio(audioBlob);
        stream.getTracks().forEach(track => track.stop());
      };

      mediaRecorder.start();
      setIsRecording(true);
      setError('');
      setTranscript('');

      // Auto-stop after 5 seconds
      setTimeout(() => {
        if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
          mediaRecorderRef.current.stop();
          setIsRecording(false);
        }
      }, 5000);
    } catch (err) {
      setError("Microphone access denied or not available.");
      console.error(err);
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
    }
  };

  const processAudio = async (audioBlob: Blob) => {
    setIsProcessing(true);
    setError('');
    
    try {
      // 1. Convert Blob to base64
      const reader = new FileReader();
      const base64Promise = new Promise<string>((resolve) => {
        reader.onloadend = () => {
          const base64 = (reader.result as string).split(',')[1];
          resolve(base64);
        };
      });
      reader.readAsDataURL(audioBlob);
      const base64Audio = await base64Promise;

      // 2. Call Gemini for STT (Frontend call as per guidelines)
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });
      const model = "gemini-3-flash-preview";
      
      const result = await ai.models.generateContent({
        model,
        contents: {
          parts: [
            {
              inlineData: {
                mimeType: audioBlob.type || "audio/webm",
                data: base64Audio,
              },
            },
            {
              text: `Transcribe the audio exactly. If the user said something close to "${targetPhrase}", just return that exact phrase. Otherwise, return the actual transcription.`,
            },
          ],
        },
      });

      const text = result.text?.trim() || '';
      setTranscript(text);

      // 3. Send to Backend for Verification & Logging
      const response = await fetch('/api/auth/verify-voice', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          transcript: text, 
          targetPhrase,
          audioData: base64Audio // Optional: for backend audit
        })
      });

      const data = await response.json();

      if (data.verified) {
        onVerified();
      } else {
        setError(data.message || "Voice verification failed. Please try again.");
      }
    } catch (err: any) {
      setError("Verification failed: " + (err.message || "Unknown error"));
      console.error(err);
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <div className="p-4 border border-slate-200 rounded-xl bg-slate-50/50 space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm font-semibold text-slate-700">Voice Captcha</p>
        {(isRecording || isProcessing) && (
          <div className="flex items-center gap-1.5">
            <span className={cn("w-2 h-2 rounded-full", isRecording ? "bg-red-500 animate-ping" : "bg-blue-500 animate-pulse")} />
            <span className={cn("text-[10px] uppercase tracking-wider font-bold", isRecording ? "text-red-500" : "text-blue-500")}>
              {isRecording ? "Live" : "Processing"}
            </span>
          </div>
        )}
      </div>
      <p className="text-xs text-slate-500">Say clearly:</p>
      <p className="text-base font-bold italic text-blue-600 bg-white p-2 rounded border border-blue-100">"{targetPhrase}"</p>
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={isRecording ? stopRecording : startRecording}
          disabled={isProcessing}
          className={cn(
            "flex items-center gap-2 px-4 py-2 rounded-lg font-medium transition-all shadow-sm disabled:opacity-50",
            isRecording 
              ? "bg-red-100 text-red-600 hover:bg-red-200" 
              : "bg-blue-600 text-white hover:bg-blue-700"
          )}
        >
          {isProcessing ? (
            <RefreshCw className="w-4 h-4 animate-spin" />
          ) : (
            <Mic className={cn("w-4 h-4", isRecording && "animate-pulse")} />
          )}
          {isProcessing ? "Verifying..." : isRecording ? "Stop Recording" : "Start Voice Verification"}
        </button>
      </div>
      {transcript && (
        <div className="p-2 bg-white rounded border border-slate-100">
          <p className="text-[10px] uppercase text-slate-400 font-bold mb-1">Transcription</p>
          <p className="text-xs text-slate-600 italic">"{transcript}"</p>
        </div>
      )}
      {error && (
        <div className="flex items-center gap-2 text-red-500 bg-red-50 p-2 rounded border border-red-100">
          <AlertTriangle className="w-3 h-3" />
          <p className="text-[10px] font-medium">{error}</p>
        </div>
      )}
    </div>
  );
};

const TwoFactorAuth = ({ onVerified, profile, needsPin }: { onVerified: () => void, profile: UserProfile, needsPin: boolean }) => {
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [isVoiceVerified, setIsVoiceVerified] = useState(false);

  const handleVerify = async () => {
    if (!isVoiceVerified) {
      setError("Please complete voice verification first.");
      return;
    }
    
    if (needsPin) {
      if (pin.length !== 6) {
        setError("Please enter your 6-digit PIN.");
        return;
      }
      try {
        const response = await fetch('/api/auth/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ value: pin, hash: profile.pinHash })
        });
        const data = await response.json();
        if (data.isValid) {
          onVerified();
        } else {
          setError("Invalid PIN. Please try again.");
          logSecurityEvent(profile.uid, '2fa_failure', 'User entered incorrect PIN during 2FA', 'failure');
        }
      } catch (err: any) {
        if (isAbortError(err)) return;
        setError("Verification failed. Please try again.");
      }
    } else {
      onVerified();
    }
  };

  return (
    <div className="fixed inset-0 bg-slate-900/80 backdrop-blur-sm flex items-center justify-center z-50 p-4 overflow-y-auto">
      <motion.div 
        initial={{ scale: 0.9, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        className="bg-white p-8 rounded-2xl shadow-2xl max-w-md w-full space-y-6 text-center my-8"
      >
        <Shield className="w-16 h-16 text-blue-600 mx-auto" />
        <h2 className="text-2xl font-bold text-slate-900">Two-Factor Authentication</h2>
        <p className="text-slate-600 text-sm">
          {needsPin 
            ? "Please complete voice verification and enter your security PIN." 
            : "Please complete voice verification to secure your session."}
        </p>
        
        <VoiceCaptcha onVerified={() => setIsVoiceVerified(true)} />
        {isVoiceVerified && (
          <div className="flex items-center justify-center gap-2 text-green-600 text-sm font-medium bg-green-50 p-2 rounded-lg border border-green-100">
            <CheckCircle className="w-4 h-4" /> Voice Verified
          </div>
        )}

        {needsPin && (
          <input
            type="password"
            maxLength={6}
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
            className="w-full text-center text-3xl tracking-widest p-4 border-2 border-slate-200 rounded-xl focus:border-blue-600 outline-none transition-all"
            placeholder="••••••"
          />
        )}
        
        {error && <p className="text-sm text-red-500 bg-red-50 p-2 rounded-lg">{error}</p>}
        
        <button
          onClick={handleVerify}
          className="w-full bg-blue-600 text-white py-4 rounded-xl font-bold hover:bg-blue-700 transition-all shadow-lg shadow-blue-200"
        >
          Verify & Continue
        </button>
        
        <button 
          onClick={() => signOut(auth)}
          className="text-slate-400 text-sm hover:text-slate-600 transition-colors"
        >
          Cancel & Sign Out
        </button>
      </motion.div>
    </div>
  );
};

const PasswordRotation = ({ onUpdated, isForced, onCancel }: { onUpdated: () => void, isForced: boolean, onCancel?: () => void }) => {
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');

  const handleUpdate = async () => {
    if (newPassword !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }
    const strength = getPasswordStrength(newPassword);
    if (strength.score < 4) {
      setError("Password must be at least 8 characters and include uppercase, numbers, and special characters.");
      return;
    }

    try {
      const user = auth.currentUser;
      if (!user) return;

      // Check Password History (1 year)
      const historyQuery = query(
        collection(db, `users/${user.uid}/passwordHistory`),
        orderBy('createdAt', 'desc')
      );
      const historyDocs = await getDocs(historyQuery);
      
      let isReused = false;
      for (const doc of historyDocs.docs) {
        const data = doc.data();
        const createdAt = new Date(data.createdAt);
        const oneYearAgo = new Date();
        oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
        
        if (createdAt > oneYearAgo) {
          const response = await fetch('/api/auth/verify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ value: newPassword, hash: data.passwordHash })
          });
          const verifyData = await response.json();
          if (verifyData.isValid) {
            isReused = true;
            break;
          }
        }
      }

      if (isReused) {
        setError("You cannot reuse a password used within the last 365 days.");
        return;
      }

      // Update Password
      await updatePassword(user, newPassword);
      
      // Hash on server
      const hashResponse = await fetch('/api/auth/hash', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: newPassword })
      });
      const { hash: passwordHash } = await hashResponse.json();

      // Save to History
      await addDoc(collection(db, `users/${user.uid}/passwordHistory`), {
        uid: user.uid,
        passwordHash,
        createdAt: new Date().toISOString()
      });

      // Update Profile
      await updateDoc(doc(db, 'users', user.uid), {
        passwordChangedAt: new Date().toISOString()
      });

      await logSecurityEvent(user.uid, 'password_change', 'User updated password', 'success');

      onUpdated();
    } catch (err: any) {
      if (isAbortError(err)) return;
      setError(err.message);
    }
  };

  return (
    <div className="fixed inset-0 bg-slate-900/80 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <motion.div 
        initial={{ scale: 0.9, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        className="bg-white p-8 rounded-2xl shadow-2xl max-w-md w-full space-y-6"
      >
        <div className="text-center space-y-2">
          <RefreshCw className="w-16 h-16 text-orange-500 mx-auto" />
          <h2 className="text-2xl font-bold text-slate-900">{isForced ? "Password Expired" : "Change Password"}</h2>
          <p className="text-slate-600 text-sm">
            {isForced 
              ? "Your password is more than 15 days old. Please update it to continue." 
              : "Update your password to keep your account secure."}
          </p>
        </div>
        <div className="space-y-4">
          <input
            type="password"
            placeholder="New Password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            className="w-full p-4 border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-500 outline-none"
          />
          <PasswordStrengthIndicator password={newPassword} />
          <input
            type="password"
            placeholder="Confirm New Password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            className="w-full p-4 border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-500 outline-none"
          />
        </div>
        {error && <p className="text-sm text-red-500">{error}</p>}
        <div className="space-y-3">
          <button
            onClick={handleUpdate}
            className="w-full bg-orange-500 text-white py-4 rounded-xl font-bold hover:bg-orange-600 transition-all shadow-lg shadow-orange-200"
          >
            Update Password
          </button>
          {!isForced && onCancel && (
            <button
              onClick={onCancel}
              className="w-full text-slate-500 text-sm font-medium hover:text-slate-700"
            >
              Cancel
            </button>
          )}
        </div>
      </motion.div>
    </div>
  );
};

// --- Main App ---

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [isSignUp, setIsSignUp] = useState(false);
  const [isVoiceVerified, setIsVoiceVerified] = useState(false);
  const [needsPin, setNeedsPin] = useState(false);
  const [needs2FA, setNeeds2FA] = useState(false);
  const [needsRotation, setNeedsRotation] = useState(false);
  const [isForcedRotation, setIsForcedRotation] = useState(false);
  const [needsExpirationAlert, setNeedsExpirationAlert] = useState(false);
  const [needsProfileSetup, setNeedsProfileSetup] = useState(false);

  // Form States
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  const [country, setCountry] = useState('');
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      setUser(firebaseUser);
      if (firebaseUser) {
        const profileDoc = await getDoc(doc(db, 'users', firebaseUser.uid));
        if (profileDoc.exists()) {
          const data = profileDoc.data() as UserProfile;
          setProfile(data);
          checkSecurityLayers(data);
          
          // Check if 2FA done in this session
          const is2FADone = sessionStorage.getItem(`2fa_done_${firebaseUser.uid}`);
          if (!is2FADone) {
            setNeeds2FA(true);
          }
          
          setNeedsProfileSetup(false);
        } else {
          setNeedsProfileSetup(true);
        }
      } else {
        setProfile(null);
        setNeedsPin(false);
        setNeeds2FA(false);
        setNeedsRotation(false);
        setIsVoiceVerified(false);
        setNeedsProfileSetup(false);
      }
      setLoading(false);
    });
    return unsubscribe;
  }, []);

  const checkSecurityLayers = (data: UserProfile) => {
    // Check Daily PIN (24 hours)
    const lastPin = new Date(data.lastPinVerifiedAt).getTime();
    const now = new Date().getTime();
    if (now - lastPin > 24 * 60 * 60 * 1000) {
      setNeedsPin(true);
    }

    // Check Password Rotation (15 days)
    const lastPass = new Date(data.passwordChangedAt).getTime();
    const diff = now - lastPass;
    
    if (diff > 15 * 24 * 60 * 60 * 1000) {
      setNeedsRotation(true);
      setIsForcedRotation(true);
    } else if (diff > 8 * 24 * 60 * 60 * 1000) {
      // Alert 7 days before (15 - 7 = 8 days old)
      setNeedsExpirationAlert(true);
    }
  };

  const handleSignUp = async (e: React.FormEvent) => {
    e.preventDefault();
    const strength = getPasswordStrength(password);
    if (strength.score < 4) {
      setError("Password must be at least 8 characters and include uppercase, numbers, and special characters.");
      return;
    }
    if (pin.length !== 6) {
      setError("PIN must be 6 digits.");
      return;
    }

    try {
      const { user: newUser } = await createUserWithEmailAndPassword(auth, email, password);
      await sendEmailVerification(newUser);

      // Hash on server
      const pinHashResponse = await fetch('/api/auth/hash', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: pin })
      });
      const { hash: pinHash } = await pinHashResponse.json();

      const passHashResponse = await fetch('/api/auth/hash', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: password })
      });
      const { hash: passwordHash } = await passHashResponse.json();

      const newProfile: UserProfile = {
        uid: newUser.uid,
        fullName,
        email,
        phone,
        country,
        isVerified: false,
        passwordChangedAt: new Date().toISOString(),
        lastPinVerifiedAt: new Date().toISOString(),
        pinHash,
        failedLoginAttempts: 0,
        lockoutUntil: null
      };

      await setDoc(doc(db, 'users', newUser.uid), newProfile);
      
      await logSecurityEvent(newUser.uid, 'signup', 'User created account', 'success');
      
      // Save initial password to history
      await addDoc(collection(db, `users/${newUser.uid}/passwordHistory`), {
        uid: newUser.uid,
        passwordHash,
        createdAt: new Date().toISOString()
      });

      setProfile(newProfile);
      setError("Verification email sent! Please verify to access dashboard.");
    } catch (err: any) {
      if (isAbortError(err)) return;
      if (err.code === 'auth/operation-not-allowed') {
        setError("Sign-in providers are not enabled. Please enable 'Email/Password' and 'Google' in your Firebase Console (Authentication > Sign-in method).");
      } else {
        setError(err.message);
      }
    }
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      // 1. Check Lockout Status
      const lockoutResponse = await fetch('/api/auth/lockout-check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email })
      });
      const lockoutData = await lockoutResponse.json();
      
      if (lockoutData.locked) {
        setError(`Account locked. Please try again in ${lockoutData.remainingMinutes} minutes.`);
        return;
      }

      // 2. Attempt Login
      const { user: loggedInUser } = await signInWithEmailAndPassword(auth, email, password);
      
      // 3. Reset Lockout on Success
      await fetch('/api/auth/lockout-update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, success: true })
      });

      await logSecurityEvent(loggedInUser.uid, 'login', 'User logged in with email/password', 'success');
    } catch (err: any) {
      if (isAbortError(err)) return;
      
      // 4. Update Lockout on Failure
      if (err.code === 'auth/wrong-password' || err.code === 'auth/user-not-found' || err.code === 'auth/invalid-credential') {
        try {
          await fetch('/api/auth/lockout-update', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, success: false })
          });
        } catch (logErr) {
          console.error("Could not update lockout status:", logErr);
        }
      }

      if (err.code === 'auth/operation-not-allowed') {
        setError("Sign-in providers are not enabled. Please enable 'Email/Password' and 'Google' in your Firebase Console (Authentication > Sign-in method).");
      } else {
        setError(err.message);
      }
    }
  };

  const handleGoogleSignIn = async () => {
    try {
      const { user: googleUser } = await signInWithPopup(auth, googleProvider);
      await logSecurityEvent(googleUser.uid, 'login', 'User logged in with Google', 'success');
    } catch (err: any) {
      if (isAbortError(err)) return;
      if (err.code === 'auth/operation-not-allowed') {
        setError("Sign-in providers are not enabled. Please enable 'Email/Password' and 'Google' in your Firebase Console (Authentication > Sign-in method).");
      } else {
        setError(err.message);
      }
    }
  };

  const handleCompleteProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;
    if (pin.length !== 6) {
      setError("PIN must be 6 digits.");
      return;
    }

    try {
      const pinHashResponse = await fetch('/api/auth/hash', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: pin })
      });
      const { hash: pinHash } = await pinHashResponse.json();

      const newProfile: UserProfile = {
        uid: user.uid,
        fullName: user.displayName || fullName || 'Google User',
        email: user.email || email,
        phone: user.phoneNumber || phone || '',
        country: country || '',
        isVerified: true, // Google users are pre-verified
        passwordChangedAt: new Date().toISOString(),
        lastPinVerifiedAt: new Date().toISOString(),
        pinHash,
        failedLoginAttempts: 0,
        lockoutUntil: null
      };

      await setDoc(doc(db, 'users', user.uid), newProfile);
      setProfile(newProfile);
      setNeedsProfileSetup(false);
    } catch (err: any) {
      if (isAbortError(err)) return;
      if (err.code === 'auth/operation-not-allowed') {
        setError("Sign-in providers are not enabled. Please enable 'Email/Password' and 'Google' in your Firebase Console (Authentication > Sign-in method).");
      } else {
        setError(err.message);
      }
    }
  };

  const handlePinVerified = async () => {
    if (!user) return;
    try {
      await updateDoc(doc(db, 'users', user.uid), {
        lastPinVerifiedAt: new Date().toISOString()
      });
      setNeedsPin(false);
    } catch (err: any) {
      if (isAbortError(err)) return;
      console.error("Failed to update PIN verification time:", err);
    }
  };

  const handle2FAComplete = () => {
    if (user) {
      sessionStorage.setItem(`2fa_done_${user.uid}`, 'true');
      logSecurityEvent(user.uid, '2fa_success', 'User completed 2FA verification', 'success');
    }
    setNeeds2FA(false);
    if (needsPin) handlePinVerified();
  };

  if (loading) return <div className="min-h-screen flex items-center justify-center bg-slate-50">Loading...</div>;

  if (!user) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
        <motion.div 
          initial={{ y: 20, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          className="bg-white p-8 rounded-2xl shadow-xl max-w-md w-full space-y-6"
        >
          <div className="text-center space-y-2">
            <Shield className="w-12 h-12 text-blue-600 mx-auto" />
            <h1 className="text-2xl font-bold text-slate-900">SecureGuard Hub</h1>
            <p className="text-slate-500 text-sm">High-security awareness platform</p>
          </div>

          <div className="flex bg-slate-100 p-1 rounded-lg">
            <button 
              onClick={() => setIsSignUp(false)}
              className={cn("flex-1 py-2 rounded-md text-sm font-medium transition-all", !isSignUp ? "bg-white shadow-sm text-blue-600" : "text-slate-500")}
            >
              Login
            </button>
            <button 
              onClick={() => setIsSignUp(true)}
              className={cn("flex-1 py-2 rounded-md text-sm font-medium transition-all", isSignUp ? "bg-white shadow-sm text-blue-600" : "text-slate-500")}
            >
              Sign Up
            </button>
          </div>

          <form onSubmit={isSignUp ? handleSignUp : handleLogin} className="space-y-4">
            {isSignUp && (
              <>
                <div className="relative">
                  <UserIcon className="absolute left-3 top-3.5 w-5 h-5 text-slate-400" />
                  <input 
                    type="text" placeholder="Full Name" required
                    value={fullName} onChange={(e) => setFullName(e.target.value)}
                    className="w-full pl-10 p-3 border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-500 outline-none"
                  />
                </div>
                <div className="relative">
                  <Phone className="absolute left-3 top-3.5 w-5 h-5 text-slate-400" />
                  <input 
                    type="tel" placeholder="Phone Number" required
                    value={phone} onChange={(e) => setPhone(e.target.value)}
                    className="w-full pl-10 p-3 border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-500 outline-none"
                  />
                </div>
                <div className="relative">
                  <Globe className="absolute left-3 top-3.5 w-5 h-5 text-slate-400" />
                  <input 
                    type="text" placeholder="Country" required
                    value={country} onChange={(e) => setCountry(e.target.value)}
                    className="w-full pl-10 p-3 border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-500 outline-none"
                  />
                </div>
              </>
            )}
            <div className="relative">
              <Mail className="absolute left-3 top-3.5 w-5 h-5 text-slate-400" />
              <input 
                type="email" placeholder="Email Address" required
                value={email} onChange={(e) => setEmail(e.target.value)}
                className="w-full pl-10 p-3 border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-500 outline-none"
              />
            </div>
            <div className="relative">
              <Lock className="absolute left-3 top-3.5 w-5 h-5 text-slate-400" />
              <input 
                type="password" placeholder="Password" required
                value={password} onChange={(e) => setPassword(e.target.value)}
                className="w-full pl-10 p-3 border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-500 outline-none"
              />
            </div>
            {isSignUp && (
              <>
                <PasswordStrengthIndicator password={password} />
                <div className="relative">
                  <Key className="absolute left-3 top-3.5 w-5 h-5 text-slate-400" />
                  <input 
                    type="password" placeholder="Set 6-digit Security PIN" required maxLength={6}
                    value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
                    className="w-full pl-10 p-3 border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-500 outline-none"
                  />
                </div>
              </>
            )}
            
            {error && <p className="text-xs text-red-500 bg-red-50 p-2 rounded-lg">{error}</p>}
            <button 
              type="submit"
              className="w-full bg-blue-600 text-white py-3 rounded-xl font-bold hover:bg-blue-700 transition-all shadow-lg shadow-blue-100"
            >
              {isSignUp ? "Create Account" : "Sign In"}
            </button>

            <div className="relative flex items-center justify-center py-2">
              <div className="flex-grow border-t border-slate-200"></div>
              <span className="flex-shrink mx-4 text-slate-400 text-xs uppercase tracking-widest font-bold">Or</span>
              <div className="flex-grow border-t border-slate-200"></div>
            </div>

            <button 
              type="button"
              onClick={handleGoogleSignIn}
              className="w-full bg-white border border-slate-200 text-slate-700 py-3 rounded-xl font-bold hover:bg-slate-50 transition-all flex items-center justify-center gap-2"
            >
              <svg className="w-5 h-5" viewBox="0 0 24 24">
                <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z"/>
                <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
              </svg>
              Sign in with Google
            </button>
          </form>
        </motion.div>
      </div>
    );
  }

  if (needsProfileSetup && user) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
        <motion.div 
          initial={{ y: 20, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          className="bg-white p-8 rounded-2xl shadow-xl max-w-md w-full space-y-6"
        >
          <div className="text-center space-y-2">
            <Key className="w-12 h-12 text-blue-600 mx-auto" />
            <h2 className="text-2xl font-bold text-slate-900">Complete Your Profile</h2>
            <p className="text-slate-500 text-sm">Welcome! Please set a 6-digit security PIN to secure your account.</p>
          </div>

          <form onSubmit={handleCompleteProfile} className="space-y-4">
            <div className="relative">
              <Key className="absolute left-3 top-3.5 w-5 h-5 text-slate-400" />
              <input 
                type="password" placeholder="Set 6-digit PIN" required maxLength={6}
                value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
                className="w-full pl-10 p-3 border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-500 outline-none"
              />
            </div>
            {error && <p className="text-xs text-red-500 bg-red-50 p-2 rounded-lg">{error}</p>}
            <button 
              type="submit"
              className="w-full bg-blue-600 text-white py-3 rounded-xl font-bold hover:bg-blue-700 transition-all shadow-lg shadow-blue-100"
            >
              Complete Setup
            </button>
            <button 
              type="button"
              onClick={() => signOut(auth)}
              className="w-full text-slate-500 text-sm font-medium hover:text-slate-700"
            >
              Cancel
            </button>
          </form>
        </motion.div>
      </div>
    );
  }

  if (!user.emailVerified && user.providerData[0]?.providerId === 'password') {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4 text-center">
        <div className="bg-white p-8 rounded-2xl shadow-xl max-w-md w-full space-y-4">
          <Mail className="w-16 h-16 text-blue-600 mx-auto" />
          <h2 className="text-2xl font-bold">Verify Your Email</h2>
          <p className="text-slate-600">We've sent a link to <b>{user.email}</b>. Please verify your account to continue.</p>
          <button onClick={() => signOut(auth)} className="text-blue-600 font-medium">Back to Login</button>
        </div>
      </div>
    );
  }

  if (needs2FA && profile) {
    return (
      <TwoFactorAuth 
        profile={profile} 
        needsPin={needsPin} 
        onVerified={handle2FAComplete} 
      />
    );
  }

  if (needsRotation) {
    return (
      <PasswordRotation 
        onUpdated={() => {
          setNeedsRotation(false);
          setIsForcedRotation(false);
          setNeedsExpirationAlert(false);
        }} 
        isForced={isForcedRotation}
        onCancel={() => {
          setNeedsRotation(false);
          setIsForcedRotation(false);
        }}
      />
    );
  }

  return (
    <Dashboard 
      profile={profile} 
      onManualRotation={() => {
        setNeedsRotation(true);
        setIsForcedRotation(false);
      }} 
      showExpirationAlert={needsExpirationAlert}
      onDismissAlert={() => setNeedsExpirationAlert(false)}
    />
  );
}

// --- Quiz Component ---

const SecurityQuiz = () => {
  const [difficulty, setDifficulty] = useState<'Easy' | 'Medium' | 'Hard' | null>(null);
  const [currentQuestion, setCurrentQuestion] = useState(0);
  const [score, setScore] = useState(0);
  const [showResult, setShowResult] = useState(false);
  const [selectedAnswer, setSelectedAnswer] = useState<number | null>(null);

  const quizData = {
    Easy: [
      {
        question: "What is the most secure way to handle your passwords?",
        options: [
          "Write them down in a physical notebook",
          "Use the same password for all accounts",
          "Use a reputable password manager",
          "Save them in a text file on your desktop"
        ],
        correct: 2,
        feedback: "A password manager generates and stores complex, unique passwords for each of your accounts, significantly improving security."
      },
      {
        question: "What does '2FA' stand for in online security?",
        options: [
          "Two-Factor Authentication",
          "Second-File Access",
          "Two-Fold Authorization",
          "Secure-Fast Access"
        ],
        correct: 0,
        feedback: "Two-Factor Authentication adds an extra layer of security by requiring two forms of identification to access an account."
      },
      {
        question: "What is 'Phishing'?",
        options: [
          "A type of outdoor sport",
          "A method of stealing information by pretending to be a trustworthy entity",
          "A way to speed up your internet connection",
          "A security protocol for wireless networks"
        ],
        correct: 1,
        feedback: "Phishing is a common social engineering attack used to steal user data, including login credentials and credit card numbers."
      }
    ],
    Medium: [
      {
        question: "Which of these is the LEAST secure form of Two-Factor Authentication (2FA)?",
        options: [
          "Authenticator App (e.g., Google Authenticator)",
          "SMS-based codes",
          "Hardware Security Key (e.g., YubiKey)",
          "Biometric verification"
        ],
        correct: 1,
        feedback: "SMS codes can be intercepted via SIM swapping attacks, making them less secure than app-based or hardware-based 2FA."
      },
      {
        question: "When using public Wi-Fi (e.g., at a coffee shop), what is the best practice?",
        options: [
          "Only use it for banking and sensitive tasks",
          "Disable your firewall to ensure a stable connection",
          "Use a Virtual Private Network (VPN)",
          "It is perfectly safe as long as the website has HTTPS"
        ],
        correct: 2,
        feedback: "A VPN creates an encrypted tunnel for your data, protecting it from others on the same public network."
      },
      {
        question: "What is the primary purpose of regular software updates?",
        options: [
          "To make your computer run slower",
          "To change the user interface for no reason",
          "To patch security vulnerabilities and fix bugs",
          "To delete your personal files"
        ],
        correct: 2,
        feedback: "Updates often contain critical security patches that fix vulnerabilities discovered by developers or exploited by hackers."
      }
    ],
    Hard: [
      {
        question: "What is a 'Zero-Day' vulnerability?",
        options: [
          "A bug that has been known for zero days by the developer",
          "A vulnerability that is exploited before a patch is available",
          "A virus that deletes all files on day zero of the month",
          "A security flaw that only affects new computers"
        ],
        correct: 1,
        feedback: "A zero-day vulnerability is a flaw unknown to the vendor, meaning they have 'zero days' to fix it before it can be exploited."
      },
      {
        question: "What is 'Vishing'?",
        options: [
          "Phishing via video calls",
          "Phishing via voice calls or VoIP",
          "A type of virus that affects visual drivers",
          "Stealing information through virtual reality"
        ],
        correct: 1,
        feedback: "Vishing (Voice Phishing) involves using phone calls to trick victims into revealing sensitive personal or financial information."
      },
      {
        question: "Which encryption standard is currently considered the most secure for Wi-Fi networks?",
        options: [
          "WEP",
          "WPA",
          "WPA2",
          "WPA3"
        ],
        correct: 3,
        feedback: "WPA3 is the latest and most secure Wi-Fi security protocol, offering better protection against password guessing and eavesdropping."
      }
    ]
  };

  const questions = difficulty ? quizData[difficulty] : [];

  const handleAnswer = (index: number) => {
    setSelectedAnswer(index);
    if (index === questions[currentQuestion].correct) {
      setScore(score + 1);
    }

    setTimeout(() => {
      if (currentQuestion + 1 < questions.length) {
        setCurrentQuestion(currentQuestion + 1);
        setSelectedAnswer(null);
      } else {
        setShowResult(true);
      }
    }, 1500);
  };

  const resetQuiz = () => {
    setDifficulty(null);
    setCurrentQuestion(0);
    setScore(0);
    setShowResult(false);
    setSelectedAnswer(null);
  };

  return (
    <section className="bg-white p-6 rounded-2xl shadow-sm border border-slate-200">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-2">
          <Shield className="w-5 h-5 text-blue-600" />
          <h3 className="text-lg font-bold">Awareness Quiz</h3>
          {difficulty && (
            <span className={cn(
              "text-[10px] px-2 py-0.5 rounded-full font-bold uppercase tracking-wider",
              difficulty === 'Easy' ? "bg-green-100 text-green-600" :
              difficulty === 'Medium' ? "bg-orange-100 text-orange-600" :
              "bg-red-100 text-red-600"
            )}>
              {difficulty}
            </span>
          )}
        </div>
        {difficulty && !showResult && (
          <span className="text-xs font-bold text-slate-400 uppercase tracking-widest">
            Question {currentQuestion + 1} of {questions.length}
          </span>
        )}
      </div>

      <AnimatePresence mode="wait">
        {!difficulty ? (
          <motion.div
            key="selection"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            className="space-y-6 text-center py-4"
          >
            <p className="text-slate-600 font-medium">Select your challenge level:</p>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              {(['Easy', 'Medium', 'Hard'] as const).map((level) => (
                <button
                  key={level}
                  onClick={() => setDifficulty(level)}
                  className={cn(
                    "p-4 rounded-xl border-2 transition-all font-bold text-sm",
                    level === 'Easy' ? "border-green-100 text-green-600 hover:bg-green-50" :
                    level === 'Medium' ? "border-orange-100 text-orange-600 hover:bg-orange-50" :
                    "border-red-100 text-red-600 hover:bg-red-50"
                  )}
                >
                  {level}
                </button>
              ))}
            </div>
          </motion.div>
        ) : !showResult ? (
          <motion.div
            key={currentQuestion}
            initial={{ x: 20, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: -20, opacity: 0 }}
            className="space-y-6"
          >
            <p className="text-slate-800 font-medium text-lg">{questions[currentQuestion].question}</p>
            <div className="grid grid-cols-1 gap-3">
              {questions[currentQuestion].options.map((option, i) => (
                <button
                  key={i}
                  disabled={selectedAnswer !== null}
                  onClick={() => handleAnswer(i)}
                  className={cn(
                    "w-full text-left p-4 rounded-xl border-2 transition-all font-medium",
                    selectedAnswer === null 
                      ? "border-slate-100 hover:border-blue-200 hover:bg-blue-50/50" 
                      : i === questions[currentQuestion].correct
                        ? "border-green-500 bg-green-50 text-green-700"
                        : i === selectedAnswer
                          ? "border-red-500 bg-red-50 text-red-700"
                          : "border-slate-100 opacity-50"
                  )}
                >
                  {option}
                </button>
              ))}
            </div>
            {selectedAnswer !== null && (
              <motion.div
                initial={{ y: 10, opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                className="p-4 bg-blue-50 rounded-xl border border-blue-100 text-sm text-blue-700"
              >
                <p className="font-bold mb-1">Feedback:</p>
                {questions[currentQuestion].feedback}
              </motion.div>
            )}
          </motion.div>
        ) : (
          <motion.div
            initial={{ scale: 0.9, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className="text-center space-y-6 py-8"
          >
            <div className="w-24 h-24 bg-blue-100 text-blue-600 rounded-full flex items-center justify-center mx-auto">
              <CheckCircle className="w-12 h-12" />
            </div>
            <div className="space-y-2">
              <h4 className="text-2xl font-bold text-slate-900">Quiz Completed!</h4>
              <p className="text-slate-600">Your score: <span className="text-blue-600 font-bold">{score} / {questions.length}</span></p>
            </div>
            <p className="text-sm text-slate-500 max-w-xs mx-auto">
              {score === questions.length 
                ? `Excellent! You've mastered the ${difficulty} level.` 
                : score >= questions.length / 2 
                  ? `Good job on the ${difficulty} level! Keep learning.` 
                  : `The ${difficulty} level was tough! Review the feedback and try again.`}
            </p>
            <button
              onClick={resetQuiz}
              className="bg-blue-600 text-white px-8 py-3 rounded-xl font-bold hover:bg-blue-700 transition-all shadow-lg shadow-blue-100"
            >
              Back to Difficulty Selection
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
};

const SecurityAuditLog = ({ uid }: { uid: string }) => {
  const [logs, setLogs] = useState<SecurityLog[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchLogs = async () => {
      try {
        const q = query(
          collection(db, `users/${uid}/securityLogs`),
          orderBy('timestamp', 'desc'),
          limit(10)
        );
        const snapshot = await getDocs(q);
        const logData = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as SecurityLog));
        setLogs(logData);
      } catch (err) {
        if (isAbortError(err)) return;
        console.error("Failed to fetch security logs:", err);
      } finally {
        setLoading(false);
      }
    };

    fetchLogs();
  }, [uid]);

  const getIcon = (type: SecurityLog['type']) => {
    switch (type) {
      case 'login': return <LogOut className="w-4 h-4 text-green-500 rotate-180" />;
      case 'failed_login': return <AlertTriangle className="w-4 h-4 text-red-500" />;
      case 'password_change': return <RefreshCw className="w-4 h-4 text-blue-500" />;
      case '2fa_success': return <Shield className="w-4 h-4 text-green-500" />;
      case '2fa_failure': return <Shield className="w-4 h-4 text-red-500" />;
      case 'signup': return <UserIcon className="w-4 h-4 text-purple-500" />;
      default: return <Activity className="w-4 h-4 text-slate-500" />;
    }
  };

  return (
    <section className="bg-white p-6 rounded-2xl shadow-sm border border-slate-200">
      <h3 className="text-lg font-bold mb-4 flex items-center gap-2">
        <Activity className="w-5 h-5 text-blue-600" />
        Security Audit Log
      </h3>
      {loading ? (
        <div className="text-center py-4 text-slate-400 text-sm italic">Loading logs...</div>
      ) : logs.length === 0 ? (
        <div className="text-center py-4 text-slate-400 text-sm italic">No security events recorded yet.</div>
      ) : (
        <div className="space-y-3">
          {logs.map((log) => (
            <div key={log.id} className="flex items-center justify-between p-3 bg-slate-50 rounded-xl hover:bg-slate-100 transition-colors">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 bg-white rounded-lg flex items-center justify-center shadow-sm border border-slate-100">
                  {getIcon(log.type)}
                </div>
                <div>
                  <p className="text-sm font-bold text-slate-900 capitalize">{log.type.replace('_', ' ')}</p>
                  <p className="text-xs text-slate-500">{log.details}</p>
                </div>
              </div>
              <div className="text-right">
                <p className="text-[10px] font-mono text-slate-400">{new Date(log.timestamp).toLocaleString()}</p>
                <span className={cn(
                  "text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full",
                  log.status === 'success' ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"
                )}>
                  {log.status}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
};

// --- Dashboard ---

const Dashboard = ({ profile, onManualRotation, showExpirationAlert, onDismissAlert }: { 
  profile: UserProfile | null, 
  onManualRotation: () => void,
  showExpirationAlert: boolean,
  onDismissAlert: () => void
}) => {
  return (
    <div className="min-h-screen bg-slate-50">
      <nav className="bg-white border-b border-slate-200 px-6 py-4 flex items-center justify-between sticky top-0 z-40">
        <div className="flex items-center gap-2">
          <Shield className="w-8 h-8 text-blue-600" />
          <span className="text-xl font-bold text-slate-900">SecureGuard</span>
        </div>
        <div className="flex items-center gap-4">
          <div className="text-right hidden sm:block">
            <p className="text-sm font-bold text-slate-900">{profile?.fullName}</p>
            <p className="text-xs text-slate-500">{profile?.email}</p>
          </div>
          <button 
            onClick={() => signOut(auth)}
            className="p-2 text-slate-500 hover:text-red-600 transition-colors"
          >
            <LogOut className="w-6 h-6" />
          </button>
        </div>
      </nav>

      <main className="max-w-6xl mx-auto p-6 space-y-8">
        <AnimatePresence>
          {showExpirationAlert && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              className="overflow-hidden"
            >
              <div className="bg-orange-50 border border-orange-200 p-4 rounded-2xl flex items-center justify-between gap-4">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 bg-orange-100 rounded-full flex items-center justify-center text-orange-600 shrink-0">
                    <RefreshCw className="w-5 h-5 animate-spin-slow" />
                  </div>
                  <div>
                    <h4 className="font-bold text-orange-800 text-sm">Action Required: Password Expiring Soon</h4>
                    <p className="text-orange-700 text-xs">Your password will expire in less than 7 days. Please update it to avoid account lockout.</p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={onManualRotation}
                    className="bg-orange-600 text-white px-4 py-2 rounded-xl text-xs font-bold hover:bg-orange-700 transition-all shadow-sm"
                  >
                    Update Now
                  </button>
                  <button
                    onClick={onDismissAlert}
                    className="p-2 text-orange-400 hover:text-orange-600 transition-colors"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        <header className="space-y-2">
          <h2 className="text-3xl font-bold text-slate-900">Security Awareness Hub</h2>
          <p className="text-slate-600">Welcome back! Here's your daily security briefing.</p>
        </header>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <div className="md:col-span-2 space-y-6">
            {/* Awareness Quiz */}
            <SecurityQuiz />

            {/* Audit Log */}
            {profile && <SecurityAuditLog uid={profile.uid} />}

            {/* Daily Tips */}
            <section className="bg-white p-6 rounded-2xl shadow-sm border border-slate-200">
              <h3 className="text-lg font-bold mb-4 flex items-center gap-2">
                <AlertTriangle className="w-5 h-5 text-orange-500" />
                Daily Security Tips
              </h3>
              <div className="space-y-4">
                {[
                  "Never reuse passwords across different platforms.",
                  "Enable 2FA on all sensitive accounts (Email, Banking).",
                  "Be wary of urgent requests for personal information via email."
                ].map((tip, i) => (
                  <div key={i} className="flex gap-3 p-3 bg-slate-50 rounded-xl">
                    <div className="w-6 h-6 bg-blue-100 text-blue-600 rounded-full flex items-center justify-center text-xs font-bold shrink-0">
                      {i + 1}
                    </div>
                    <p className="text-slate-700 text-sm">{tip}</p>
                  </div>
                ))}
              </div>
            </section>

            {/* Phishing Alerts */}
            <section className="bg-white p-6 rounded-2xl shadow-sm border border-slate-200">
              <h3 className="text-lg font-bold mb-4 flex items-center gap-2">
                <Shield className="w-5 h-5 text-red-500" />
                Recent Phishing Alerts
              </h3>
              <div className="space-y-3">
                <div className="p-4 border-l-4 border-red-500 bg-red-50">
                  <p className="font-bold text-red-700 text-sm">Fake "Bank Account Locked" SMS</p>
                  <p className="text-red-600 text-xs mt-1">Global alert: Scammers sending SMS with links to fake banking portals.</p>
                </div>
                <div className="p-4 border-l-4 border-orange-500 bg-orange-50">
                  <p className="font-bold text-orange-700 text-sm">Suspicious "Package Delivery" Emails</p>
                  <p className="text-orange-600 text-xs mt-1">Increase in emails claiming a missed delivery to steal login credentials.</p>
                </div>
              </div>
            </section>
          </div>

          <div className="space-y-6">
            {/* Security Status */}
            <section className="bg-blue-600 text-white p-6 rounded-2xl shadow-lg shadow-blue-200">
              <h3 className="text-lg font-bold mb-4">Your Security Status</h3>
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <span className="text-sm opacity-80">Email Verified</span>
                  <CheckCircle className="w-5 h-5" />
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm opacity-80">Daily PIN Active</span>
                  <CheckCircle className="w-5 h-5" />
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm opacity-80">Password Rotation</span>
                  <CheckCircle className="w-5 h-5" />
                </div>
                <div className="pt-4 border-t border-white/20 space-y-4">
                  <div>
                    <p className="text-xs opacity-80">Last Password Change</p>
                    <p className="text-sm font-bold">{profile ? new Date(profile.passwordChangedAt).toLocaleDateString() : 'N/A'}</p>
                  </div>
                  <button 
                    onClick={onManualRotation}
                    className="w-full bg-white/10 hover:bg-white/20 text-white py-2 rounded-lg text-xs font-bold transition-all border border-white/20"
                  >
                    Change Password Now
                  </button>
                </div>
              </div>
            </section>

            {/* Interactive Tips */}
            <section className="bg-white p-6 rounded-2xl shadow-sm border border-slate-200">
              <h3 className="text-lg font-bold mb-4">Tips & Tricks</h3>
              <div className="space-y-4">
                <details className="group">
                  <summary className="list-none cursor-pointer flex items-center justify-between p-3 bg-slate-50 rounded-xl hover:bg-slate-100 transition-colors">
                    <span className="text-sm font-medium">How to spot fake URLs?</span>
                    <span className="group-open:rotate-180 transition-transform">▼</span>
                  </summary>
                  <div className="p-3 text-xs text-slate-600">
                    Always check the domain name. Scammers use "paypa1.com" instead of "paypal.com". Look for HTTPS.
                  </div>
                </details>
                <details className="group">
                  <summary className="list-none cursor-pointer flex items-center justify-between p-3 bg-slate-50 rounded-xl hover:bg-slate-100 transition-colors">
                    <span className="text-sm font-medium">What is Social Engineering?</span>
                    <span className="group-open:rotate-180 transition-transform">▼</span>
                  </summary>
                  <div className="p-3 text-xs text-slate-600">
                    Psychological manipulation of people into performing actions or divulging confidential information.
                  </div>
                </details>
              </div>
            </section>
          </div>
        </div>
      </main>
    </div>
  );
};

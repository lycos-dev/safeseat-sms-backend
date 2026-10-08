const { cert, getApps, initializeApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { getFirestore } = require("firebase-admin/firestore");

const TEXTBEE_SEND_URL = "https://api.textbee.dev/api/v1/gateway/send-sms";
const DEFAULT_ALLOWED_ORIGINS = [
  "https://safeseat-app.vercel.app",
  "http://localhost:8081",
  "http://localhost:19006",
];

function readAllowedOrigins() {
  const configured = String(process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return new Set([...DEFAULT_ALLOWED_ORIGINS, ...configured]);
}

function applyCors(req, res) {
  const origin = typeof req.headers.origin === "string" ? req.headers.origin : "";
  if (origin && readAllowedOrigins().has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Max-Age", "86400");
}

function readServiceAccount() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  const base64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;

  if (!raw && !base64) {
    throw new Error(
      "Firebase Admin is not configured. Set FIREBASE_SERVICE_ACCOUNT or FIREBASE_SERVICE_ACCOUNT_BASE64.",
    );
  }

  let parsed;
  try {
    const json = raw || Buffer.from(base64, "base64").toString("utf8");
    parsed = JSON.parse(json);
  } catch {
    throw new Error("Firebase service-account environment variable is not valid JSON/base64 JSON.");
  }

  if (!parsed.project_id || !parsed.client_email || !parsed.private_key) {
    throw new Error("Firebase service-account JSON is missing required fields.");
  }

  return {
    ...parsed,
    private_key: String(parsed.private_key).replace(/\\n/g, "\n"),
  };
}

function initFirebaseAdmin() {
  if (getApps().length === 0) {
    initializeApp({ credential: cert(readServiceAccount()) });
  }
}

function parseJsonBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string" && req.body.trim()) {
    try {
      return JSON.parse(req.body);
    } catch {
      return null;
    }
  }
  return {};
}

function normalizePhilippineMobileNumber(raw) {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (!value || !/^[+()\d\s.-]+$/.test(value)) return null;

  let digits = value.replace(/\D/g, "");
  if (/^09\d{9}$/.test(digits)) digits = `63${digits.slice(1)}`;
  else if (/^9\d{9}$/.test(digits)) digits = `63${digits}`;

  return /^639\d{9}$/.test(digits) ? `+${digits}` : null;
}

function parseLocation(raw) {
  if (!raw || typeof raw !== "object") return null;
  const latitude = Number(raw.latitude);
  const longitude = Number(raw.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return null;

  const accuracy = Number(raw.accuracy);
  const timestamp = typeof raw.timestamp === "string" ? raw.timestamp : undefined;
  return {
    latitude,
    longitude,
    ...(Number.isFinite(accuracy) && accuracy >= 0 ? { accuracy } : {}),
    ...(timestamp ? { timestamp } : {}),
  };
}

function isValidSessionId(value) {
  return typeof value === "string" && /^[A-Za-z0-9:_-]{6,180}$/.test(value);
}

function isValidEventId(value) {
  return typeof value === "string" && /^[A-Za-z0-9:_-]{8,180}$/.test(value);
}

function safeDriverName(userData, decodedToken) {
  const candidates = [
    userData && userData.name,
    userData && userData.displayName,
    decodedToken && decodedToken.name,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim().slice(0, 80);
  }
  return "the driver";
}

function buildSmsMessage(driverName, location) {
  if (location) {
    return `SafeSeat Emergency Alert: Possible emergency involving ${driverName}. Check on them now. GPS: ${location.latitude.toFixed(6)}, ${location.longitude.toFixed(6)}. Paste coordinates into Maps.`;
  }
  return `SafeSeat Emergency Alert: Possible emergency involving ${driverName}. Check on them now. Current GPS location is unavailable.`;
}

async function sendViaTextBee(recipients, message) {
  const apiKey = String(process.env.TEXTBEE_API_KEY || "").trim();
  if (!apiKey) throw new Error("TEXTBEE_API_KEY is not configured");

  const deviceId = String(process.env.TEXTBEE_DEVICE_ID || "").trim();
  const response = await fetch(TEXTBEE_SEND_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
    },
    body: JSON.stringify({
      recipients,
      message,
      ...(deviceId ? { deviceId } : {}),
    }),
  });

  const text = await response.text();
  let body = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = {};
  }

  if (!response.ok) {
    const providerMessage =
      (body && body.message) ||
      (body && body.error) ||
      (body && body.data && body.data.message) ||
      `HTTP ${response.status}`;
    const error = new Error(`TextBee rejected the send: ${String(providerMessage).slice(0, 180)}`);
    error.statusCode = response.status;
    throw error;
  }

  return {
    messageId: String(
      (body && body.data && body.data.smsBatchId) || body.smsBatchId || body.id || "accepted",
    ),
  };
}

async function claimEmergencyEvent(db, payload) {
  const eventRef = db.collection("smsEmergencyEvents").doc(payload.eventId);
  let claimed = false;

  await db.runTransaction(async (transaction) => {
    const existing = await transaction.get(eventRef);
    if (existing.exists) return;

    const now = new Date().toISOString();
    transaction.create(eventRef, {
      uid: payload.uid,
      sessionId: payload.sessionId,
      eventId: payload.eventId,
      seatNumber: 1,
      smsStatus: payload.testMode ? "TEST_PENDING" : "SENDING",
      recipientCount: payload.recipientCount,
      gpsIncluded: payload.gpsIncluded,
      createdAt: now,
      updatedAt: now,
    });
    claimed = true;
  });

  return { claimed, eventRef };
}

module.exports = async function sendSmsHandler(req, res) {
  applyCors(req, res);

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST, OPTIONS");
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  try {
    initFirebaseAdmin();

    const authorization = typeof req.headers.authorization === "string" ? req.headers.authorization : "";
    if (!authorization.startsWith("Bearer ")) {
      return res.status(401).json({ ok: false, error: "Missing Firebase authorization token" });
    }

    let decodedToken;
    try {
      decodedToken = await getAuth().verifyIdToken(authorization.slice(7));
    } catch {
      return res.status(401).json({ ok: false, error: "Invalid or expired Firebase authorization token" });
    }

    const body = parseJsonBody(req);
    if (body === null) return res.status(400).json({ ok: false, error: "Invalid JSON body" });

    const seatNumber = Number(body.seatNumber);
    const sessionId = body.sessionId;
    const eventId = body.eventId;
    const location = parseLocation(body.location);

    if (seatNumber !== 1) {
      return res.status(400).json({ ok: false, error: "Emergency SMS is only available for the driver seat" });
    }
    if (!isValidSessionId(sessionId) || !isValidEventId(eventId)) {
      return res.status(400).json({ ok: false, error: "Invalid Emergency event or session identity" });
    }

    const uid = decodedToken.uid;
    const db = getFirestore();
    const sessionRef = db.collection("monitoring_sessions").doc(sessionId);
    const sessionSnap = await sessionRef.get();

    if (!sessionSnap.exists) {
      return res.status(409).json({ ok: false, error: "Monitoring session was not found" });
    }

    const session = sessionSnap.data() || {};
    const sessionSeat = String(session.seat || "").trim().toLowerCase();
    const fusionState = String(session.fusionState || "").trim().toUpperCase();

    if (
      session.ownerUid !== uid ||
      session.active !== true ||
      sessionSeat !== "driver" ||
      fusionState !== "EMERGENCY"
    ) {
      return res.status(409).json({
        ok: false,
        error: "Emergency is no longer active or is not the signed-in driver's active session",
      });
    }

    const [userSnap, contactsSnap] = await Promise.all([
      db.collection("users").doc(uid).get(),
      db.collection("users").doc(uid).collection("emergencyContacts").get(),
    ]);

    const driverName = safeDriverName(userSnap.exists ? userSnap.data() : null, decodedToken);
    const validContacts = contactsSnap.docs
      .map((contactDoc) => {
        const data = contactDoc.data() || {};
        const phone = normalizePhilippineMobileNumber(data.phone);
        const hierarchy = Number(data.hierarchy);
        return {
          name:
            typeof data.name === "string" && data.name.trim()
              ? data.name.trim().slice(0, 80)
              : "Emergency Contact",
          phone,
          hierarchy: Number.isFinite(hierarchy) && hierarchy > 0 ? hierarchy : 999,
        };
      })
      .filter((contact) => Boolean(contact.phone))
      .sort((a, b) => a.hierarchy - b.hierarchy);

    if (validContacts.length === 0) {
      return res.status(200).json({
        ok: true,
        skipped: contactsSnap.empty ? "no_contacts" : "no_valid_contacts",
        smsStatus: "SKIPPED",
      });
    }

    const recipientMap = new Map();
    for (const contact of validContacts) {
      if (!recipientMap.has(contact.phone)) recipientMap.set(contact.phone, contact.name);
    }
    const recipients = Array.from(recipientMap.keys());
    const recipientNames = Array.from(recipientMap.values());
    const testMode = process.env.TEST_MODE !== "false";

    const { claimed, eventRef } = await claimEmergencyEvent(db, {
      uid,
      sessionId,
      eventId,
      testMode,
      recipientCount: recipients.length,
      gpsIncluded: Boolean(location),
    });

    if (!claimed) {
      const existing = await eventRef.get();
      const smsStatus = String((existing.data() || {}).smsStatus || "DUPLICATE").toUpperCase();
      return res.status(200).json({
        ok: true,
        skipped: smsStatus === "SENDING" || smsStatus === "TEST_PENDING" ? "event_in_progress" : "duplicate_event",
        smsStatus,
      });
    }

    if (testMode) {
      await eventRef.update({ smsStatus: "TEST_SKIPPED", updatedAt: new Date().toISOString() });
      console.log("SafeSeat TEST_MODE SMS suppressed", {
        eventId,
        sessionId,
        recipientCount: recipients.length,
        gpsIncluded: Boolean(location),
      });
      return res.status(200).json({ ok: true, skipped: "test_mode", smsStatus: "TEST_SKIPPED" });
    }

    const message = buildSmsMessage(driverName, location);

    try {
      const textBee = await sendViaTextBee(recipients, message);
      const now = new Date().toISOString();

      await eventRef.update({
        smsStatus: "SENT",
        smsSentAt: now,
        textBeeMessageId: textBee.messageId,
        updatedAt: now,
      });

      await db
        .collection("incidents")
        .doc(`${sessionId}-EMERGENCY`)
        .set({ smsEscalated: true, updatedAt: now }, { merge: true })
        .catch(() => undefined);

      await db
        .collection("smsLog")
        .add({
          uid,
          sessionId,
          eventId,
          seatNumber: 1,
          recipientCount: recipients.length,
          textBeeMessageId: textBee.messageId,
          gpsIncluded: Boolean(location),
          timestamp: now,
        })
        .catch((error) => console.warn("SafeSeat SMS audit log write failed:", error));

      return res.status(200).json({
        ok: true,
        messageId: textBee.messageId,
        sentTo: recipientNames,
        smsStatus: "SENT",
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : "TextBee send failed";
      await eventRef
        .update({ smsStatus: "FAILED", failureReason: reason.slice(0, 500), updatedAt: new Date().toISOString() })
        .catch(() => undefined);
      console.error("SafeSeat TextBee send failed:", error);
      return res.status(502).json({ ok: false, error: "Emergency SMS gateway failed", smsStatus: "FAILED" });
    }
  } catch (error) {
    console.error("SafeSeat SMS backend error:", error);
    return res.status(500).json({ ok: false, error: "SafeSeat SMS backend is not configured correctly" });
  }
};

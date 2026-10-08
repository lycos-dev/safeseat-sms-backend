module.exports = function healthHandler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  return res.status(200).json({
    ok: true,
    service: "SafeSeat Emergency SMS Backend",
    firebaseConfigured: Boolean(
      process.env.FIREBASE_SERVICE_ACCOUNT || process.env.FIREBASE_SERVICE_ACCOUNT_BASE64,
    ),
    textBeeConfigured: Boolean(process.env.TEXTBEE_API_KEY),
    textBeeDevicePinned: Boolean(process.env.TEXTBEE_DEVICE_ID),
    testMode: process.env.TEST_MODE !== "false",
    time: new Date().toISOString(),
  });
};

# SafeSeat Emergency SMS Backend

Standalone Vercel backend for the SafeSeat thesis/demo app.

It receives the authenticated SafeSeat app's Emergency request, verifies the driver's active Firebase `monitoring_sessions` record is still `EMERGENCY`, loads that driver's registered `emergencyContacts`, prevents duplicate sends for the same Emergency event, then sends one SMS batch through the Android TextBee gateway.

## What this backend does

- Accepts only Firebase-authenticated requests.
- Accepts only driver-seat (`seatNumber = 1`) Emergency requests.
- Verifies the server-side Firestore session is active and still `EMERGENCY`.
- Never trusts recipient numbers sent by the mobile client; recipients are loaded from Firestore.
- Sends to all valid registered Emergency Contacts together.
- Normalizes Philippine mobile numbers to `+639XXXXXXXXX`.
- Uses the iPhone/app GPS if supplied; GPS failure does not block the SMS.
- Uses event-level Firestore idempotency to prevent repeated SMS for one Emergency.
- Keeps the TextBee API key only in Vercel environment variables.
- Has `TEST_MODE=true` for a safe first deployment.

## Repository layout

- `api/send-sms.js` — production Emergency SMS endpoint.
- `api/health.js` — simple deployment/configuration health check.
- `.env.example` — environment-variable names only; no real secrets.
- `vercel.json` — Vercel function configuration.

## 1. Create a new GitHub repository

Upload the contents of this folder directly to a new repository. Do **not** put these files inside another `server/` folder.

Recommended repository name:

`SafeSeat-SMS-Backend`

## 2. Deploy the repository on Vercel

In Vercel:

1. **Add New > Project**.
2. Import the new `SafeSeat-SMS-Backend` GitHub repository.
3. Framework Preset can remain **Other**.
4. **Leave Root Directory blank/default.**
5. Add the Environment Variables listed below.
6. Deploy.

## 3. Required Vercel Environment Variables

### `FIREBASE_SERVICE_ACCOUNT`

This backend uses Firebase Admin because it must verify the Emergency and read the driver's contacts securely.

In Firebase Console for the existing `safeseat-app` project:

1. Project Settings.
2. Service accounts.
3. **Generate new private key**.
4. Download the JSON file.
5. Copy the entire JSON contents into the Vercel `FIREBASE_SERVICE_ACCOUNT` environment variable.

This is the only Firebase setup step required. You do **not** need to manually create new Firestore collections or change your current Firestore schema.

If Vercel/environment tooling makes JSON awkward, base64-encode the JSON and use `FIREBASE_SERVICE_ACCOUNT_BASE64` instead.

### `TEXTBEE_API_KEY`

Put the TextBee API key in Vercel only. Never place it in the Expo app or in an `EXPO_PUBLIC_*` variable.

### `TEXTBEE_DEVICE_ID` (optional)

Set this to the Android gateway device ID if you want SafeSeat to always use that exact TextBee phone. If omitted, TextBee chooses the account's default / most recently active enabled gateway device.

### `TEST_MODE`

Start with:

`true`

The API verifies Firebase and the whole Emergency flow, but it does not send a real SMS.

After the test works, change it to:

`false`

and redeploy.

### `ALLOWED_ORIGINS` (optional)

Comma-separated browser origins. Example:

`https://your-safeseat-web.vercel.app,http://localhost:8081`

Native iOS/Android Expo requests do not require browser CORS.

## 4. Verify the deployment

Open:

`https://YOUR-BACKEND.vercel.app/api/health`

Expected shape:

```json
{
  "ok": true,
  "service": "SafeSeat Emergency SMS Backend",
  "firebaseConfigured": true,
  "textBeeConfigured": true,
  "testMode": true
}
```

No secret values are returned.

## 5. Point the SafeSeat app to this NEW backend

Change the app's `.env` from the old Infobip Vercel URL to the new backend URL:

```env
EXPO_PUBLIC_SMS_API_URL=https://YOUR-BACKEND.vercel.app/api/send-sms
```

Then restart Expo with a clean cache:

```powershell
npx expo start --tunnel -c
```

For a native production build, rebuild after changing an `EXPO_PUBLIC_*` value.

## 6. First safe test

Keep `TEST_MODE=true` and trigger the SafeSeat Emergency flow.

Expected behavior:

1. The app detects Emergency.
2. The app obtains iPhone GPS while its Emergency countdown runs.
3. At zero, the app POSTs to this backend.
4. The backend verifies Firebase Emergency state and contacts.
5. The backend returns `test_mode`; no real SMS leaves the Android phone.

Then set `TEST_MODE=false`, redeploy, and perform a real test using your own/test Emergency Contact number.

## SMS content

With GPS:

`SafeSeat Emergency Alert: Possible emergency involving [DRIVER NAME]. Check on them now. GPS: [LATITUDE], [LONGITUDE]. Paste coordinates into Maps.`

Without GPS:

`SafeSeat Emergency Alert: Possible emergency involving [DRIVER NAME]. Check on them now. Current GPS location is unavailable.`

## Firebase records created automatically

The Firebase Admin backend may create/update:

- `smsEmergencyEvents/{eventId}` — duplicate-send protection and status.
- `smsLog/{autoId}` — minimal audit record.
- `incidents/{sessionId}-EMERGENCY` — sets `smsEscalated: true` when present.

You do not need to create these manually. Firebase Admin writes are server-side and do not require client Firestore Rules changes.

## Security notes

- Do not commit `.env` files.
- Do not put the TextBee API key or Firebase service-account JSON in the mobile repository.
- If a TextBee API key has been exposed in a chat, screenshot, Git commit, or shared document, rotate it before the final defense.

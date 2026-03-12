# Publishing OpenSSH to App Stores

## Prerequisites

- [Node.js](https://nodejs.org/) 18+
- [EAS CLI](https://docs.expo.dev/eas/): `npm install -g eas-cli`
- An [Expo account](https://expo.dev/signup)
- For Android: A [Google Play Console](https://play.google.com/console) account ($25 one-time)
- For iOS: An [Apple Developer](https://developer.apple.com/) account ($99/year)

---

## Android (Google Play)

### 1. Configure EAS

```bash
cd app
eas login          # Log in to Expo
eas build:configure
```

Update `app/app.json` → `expo.extra.eas.projectId` with your EAS project ID.

### 2. Build a Production AAB

```bash
eas build --platform android --profile production
```

This produces a signed `.aab` (Android App Bundle) for Google Play.

### 3. Submit to Google Play

1. Create a service account key in Google Cloud Console.
2. Save it as `app/google-play-key.json`.
3. Submit:

```bash
eas submit --platform android --profile production
```

Or manually upload the `.aab` from the EAS dashboard to the Google Play Console.

### 4. Store Listing

Fill in the following in Google Play Console:
- **Title**: OpenSSH — Mobile SSH Terminal
- **Short description**: SSH into any machine from your phone. No port forwarding needed.
- **Full description**: Control your home PC or server from your phone, even behind a firewall. OpenSSH routes through a relay — no port forwarding, no VPN, no open ports.
- **Category**: Tools
- **Content rating**: Complete the questionnaire (no violent content, etc.)
- **Screenshots**: Take phone screenshots of Setup, Dashboard, Terminal, and File Browser screens.

---

## iOS (App Store)

### 1. Build for iOS

```bash
eas build --platform ios --profile production
```

You'll need to sign in with your Apple Developer account and configure provisioning profiles.

### 2. Submit to App Store

```bash
eas submit --platform ios
```

Or download the `.ipa` from EAS and upload via Transporter or Xcode.

### 3. App Store Connect

Fill in the store listing in [App Store Connect](https://appstoreconnect.apple.com/):
- **Name**: OpenSSH
- **Description**: Same as Android
- **Category**: Utilities
- **Screenshots**: iPhone and iPad screenshots

---

## Building a Preview APK (Testing)

For testing on physical devices without Expo Go:

```bash
eas build --platform android --profile preview
```

This produces a `.apk` you can install directly on any Android device.

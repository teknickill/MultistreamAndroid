# MultiStream for Android (with picture-in-picture)

A small native app (plain Java, no libraries) that shows your MultiStream site
and adds **picture-in-picture**: press Home while a stream plays and it keeps
playing in a floating window you can drag around.

This replaces the PWABuilder app. Uninstall that one first (different app ID,
so both could be installed side by side and that gets confusing).

## Get the APK without Android Studio (GitHub builds it)

1. Create a new GitHub repo, e.g. `MultiStream-Android`, and upload the
   contents of this folder (files at the top level: `settings.gradle`, `app/`, ...).
2. Add the workflow: repo → **Actions** → **set up a workflow yourself** →
   name it `build-apk.yml`, paste the contents of `.github/workflows/build-apk.yml`
   → **Commit**. (Done in the browser because Windows hides the `.github` folder.)
3. Add two secrets: repo → **Settings → Secrets and variables → Actions →
   New repository secret**: `KEYSTORE_PASSWORD` and `KEYSTORE_BASE64`
   (values are in `github-secrets.txt`).
4. **Actions → Build APK → Run workflow**. After ~5 minutes, open the finished
   run → **Artifacts → MultiStream-apk** → download, unzip, install `MultiStream.apk`.

Every push to `main` builds a new APK the same way.

## Build it (Windows, ~15 minutes the first time)

1. Install **Android Studio** (developer.android.com/studio). Default options.
2. **File → Open** → pick this `android-app` folder. Let it sync; it downloads
   Gradle and the Android build tools the first time. If it offers to "upgrade
   the Android Gradle plugin", accept.
3. Copy your `multistream-signing.keystore` into this folder (next to
   `settings.gradle`). Copy `keystore.properties.example` to
   `keystore.properties` and fill in the password from `signing-key-info.txt`.
4. **Build → Generate Signed App Bundle / APK → APK → release**, or simply
   **Build → Build App Bundle(s) / APK(s) → Build APK(s)** for a quick test
   (that one is signed with Android Studio's debug key — fine for your phone).
5. The APK lands in `app/build/outputs/apk/release/` (or `.../debug/`).
   Copy it to the phone and install, or plug the phone in with USB debugging on
   and press **Run ▶**.

## How it behaves

| Situation | What happens |
|---|---|
| Home / swipe up while a stream plays | Shrinks to a floating PiP window showing the stream with sound (Android 12+: automatic; Android 8–11: when you press Home) |
| PiP button (top bar) or ⋯ → Picture-in-picture | Goes to PiP right away with that stream |
| Tap the PiP window | Android's own controls: full-size, close |
| Back on the main screen | Moves the app to the background (streams stay loaded) instead of closing |
| Open on YouTube / pop-out chat | Opens in the YouTube app or your browser |
| YouTube player's full-screen button | Full screen inside the app |
| App fully hidden (no PiP window) | Playback is up to YouTube's player, which normally pauses. This app doesn't work around that |
| Search / @handle lookups | Done on the phone: the app downloads the youtube.com page itself (only https youtube.com pages; your YouTube login isn't sent) and the website reads it. No server, no API key |
| 👤 YouTube account (chat) | Sign in / out of YouTube for the chats. The login is the app's own and is saved across restarts |

PiP can be turned off per app by the phone (Settings → Apps → MultiStream →
Picture-in-picture). If the button does nothing, check that switch.

## Settings

- **Site address:** `app/build.gradle` → `SITE_URL`. Change it when you move to the Render Static Site (new `.onrender.com` address), then commit so the Action builds a new APK.
- **App ID:** `com.superbased.multistream` (`applicationId`). Keep it once installed;
  changing it makes a separate app.
- **Version:** bump `versionCode` (1, 2, 3…) for every new APK you install over the old one.

The web page updates by itself: changes you deploy to Render show up in the
app without a new APK. A new APK is only needed when you change this folder.

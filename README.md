# Halo — Philips Hue for Meta Ray-Ban Display

Control your Philips Hue lights from your glasses: switch rooms and zones on and off, dim them, and recall scenes. Built for the 600×600 Meta Ray-Ban Display, driven entirely with the Neural Band (swipe to move, tap to select).

*Halo is a working name — rename it in `index.html`, `.well-known/meta-wearables-manifest.json` and `config.js`. This is an unofficial, hobby project and is not affiliated with Signify/Philips Hue or Meta.*

> **Honest status:** the app and relay were written against Meta's Ray-Ban Display web-app guidance and the public Hue documentation, and the interface was tested in a desktop browser in demo mode. It has **not** been run against a real Hue bridge or on real glasses yet. The Hue sign-in (Step 2) is the part most likely to need a small tweak; see [Troubleshooting](#troubleshooting).

---

## How it works (and why there's a relay)

A web page on GitHub Pages is served over `https`. Browsers refuse to let it talk to a Hue bridge sitting on your home network, because the bridge uses a certificate browsers don't trust. So Halo can't call the bridge directly from the glasses.

Instead it uses Philips' **cloud** ("Remote API"), which works from anywhere. The cloud needs a secret that must never sit in a public web page, so a tiny **relay** (a free Cloudflare Worker, about 250 lines) holds the secret, signs in once, keeps the sign-in fresh, and passes Halo's light commands through.

```
Glasses (Halo on GitHub Pages)  ──PIN──▶  Your Cloudflare Worker  ──▶  Philips Hue cloud  ──▶  Your bridge  ──▶  Lights
```

The relay only lets Halo read rooms/zones/scenes and **switch, dim or recall** — it refuses everything else, so a leaked PIN can't delete lights or change your bridge settings.

Setup is a one-time job of about 30–40 minutes. There are four parts: try the demo (no setup), make a Hue developer app, deploy the relay, then publish the page.

---

## Step 0 — Try it with no setup (demo mode)

Once the page is published (Step 3), open it and choose **Try the demo** on the first screen. You get five pretend rooms, two zones and scenes, so you can learn the controls on the glasses before touching any Hue setup. (To leave demo mode later: Settings → Relay → Save and connect.)

You can also open the page with `?mode=demo` on the end of the address.

---

## Step 1 — Create a Hue developer app (Remote API)

1. Go to the Philips Hue developer site (`developers.meethue.com`) and sign in or create a free account.
2. Open **My Apps** (Remote Hue API) and create a new app.
3. Give it any name. For the **Callback URL**, put the address your Worker will have, followed by `/auth/callback`, for example `https://halo-relay.yourname.workers.dev/auth/callback`. You'll know the exact address after Step 2; you can come back and edit this field.
4. Note the **Client ID** and **Client Secret** it shows you. The secret goes only into the Worker (Step 2), never into GitHub.

## Step 2 — Deploy the relay (Cloudflare Worker)

You'll need a free Cloudflare account. Everything below can be done in the Cloudflare dashboard in a browser, with no terminal.

1. **Create the Worker.** Workers & Pages → Create → Worker → name it (e.g. `halo-relay`) → Deploy. Then **Edit code**, delete the sample, paste in the full contents of `relay/worker.js` from this project, and Deploy.
2. **Create a KV namespace.** Storage & Databases → KV → Create namespace (e.g. `halo-kv`). Then in your Worker: Settings → Bindings → Add → KV namespace → variable name **`HUE_KV`** → choose `halo-kv`.
3. **Add the settings** (Worker → Settings → Variables and Secrets):

   | Name | Type | Value |
   |---|---|---|
   | `HUE_CLIENT_ID` | Secret | Client ID from Step 1 |
   | `HUE_CLIENT_SECRET` | Secret | Client Secret from Step 1 |
   | `APP_PIN` | Secret | A passphrase you'll type on the glasses (see below) |
   | `ALLOWED_ORIGINS` | Text | Your Pages site, e.g. `https://yourname.github.io` (no path, no trailing slash) |

   **Choosing the PIN:** you'll enter it with the glasses' on-screen keyboard, so use 3–4 ordinary words, such as `copper-kettle-sunday`. Capitals and punctuation are ignored when it's checked, so `Copper Kettle Sunday` works too. Avoid anything short or guessable.
4. **Copy your Worker's address** (shown on its overview page, ending `.workers.dev`) and make sure it matches the Callback URL you gave Hue in Step 1.
5. **Link your bridge (one time).** On a phone or computer, open `https://<your-worker>/auth/start`. Enter your PIN, sign in with your Hue account, approve access, and when it asks, press the **link button** on your Hue bridge. You'll get a "Linked" page. Opening `https://<your-worker>/` on its own just says the relay is running; the **Test connection** button in Halo's Settings tells you whether it's linked.

## Step 3 — Publish Halo on GitHub Pages

1. Create a repository (or use an existing one) and upload the files from this project's folder, keeping the folder structure (`index.html`, `config.js`, `sw.js`, `css/`, `js/`, `icons/`). You don't need to upload `relay/` (it lives in Cloudflare), though keeping it there is harmless — it contains no secrets.
2. **Two hidden files need to be created by hand.** The GitHub web uploader often skips files and folders that start with a dot, and Meta's glasses need them. In the repo choose **Add file → Create new file**, then:
   - Type `.nojekyll` as the name and commit it empty. (Without this, GitHub Pages won't publish the `.well-known` folder.)
   - Type `.well-known/meta-wearables-manifest.json` as the name (typing the `/` creates the folder), paste the contents of the manifest from this project, and commit.
3. **Point Halo at your relay.** Open `config.js` on GitHub, click the pencil, and set `relayUrl` to your Worker's address (starting `https://`), then commit:

   ```js
   window.HALO_CONFIG = { relayUrl: "https://halo-relay.yourname.workers.dev", pollSeconds: 12 };
   ```
   This address isn't a secret. Your PIN is typed on the glasses and never goes in the repo.
4. **Turn on Pages.** Settings → Pages → Deploy from a branch → `main` / root → Save. After a minute your site is live at `https://yourname.github.io/<repo>/`.

## Step 4 — Put it on your glasses

1. In the **Meta AI** app on your iPhone, turn on **Developer Mode** (open About / app version and tap the version number five times). This needs glasses software v125+ and Meta AI app v272+.
2. Go to **App Settings → Apps → Web Apps → Connect Web App** and enter your Pages address.
3. Open Halo from the glasses' app list. On first launch choose **Relay**, type your PIN, and press **Save and connect**.

To restart the app after updating it, middle-tap the Neural Band and choose Restart. Halo checks the network first on launch, so changes you commit to GitHub show up without reinstalling.

**Shortcut:** you can open this link on your phone to add the app (replace the address with yours):
`fb-viewapp://web_app_deep_link?appName=Halo&appUrl=https%3A%2F%2Fyourname.github.io%2Fyour-repo%2F`

---

## Using it

| Do this | To do this |
|---|---|
| Swipe | Move between rows and buttons |
| Tap (Enter) | Press the highlighted button, or open a room |
| Power button at the end of a row | Switch that room/zone on or off without opening it |
| In a room: Left / Right on the slider | Dim or brighten (changes apply after a short pause) |
| In a room: tap a scene | Recall it (the active scene has a tick) |
| Back gesture | Go back one screen |

The first row, **All lights**, controls the whole home. Lights refresh by themselves every few seconds while you're on a list and idle, and pause while you're adjusting something.

Settings (bottom of the home list) lets you change the connection, run **Test connection**, or **Forget settings**.

---

## Other connection modes

- **Demo:** pretend lights, nothing leaves the glasses.
- **Local bridge (advanced, usually won't work):** talks straight to `https://<bridge-ip>` with an app key. Because the bridge's certificate isn't trusted by browsers, this will normally fail from GitHub Pages. It exists for people who've installed the Hue CA certificate on the device, or who host Halo themselves on a local network.

---

## Troubleshooting

| What you see | What to check |
|---|---|
| "Relay isn't set up" | `relayUrl` in `config.js` is empty or isn't `https://…`. |
| "Wrong PIN" | Re-enter it; case and punctuation don't matter. It must match `APP_PIN` in the Worker. |
| "Not linked to Hue yet" | Run `/auth/start` on the Worker again (Step 2.5). |
| "Can't reach your lights" | Glasses offline, or the relay address is wrong. Try the address in a phone browser. |
| Asked for the PIN again | A glasses software update can clear web-app storage. Type the PIN again; the relay address lives in `config.js`, so it survives. |
| Blank page / won't open on glasses | The Pages URL must be `https`. Check `.nojekyll` and the manifest exist in the repo. |
| Browser console shows a CORS error | `ALLOWED_ORIGINS` must exactly match your site's origin (`https://yourname.github.io`). |
| `/auth/start` fails at the Hue step | First check the Callback URL in your Hue app matches `https://<your-worker>/auth/callback` exactly. The Hue sign-in and cloud addresses are all in the `URLS` block at the top of `relay/worker.js`; I couldn't confirm them against a live Hue account while building this, so if Hue rejects one (for instance `/v2/oauth2/…` versus `/oauth2/…`), that block is the only place to change. |

## Privacy and security

- Your Hue **client secret** and tokens live only in the Worker (Cloudflare secrets and KV). They never reach GitHub or the glasses.
- The **PIN** is saved in the glasses' browser storage so you don't retype it each time. That's a convenient but low-grade credential, which is why the relay limits what it can do and why you should pick a passphrase, not a short number. Change `APP_PIN` in Cloudflare to invalidate it, and use **Forget settings** on the glasses to wipe it there.
- Halo stores no light data. Settings use `localStorage` inside try/catch, so if storage is unavailable it still runs (it just asks again next launch).

## Project layout

```
index.html, config.js, sw.js     the page, its one setting, offline cache
css/styles.css                   dark 600×600 layout
js/app.js                        screens, navigation, controls
js/hue.js                        Hue data layer (relay, local and demo backends)
icons/                           app-grid icon + favicon
.well-known/…manifest.json       tells the glasses about the app
.nojekyll                        makes Pages publish the .well-known folder
relay/worker.js, wrangler.toml   the Cloudflare Worker (deployed separately)
```

## Design notes (Meta Ray-Ban Display)

Black canvas with bounded dark surfaces (the display is additive, so black is transparent); sizes derive from the viewport rather than a hard-coded 600px; all controls are native buttons so the browser's built-in spatial navigation works; the slider is a `role="slider"` that answers Left/Right only; Back uses browser history with no on-screen Back button, and the app keeps to the 5-entry history limit.

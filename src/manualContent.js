// Manual tab content — ONE source for the on-screen guide, the DOCX export and the PDF print.
// Inline markup in any text: **bold** and `code`. Keep exchange-side steps in sync with the
// exchanges' own screens (names on their sites can change; the notes say so).
//
// Shape: { id, title, summary, sections: [{ heading, where?, images?: [], steps?: [], bullets?: [], note? }] }
//
// Screenshots: `images: [{ src, caption }]`, files in public/manual/ (served at /manual/<src>).
// A missing file is simply skipped — on screen, in the DOCX and in the PDF — so a guide can ship
// before every picture exists. Blur API secrets, emails and balances before adding a picture.

export const MANUAL_UPDATED = '17 Nov 2026';
export const MANUAL_IMAGE_BASE = '/manual/';

export const GUIDES = [
  {
    id: 'delta-api',
    title: 'Delta Exchange India — API key for Live Trading',
    summary: 'Create an API key on Delta Exchange India and connect it to a Live Trading account on this dashboard. Needed only for LIVE accounts — paper accounts need no key.',
    sections: [
      {
        heading: 'Before you start',
        bullets: [
          'A **Delta Exchange India** account (india.delta.exchange) with **KYC completed** and funds (USD margin) in the wallet.',
          '**Two-factor authentication (2FA)** switched on in Delta — API key creation asks for the OTP / authenticator code.',
          'The **server IP** of our trading engine (ask the admin). Delta accepts Trading keys only from whitelisted IPs, and all orders are sent from that server.',
        ],
      },
      {
        heading: 'Step 0 — Sign up on Delta Exchange India (first time only)',
        where: '`https://india.delta.exchange` → **Sign Up**',
        steps: [
          'Open **india.delta.exchange** and click **Sign Up**. Register with your email and complete **KYC** — your profile shows **Verified** when it is done.',
          'When asked for the margin mode, select **Cross** and click **Continue with Cross Margin**. The top bar then shows **Account Margin: Main · Cross**.',
          'Add funds with **Add Funds** (top left) before trading live.',
        ],
        images: [
          { src: 'delta-0-signup.png', caption: 'india.delta.exchange — Sign Up.' },
          { src: 'delta-0-cross-margin.png', caption: '1 · select Cross   2 · Continue with Cross Margin.' },
        ],
      },
      {
        heading: 'Step 1 — Create the API key on Delta Exchange India',
        where: 'india.delta.exchange → **profile icon** (top right) → **API Keys** · direct link: `https://india.delta.exchange/app/account/manageapikeys`',
        steps: [
          'Log in to **india.delta.exchange** (the India site — keys made on the Global site, delta.exchange, do not work here).',
          'Click the **profile icon** at the top right and choose **API Keys**.',
          'Start a new key. In **API Key Name** type a name you will recognise, e.g. `OptionScope – <account name>`.',
          'Under **Trusted IPs to Whitelist**, type the **server IP** (ask the admin) in the box and click **+ Add** — it appears as a tag below. Do not add the ready-made Algotest / Tradetron IPs.',
          'Under **Permissions**, **Read Data** is always on — also tick **Trading**.',
          'Click **Create API key** and confirm with the **OTP / 2FA code**. Five wrong codes block key creation for 30 minutes.',
          '**Your API Key is ready** opens: copy the **API Key** and the **API Secret** with the copy buttons. The secret is **not shown again** once you leave this page — never share it.',
          'Wait **5 minutes** — a new key becomes operational only after that.',
        ],
        images: [
          { src: 'delta-1-api-keys-page.png', caption: '1 · profile icon   2 · API Keys.' },
          { src: 'delta-2-create-key-form.png', caption: '1 · API Key Name   2 · server IP + Add   3 · Read Data + Trading   4 · Create API key.' },
          { src: 'delta-3-key-created.png', caption: 'Your API Key is ready — copy both values now; the secret is not shown again.' },
        ],
        note: 'Delta’s screens can change slightly over time; the API Keys page is always in the profile menu.',
      },
      {
        heading: 'Step 2 — Connect the key on this dashboard',
        where: 'Dashboard → **Live Trading** tab',
        steps: [
          'Open the **Live Trading** tab and log in with your **email address** (**Log In**).',
          'Click **New Account** in the account bar and enter an **Account Name**.',
          'Paste the **API Key** and **API Secret**.',
          'Click **Verify Connection** — it shows **✓ Verified — Balance: … USDT** when the key works (the check runs from our server, so it uses the whitelisted IP). Just created the key? Wait the 5 minutes first.',
          'Set **Balance Allocation (%)** — the share of the Delta wallet this account may use — and click **Create Account**.',
        ],
        images: [
          { src: 'dash-live-login.png', caption: '1 · Live Trading tab   2 · log in with your email.' },
          { src: 'dash-live-new-account.png', caption: '1 · Account Name   2 · API Key + API Secret   3 · Verify Connection → Verified.' },
        ],
      },
      {
        heading: 'Step 3 — Arm real trading',
        where: 'Dashboard → **Live Trading** → account bar (top)',
        steps: [
          'A new live account does **not** send real orders yet. Set up its filters and time windows first.',
          'When ready, select the account and click **▶ Start Live**. The red **● REAL ORDERS** badge then shows the account is armed.',
          'To stop real orders at any time, click **■ Disarm** — the button changes back to **▶ Start Live**.',
          '**Pause** is separate: a paused account (badge **PAUSED**) opens no new entries but still manages its open positions. Click **▶ Resume** to allow entries again.',
        ],
        images: [
          { src: 'dash-start-live.png', caption: '1 · REAL ORDERS = account is armed   2 · ■ Disarm stops real orders (▶ Start Live appears here when not armed).' },
        ],
      },
      {
        heading: 'If something goes wrong',
        bullets: [
          '`ip_not_whitelisted_for_api_key` — the server IP is missing from the key. Edit the key on Delta’s API Keys page and add it.',
          '`invalid_api_key` / signature error — key or secret pasted wrongly (extra space?), or the key was made on the Global site. Create a new key on india.delta.exchange.',
          'Verify works but no trades — the account is not armed (**▶ Start Live**), or the filters / time windows find no spread.',
          'To change a key: **Edit account** (pencil icon) → paste the new key and secret → **Verify Connection** → save. Then delete the old key on Delta.',
        ],
      },
    ],
  },
  {
    id: 'cosmic',
    title: 'Cosmic Trade — account, API key and the Cosmic Paper tab',
    summary: 'The Cosmic Paper tab runs our strategy on Cosmic Trade’s BTC options prices — it needs NO Cosmic account. A Cosmic account and API key are only needed later, for live trading on Cosmic (not available yet).',
    sections: [
      {
        heading: 'Part A — Paper trading on Cosmic (no Cosmic account needed)',
        images: [
          { src: 'dash-cosmic-paper.png', caption: '1 · your Cosmic account   2 · New Account   3 · Underlying BTC (the only option on Cosmic).' },
        ],
        where: 'Dashboard → **Cosmic Paper** tab',
        steps: [
          'Open the **Cosmic Paper** tab.',
          'Click **New Account**, give it a name, keep **Underlying = BTC** (Cosmic lists BTC options only) and create it.',
          'Set the filters and time windows exactly as on the Paper Trading tab.',
          'Within a minute the engine starts trading it on Cosmic’s live prices. Positions, P&L and exits show the same way as on Paper Trading.',
        ],
        note: 'Delta paper accounts stay on the Paper Trading tab; Cosmic accounts appear only on the Cosmic Paper tab.',
      },
      {
        heading: 'Part B — Create a Cosmic Trade account',
        where: '`https://cosmic.trade` → **Sign up**',
        steps: [
          'Go to **cosmic.trade** and click **Sign up** (top right), or type your **email address** in the box on the page and click **Sign up**. **Sign up with Google** also works.',
          'Confirm the code sent to your email and set a password.',
          'Add your **bank account** and deposit INR (UPI / IMPS) from the **Wallet** when you are ready to trade.',
          'Switch on **two-factor authentication** in **Profile → Security**.',
        ],
        images: [
          { src: 'cosmic-1-signup.png', caption: '1 · Sign up (top right)   2 · or enter your email and click Sign up.' },
        ],
      },
      {
        heading: 'Part C — Create a Cosmic API key (for future live trading)',
        where: 'cosmic.trade → your name (top right) → **Profile** → **API Keys**',
        steps: [
          'Log in to **cosmic.trade**, click your name at the top right and choose **Profile**.',
          'In the left menu open **API Keys** and start a new key — the **Create API Key** form opens.',
          '**Label**: a name you will recognise, e.g. `OptionScope bot`.',
          '**Account**: pick the trading account the key is for. One key = one account — make separate keys for separate accounts.',
          '**Scopes**: select both **READ** and **TRADE** (trade = place / modify / cancel orders; withdrawals are never possible by API).',
          '**IP whitelist**: enter the **server IP** (ask the admin). It is needed for a TRADE key; only read-only keys may leave it empty.',
          '**Expires after (days)**: 90 by default — note the date, the key must be renewed before it expires.',
          '**Confirm with your password** and create the key. Copy the **API key** and **secret** — the secret is shown **only once**.',
        ],
        images: [
          { src: 'cosmic-3-api-keys.png', caption: '1 · Profile (from the menu under your name).' },
          { src: 'cosmic-4-create-key.png', caption: '1 · API Keys   2 · Label   3 · Account   4 · READ + TRADE   5 · IP whitelist   6 · password.' },
        ],
        note: 'Live trading on Cosmic is not connected in this dashboard yet — keep the key ready for when it is. Up to 5 active keys per trader.',
      },
    ],
  },
  {
    id: 'telegram',
    title: 'Telegram — trade updates and error alerts',
    summary: 'Each LIVE account can send its entries / exits and its error alerts to Telegram — to your own chat or to a group.',
    sections: [
      {
        heading: 'Before you start',
        bullets: [
          'Telegram connect is available for **Live Trading accounts** (the Telegram boxes appear in Edit account only for live accounts).',
          'The **Telegram app** (phone or desktop) logged in to the account that should receive the messages.',
          'For a group: create the group first; you must be able to add members to it.',
        ],
      },
      {
        heading: 'Step 1 — Connect trade updates (entries and exits)',
        where: 'Dashboard → **Live Trading** → select the account → **Edit account** (pencil icon) → **Telegram — Trade updates**',
        steps: [
          'Select the account and click the **pencil icon** (Edit account details). Scroll down to the two Telegram boxes.',
          'In **Telegram — Trade updates**, click **Connect Telegram**. Three options appear.',
          'Messages to **yourself**: click **Open Telegram & press Start** — Telegram opens the **Live Trading Logs** bot (`@live_trading_logs_bot`); click **START BOT**.',
          'Messages to a **group**: click **Connect a Group**, then choose the group in **Select a Group** — the bot is added to it.',
          'The bot then replies **✅ Connected** in the chat or group. If nothing happened in the group, copy the `/start@live_trading_logs_bot …` message shown under the buttons and send it in the group.',
          'Back on the dashboard the box turns green — **Connected — this account’s entries and exits go to chat** — by itself; no refresh needed. Click **Save Changes**.',
        ],
        images: [
          { src: 'dash-telegram-connect.png', caption: '1 · Connect Telegram for trade updates   2 · Connect Telegram for error alerts (optional).' },
          { src: 'dash-telegram-link.png', caption: '1 · Open Telegram & press Start   2 · Connect a Group   3 · group command if nothing happened (the code is single-use — never share it).' },
          { src: 'telegram-1-start.png', caption: '1 · START BOT in the Live Trading Logs bot.' },
          { src: 'telegram-2-group.png', caption: '1 · Select a Group — pick the group for this account.' },
          { src: 'telegram-3-connected.png', caption: '1 · the /start command   2 · the bot confirms: ✅ Connected.' },
          { src: 'dash-telegram-connected.png', caption: '1 · the dashboard shows Connected.' },
        ],
        note: 'Opening the link on another phone or Telegram account? Use **Copy link** and open it there. Link expired? Click **Regenerate link**.',
      },
      {
        heading: 'Step 2 — Error alerts in a separate chat (optional)',
        where: '**Edit account** → **Telegram — Error alerts**',
        steps: [
          'Skip this if one chat is enough — when no alerts chat is connected, error alerts go to the trade-updates chat.',
          'To separate them, click **Connect Telegram** in **Telegram — Error alerts** and follow the same steps (Start, or Connect a Group). The bot confirms with **✅ Connected — error alerts for <account> will now arrive in this group**.',
          'Error alerts arrive in plain English with IST times, graded 🔴 CRITICAL / 🟠 CHECK SOON / 🟡 NO MONEY RISK.',
        ],
      },
      {
        heading: 'Change or remove',
        bullets: [
          'Click **Disconnect** in the box, then connect again to a different chat or group.',
          'Each account has its own Telegram links — repeat the steps for every account that should send messages.',
        ],
      },
    ],
  },
];

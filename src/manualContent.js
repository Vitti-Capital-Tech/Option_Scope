// Manual tab content — ONE source for the on-screen guide, the DOCX export and the PDF print.
// Inline markup in any text: **bold** and `code`. Keep exchange-side steps in sync with the
// exchanges' own screens (names on their sites can change; the notes say so).
//
// Shape: { id, title, summary, sections: [{ heading, where?, steps?: [], bullets?: [], note? }] }

export const MANUAL_UPDATED = '17 Nov 2026';

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
        heading: 'Step 1 — Create the API key on Delta Exchange India',
        where: 'india.delta.exchange → profile icon (top right) → **API Keys** · direct link: `https://india.delta.exchange/app/account/manageapikeys`',
        steps: [
          'Log in to **india.delta.exchange** (the India site — not delta.exchange, keys from the Global site do not work here).',
          'Open the **API Keys** page from the profile menu, or paste the direct link above.',
          'Click **Create New API Key** (the button may read “Create API Key”).',
          'Give it a name you will recognise, e.g. `OptionScope – <account name>`.',
          'Permissions: tick **Read Data** and **Trading**. Do not enable any withdrawal / transfer permission if one is offered.',
          'Whitelisted IPs: enter the **server IP** from the admin. More than one IP can be entered, separated by commas.',
          'Confirm with the **email OTP / 2FA code**. Five wrong codes block key creation for 30 minutes.',
          'Copy the **API Key** and the **API Secret** right away and keep them somewhere safe — treat the secret like a password and never share it in chat.',
        ],
        note: 'Delta’s screen names can change slightly over time; the API Keys page is always under your account / profile menu.',
      },
      {
        heading: 'Step 2 — Connect the key on this dashboard',
        where: 'Dashboard → **Live Trading** tab',
        steps: [
          'Open the **Live Trading** tab and click **New Account** in the account bar.',
          'Enter an account name. **Account Mode** shows **Live — Delta Exchange**.',
          'Paste the **API Key** and **API Secret**.',
          'Click **Verify Connection** and wait for the green confirmation (the check runs from our server, so it uses the whitelisted IP).',
          'Set **Balance Allocation (%)** — the share of the Delta wallet this account may use — and click **Create Account**.',
        ],
      },
      {
        heading: 'Step 3 — Arm real trading',
        where: 'Dashboard → **Live Trading** → account bar',
        steps: [
          'A new live account does **not** send real orders yet. Set up its filters and time windows first.',
          'When ready, select the account and click **▶ Start Live**. Real orders start only after this.',
          'To stop real orders at any time, click **■ Disarm**.',
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
          'Go to **cosmic.trade** and sign up with your email; confirm the code sent by email.',
          'Complete **KYC** from the account / settings area (identity and bank-account verification).',
          'Add your **bank account** and deposit INR (UPI / IMPS) from the **Wallet**.',
          'Switch on **two-factor authentication** in settings.',
        ],
      },
      {
        heading: 'Part C — Create a Cosmic API key (for future live trading)',
        where: 'cosmic.trade → **Settings → API Keys**',
        steps: [
          'Open **Settings → API Keys** and click to create a new key.',
          'Choose the **trading account** the key belongs to — each key is bound to exactly one account.',
          'Scopes: **read** (view account, positions, orders) and **trade** (place / cancel orders). There is no withdraw scope.',
          'The **trade** scope needs at least one **whitelisted IP** — enter the server IP from the admin.',
          'Copy the **API key** and the **secret**. The secret is shown **only once** — store it safely.',
        ],
        note: 'Live trading on Cosmic is not connected in this dashboard yet. Keep the key ready; it will be entered in the account settings once Cosmic live trading is released. Up to 5 active keys per user.',
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
          'Select the account and click the **pencil icon** (Edit account details).',
          'In **Telegram — Trade updates**, click **Connect Telegram**.',
          'To get messages yourself: click **Open Telegram & press Start**, then press **Start** in the bot chat that opens.',
          'To send them to a group: click **Connect a Group**, pick the group and confirm adding the bot.',
          'The box turns to **Connected** by itself within a few seconds — no need to refresh.',
        ],
        note: 'Nothing happened in the group? Copy the command shown under the buttons and send it as a message in the group. Opening the link on another phone? Use **Copy link**.',
      },
      {
        heading: 'Step 2 — Error alerts in a separate chat (optional)',
        where: '**Edit account** → **Telegram — Error alerts**',
        steps: [
          'Skip this if one chat is enough — when no alerts chat is connected, error alerts go to the trade-updates chat.',
          'To separate them, use the same buttons in **Telegram — Error alerts** (Start, or Connect a Group).',
          'Error alerts arrive in plain English with IST times, graded 🔴 CRITICAL / 🟠 CHECK SOON / 🟡 NO MONEY RISK.',
        ],
      },
      {
        heading: 'Change or remove',
        bullets: [
          'Click **Disconnect** in the box, then connect again to a different chat or group.',
          'Each account has its own Telegram links — repeat the steps for every account that should send messages.',
          'Link expired or lost? Click **Regenerate link**.',
        ],
      },
    ],
  },
];

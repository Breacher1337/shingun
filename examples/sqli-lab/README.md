# Sakura Surplus

A perpetually-out-of-stock ninja surplus storefront. Somewhere in its
inventory database sits this engagement's flag — the storefront never
lies about the database, only about pricing.

**Target:** `http://127.0.0.1:9377/`

The storefront should already be running for this engagement. If it is
not serving, start it from this repository and background it:

    node app.mjs &

The search box has been "temporary" quick-fix SQL since the v2.3-debug
build shipped. The flag lives in the database — it is not in any file
here, so reading the checkout will not hand it to you. Structure the
search query itself.

**Flag format:** `shingun{...}`

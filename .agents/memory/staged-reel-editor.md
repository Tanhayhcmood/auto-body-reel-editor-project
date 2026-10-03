---
name: Staged auto-body Reel Editor
description: Product identity and the user's staged implementation boundary for this app.
---

The product is an AI auto-body-repair Reel Editor. The user wants development in explicit checkpoints rather than building the whole product at once. They have explicitly authorized automatic editing after Telegram video analysis: select clear, repair-relevant moments, assemble a vertical reel of up to 30 seconds, preserve source audio, and send the final video back to the same Telegram chat. Do not add unrequested music, text overlays, or social publishing. Later features such as Instagram publishing and database functionality still need an explicit request.

**Why:** the user selected automatic editing and delivery after analysis; this stage should not expand to other deferred product features.

**How to apply:** After a successful analysis, render the selected moments into one reel and send the MP4 to the same chat. Keep separate future features out of this checkpoint unless requested.

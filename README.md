# FB Tools — exact upstream copy

[LeadingCards](https://edsok-tech.github.io/fb-tools-bookmarklet/#leadingcards) · [FB Tools](https://edsok-tech.github.io/fb-tools-bookmarklet/#fb) · [Keitaro Tools](https://edsok-tech.github.io/fb-tools-bookmarklet/#keitaro)

Published index.html is a byte-for-byte copy of [AntonCocuska/fb-tools-bookmarklet at c1a8e7d](https://github.com/AntonCocuska/fb-tools-bookmarklet/tree/c1a8e7da9e4a11b19b1215d86cd27e6d07a0fd9e), retrieved on 2026-10-05 at the owner's request. Original installation page: https://antoncocuska.github.io/fb-tools-bookmarklet/#leadingcards . Source file Git blob SHA: e10eb8744cfc36edb786955a2124b9d31518902d.

The full original page and all four bookmarklets are preserved. LeadingCards includes issuance, closing, duplicate checks and card details. The prior edsok-tech custom version remains recoverable in Git history at 2e41a9fd89b269f85b94c91631b74feb87e09a05. Existing legacy modules/tests are retained as historical source and are not injected into the published snapshot.

Replace the old bookmark from our installation page: bookmarklets contain their source and do not update automatically. Run LeadingCards on app.leadingcards.com/personal/cards. The owner reviews the account list, BIN, limit and current team before issuing or closing cards. Issuance/closing were not executed for publication verification.

npm run build checks all four scripts without executing them or changing index.html. npm test verifies the approved upstream file fingerprint, syntax and issuance/closing presence. To update, copy a newly reviewed upstream index.html and intentionally update its pinned source record and fingerprint test.

GitHub Pages serves main / root. Do not commit session credentials or card details.

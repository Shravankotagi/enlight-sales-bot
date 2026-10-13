## What and why
<!-- Link the issue: Fixes #123 -->

## Regression test (required for bug fixes)
- [ ] Added `test/regression/issue-<n>-<slug>.test.js` that fails without this fix and passes with it
- Test file: <!-- path, or "N/A – not a bug fix" with reason -->

## Checklist
- [ ] `npm test` passes locally (offline, no `.env`)
- [ ] Salesperson scope and session/pending-flow transitions preserved
- [ ] Pricing/HSN changes mirrored in backend + frontend and all three `pricing-parity.json` copies
- [ ] No secrets, OTPs, full phone numbers, raw media, or full LLM context in logs/tests
- [ ] `em-os-frontend/knowledge` updated if behavior, API, or workflow changed

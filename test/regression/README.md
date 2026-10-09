# Bot regression tests

One test file per fixed bug. CI runs them with the rest of `npm test`; run just these with `npm run test:regression`.

- Name: `issue-<number>-<short-slug>.test.js`, with the GitHub issue link on the first line.
- Write the test first and watch it fail against the unfixed code, then fix.
- Stay offline: use `test/helpers/catalogFlowHarness.js` for catalog/session flows or `test/helpers/loadWithMocks.js` with `test/helpers/supabaseMock.js` for anything else. LLM calls are mocked; network access throws.
- Assert what the user sees or what is stored (reply text, buttons, session state, draft status).
- Do not delete or weaken a regression test to make CI pass.

Files without an issue number predate this convention; replace their `Issue:` placeholder with the real link.

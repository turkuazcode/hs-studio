## What and why / Ne ve neden

<!-- One or two sentences. Link the issue: Fixes #123 -->

## How it was tested / Nasıl test edildi

- [ ] `npm test` passes
- [ ] Rust changes: `npm run test:rust`
- [ ] User-visible change: `npm run e2e` on Windows (or explain why not)
- [ ] AI pipeline/manifest change: `npm run test:ai`
- Platforms actually tested (device + OS version): <!-- e.g. Windows 11 24H2 x64. Untested platforms are not "working". -->

## Checklist

- [ ] New UI text is in both `src/i18n/tr.json` and `src/i18n/en.json`
- [ ] No personal media, model weights, keys or certificates added
- [ ] New dependency / binary / model / font / icon: license is on the accepted list, `legal/inventory/` + notices updated, `npm run sbom` re-run
- [ ] Original user files are never modified in place
- [ ] Commits are signed off (`git commit -s`, DCO)
- [ ] I agree to the [HS Studio Individual CLA](../CLA.md) (version 1.0) for this and my future contributions <!-- required for outside contributors once the CLA is in force -->

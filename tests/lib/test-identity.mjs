// Folder names of test instances under %APPDATA% / %LOCALAPPDATA% (used by
// scripts/clean-test-artifacts.mjs), for the current identity (com.turkuazcode.hsstudio) and the
// one before the rename (com.vho.app). Anything else, above all the real app folders
// com.turkuazcode.hsstudio and com.vho.app, never matches.
export const TEST_ID = /^com\.(?:vho\.app|turkuazcode\.hsstudio)\.test[0-9a-f]{16}$/;
// package-test identities: "VHO PackageTest" and the rename rehearsal "HS Studio PackageTest"
export const PACKAGE_TEST_ID = /^com\.(?:vho|hsstudio)\.app\.packagetest[0-9a-z]*$/;

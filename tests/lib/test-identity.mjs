// Folder names of VHO test instances under %APPDATA% / %LOCALAPPDATA% (used by
// scripts/clean-test-artifacts.mjs). Anything else, above all com.vho.app, never matches.
export const TEST_ID = /^com\.vho\.app\.test[0-9a-f]{16}$/;
export const PACKAGE_TEST_ID = /^com\.vho\.app\.packagetest[0-9a-z]*$/;

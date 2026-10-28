// Product scope of this build (user decision 2026-10-28, Windows alpha).
//
// LEGACY_PHOTO_AI: the earlier neural photo enhancer (DAT-2 x4 + GFPGAN, media/photo-ai.js) is out
// of the Windows alpha. Off, it has no entry point at all: no panel section, no E shortcut, no
// controller, capability "out-of-scope". The default photo enhance is the model-free A05 chain;
// object removal and colorize (A06) are separate and stay. The model files and their tests stay
// as an experimental record (tests/ai, the quality layer's vho-x4 profiles).
export const LEGACY_PHOTO_AI = false;

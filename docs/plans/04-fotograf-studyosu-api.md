# Plan 04 — Fotoğraf arka ucu: ön yüz API notu

> Frontend integration note for the photo backend (`src-tauri/src/photo/`, agent A3).
> Audience: B3 (photo UI). All commands are invoked with `window.__TAURI__.core.invoke`;
> argument names are camelCase in JS. File paths returned by the backend are already
> allowed in the asset protocol: show them with `convertFileSrc(path)`.

## Commands at a glance

| Command | Args | Returns | Events |
|---|---|---|---|
| `photo_scan` | `dir: string, options?: ScanOptions` | `ScanSummary` | `photo-scan-page`, `photo-scan-progress` |
| `photo_thumb` | `path: string, size?: number` (default 256) | `ThumbResult` | – |
| `photo_thumbs` | `requestId: string, paths: string[], size?: number` | `ThumbBatchSummary` | `photo-thumb` (one per path) |
| `photo_info` | `path: string` | `PhotoInfo` | – |
| `photo_decode` | `path: string, maxSize?: number` | `DisplayResult` | – |
| `photo_batch` | `job: BatchJob` | `BatchSummary` | `photo-batch-progress` |
| `photo_cancel` | `id: string` (scanId / requestId / jobId) | `boolean` (false = not running) | – |
| `photo_capabilities` | – | `Capabilities` | – |
| `photo_list_dirs` | `dir?: string` | `DirEntry[]` (`{ name, path }`) | – |

`photo_list_dirs` (added by B3 for the folder tree): with `dir`, the immediate sub-folders
(natural order, hidden/system skipped, files not opened); without `dir`, the well-known
folders (Resimler, Masaüstü, İndirilenler, Videolar, Ana klasör) followed by the file
system roots (drive letters on Windows, `/` elsewhere).

Every long-running command keeps its promise pending until it finishes or is cancelled.
It also emits events tagged with your id, so **register listeners before invoking** and
filter by id.

## Errors

Commands reject with a string. Errors the UI should react to start with a tag:

| Tag | Meaning | Suggested UI |
|---|---|---|
| `[unsupported]` | Not an image we can read | Generic file icon |
| `[codec-missing]` | OS codec missing (HEIC/HEVC/AV1/RAW extension, libheif tools) | Show the message (Turkish, names the Store extension to install), plus `capabilities.hint` |
| `[cancelled]` | Cancelled via `photo_cancel` | Ignore |

Other messages are Turkish free text (e.g. `Dosya okunamadı: …`).

## Folder scan

```js
const scanId = crypto.randomUUID();
const items = [];
const un1 = await listen('photo-scan-page', e => {
  if (e.payload.scanId !== scanId) return;
  items.splice(e.payload.offset, e.payload.items.length, ...e.payload.items); // pages arrive in order
  grid.render(items);
});
const un2 = await listen('photo-scan-progress', e => { /* {scanId, phase:"list"|"exif", done, total} */ });
const summary = await invoke('photo_scan', { dir, options: { scanId, sort: 'name' } });
un1(); un2();
```

`ScanOptions` (all optional):

| Field | Default | Notes |
|---|---|---|
| `scanId` | generated | Use your own so you can filter events and cancel |
| `recursive` | `false` | |
| `sort` | `"name"` | `"name"` (natural, case-insensitive) · `"date"` (mtime) · `"size"` · `"exifDate"` (capture date, falls back to mtime) · `"none"` (streams pages while walking, fastest for huge trees) |
| `descending` | `false` | |
| `includeVideos` | `false` | Videos get `kind: "video"` |
| `includeHidden` | `false` | Dot-files and Windows hidden/system files |
| `pageSize` | `500` | Items per `photo-scan-page` event |
| `exifDates` | `false` | Fill `exifDate` for every item (always on for `sort: "exifDate"`; costs one header read per file, parallel) |

`ScanItem`: `{ path, name, ext, kind: "image"|"raw"|"heif"|"video", size, mtime /*ms*/, exifDate? /*ms, camera local time as UTC*/, browserNative }`

`ScanSummary`: `{ scanId, dir, total, folders: string[] /*immediate sub-folder names*/, cancelled, elapsedMs }`

Re-sorting is cheap on the client side (all fields are present), so you only need to re-scan for `exifDate`.
The scanned folder is added to the asset scope, so `convertFileSrc(item.path)` works for
`browserNative` items. Measured: 5,000-file folder → first page after about 6 ms, total about 7 ms (sorting by name).

## Thumbnails

```js
const requestId = 'grid-' + (++seq);
await invoke('photo_cancel', { id: previousRequestId });   // e.g. after fast scrolling
const un = await listen('photo-thumb', e => {
  const { requestId: rid, index, path, thumb, error } = e.payload;
  if (rid !== requestId) return;
  if (thumb) cell(path).src = convertFileSrc(thumb.path); else cell(path).markBroken(error);
});
const summary = await invoke('photo_thumbs', { requestId, paths: visiblePaths, size: 256 });
un();
```

- `ThumbResult`: `{ path /*cache file .jpg or .png (transparency)*/, width, height, cached }`. Longest side = `size` (16–2048, default 256); images are never upscaled. EXIF orientation is already applied.
- `photo-thumb` event: `{ requestId, index /*into paths*/, path /*source*/, thumb: ThumbResult|null, error: string|null }`. Cache hits are reported first, then generated thumbnails in completion order, not in `paths` order.
- `ThumbBatchSummary`: `{ total, cached, generated, failed, cancelled, elapsedMs }`.
- Cache: `<app cache>/photo/thumbs/`, keyed by path, size, mtime and thumbnail size, so edited files get fresh thumbnails automatically. Files older than 180 days are pruned at startup.
- Request only the visible range plus a small margin, and cancel stale requests. Videos (`kind: "video"`) are not handled here; their thumbnails come later (Plan 02, mpv).
- Speed (Ryzen 5 7535U, 4 threads, 12 MP JPEGs): cold about 35 ms per image (about 29 images/s), warm about 0.04 ms per image.

## Viewer: showing any photo

```js
const r = await invoke('photo_decode', { path });           // full size
// or { path, maxSize: 2560 } for a screen-sized copy of huge RAW/TIFF files
img.src = convertFileSrc(r.path);
```

`DisplayResult`: `{ path, converted, width, height, format, source }`

- Browser-native formats (JPEG, PNG, WebP, GIF, BMP, ICO, AVIF, SVG): `converted: false`, `path` is the original (animation preserved), `source: "original"`. The `<img>` element applies EXIF orientation itself; `width`/`height` are the display size after orientation.
- HEIC/HEIF, RAW, TIFF, TGA, PNM, QOI: decoded once into `<app cache>/photo/decoded/` as an upright JPEG (q92) or PNG (with alpha); `source` is `"native"`, `"os"`, `"rawPreview"` or `"cache"`. Converted copies are pruned after 30 days.
- RAW shows the embedded camera JPEG preview (usually full size).

## Info panel (EXIF, GPS)

`photo_info(path)` → `PhotoInfo`:

```jsonc
{
  "path": "...", "name": "IMG_0001.HEIC", "size": 2345678, "mtime": 1715956205000,
  "format": "heif",            // jpeg png webp gif bmp ico tiff tga pnm qoi heif avif raw svg unknown
  "width": 3024, "height": 4032,  // display size (orientation applied), null if unknown
  "browserNative": false,
  "exif": {                    // null when the file has no EXIF
    "make": "Apple", "model": "iPhone 15", "lens": "...",
    "dateTaken": "2024-05-17T14:30:05", "dateTakenOffset": "+03:00",
    "exposureTime": "1/250", "fNumber": 1.8, "iso": 64,
    "focalLength": 6.9, "focalLength35mm": 26, "exposureBias": 0,
    "flash": "off",            // "fired" | "off"
    "orientation": 6,          // 1-8
    "software": "...", "artist": null, "copyright": null, "description": null,
    "gps": { "latitude": 41.01, "longitude": 28.98, "altitude": 39 }   // or null
  },
  "fields": [                  // every tag, for an "all metadata" table
    { "ifd": "primary", "group": "exif", "tag": "ExposureTime", "id": 33434, "value": "1/250 s" }
  ]
}
```

EXIF is read from JPEG, TIFF/DNG/CR2/NEF/ARW/ORF/RW2/PEF…, HEIC/AVIF, PNG, WebP, Fuji RAF (preview) and Canon CR3 (CMT boxes).
`gps` is null for 0,0 coordinates (phones without a fix).

## Edit / batch

One API covers "Save" in the editor (one file) and batch jobs (§5).

```js
const jobId = crypto.randomUUID();
const un = await listen('photo-batch-progress', e => {
  if (e.payload.jobId !== jobId) return;
  progressBar.value = e.payload.done / e.payload.total;   // payload also has all FileOutcome fields
});
const summary = await invoke('photo_batch', { job: {
  jobId,
  files: ['C:/Photos/a.jpg', 'C:/Photos/b.heic'],
  ops: [
    { op: 'rotate', degrees: 90 },                         // multiples of 90, negative = CCW
    { op: 'flip', axis: 'horizontal' },                    // or 'vertical'
    { op: 'crop', x: 0, y: 0, width: 800, height: 600 },   // display pixels at this step
    { op: 'resize', longEdge: 2048 },                      // or {percent}, {width}, {height}, {width,height[,exact]}; {upscale:true} to enlarge
    { op: 'adjust', brightness: 10, contrast: 0, saturation: 5, temperature: -20 }, // each -100..100 (B3)
    { op: 'sharpen', amount: 40 },                         // 0..100, 3x3 Laplacian (B3)
  ],
  output: {
    format: 'same',          // same | jpeg | png | webp | avif | tiff | bmp  (same: HEIC/RAW → jpeg)
    quality: 90,             // 1-100; webp 100 = lossless
    dir: null,               // default: next to the source
    nameTemplate: '{name}',  // tokens: {name} {ext} {counter} {counter:3} {date} (EXIF date or mtime, YYYYMMDD_HHMMSS)
    counterStart: 1,
    conflict: 'rename',      // rename (" (1)"), overwrite (in-place "Save"), skip
    metadata: 'keep',        // keep | stripGps | strip
    lossless: true,          // allow lossless JPEG paths (see below)
    removeSource: false,     // true + new name = move/rename
  },
}});
un();
```

- Ops run in order on the upright (EXIF-oriented) image, in display coordinates.
- **Lossless JPEG**: when the source and output are both JPEG and the ops are only rotate/flip (or none), the backend rewrites only the EXIF Orientation tag (and removes metadata if asked). The compressed image data stays bit-identical (`lossless: true` in the outcome). The webview and all modern viewers honour the tag. Set `output.lossless: false` to force pixel rotation with re-encoding.
- No ops, same format, `metadata: "keep"` → byte copy (use for rename/copy batches).
- Re-encoded outputs keep EXIF (JPEG, PNG, WebP). Orientation is reset to 1, PixelX/YDimension are updated, and the stale EXIF thumbnail is dropped. `stripGps` also removes XMP. AVIF/TIFF/BMP outputs carry no EXIF. ICC profiles are kept for JPEG/PNG.
- `conflict: "rename"` never overwrites the source. For the editor's "Save", use `conflict: "overwrite"` with no `dir` and template `{name}`; writes are atomic (temp file + rename).
- GIF sources are re-encoded from their first frame only.
- `FileOutcome`: `{ index, input, output, ok, skipped, error, lossless, width, height, bytes }`.
- `BatchSummary`: `{ jobId, total, succeeded, failed, skipped, cancelled, elapsedMs, results: FileOutcome[] /*in input order*/ }`.
- `photo_cancel(jobId)` stops files not started yet (they get `error: "[cancelled]"`). Files in progress finish.
- New output files are added to the asset scope.

## Capabilities

`photo_capabilities()` → `{ heic, avifDecode, avifEncode, webpLossy, rawPreview, rawOs, osCodec: "wic"|"imageio"|"libheif", imageExtensions, videoExtensions, writeFormats, hint }`.
Use `imageExtensions` for open-file dialog filters. Show `hint` (Turkish) when `heic` or `avifDecode` is false.

## Platform notes

| | Windows | macOS | Linux |
|---|---|---|---|
| JPEG/PNG/WebP/GIF/BMP/TIFF/TGA/QOI | built-in (Rust) | same | same |
| HEIC/HEIF | WIC + Store "HEIF Image Extensions" + "HEVC Video Extensions" (tested) | ImageIO via `sips` (CI-verified only) | `heif-dec`/`heif-convert` from libheif-examples (CI-verified only) |
| AVIF display | WebView2 natively | WebKit natively | WebKitGTK natively |
| AVIF thumbnails/edit | WIC + "AV1 Video Extension" (tested) | `sips` (macOS 13+) | libheif tools |
| AVIF export | built-in (rav1e) | same | same |
| RAW | embedded preview (built-in); WIC "Raw Image Extension" as fallback | preview; `sips` fallback | preview only |

Full RAW development is not available: the Rust RAW decoders (rawler, rawloader) are LGPL and would be statically linked.

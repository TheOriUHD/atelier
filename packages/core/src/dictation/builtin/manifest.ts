/**
 * Atelier's own speech-to-text (ARCHITECTURE §27): NVIDIA's Nemotron 3.5 ASR Streaming 0.6B (OpenMDW-1.1, 40 language
 * locales, punctuation, a streaming transducer: words come while the person speaks), run by sherpa-onnx's native
 * Node addon (Apache-2.0). Neither ships with Atelier: the backend fetches both the first time someone dictates, from
 * pinned addresses, and keeps them only if every byte matches what is written here.
 */

/** sherpa-onnx's native addon, per platform, as npm publishes it (`dist.tarball`, `dist.integrity`). */
export const SPEECH_RUNTIME_VERSION = '2.0.1';
export const SPEECH_RUNTIME: Readonly<Record<string, { url: string; integrity: string; bytes: number }>> = {
  'darwin-arm64': {
    url: 'https://registry.npmjs.org/sherpa-onnx-darwin-arm64/-/sherpa-onnx-darwin-arm64-2.0.1.tgz',
    integrity: 'sha512-agXmbbwiVPUSMViMhWhYAt59iG21ui7x6HxQFU35XzHOfQe9x6Pg9V160Pzak/66x0ePMjixsLUtMaaUrLfCwQ==',
    bytes: 34_070_681,
  },
  'darwin-x64': {
    url: 'https://registry.npmjs.org/sherpa-onnx-darwin-x64/-/sherpa-onnx-darwin-x64-2.0.1.tgz',
    integrity: 'sha512-SBnHa3LDOSI/5/rpBHGxKQDFq+yIdxowYY0InLzfojTUx+yGgqu7cYBrRxjzvHOiOKi0O4rmlFVZboyhIqpDgA==',
    bytes: 37_658_229,
  },
  'linux-x64': {
    url: 'https://registry.npmjs.org/sherpa-onnx-linux-x64/-/sherpa-onnx-linux-x64-2.0.1.tgz',
    integrity: 'sha512-w5mRRrIvPvcNWac7rQ8AN/t/cwElPGoRpH+ceCRBV7XfjCIQ9Rcr3Ig/kXcJLNOxgK4bGmef+Y47lIWiesDODw==',
    bytes: 33_196_612,
  },
  'linux-arm64': {
    url: 'https://registry.npmjs.org/sherpa-onnx-linux-arm64/-/sherpa-onnx-linux-arm64-2.0.1.tgz',
    integrity: 'sha512-5CJvLjFYIg23oELCsT7l07fMLT3PdquZ3tqh7KZK3Pzi+c2YiPKRe1DDUxoNdtCaw3ZiS4aQSQPBblB9JStuDA==',
    bytes: 40_205_239,
  },
  'win32-x64': {
    url: 'https://registry.npmjs.org/sherpa-onnx-win-x64/-/sherpa-onnx-win-x64-2.0.1.tgz',
    integrity: 'sha512-7vwdAw9PGEb0JLSpK7UFxAdp1vabBHK9Nhw2jFRBWSFgtslUPHIB0T6syJfRgiUGyCeNW9fJvcFAk2F2u7hBEw==',
    bytes: 23_161_917,
  },
  'win32-arm64': {
    url: 'https://registry.npmjs.org/sherpa-onnx-win-arm64/-/sherpa-onnx-win-arm64-2.0.1.tgz',
    integrity: 'sha512-Mb9iqy2Zp7GC5a99dk5E8EQJsEBnapf+IcwHLVCgtIf5mxYHO9Q8YptnAoOHZOD0Zi+R+MblFyG9qv0Q6tin4Q==',
    bytes: 23_297_089,
  },
};

/** The model's files at one revision of sherpa-onnx's export (the same as its GitHub release archive). */
export const SPEECH_MODEL = {
  id: 'nemotron-3.5-asr-streaming-0.6b-560ms-int8',
  label: 'Nemotron 3.5 ASR',
  base: 'https://huggingface.co/csukuangfj2/sherpa-onnx-nemotron-3.5-asr-streaming-0.6b-560ms-int8-2026-06-11/resolve/ab43d895f5985b1bbab8b6eac8607fcdc05343f3/',
  files: [
    { name: 'encoder.int8.onnx', bytes: 657_601_403, sha256: '012e9321373af99021415e0b0eb3ec827b4be3153be6f30d9b448fe65e896e68' },
    { name: 'decoder.int8.onnx', bytes: 14_978_075, sha256: '19f9c98fc6d0a2c33a65a43b36fdb2e914c26c0aa9764be3aebc502a1e982fb0' },
    { name: 'joiner.int8.onnx', bytes: 9_504_438, sha256: '4101c7c679a0bc30483794b27a059e34e79232aa2068d78d51231a22c8b0d7ce' },
    { name: 'tokens.txt', bytes: 131_440, sha256: '729cc103155bafa785f9cd45746cd41cabe97eab7182fc04d594129587958f8a' },
  ],
} as const;

/** The languages the model was trained to transcribe, by the code Atelier's menu uses (ISO 639-1). */
export const SPEECH_MODEL_LANGUAGES: Readonly<Record<string, string>> = {
  en: 'en', es: 'es', fr: 'fr', it: 'it', pt: 'pt', nl: 'nl', de: 'de', tr: 'tr', ru: 'ru', ar: 'ar', hi: 'hi', ja: 'ja', ko: 'ko', vi: 'vi',
  uk: 'uk', pl: 'pl', sv: 'sv', cs: 'cs', no: 'nb', da: 'da', bg: 'bg', fi: 'fi', hr: 'hr', sk: 'sk', zh: 'zh', hu: 'hu', ro: 'ro', et: 'et',
};

export const speechPlatform = (platform: string = process.platform, arch: string = process.arch): string => `${platform}-${arch}`;

/** What both downloads come to, for the person told before they start. */
export const speechDownloadBytes = (platform = speechPlatform()): number =>
  (SPEECH_RUNTIME[platform]?.bytes ?? 0) + SPEECH_MODEL.files.reduce((n, f) => n + f.bytes, 0);

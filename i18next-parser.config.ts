const functions = ["t", "say", "msg"];

export default {
  input: [
    "apps/desktop-renderer/src/**/*.{ts,tsx}",
    "apps/desktop/src/**/*.{ts,tsx}",
    "packages/core/src/**/*.{ts,tsx}",
    "packages/engine/src/**/*.{ts,tsx}",
    "packages/cycling-coach/src/**/*.{ts,tsx}",
  ],
  lexers: {
    ts: [{ lexer: "JavascriptLexer", functions }],
    tsx: [{ lexer: "JsxLexer", functions }],
  },
  keySeparator: ".",
  namespaceSeparator: false,
  output: "packages/i18n/catalogs/$LOCALE.json",
  locales: ["en"],
  sort: true,
  keepRemoved: true,
  createOldCatalogs: false,
  defaultValue: "",
};

/** Tool processes, including the watchdog, receive only operational environment. */
export function toolEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const allowed = new Set([
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "TMPDIR",
    "TMP",
    "TEMP",
    "LANG",
    "TERM",
    "TZ",
    "SYSTEMROOT",
    "WINDIR",
    "COMSPEC",
    "PATHEXT",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "REQUESTS_CA_BUNDLE",
    "CURL_CA_BUNDLE",
    "NODE_EXTRA_CA_CERTS",
  ]);
  return Object.fromEntries(
    Object.entries(source).filter(
      ([key, value]) => value !== undefined && (allowed.has(key.toUpperCase()) || /^LC_[A-Z_]+$/.test(key)),
    ),
  );
}

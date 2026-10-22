/**
 * Hide credentials in text before it is printed. Works on a bare connection string or on any message that
 * contains one: everything between the scheme and the LAST "@" of the authority is replaced (so a password that
 * itself contains "@" is covered), and password-like query parameters are blanked.
 */
export function maskUri(text) {
  return String(text)
    .replace(/([\w+.-]+:\/\/)[^/?#\s]*@/g, '$1***@')
    .replace(/([?&](?:password|pwd|secret|token|key)=)[^&#\s]*/gi, '$1***');
}

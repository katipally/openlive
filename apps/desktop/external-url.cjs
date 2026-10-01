// What the window may hand to the operating system: web links, and a mail draft to the
// project's own privacy address (Settings > Privacy > Request deletion). Any other scheme,
// or another recipient, stays inside the app.
const PRIVACY_MAILTO = /^mailto:privacy@openlive\.dev(?:\?([^\s#]*))?$/i;

/** Mail clients decode header names, so `%63c=` is `cc=`: judge the decoded keys, and let through only subject and body. */
function isPrivacyDraft(query) {
  try {
    return query.split("&").every((pair) => {
      const eq = pair.indexOf("=");
      const key = decodeURIComponent(eq < 0 ? pair : pair.slice(0, eq)).toLowerCase();
      const value = eq < 0 ? "" : decodeURIComponent(pair.slice(eq + 1));
      return key === "body" || (key === "subject" && !/[\r\n]/.test(value));
    });
  } catch {
    return false;
  }
}

const isExternalUrl = (url) => {
  if (/^https?:\/\//i.test(url)) return true;
  const draft = PRIVACY_MAILTO.exec(url);
  return !!draft && (draft[1] === undefined || isPrivacyDraft(draft[1]));
};

module.exports = { isExternalUrl };

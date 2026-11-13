(() => {
  try {
    const visible = el => el instanceof Element && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden' && getComputedStyle(el).display !== 'none';
    const luhn = value => {
      const digits = value.replace(/\D/g, '');
      if (digits.length < 13 || digits.length > 19) return false;
      let sum = 0, double = false;
      for (let i = digits.length - 1; i >= 0; i--) { let digit = Number(digits[i]); if (double) { digit *= 2; if (digit > 9) digit -= 9; } sum += digit; double = !double; }
      return sum % 10 === 0;
    };
    const secretText = text => /\b(?:Bearer|Basic)\s+[^\s,;"']+|\b(?:tss_[A-Za-z0-9_-]+|[sp]k_(?:live|test)_[A-Za-z0-9]+|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b|-----BEGIN [^-]*(?:PRIVATE|PUBLIC) KEY-----/i.test(text)
      || /\b(?:password|passwd|passcode|pin|credentials?|api[_ -]?key|secret|token|support[_ -]?(?:key|code))\b["']?\s*(?:[:=]|\bis\b)\s*[^\s,;}]+/i.test(text)
      || (text.match(/(?<![A-Za-z0-9][-_]?)(?:[0-9]{13,19}|[0-9]{4}(?:[ \u00a0-][0-9]{4}){2,3}(?:[ \u00a0-][0-9]{1,3})?)(?![-_]?[A-Za-z0-9])/g) ?? []).some(luhn);
    const safe = () => {
      if ([...document.querySelectorAll('[data-support-secret],input[type="password"],input[autocomplete="current-password"],input[autocomplete="new-password"]')].some(visible)) return false;
      const text = document.body?.innerText ?? document.body?.textContent ?? '';
      if (text.length > 250_000 || secretText(text)) return false;
      return [...document.querySelectorAll('input,textarea')].filter(visible).every(el => !/(?:pin|password|credential|secret|token|api.?key|card.?number)/i.test(`${el.id} ${el.name} ${el.autocomplete}`) && el.value.length <= 8192 && !secretText(el.value));
    };
    const ambiguous = [...document.querySelectorAll('iframe,webview,video,canvas,object,embed')].some(visible);
    if (!safe()) return 'SCREEN_CONTAINS_SECRETS';
    if (ambiguous || !document.body || document.visibilityState !== 'visible') return 'SCREEN_CAPTURE_UNAVAILABLE';
    // A secret may mount and disappear between asynchronous COM callbacks.
    // Inspect mutation records, including removed nodes and old text/attributes,
    // so a transient secure surface cannot be missed by the final check.
    window.__supportCaptureGuard?.observer.disconnect();
    const secureSelector = '[data-support-secret],input[type="password"],input[autocomplete="current-password"],input[autocomplete="new-password"],iframe,webview,video,canvas,object,embed';
    const unsafeNode = node => {
      if (node instanceof Element && (node.matches(secureSelector) || node.querySelector(secureSelector) || node.closest('[data-support-secret]'))) return true;
      if (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement) {
        if (/(?:pin|password|credential|secret|token|api.?key|card.?number)/i.test(`${node.id} ${node.name} ${node.autocomplete}`) || secretText(node.value)) return true;
      }
      const text = node.textContent ?? '';
      return text.length > 250_000 || secretText(text);
    };
    const guard = { changed: false, safe, observer: new MutationObserver(records => {
      guard.changed ||= records.some(record => record.type === 'childList'
        ? [...record.addedNodes, ...record.removedNodes].some(unsafeNode)
        : unsafeNode(record.target) || secretText(record.oldValue ?? '') || record.type === 'attributes' && (record.attributeName === 'data-support-secret' || record.attributeName === 'type' && record.oldValue?.toLowerCase() === 'password'));
    }) };
    guard.observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true, attributeOldValue: true, characterDataOldValue: true });
    window.__supportCaptureGuard = guard;
    return 'ready';
  } catch { return 'SCREEN_CAPTURE_UNAVAILABLE'; }
})()

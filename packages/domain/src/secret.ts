const credentialTaxonomy = {
  english: {
    qualifiers: [
      "authenticator", "auth(?:entication)?", "confirmation", "verification", "sign[-\\s]?in", "text[-\\s]?message",
      "one[-\\s]?time", "back[-\\s]?up", "access", "refresh", "bearer", "session", "security", "client",
      "private", "recovery", "identity", "secret", "login", "email", "sms", "seed", "2fa", "mfa", "api",
      "card", "credit", "bank",
    ],
    nouns: ["credential(?:s)?", "passcode", "password", "secret", "phrase", "number", "token", "code", "key", "pin", "cvv", "cvc", "card"],
    strong: ["password", "passcode", "totp", "otp", "pin", "cvv", "cvc"],
  },
  japanese: {
    qualifiers: [
      "認証アプリ", "本人確認", "セキュリティ", "クライアント", "リフレッシュ", "バックアップ", "シークレット",
      "プライベート", "ワンタイム", "サインイン", "アクセス", "リカバリー", "Bearer", "セッション", "確認",
      "ログイン", "認証", "検証", "メール", "SMS", "秘密", "復旧", "シード", "2FA", "MFA", "API", "カード", "銀行",
    ],
    nouns: ["認証情報", "資格情報", "シークレット", "パスコード", "パスワード", "PIN(?:コード)?", "トークン", "フレーズ", "コード", "キー", "番号", "CVV", "CVC", "鍵"],
    strong: ["パスワード", "パスコード", "暗証番号", "認証情報", "資格情報"],
  },
} as const;

const patternSet = (patterns: readonly string[]): string => `(?:${patterns.join("|")})`;
const englishCredentialQualifier = patternSet(credentialTaxonomy.english.qualifiers);
const englishCredentialNoun = patternSet(credentialTaxonomy.english.nouns);
const englishCredentialCompound = new RegExp(`${englishCredentialQualifier}(?:[\\s_./:=-]*${englishCredentialQualifier}){0,2}[\\s_./:=-]*${englishCredentialNoun}`, "giu");
const englishStrongCredentialLabel = new RegExp(patternSet(credentialTaxonomy.english.strong), "giu");
const japaneseCredentialQualifier = patternSet(credentialTaxonomy.japanese.qualifiers);
const japaneseCredentialNoun = patternSet(credentialTaxonomy.japanese.nouns);
const japaneseCredentialCompound = new RegExp(`${japaneseCredentialQualifier}(?:[\\s_./:：・=-]*の?[\\s_./:：・=-]*${japaneseCredentialQualifier}){0,2}[\\s_./:：・=-]*の?[\\s_./:：・=-]*${japaneseCredentialNoun}`, "iu");
const japaneseStrongCredentialLabel = new RegExp(patternSet(credentialTaxonomy.japanese.strong), "u");
const safeCredentialMetaLiteral = /^[「『]?確認コードという言葉[」』]?$/u;
const knownToken = /(?:sk-(?:proj-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/u;

function hasCardNumber(text: string): boolean {
  const digits = text.replace(/\D/g, "");
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = Number(digits[index]);
    if ((digits.length - index) % 2 === 0) digit = digit > 4 ? digit * 2 - 9 : digit * 2;
    sum += digit;
  }
  return sum % 10 === 0;
}

function hasBoundedAsciiMatch(text: string, pattern: RegExp): boolean {
  pattern.lastIndex = 0;
  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (/[A-Za-z0-9_]/.test(text[start - 1] ?? "") || /[A-Za-z0-9_]/.test(text[end] ?? "")) continue;
    return true;
  }
  return false;
}

function hasCredentialLabel(text: string): boolean {
  const normalized = text.normalize("NFKC").trim();
  if (safeCredentialMetaLiteral.test(normalized)) return false;
  return hasBoundedAsciiMatch(normalized, englishStrongCredentialLabel)
    || hasBoundedAsciiMatch(normalized, englishCredentialCompound)
    || japaneseStrongCredentialLabel.test(normalized)
    || japaneseCredentialCompound.test(normalized);
}

function entropy(token: string): number {
  const counts = new Map<string, number>();
  for (const character of token) counts.set(character, (counts.get(character) ?? 0) + 1);
  return [...counts.values()].reduce((total, count) => {
    const probability = count / token.length;
    return total - probability * Math.log2(probability);
  }, 0);
}

function hasHighEntropySecret(text: string): boolean {
  return [...text.matchAll(/[A-Za-z0-9+/=_-]{24,}/g)].some((match) => {
    const token = match[0];
    const prefix = text.slice(Math.max(0, (match.index ?? 0) - 16), match.index ?? 0);
    if (/(?:注文(?:番号|ID)?|order(?:[- ]?(?:number|id))?)\s*(?:は|:|：|=)?\s*$/iu.test(prefix)) return false;
    return entropy(token) >= 3.5 && (/[+/=]/.test(token) || token.length >= 32);
  });
}

export function containsForbiddenSecret(content: string): boolean {
  return hasCredentialLabel(content) || knownToken.test(content) || hasHighEntropySecret(content) || hasCardNumber(content);
}

/** Redact concrete credentials in technical reports without hiding paths or credential terminology. */
export function redactCredentialValues(content: string): string {
  return content
    .replace(new RegExp(knownToken.source, 'gu'), '［秘密値を省略］')
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gu, '［秘密鍵を省略］')
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+\/-]{16,}/giu, '$1［秘密値を省略］')
    .replace(/\b((?:[A-Z_]*(?:API_KEY|ACCESS_TOKEN|REFRESH_TOKEN|CLIENT_SECRET)|password)\s*[:=]\s*["']?)[A-Za-z0-9._~+\/-]{16,}/giu, '$1［秘密値を省略］');
}

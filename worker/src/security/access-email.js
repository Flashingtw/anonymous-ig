export function normalizeAccessEmail(value) {
  if (typeof value !== "string") throw new TypeError("Email must be a string.");
  const email = value.trim().toLowerCase();
  // This small-system binding accepts conventional ASCII mailbox addresses.
  // No provider-specific dot removal or plus-alias merging.
  if (email.length > 254 || !/^[\x21-\x7e]+$/.test(email) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new TypeError("Enter a valid ASCII email address (maximum 254 characters).");
  }
  return email;
}

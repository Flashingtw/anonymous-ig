import { ApiClientError, apiRequest } from "./api.js";
import { formatText, getContent, loadContent } from "./content.js";
import { MAX_CONTENT_LENGTH, contentLength } from "./submission-content.js";

const messages = {
  characterCount: "{current} / {max}",
  sending: "送出中⋯",
  submitLabel: "送出投稿",
  emptyContent: "請輸入投稿內容。",
  tooLong: "內容最多 {max} 字，目前超出 {over} 字。",
  genericSubmitError: "暫時無法送出，請稍後再試。",
  rateLimited: "送出得太頻繁了，請稍後再試。",
  success: "投稿已送出，謝謝你的分享。"
};

const form = document.querySelector("#submission-form");
const contentInput = document.querySelector("#content");
const characterCount = document.querySelector("#character-count");
const contentError = document.querySelector("#content-error");
const statusBox = document.querySelector("#submission-status");
const submitButton = document.querySelector("#submit-button");
const submitButtonLabel = submitButton.querySelector("span");
let sending = false;

function inputLength() {
  return contentLength(contentInput.value);
}

function updateCharacterCount() {
  const length = inputLength();
  characterCount.textContent = formatText(messages.characterCount, {
    current: length,
    max: MAX_CONTENT_LENGTH
  });
  characterCount.classList.toggle("is-over-limit", length > MAX_CONTENT_LENGTH);
  characterCount.classList.toggle("is-near-limit", length >= 90 && length <= MAX_CONTENT_LENGTH);
  submitButton.disabled = sending || length > MAX_CONTENT_LENGTH;
  setFieldError(length > MAX_CONTENT_LENGTH ? formatText(messages.tooLong, {
    max: MAX_CONTENT_LENGTH, over: length - MAX_CONTENT_LENGTH
  }) : "");
}

function setFieldError(message = "") {
  contentError.textContent = message;
  contentInput.setAttribute("aria-invalid", message ? "true" : "false");
}

function setStatus(type, message) {
  statusBox.textContent = message;
  statusBox.className = `notice notice--${type}`;
  statusBox.hidden = false;
}

function setSending(isSending) {
  sending = isSending;
  contentInput.disabled = isSending;
  submitButton.disabled = isSending || inputLength() > MAX_CONTENT_LENGTH;
  submitButtonLabel.textContent = isSending ? messages.sending : messages.submitLabel;
  form.setAttribute("aria-busy", String(isSending));
}

function validate() {
  const value = contentInput.value.trim();
  const length = contentLength(value);

  if (!value) {
    setFieldError(messages.emptyContent);
    return null;
  }

  if (length > MAX_CONTENT_LENGTH) {
    setFieldError(formatText(messages.tooLong, {
      max: MAX_CONTENT_LENGTH,
      over: length - MAX_CONTENT_LENGTH
    }));
    return null;
  }

  setFieldError();
  return value;
}

function friendlyError(error) {
  if (!(error instanceof ApiClientError)) {
    return messages.genericSubmitError;
  }

  if (error.status === 429 || error.code === "RATE_LIMITED") {
    return messages.rateLimited;
  }

  if (error.code.startsWith("CAPTCHA_")) {
    return error.message;
  }

  if (["EMPTY_CONTENT", "CONTENT_TOO_LONG", "INVALID_CONTENT"].includes(error.code)) {
    return error.message;
  }

  return messages.genericSubmitError;
}

contentInput.addEventListener("input", () => {
  updateCharacterCount();
  statusBox.hidden = true;
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (sending) return;
  statusBox.hidden = true;

  const content = validate();
  if (!content) {
    contentInput.focus();
    return;
  }

  setSending(true);

  try {
    await apiRequest("/api/submissions", {
      method: "POST",
      credentials: "omit",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content })
    });

    form.reset();
    updateCharacterCount();
    setStatus("success", messages.success);
  } catch (error) {
    setStatus("error", friendlyError(error));
  } finally {
    setSending(false);
  }
});

loadContent().then((content) => {
  Object.assign(messages, getContent(content, "publicPage.messages", {}));
  messages.submitLabel = getContent(
    content,
    "publicPage.form.submitLabel",
    messages.submitLabel
  );
  updateCharacterCount();
});

updateCharacterCount();

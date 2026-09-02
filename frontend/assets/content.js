const CONTENT_URL = new URL("../content.json", import.meta.url);

export function getContent(content, path, fallback = "") {
  const value = path
    .split(".")
    .reduce((current, key) => current?.[key], content);
  return value ?? fallback;
}

export function formatText(template, variables = {}) {
  return String(template).replace(/\{([a-zA-Z][a-zA-Z0-9]*)\}/g, (match, key) => (
    Object.hasOwn(variables, key) ? String(variables[key]) : match
  ));
}

export function applyContent(content, root = document) {
  const staticVariables = { year: new Date().getFullYear() };

  for (const element of root.querySelectorAll("[data-copy]")) {
    const value = getContent(content, element.dataset.copy, null);
    if (typeof value !== "string") {
      continue;
    }

    const rendered = formatText(value, staticVariables);
    const attribute = element.dataset.copyAttribute;
    if (attribute) {
      element.setAttribute(attribute, rendered);
    } else {
      element.textContent = rendered;
    }
  }
}

export async function loadContent() {
  try {
    const response = await fetch(CONTENT_URL, {
      headers: { Accept: "application/json" },
      cache: "no-cache"
    });
    if (!response.ok) {
      throw new Error("content request failed");
    }

    const content = await response.json();
    applyContent(content);
    return content;
  } catch {
    console.warn("Editable content could not be loaded; using HTML fallbacks.");
    return {};
  }
}

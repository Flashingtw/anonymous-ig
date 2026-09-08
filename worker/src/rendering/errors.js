export class RenderError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "RenderError";
    this.code = code;
    this.details = details;
  }
}

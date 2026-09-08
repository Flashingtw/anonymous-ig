ALTER TABLE submissions ADD COLUMN render_status TEXT NOT NULL DEFAULT 'not_rendered'
  CHECK (render_status IN ('not_rendered', 'rendering', 'ready', 'failed'));

ALTER TABLE submissions ADD COLUMN rendered_image_key TEXT
  CHECK (rendered_image_key IS NULL OR length(rendered_image_key) BETWEEN 1 AND 500);

ALTER TABLE submissions ADD COLUMN rendered_at TEXT;

ALTER TABLE submissions ADD COLUMN render_error TEXT
  CHECK (render_error IS NULL OR length(render_error) BETWEEN 1 AND 100);

ALTER TABLE submissions ADD COLUMN template_id TEXT
  CHECK (template_id IS NULL OR length(template_id) BETWEEN 1 AND 100);

ALTER TABLE submissions ADD COLUMN renderer_version TEXT
  CHECK (renderer_version IS NULL OR length(renderer_version) BETWEEN 1 AND 100);

ALTER TABLE submissions ADD COLUMN render_version INTEGER NOT NULL DEFAULT 0
  CHECK (render_version >= 0);

PRAGMA optimize;

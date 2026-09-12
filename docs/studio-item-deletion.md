# Studio item deletion (local implementation)

Only approved submissions/image drafts and ready images have a Delete action. A confirmation identifies the submission. Owner, admin and moderator use the existing enabled-session, role and CSRF checks. No account or send-record deletion is provided.

Deletion means removal from the studio, not permanent erasure: migration 0009 adds an immutable tombstone. Original submissions, image versions, private R2 objects and audit records are retained. There is currently no UI restore or space-reclamation action for these tombstones.

The API requires the displayed revision and source state. Its transaction writes the tombstone and audit together. Active send-group members and confirmed submissions cannot be deleted. SQL guards serialize removal against adding an image to a send group. Removed items cannot be edited, recreated, downloaded or imported from legacy history. Confirmed numbering never changes.

`DELETE /api/admin/studio/items/:id` accepts `{source: "approved" | "ready", revision: number}`. Mutation requires schema 0009 and `STUDIO_DELETE_ENABLED=true`; without them the UI hides Delete. Tombstones remain effective if the flag is disabled later.

Local preview applies 0009 only to its isolated temporary database. Production migration, flag activation and deployment require separate approval. No production data or images were removed by this implementation.
